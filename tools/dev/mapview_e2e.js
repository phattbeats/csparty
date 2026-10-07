// #3924 (tools/dev/mapview_e2e.js): one browser player on the board, map overlay on, screenshots.
// Runs in the Playwright image on game-host (GPU), against the isolated test stack (relay :8096, server :27030).
// env: KEY (relay PARTY_KEY), RPW (rcon password), TAG (screenshot prefix), MOVES (turns to fast-forward before the map)
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const URL = `http://127.0.0.1:8096/?key=${process.env.KEY}&nosound=1&dev=1`;
const OUT = "/work/out"; fs.mkdirSync(OUT, { recursive: true });
const TAG = process.env.TAG || "map";
const t0 = Date.now();
const note = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"); const H = Buffer.from([255, 255, 255, 255]);
    let out = "", timer;
    const done = => { try { s.close(); } catch {} ok(out || "timeout"); };
    timer = setTimeout(done, 4000);
    s.on("message", (m) => {
      const t = m.slice(4).toString();
      const c = /challenge rcon (\d+)/.exec(t);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${process.env.RPW}" ${cmd}\n`)]), 27030, "127.0.0.1");
      else { out += t.replace(/^l/, ""); clearTimeout(timer); timer = setTimeout(done, 600); }
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), 27030, "127.0.0.1");
  });
}

(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const pg = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const states = [];
  pg.on("console", (m) => { const t = m.text(); const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
    if (/Host_Error|Sys_Error|abort|csp_space|csp_face|couldn't|not found/i.test(t)) note(`console: ${t.slice(0, 200)}`); });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note("renderer: " + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  await pg.fill("#name", "phaTT"); await pg.click("#go");
  const t = Date.now(); while (!states.includes(4) && Date.now() - t < 300000) await sleep(500);
  note("in game: " + states.includes(4));
  await sleep(15000);
  note((await rcon("csp_speed 0.2; csp_turn_timeout 1; csp_start")).trim());
  const board = async => { let st = ""; for (let i = 0; i < 90; i++) { st = await rcon("csp_state"); if (/state=1 turn=[1-9]/.test(st)) break; await sleep(2000); } note("state: " + st.split("\n")[0]); };
  await sleep(12000); await board();
  await pg.evaluate(() => { const p = document.getElementById("pause"); if (p) p.hidden = true; });
  for (let k = 0; k < (+process.env.SHOTS || 3); k++) {
    if (k) await board();
    note((await rcon("csp_mapview")).trim());
    await sleep(2500);
    await pg.screenshot({ path: `${OUT}/${TAG}-${k}-on.png` });
    note((await rcon("csp_mapview")).trim());   // off again: the turns carry on
    await sleep(+process.env.GAP || 25000);
  }
  await browser.close();
  note("done");
})().catch((e) => { note("FAIL " + e.stack); process.exit(1); });
