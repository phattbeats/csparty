// ISSUE: Maze Run pool maps with a browser client, desktop or phone (VIEW). For each map in MAPS:
// csp_test_remote 11 ffa <map>, then csp_mazewalk 1 (tools/dev/csp_mazewalk.sma walks the player along the solution),
// screenshots at the start, mid-run and the finish, and the time to the finish. env: RELAY, KEY, RCON_PORT, RPW, MAPS, VIEW.
// Runs in the Playwright image on game-host (GPU) against an isolated stack; writes /work/out/<VIEW>.
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8097";
const URL = `${RELAY}/?key=${encodeURIComponent(process.env.KEY || "")}&nosound=1&dev=1`;
const RPORT = +(process.env.RCON_PORT || 27040);
const VIEW = process.env.VIEW || "desktop";
const OUT = "/work/out/" + VIEW; fs.mkdirSync(OUT, { recursive: true });
const log = fs.createWriteStream(`${OUT}/browser.log`);
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

(async => {
  const maps = (process.env.MAPS || "").split(",").filter(Boolean);
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const ctxOpts = VIEW === "phone"
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
        userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" }
    : { viewport: { width: 640, height: 400 } };
  const ctx = await browser.newContext(ctxOpts);
  const pg = await ctx.newPage();
  const states = [], announced = [];
  pg.on("console", (m) => {
    const t = m.text(); const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
    const mp = /CSP_MAP_([\w.\-]+)/.exec(t); if (mp) announced.push(mp[1]);
    if (/Host_Error|Sys_Error|couldn't|can't find|not found|abort|Error/i.test(t)) note(`console.${m.type()}: ${t.slice(0, 300)}`);
  });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  pg.on("crash", => note("PAGE CRASHED"));
  const packs = [];
  pg.on("response", (r) => { if (r.url().includes("mappacks/")) packs.push(`${r.status()} ${r.url().replace(/key=[^&]*/, "key=***").split("/").pop()}`); });
  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note(`view ${VIEW}; renderer: ` + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  if (VIEW === "phone") note("touch UI: " + await pg.evaluate(() => matchMedia("(pointer: coarse)").matches + " coarse, " + ("ontouchstart" in window) + " ontouchstart"));
  await pg.fill("#name", "phaTT"); await pg.click("#go");
  const joins = => states.filter((s) => s === 4).length;
  const waitJoins = async (n, secs) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { if (joins() >= n) return true; await sleep(500); } return false; };
  note("joined board: " + await waitJoins(1, 240));
  await sleep(15000);
  const results = [];
  for (const map of maps) {
    const before = joins(), a0 = announced.length;
    note(`== ${map}: ${(await rcon("csp_test_remote 11 ffa " + map)).trim() || "(ok)"}`);
    const inMap = await waitJoins(before + 1, 240);
    note(`  in the race map: ${inMap}; announced ${announced.slice(a0).join(",")}; packs ${JSON.stringify(packs.slice(-2))}`);
    const bsp = await pg.evaluate((m) => { try { return __csp.FS.stat(`/xash/cstrike/maps/${m}.bsp`).size; } catch (e) { return String(e); } }, map);
    note(`  bsp in the browser FS: ${bsp}`);
    await sleep(14000);
    await pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
    await pg.screenshot({ path: `${OUT}/${map}-1start.png` });
    await rcon("csp_mazewalk 1"); const t1 = Date.now(); let done = false, shots = 0;
    while (Date.now() - t1 < 160000) {
      await sleep(2000);
      const r = await rcon("csp_mazewalk"); if (/is "0"/.test(r)) { done = true; break; }
      if ((Date.now() - t1) / 1000 > 12 + shots * 14) { shots++; await pg.screenshot({ path: `${OUT}/${map}-2run${shots}.png` }); }
    }
    const secs = (Date.now() - t1) / 1000;
    await sleep(1200);
    await pg.screenshot({ path: `${OUT}/${map}-3finish.png` });
    note(`  walker reached the finish: ${done} in ${secs.toFixed(1)} s`);
    results.push({ map, inMap, bsp, done, secs });
    await sleep(6000);
    await pg.screenshot({ path: `${OUT}/${map}-4after.png` });
    note(`  back on the board: ${await waitJoins(before + 2, 200)}`);
    await sleep(8000);
  }
  note("RESULTS " + JSON.stringify(results));
  await pg.evaluate(() => { try { __csp._CL_Disconnect(); } catch (e) {} });
  await sleep(500);
  await browser.close();
  note("done");
})().catch((e) => { note("FAILED " + e.stack); process.exit(1); });
