// #3980 (tools/dev/surf_e2e.js): every surf pool map, raced to the finish in a browser client.
// One player joins the board, then per map: csp_test_remote 8 ffa <map> -> the map pack arrives, the race starts,
// and the player surfs each stage with real movement commands (+moveleft / +moveright / +forward through the
// engine's command buffer, like held keys), steered by its position, which the test-only helper plugin csp_t3980 prints into the player's console
// 20 times a second (T_POS). A stage that fails ASSIST_AFTER times in a row is skipped with t_tp (logged as
// "assisted"); the finish itself is always the plugin's own finish-box check.
// Runs in the Playwright image on game-host (GPU) against an isolated stack.
// env: RELAY, KEY, RCON_PORT, RPW, MAPS (comma list), DEVICE (desktop|phone), ROUTES (json), TAG. Writes /work/out.
const { chromium, devices } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8098";
const DEVICE = process.env.DEVICE || "desktop";
const URL = `${RELAY}/?key=${encodeURIComponent(process.env.KEY || "")}&nosound=1&dev=1`;
const RPORT = +(process.env.RCON_PORT || 27050);
const MAPS = (process.env.MAPS || "").split(",").filter(Boolean);
const ROUTES = JSON.parse(fs.readFileSync(process.env.ROUTES || "/work/routes.json", "utf8"));
const ASSIST_AFTER = +(process.env.ASSIST_AFTER || 4);
const TAG = process.env.TAG || DEVICE;
const OUT = "/work/out"; fs.mkdirSync(OUT, { recursive: true });
const log = fs.createWriteStream(`${OUT}/${TAG}.log`);
const t0 = Date.now();
const note = (s) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}] ${s}`; log.write(l + "\n"); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"); const H = Buffer.from([255, 255, 255, 255]);
    const done = (v) => { try { s.close(); } catch {} ok(v); };
    setTimeout(() => done("timeout"), 3000);
    s.on("message", (m) => {
      const t = m.slice(4).toString();
      const c = /challenge rcon (\d+)/.exec(t);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${process.env.RPW}" ${cmd}\n`)]), RPORT, "127.0.0.1");
      else done(t.replace(/^l/, ""));
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), RPORT, "127.0.0.1");
  });
}
let streamed = null, streamedAt = 0;   // T_POS lines the helper plugin prints into this player's console, 20 a second
function parsePos(r) {
  const m = /T_POS (-?\d+) (-?\d+) (-?\d+) vel (-?\d+) (-?\d+) (-?\d+) yaw (-?\d+) alive (\d) flags (\d+)/.exec(r);
  if (!m) return null;
  const v = m.slice(1).map(Number);
  return { x: v[0], y: v[1], z: v[2], vx: v[3], vy: v[4], vz: v[5], yaw: v[6], alive: v[7], ground: (v[8] & 512) !== 0 };
}
async function pos() {
  for (let i = 0; i < 20; i++) { if (streamed && Date.now() - streamedAt < 400) return streamed; await sleep(25); }
  return null;
}
async function state() { const r = await rcon("csp_state"); const m = /state=(\d+)/.exec(r); return m ? +m[1] : -1; }

(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const ctxOpts = DEVICE === "phone" ? { ...devices["Pixel 7 landscape"] } : { viewport: { width: 640, height: 400 } };
  const ctx = await browser.newContext(ctxOpts);
  const pg = await ctx.newPage();
  const states = [];
  pg.on("console", (m) => {
    const t = m.text();
    if (t.includes("T_POS")) { const p = parsePos(t); if (p) { streamed = p; streamedAt = Date.now(); } return; }
    const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
    if (/watch|\[boot\]|CSP_MAP|Host_Error|Sys_Error|couldn't|can't find|not found|download|abort|Error/i.test(t)) note(`console.${m.type()}: ${t.slice(0, 240)}`);
  });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  pg.on("crash", => note("PAGE CRASHED"));
  const packs = [];
  pg.on("response", (r) => { if (r.url().includes("mappacks/")) packs.push(`${r.status()} ${r.url().replace(/key=[^&]*/, "key=***").replace(RELAY, "")}`); });

  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note(`device ${DEVICE} ${JSON.stringify(ctxOpts.viewport)} touch=${await pg.evaluate(() => matchMedia("(pointer: coarse)").matches)}`);
  note("renderer: " + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  await pg.fill("#name", DEVICE === "phone" ? "phone" : "desk"); await pg.click("#go");
  const joins = => states.filter((s) => s === 4).length;
  const waitJoins = async (n, secs) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { if (joins() >= n) return true; await sleep(500); } return false; };
  note("joined board: " + await waitJoins(1, 300));
  await sleep(15000);
  const cmd = (c) => pg.evaluate((c) => { const e = window.__csp; const p = e.stringToNewUTF8(c + "\n"); e._Cbuf_AddText(p); e._free(p); }, c);
  const release = => cmd("-forward; -back; -moveleft; -moveright; -jump; -duck");
  const results = [];

  for (const map of MAPS) {
    const route = ROUTES[map];
    const res = { map, device: DEVICE, joined: false, raced: false, finished: false, assisted: [], stageTries: [], time: null };
    results.push(res);
    const before = joins();
    note(`=== ${map}: ` + (await rcon(`csp_test_remote 8 ffa ${map}`)).trim().slice(0, 160));
    res.joined = await waitJoins(before + 1, 300);
    note(`${map}: joined ${res.joined}; packs so far: ${packs.slice(-2).join(" | ")}`);
    if (!res.joined) { await pg.screenshot({ path: `${OUT}/${TAG}-${map}-nojoin.png` }); continue; }
    await pg.evaluate(() => { const p = document.getElementById("pause"); if (p) p.hidden = true; document.getElementById("canvas").focus(); });
    // wait for GO (state 7 = race)
    let st = -1; const tw = Date.now();
    while (Date.now() - tw < 90000) { st = await state(); if (st === 7) break; await sleep(1500); }
    res.raced = st === 7;
    note(`${map}: race state ${st}`);
    await sleep(600);
    await pg.screenshot({ path: `${OUT}/${TAG}-${map}-start.png` });
    const raceT0 = Date.now();
    let p = await pos(); note(`${map}: start pos ${JSON.stringify(p)}`);
    for (let i = 0; i < route.length && res.raced; i++) {
      const s = route[i]; const key = s.side === "l" ? "moveleft" : "moveright";
      let ok = false, tries = 0;
      while (!ok && tries < ASSIST_AFTER) {
        tries++;
        // A: line up on the ramp's lane while still on the ledge
        let tA = Date.now();
        while (Date.now() - tA < 6000) {
          p = await pos(); if (!p) break;
          const dy = s.y - p.y;
          if (Math.abs(dy) < 30) break;
          await cmd(dy > 0 ? "-moveright; +moveleft" : "-moveleft; +moveright"); await sleep(60);
        }
        await cmd("-moveleft; -moveright");
        // B: walk off the edge
        await cmd("+forward"); tA = Date.now();
        while (Date.now() - tA < 6000) { p = await pos(); if (!p || p.x > s.x0 + 8) break; await sleep(40); }
        await cmd(`-forward; +${key}`);
        // C: surf (hold toward the ramp) until on the landing platform, or back at the start (fell)
        tA = Date.now(); let fell = false, best = -1e9;
        while (Date.now() - tA < 15000) {
          p = await pos(); if (!p) { await sleep(100); continue; }
          best = Math.max(best, p.x);
          if (p.x > s.px0 + 20 && p.ground) { ok = true; break; }
          if (p.x < s.x0 - 40 && best > s.x0 + 40) { fell = true; break; }   // teleported back to the stage start
          await sleep(50);
        }
        await release();
        note(`${map}: stage ${i + 1} try ${tries}: ${ok ? "landed" : fell ? "fell" : "timeout"} (furthest x ${best}, now ${p && `${p.x} ${p.y} ${p.z}`})`);
        if (!ok && !fell) { await rcon(`t_tp ${Math.round((s.x0 - 200))} ${Math.round(route[i].y)} ${Math.round(s.pz + 2000)} 0 0`); }   // stuck: never happens on a sane map
        await sleep(400);
      }
      res.stageTries.push(tries);
      if (!ok) {
        res.assisted.push(i + 1);
        await rcon(`t_tp ${Math.round(s.px0 + 80)} ${Math.round((route[i + 1] || s).y)} ${Math.round(s.pz + 40)} 0 0`);
        note(`${map}: stage ${i + 1} ASSISTED (t_tp to its landing platform)`);
        await sleep(500);
        if (i === route.length - 1) { await cmd("+forward"); await sleep(400); await cmd("-forward"); }
      }
    }
    // the finish: the plugin's banner/announce ("<name> finishes in N s")
    await sleep(700);
    await pg.screenshot({ path: `${OUT}/${TAG}-${map}-finish.png` });
    res.time = (Date.now() - raceT0) / 1000;
    // back to the board: the plugin changelevels ~5 s after the winner
    let back = false; const tb = Date.now();
    while (Date.now() - tb < 60000) { st = await state(); if (st !== 7 && st !== 6) { back = true; break; } await sleep(2000); }
    res.finished = back;   // confirmed against the server log ("finishes in") by the caller
    note(`${map}: race over -> state ${st}; ${JSON.stringify(res)}`);
    await waitJoins(joins() + 1, 240);
    await sleep(12000);
  }
  fs.writeFileSync(`${OUT}/${TAG}-results.json`, JSON.stringify({ results, packs }, null, 1));
  note("packs: " + packs.join(" | "));
  await browser.close();
  process.exit(0);
})();
