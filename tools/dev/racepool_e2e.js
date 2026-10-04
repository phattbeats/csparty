// ISSUE (tools/dev/racepool_e2e.js): race map pools with a browser client. One player joins the board, then:
//   1. csp_test_remote 10 ffa kz_triangles   a pool map that isn't in gamedata.zip: its map pack must arrive
//                                            (CSP_MAP_) before the engine loads it, and the race must run
//   2.. csp_test_remote 10 ffa               pool draws: never a map this match already played, until the pool is used up
// Runs in the Playwright image on game-host (GPU) against an isolated stack. env: RELAY (http://127.0.0.1:8097),
// KEY (party key), RCON_PORT (27040), RPW (rcon password). Writes /work/out.
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8097";
const URL = `${RELAY}/?key=${encodeURIComponent(process.env.KEY || "")}&nosound=1&dev=1`;
const RPORT = +(process.env.RCON_PORT || 27040);
const OUT = "/work/out"; fs.mkdirSync(OUT, { recursive: true });
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
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const pg = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const states = [], maps = [];
  pg.on("console", (m) => {
    const t = m.text(); const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
    const mp = /CSP_MAP_([\w.\-]+)/.exec(t); if (mp) maps.push(mp[1]);
    if (/watch|\[boot\]|CSP_MAP|Host_Error|Sys_Error|couldn't|can't find|not found|download|abort|Error/i.test(t)) note(`console.${m.type()}: ${t.slice(0, 300)}`);
  });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  pg.on("crash", => note("PAGE CRASHED"));
  const mapRequests = [];
  pg.on("request", (r) => { if (r.url().includes("mappacks/")) mapRequests.push(r.url().replace(/key=[^&]*/, "key=***")); });

  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note("renderer: " + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  await pg.fill("#name", "phaTT"); await pg.click("#go");
  const joins = => states.filter((s) => s === 4).length;
  const waitJoins = async (n, secs) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { if (joins() >= n) return true; await sleep(500); } return false; };
  note("joined board: " + await waitJoins(1, 240));
  await sleep(15000);

  // PRESS=<kreedz map>: race that map alone and press its stop button for the player (test-only plugin
  // tools/dev/csp_test_press.sma, srvcmd csp_press_stop): the player must win, not a bot on the clock.
  if (process.env.PRESS) {
    const before = joins();
    note(`press: csp_test_remote 10 ffa ${process.env.PRESS} -> ${(await rcon(`csp_test_remote 10 ffa ${process.env.PRESS}`)).trim()}`);
    note(`  in the race map: ${await waitJoins(before + 1, 240)}`);
    await sleep(22000);   // waiting room + countdown
    note(`  ${(await rcon("csp_press_stop")).trim()}`);
    await sleep(1500);
    await pg.evaluate(() => { document.getElementById("pause").hidden = true; });
    await pg.screenshot({ path: `${OUT}/press-finish.png` });
    note(`  back on the board: ${await waitJoins(before + 2, 120)}`);
    await browser.close(); note("done"); return;
  }
  const pool = ((await rcon("csp_test_remote pools")).match(/pool 10 Climb:([^\n]*)/) || ["", ""])[1].trim().split(/\s+/);
  note(`climb pool: ${pool.join(" ")}`);
  const runs = ["csp_test_remote 10 ffa kz_triangles", ...Array(+(process.env.DRAWS || pool.length)).fill("csp_test_remote 10 ffa")];
  const played = [];
  for (let i = 0; i < runs.length; i++) {
    const cmd = runs[i], want = i === 0 ? "kz_triangles" : null;
    const before = joins(), mapsBefore = maps.length;
    note(`run ${i + 1}: ${cmd} -> ${(await rcon(cmd)).trim() || "(ok)"}`);
    note(`  in the race map: ${await waitJoins(before + 1, 240)}  announced: ${maps.slice(mapsBefore).join(",")}`);
    const got = maps.at(-1);
    const fresh = !played.includes(got), poolLeft = pool.filter((m) => !played.includes(m)).length;
    note(`  map ${got}${want ? (got === want ? " (expected)" : ` (EXPECTED ${want})`) : fresh ? " (not played yet: ok)" : poolLeft ? " (REPEAT with unplayed maps left)" : " (repeat: pool used up, ok)"}`);
    played.push(got);
    note(`  bsp in FS: ${await pg.evaluate((m) => { try { return __csp.FS.stat(`/xash/cstrike/maps/${m}.bsp`).size; } catch (e) { return String(e); } }, got)}`);
    await sleep(12000);
    await pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
    await pg.screenshot({ path: `${OUT}/run${i + 1}-${got}-start.png` });
    await sleep(25000);
    await pg.screenshot({ path: `${OUT}/run${i + 1}-${got}-race.png` });
    note(`  back on the board: ${await waitJoins(before + 2, 200)}`);
    await sleep(8000);
    await pg.screenshot({ path: `${OUT}/run${i + 1}-board.png` });
    note(`  pools: ${(await rcon("csp_test_remote pools")).trim().split("\n").filter((l) => /Climb|played/.test(l)).join(" | ")}`);
  }
  note("map pack requests: " + JSON.stringify(mapRequests));
  fs.writeFileSync(`${OUT}/engine.log`, await pg.evaluate(() => { try { return __csp.FS.readFile("/xash/engine.log", { encoding: "utf8" }); } catch (e) { return String(e); } }));
  await pg.evaluate(() => { try { __csp._CL_Disconnect(); } catch (e) {} });
  await sleep(500);
  await browser.close();
  note("done");
})().catch((e) => { note("FAILED " + e.stack); process.exit(1); });
