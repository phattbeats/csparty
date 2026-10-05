// ISSUE: every Climb pool map, with two browser clients in one party: a desktop page (keyboard) and a phone
// page (touch layout, taps the on-screen Use button). Per map: csp_test_remote 10 ffa <map>, both clients load the
// map pack and the map, then each is put in front of the map's stop-timer button (test plugin csp_kz_goto) and
// presses +use; the race must record the finish. Runs in the Playwright image on game-host against the isolated
// csp3981 stack. env: RELAY, KEY, RCON_PORT, RPW, MAPS (space separated). Writes /work/out.
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8100";
const URL = `${RELAY}/?key=${encodeURIComponent(process.env.KEY || "")}&nosound=1&dev=1`;
const RPORT = +(process.env.RCON_PORT || 27060);
if (RPORT === 27016) throw new Error("refusing the live server port");
const MAPS = (process.env.MAPS || "").split(/\s+/).filter(Boolean);
const OUT = "/work/out"; fs.mkdirSync(OUT, { recursive: true });
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

async function client(browser, who, phone) {
  const ctx = phone
    ? await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36" })
    : await browser.newContext({ viewport: { width: 640, height: 400 } });
  const pg = await ctx.newPage();
  const c = { who, phone, pg, states: [], maps: [], finishes: [], packs: [], cdp: phone ? await ctx.newCDPSession(pg) : null };
  pg.on("console", (m) => {
    const t = m.text();
    const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) c.states.push(+s[2]);
    const mp = /CSP_MAP_([\w.\-]+)/.exec(t); if (mp) c.maps.push(mp[1]);
    for (const f of t.matchAll(/(\w+) finishes in ([\d.]+) s/g)) if (!c.finishes.includes(`${f[1]} ${f[2]}`)) c.finishes.push(`${f[1]} ${f[2]}`);
    if (/finishes in|wins the|Time!|Host_Error|Sys_Error|can't find|not found|mappack|PAGEERROR|couldn't load "maps/i.test(t)) note(`${who} console: ${t.slice(0, 200)}`);
  });
  pg.on("pageerror", (e) => note(`${who} PAGEERROR: ${e.message}`));
  pg.on("crash", => note(`${who} PAGE CRASHED`));
  pg.on("response", (r) => { if (r.url().includes("mappacks/")) c.packs.push(`${r.url().split("/").pop().split("?")[0]} ${r.status()} ${r.headers()["content-length"] || "?"}`); });
  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note(`${who} renderer: ` + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  await pg.fill("#name", who); await pg.click("#go");
  return c;
}

const joins = (c) => c.states.filter((s) => s === 4).length;
async function waitAll(cs, target, secs) {
  const t = Date.now();
  while (Date.now() - t < secs * 1000) { if (cs.every((c, i) => joins(c) >= target[i])) return true; await sleep(500); }
  return false;
}

async function pressUse(c) {
  if (c.phone) {
    // the touch layout's "use" button: x 0.78-0.88, y 0.77-0.99 of the screen
    const pt = [{ x: 0.83 * 844, y: 0.88 * 390, id: 1 }];
    await c.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
    await sleep(1500);   // a slow phone frame can miss a short tap
    await c.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await c.pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
    await c.pg.keyboard.down("e"); await sleep(400); await c.pg.keyboard.up("e");
  }
}

const shot = (c, name) => c.pg.screenshot({ path: `${OUT}/${name}-${c.who}.png` }).catch((e) => note(`${c.who} screenshot failed ${e.message}`));

(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const results = [];
  for (const map of MAPS) {
    const r = { map };
    // SPOTS="map:desk:phone ..." picks other free spots in front of the stop button for a map (default 0 and 2)
    const sp = (process.env.SPOTS || "").split(/\s+/).map((x) => x.split(":")).find((x) => x[0] === map);
    const spots = sp ? [sp[1], sp[2]] : [0, 2];
    const desk = await client(browser, "Desk", false);
    const phone = await client(browser, "Phone", true);
    const cs = [desk, phone];
    note("both on the board: " + await waitAll(cs, [1, 1], 300));
    await sleep(10000);
    const before = cs.map(joins);
    for (const c of cs) { c.finishes.length = 0; c.packs.length = 0; }
    note(`== ${map}: ${(await rcon(`csp_test_remote 10 ffa ${map}`)).trim() || "(ok)"}`);
    r.loaded = await waitAll(cs, before.map((b) => b + 1), 240);
    note(`  both clients in ${map}: ${r.loaded}`);
    for (const c of cs) {
      r[`${c.who}_bsp`] = await c.pg.evaluate((m) => { try { return __csp.FS.stat(`/xash/cstrike/maps/${m}.bsp`).size; } catch (e) { return String(e); } }, map);
      r[`${c.who}_pack`] = c.packs.join(",");
    }
    await sleep(14000);   // seats rebind, round restart, 3-2-1 countdown
    for (const c of cs) await shot(c, `${map}-start`);
    // PRESS_DELAY=<s>: wait before pressing, to see that bots don't finish early (the map's bottime window)
    if (+process.env.PRESS_DELAY) { await sleep(+process.env.PRESS_DELAY * 1000); note(`  after ${process.env.PRESS_DELAY} s: finishes ${desk.finishes.join(";") || "none"}`); }
    for (let i = 0; i < 8 && !(desk.finishes.some((x) => x.startsWith("Desk")) && desk.finishes.some((x) => x.startsWith("Phone"))); i++) {
      // both at once: the race ends 5 s after the first finish
      const g1 = (await rcon(`csp_kz_goto Desk ${spots[0]}`)).trim(), g2 = (await rcon(`csp_kz_goto Phone ${spots[1]}`)).trim();
      if (i === 0) note(`  ${g1} | ${g2}`);
      await sleep(600);
      // phone first: the race ends 5 s after the first finish, and the touch press is the slower path
      if (!desk.finishes.some((x) => x.startsWith("Phone"))) await pressUse(phone);
      await sleep(800);
      if (!desk.finishes.some((x) => x.startsWith("Desk"))) await pressUse(desk);
      await sleep(1500);
      if (i === 0 || desk.finishes.length || phone.finishes.length) for (const c of cs) await shot(c, `${map}-finish`);
      if (!(desk.finishes.some((x) => x.startsWith("Desk")) && desk.finishes.some((x) => x.startsWith("Phone")))) await sleep(3000);
    }
    r.desk = desk.finishes.join(";") || "NO FINISH"; r.phone = phone.finishes.join(";") || "NO FINISH";
    note(`  finishes seen by Desk: ${r.desk}  by Phone: ${r.phone}`);
    results.push(r);
    fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
    for (const c of cs) fs.writeFileSync(`${OUT}/engine-${map}-${c.who}.log`, await c.pg.evaluate(() => { try { return __csp.FS.readFile("/xash/engine.log", { encoding: "utf8" }); } catch (e) { return String(e); } }).catch(() => ""));
    for (const c of cs) await c.pg.evaluate(() => { try { __csp._CL_Disconnect(); } catch (e) {} }).catch(() => {});
    await sleep(1500);
    await desk.pg.context().close(); await phone.pg.context().close();
    await sleep(6000);
  }
  await browser.close();
  note("done");
})().catch((e) => { note("FAILED " + e.stack); process.exit(1); });
