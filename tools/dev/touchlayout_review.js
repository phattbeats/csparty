// PHA-4121 follow-up (tools/dev/touchlayout_review.js): what the phone screen looks like with the menu pad up, at several
// phone sizes, so overlaps with the HUD, the engine's own touch buttons and the page buttons can be reviewed by eye.
// One landscape touch player on the ISOLATED test stack (relay :8221, server :27121), never the live one.
// env: KEY, RPW, RELAY, RPORT, OUT (/work/out), SIZES ("667x375,740x360,844x390,932x430")
// Writes <state>-<w>x<h>.png plus layout.json (page element boxes per state and size).
const { chromium, devices } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8221", RPORT = +(process.env.RPORT || 27121), OUT = process.env.OUT || "/work/out";
const SIZES = (process.env.SIZES || "667x375,740x360,844x390,932x430").split(",").map((s) => s.split("x").map(Number));
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const note = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"); const H = Buffer.from([255, 255, 255, 255]);
    let out = "", timer;
    const done = () => { try { s.close(); } catch {} ok(out || "timeout"); };
    timer = setTimeout(done, 4000);
    s.on("message", (m) => {
      const t = m.slice(4).toString();
      const c = /challenge rcon (\d+)/.exec(t);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${process.env.RPW}" ${cmd}\n`)]), RPORT, "127.0.0.1");
      else { out += t.replace(/^l/, ""); clearTimeout(timer); timer = setTimeout(done, 600); }
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), RPORT, "127.0.0.1");
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const [W0, H0] = SIZES.find(([w]) => w === 844) || SIZES[0];
  const ctx = await browser.newContext({ viewport: { width: W0, height: H0 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: devices["Pixel 7"].userAgent });
  const pg = await ctx.newPage();
  const cdp = await ctx.newCDPSession(pg);
  pg.on("pageerror", (e) => note("PAGE ERROR " + e.message));
  await pg.addInitScript(() => { try { localStorage.setItem("csp_primer", "1"); } catch {} });
  await pg.goto(`${RELAY}/?key=${process.env.KEY}&nosound=1`, { waitUntil: "domcontentloaded" });
  await pg.fill("#name", "phaTT"); await pg.click("#go");
  for (let i = 0; i < 400; i++) { if (await pg.evaluate(() => !!window.__csp && !document.getElementById("gate").offsetParent)) break; await sleep(500); }
  note("joined");
  await sleep(25000);
  const rc = async (...c) => { for (const x of c) await rcon(x); };
  await rc("sv_timeout 900", "csp_turn_timeout 0", "csp_speed 0.5");
  if (!/state=1/.test(await rcon("csp_state"))) await rcon("csp_start");

  const layout = {};
  const boxes = () => pg.evaluate(() => {
    const r = (e) => { if (!e || e.hidden || !e.offsetParent && getComputedStyle(e).position !== "fixed") return null; const b = e.getBoundingClientRect(); return b.width ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] : null; };
    const btns = [...document.querySelectorAll("#navpad button")].filter((b) => !b.hidden && !document.getElementById("navpad").hidden);
    return { vw: innerWidth, vh: innerHeight, pad: document.getElementById("navpad").hidden ? null : r(document.getElementById("nav-box")), menu: r(document.getElementById("pz-open")), fs: r(document.getElementById("fs")),
      rows: [...document.querySelectorAll("#nav-rows button")].map((b) => (b.disabled ? "(dim)" : "") + b.textContent),
      small: btns.filter((b) => !b.disabled).map((b) => b.getBoundingClientRect()).filter((b) => b.width < 44 || b.height < 44).length,
      scroll: document.getElementById("nav-box").scrollHeight > document.getElementById("nav-box").clientHeight + 1 };
  });
  const size = async (w, h) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } }); await sleep(4500); };
  const capture = async (state) => {
    for (const [w, h] of SIZES) {
      await size(w, h);
      const name = `${state}-${w}x${h}`;
      layout[name] = await boxes();
      try { await pg.screenshot({ path: `${OUT}/${name}.png`, timeout: 20000 }); note(`shot ${name} pad=${JSON.stringify(layout[name].pad)}`); } catch { note(`shot ${name} FAILED`); }
    }
    await size(W0, H0);
    fs.writeFileSync(`${OUT}/layout.json`, JSON.stringify(layout, null, 1));
  };
  const padRows = () => pg.evaluate(() => document.getElementById("navpad").hidden ? [] : [...document.querySelectorAll("#nav-rows button")].map((b) => { const r = b.getBoundingClientRect(); return { label: b.querySelector("span").textContent, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
  const ctlBtn = (act) => pg.evaluate((a) => { const b = document.querySelector(`#nav-ctl [data-act="${a}"]`); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, act);
  const waitRows = async (re, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = await padRows(); if (r.some((x) => re.test(x.label))) return r; await sleep(300); } note("timeout waiting for " + re); return padRows(); };
  const tap = async (p) => { if (!p) return; await sleep(600); await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }] }); await sleep(60); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };

  await sleep(4000);
  await capture("a-board-idle");
  await waitRows(/Open a case/, 180000);
  await rc("csp_give 0 0", "csp_give 0 1", "csp_give 0 4", "csp_stuff phaTT say /menu");
  let rows = await waitRows(/Use Knife Out/, 15000);
  await capture("b-turn-menu");
  await tap(rows.find((r) => /Buy gear/.test(r.label)));
  rows = await waitRows(/Handgun/);
  await capture("c-buy-menu");
  await tap(rows.find((r) => /Rifle/.test(r.label)));
  await sleep(2500);
  await capture("d-rifles");
  await tap(await ctlBtn("back"));
  rows = await waitRows(/Handgun/);
  await tap(await ctlBtn("back"));
  rows = await waitRows(/Use Knife Out/);
  await tap(rows.find((r) => /Use Knife Out/.test(r.label)));
  await sleep(2500);
  await capture("e-target-menu");
  await tap(await ctlBtn("back"));
  await sleep(2000);
  await pg.evaluate(() => document.getElementById("pz-open").click());
  await sleep(1500);
  await capture("f-esc-menu");
  await pg.evaluate(() => document.getElementById("pz-resume").click());
  note("done");
  await browser.close();
})();
