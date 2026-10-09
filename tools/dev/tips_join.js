// #3984 (tools/dev/tips_join.js): the tip on the boot card and in the "Joining the party" card, desktop or phone.
// Env: PORT (relay), KEY, PHONE=1. Writes /work/join[-phone]/*.png and prints the tip text at each step.
const { chromium } = require("playwright");
const fs = require("fs");
const PORT = process.env.PORT || 8111, KEY = process.env.KEY || "t3984", PHONE = !!process.env.PHONE;
const OUT = `/work/join${PHONE ? "-phone" : ""}`; fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${s}`);
(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext(PHONE ? { viewport: { width: 740, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: { width: 960, height: 600 } });
  const pg = await ctx.newPage(); const states = [];
  pg.on("console", (m) => { const s = /\[watch\] state (-?\d) -> (\d)/.exec(m.text()); if (s) { states.push(+s[2]); note("state " + s[2]); } });
  pg.on("pageerror", (e) => note("PAGEERROR " + e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/?key=${KEY}&nosound=1&dev=1`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  const tipOf = (id) => pg.evaluate((id) => { const e = document.getElementById(id); return e.hidden ? "(hidden)" : e.textContent; }, id);
  note("boot tip: " + await tipOf("boot-tip"));
  await pg.evaluate(() => document.getElementById("boot-tip").scrollIntoView({ block: "center" }));
  await pg.screenshot({ path: `${OUT}/boot.png` });
  await pg.evaluate(() => { document.getElementById("name").value = "tipper2"; document.getElementById("form").requestSubmit(); });
  const t1 = Date.now(); let shots = 0;
  while (!states.includes(4) && Date.now() - t1 < 180000) {
    const ov = await pg.evaluate(() => !document.getElementById("overlay").hidden), ld = await pg.evaluate(() => !document.getElementById("loading").hidden);
    if (ld) { note(`overlay=${ov} ov-tip: ${await tipOf("ov-tip")} | loading-tip: ${await tipOf("loading-tip")}`); if (shots++ < 3) await pg.screenshot({ path: `${OUT}/join-${shots}.png` }); }
    await sleep(2500);
  }
  note("in game: " + states.includes(4) + " ov-tip after join: " + await tipOf("ov-tip") + " overlay hidden: " + await pg.evaluate(() => document.getElementById("overlay").hidden));
  await browser.close(); note("done");
})();
