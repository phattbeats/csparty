// #3984 (tools/dev/tips_e2e.js): loading-screen tips and in-game HUD tips, desktop or phone viewport.
// Runs in the Playwright image on game-host (GPU) against the isolated stack. Env: PORT (relay), GPORT (game), RPW, KEY, PHONE=1, SECS.
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");
const PORT = process.env.PORT || 8111, GPORT = +process.env.GPORT || 27091, RPW = process.env.RPW || "csp3984", KEY = process.env.KEY || "t3984";
const PHONE = !!process.env.PHONE, OUT = `/work/out${PHONE ? "-phone" : ""}`; fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${s}`);
function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"), H = Buffer.from([255, 255, 255, 255]);
    const done = (v) => { try { s.close(); } catch {} ok(v); };
    setTimeout(() => done("timeout"), 4000);
    s.on("message", (m) => { const t = m.slice(4).toString(); const c = /challenge rcon (\d+)/.exec(t);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${RPW}" ${cmd}\n`)]), GPORT, "127.0.0.1"); else done(t); });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), GPORT, "127.0.0.1");
  });
}
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext(PHONE ? { viewport: { width: 740, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: { width: 960, height: 600 } });
  const pg = await ctx.newPage(); const states = [];
  pg.on("console", (m) => { const s = /\[watch\] state (-?\d) -> (\d)/.exec(m.text()); if (s) { states.push(+s[2]); note("state " + s[2]); } });
  pg.on("pageerror", (e) => note("PAGEERROR " + e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/?key=${KEY}&nosound=1&dev=1`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  note("boot tip: " + JSON.stringify(await pg.evaluate(() => { const e = document.getElementById("boot-tip"); return { hidden: e.hidden, text: e.textContent }; })));
  await pg.screenshot({ path: `${OUT}/boot-0.png` });
  await sleep(7500);
  note("boot tip 2: " + await pg.evaluate(() => document.getElementById("boot-tip").textContent));
  await pg.screenshot({ path: `${OUT}/boot-1.png` });
  note("form: " + JSON.stringify(await pg.evaluate(() => { const n = document.getElementById("name"), g = document.getElementById("go"); return { name: !!n, nameDis: n && n.disabled, go: !!g, goDis: g && g.disabled, url: location.href }; })));
  await pg.evaluate(() => { document.getElementById("name").value = "tipper"; document.getElementById("form").requestSubmit(); });
  const t1 = Date.now(); let shot = 0, sawLoading = false;
  while (!states.includes(4) && Date.now() - t1 < 240000) {
    if (await pg.evaluate(() => !document.getElementById("loading").hidden)) { sawLoading = true; if (shot++ < 2) await pg.screenshot({ path: `${OUT}/loading-${shot}.png` }); note("loading tip: " + await pg.evaluate(() => document.getElementById("loading-tip").textContent)); }
    await sleep(1500);
  }
  note("in game: " + states.includes(4) + ", saw loading screen: " + sawLoading);
  await sleep(8000);
  await pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
  note("start: " + (await rcon("csp_start")).trim().slice(0, 80));
  const secs = +process.env.SECS || 150;
  for (let i = 0, t = Date.now(); Date.now() - t < secs * 1000; i++) {
    await sleep(4000);
    await pg.screenshot({ path: `${OUT}/g-${String(i).padStart(2, "0")}.png` });
    if (i % 5 === 4) { await pg.keyboard.down("Space"); await sleep(200); await pg.keyboard.up("Space"); }   // jump = pick the menu line / roll
  }
  // map change: the loading screen with the tip next to a how-to card
  note("remote: " + (await rcon("csp_test_remote 8 1v3")).trim().slice(0, 80));
  for (let i = 0; i < 40; i++) {
    if (await pg.evaluate(() => !document.getElementById("loading").hidden)) { await pg.screenshot({ path: `${OUT}/maploading-${i}.png` }); note("map loading tip: " + await pg.evaluate(() => document.getElementById("loading-tip").textContent + " | howto: " + document.getElementById("loading-howto").textContent.slice(0, 20))); if (i > 3) break; }
    await sleep(1000);
  }
  await browser.close(); note("done");
})();
