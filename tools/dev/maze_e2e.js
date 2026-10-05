// ISSUE: Maze Run pool maps with a browser client, desktop or phone (VIEW). For each map in MAPS, in a fresh browser:
// join the board, csp_test_remote 11 ffa <map>, then csp_mazewalk 1 (tools/dev/csp_mazewalk.sma walks the player along
// the solution), screenshots at the start, mid-run and the finish, and the time to the finish. env: RELAY, KEY, RCON_PORT,
// RPW, MAPS, VIEW, SPEED (walker u/s, default 250; bots finish on a 30-60 s clock and the race ends 5 s after the first
// finisher, so 400 proves the route). The phone view is landscape (844x390): portrait shows only "turn your phone".
// Runs in the Playwright image on game-host (GPU) against an isolated stack; writes /work/out/<VIEW>.
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8097";
const URL = `${RELAY}/?key=${encodeURIComponent(process.env.KEY || "")}&nosound=1&dev=1`;
const RPORT = +(process.env.RCON_PORT || 27040);
const VIEW = process.env.VIEW || "desktop";
const OUT = "/work/out/" + VIEW; fs.mkdirSync(OUT, { recursive: true });
const log = fs.createWriteStream(`${OUT}/browser.log`, { flags: "a" });
const t0 = Date.now();
const note = (s) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}] ${s}`; log.write(l + "\n"); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"); const H = Buffer.from([255, 255, 255, 255]);
    const done = (v) => { try { s.close(); } catch {} ok(v); };
    setTimeout(() => done("timeout"), 4000);
    s.on("message", (m) => {
      const t = m.slice(4).toString();
      const c = /challenge rcon (\d+)/.exec(t);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${process.env.RPW}" ${cmd}\n`)]), RPORT, "127.0.0.1");
      else done(t.replace(/^l/, ""));
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), RPORT, "127.0.0.1");
  });
}

// A screenshot that can't hang the run: the engine's main thread blocks document.fonts now and then.
const shot = async (pg, path) => { try { await pg.screenshot({ path, timeout: 20000 }); } catch (e) { note(`  screenshot ${path.split("/").pop()} failed: ${e.message.split("\n")[0]}`); } };

async function runMap(map) {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const ctxOpts = VIEW === "phone"
    ? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
        userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" }
    : { viewport: { width: 640, height: 400 } };
  const result = { map, inMap: false, bsp: null, done: false, secs: 0, back: false };
  try {
    const ctx = await browser.newContext(ctxOpts);
    const pg = await ctx.newPage();
    const states = [], announced = [], packs = [];
    pg.on("console", (m) => {
      const t = m.text(); const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
      const mp = /CSP_MAP_([\w.\-]+)/.exec(t); if (mp) announced.push(mp[1]);
      if (/Host_Error|Sys_Error|can't find|not found|abort|Error/i.test(t) && !/room_type|logos\/remapped|_sky|Audio subsystem|VoiceCapture|overviews\//.test(t)) note(`console.${m.type()}: ${t.slice(0, 300)}`);
    });
    pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
    pg.on("crash", => note("PAGE CRASHED"));
    pg.on("response", (r) => { if (r.url().includes("mappacks/")) packs.push(`${r.status()} ${r.url().replace(/key=[^&]*/, "key=***").split("/").pop()}`); });
    await pg.goto(URL, { waitUntil: "domcontentloaded" });
    note(`== ${map} (${VIEW}); renderer: ` + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
    if (VIEW === "phone") note("  touch UI: " + await pg.evaluate(() => matchMedia("(pointer: coarse)").matches + " coarse, " + ("ontouchstart" in window) + " ontouchstart, landscape " + matchMedia("(orientation: landscape)").matches));
    await pg.fill("#name", "phaTT"); await pg.click("#go");
    const joins = => states.filter((s) => s === 4).length;
    const waitJoins = async (n, secs) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { if (joins() >= n) return true; await sleep(500); } return false; };
    note("  joined board: " + await waitJoins(1, 240));
    await sleep(12000);
    const before = joins(), a0 = announced.length;
    note(`  csp_test_remote: ${(await rcon("csp_test_remote 11 ffa " + map)).trim() || "(ok)"}`);
    result.inMap = await waitJoins(before + 1, 240);
    note(`  in the race map: ${result.inMap}; announced ${announced.slice(a0).join(",")}; packs ${JSON.stringify(packs.slice(-2))}`);
    result.bsp = await pg.evaluate((m) => { try { return __csp.FS.stat(`/xash/cstrike/maps/${m}.bsp`).size; } catch (e) { return String(e); } }, map);
    note(`  bsp in the browser FS: ${result.bsp}`);
    await sleep(14000);
    await pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
    await shot(pg, `${OUT}/${map}-1start.png`);
    await rcon("csp_mazewalk_speed " + (process.env.SPEED || 250)); await rcon("csp_mazewalk 1"); const t1 = Date.now(); let shots = 0;
    while (Date.now() - t1 < 160000) {
      await sleep(2000);
      const r = await rcon("csp_mazewalk"); if (/is "0"/.test(r)) { result.done = true; break; }
      if ((Date.now() - t1) / 1000 > 10 + shots * 12) { shots++; await shot(pg, `${OUT}/${map}-2run${shots}.png`); }
    }
    result.secs = +((Date.now() - t1) / 1000).toFixed(1);
    await sleep(1500);
    await shot(pg, `${OUT}/${map}-3finish.png`);
    note(`  walker reached the finish: ${result.done} in ${result.secs} s`);
    await sleep(6000);
    await shot(pg, `${OUT}/${map}-4after.png`);
    result.back = await waitJoins(before + 2, 200);
    note(`  back on the board: ${result.back}`);
    await sleep(5000);
    await pg.evaluate(() => { try { __csp._CL_Disconnect(); } catch (e) {} }).catch(() => {});
    await sleep(500);
  } catch (e) {
    note(`  FAILED ${map}: ${e.stack.split("\n").slice(0, 3).join(" | ")}`);
    result.error = e.message.split("\n")[0];
  }
  await browser.close().catch(() => {});
  await rcon("csp_mazewalk 0");
  return result;
}

(async => {
  const maps = (process.env.MAPS || "").split(",").filter(Boolean);
  const results = [];
  for (const map of maps) {
    let r = await runMap(map);
    if (!(r.inMap && r.done)) { note(`  retrying ${map} once`); await sleep(20000); r = await runMap(map); r.retried = true; }
    results.push(r);
    await sleep(10000);
  }
  note("RESULTS " + JSON.stringify(results));
  note("done");
  process.exit(results.every((r) => r.inMap && r.done) ? 0 : 1);
})().catch((e) => { note("FAILED " + e.stack); process.exit(1); });
