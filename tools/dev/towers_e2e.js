// ISSUE (tools/dev/towers_e2e.js): browser client on csp_towers with the AWP, then the leave guard and a mid-fight drop.
// Runs in the Playwright image on game-host (GPU), against the isolated test stack (relay :8096, server :27030).
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const URL = "http://127.0.0.1:8096/?key=t3929&nosound=1&dev=1";
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
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "csp3929" ${cmd}\n`)]), 27030, "127.0.0.1");
      else done(t);
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), 27030, "127.0.0.1");
  });
}

(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const pg = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const states = [];
  pg.on("console", (m) => { const t = m.text(); const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
    if (/watch|boot|error|Error|vertex|buffer|GL_|WebGL|Host_Error|Sys_Error|abort|assert/i.test(t)) note(`console.${m.type()}: ${t.slice(0, 300)}`); });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  pg.on("crash", => note("PAGE CRASHED"));
  pg.on("close", => note("page closed"));
  let dialogMode = "dismiss";
  pg.on("dialog", async (d) => { note(`DIALOG ${d.type()}: ${d.message()}`); dialogMode === "accept" ? await d.accept() : await d.dismiss(); });

  await pg.goto(URL);
  note("renderer: " + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  await pg.fill("#name", "phaTT"); await pg.click("#go");
  const waitState4 = async (n, secs) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { if (states.filter((s) => s === 4).length >= n) return true; await sleep(500); } return false; };
  note("joined board: " + await waitState4(1, 240));
  await sleep(20000);
  note("rcon: " + (await rcon("csp_test_remote 12 1v3")).trim());
  note("in csp_towers: " + await waitState4(2, 240));
  await sleep(15000);   // harness rule: leave the page alone right after a map load
  await pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
  await pg.screenshot({ path: `${OUT}/towers-0.png` });

  // AWP: scope in and out, look around the open map, fire, duck-walk. Console commands go in through the engine.
  const cmd = (c) => pg.evaluate((c) => { const e = window.__csp; const p = e.stringToNewUTF8(c + "\n"); e._Cbuf_AddText(p); e._free(p); }, c);
  for (let i = 0; i < (+process.env.LOOPS || 12); i++) {
    await cmd("slot1"); await sleep(400);
    await pg.mouse.down({ button: "right" }); await sleep(80); await pg.mouse.up({ button: "right" });   // zoom 1
    await sleep(700); await cmd("cl_yawspeed 120; +right"); await sleep(900); await cmd("-right");
    await pg.mouse.down({ button: "right" }); await sleep(80); await pg.mouse.up({ button: "right" });   // zoom 2
    await sleep(500); await cmd("+lookup"); await sleep(300); await cmd("-lookup; +attack"); await sleep(100); await cmd("-attack");
    await sleep(800); await cmd("+duck; +forward"); await sleep(700); await cmd("-forward; -duck; +lookdown"); await sleep(300); await cmd("-lookdown");
    if (i % 4 === 3) await pg.screenshot({ path: `${OUT}/towers-${i}.png` });
    if (states.at(-1) !== 4) { note(`state left 4: ${states.at(-1)}`); break; }
  }
  note("AWP phase done, page alive: " + !pg.isClosed());
  if (!pg.isClosed()) fs.writeFileSync(`${OUT}/engine.log`, await pg.evaluate(() => { try { return __csp.FS.readFile("/xash/engine.log", { encoding: "utf8" }); } catch (e) { return String(e); } }));

  // Leave guard: a close with beforeunload must ask; dismissing keeps the page (and the game).
  // (Playwright's page.close never shows the beforeunload dialog, even on a bare page; a reload does, like Ctrl+W in a real tab.)
  dialogMode = "dismiss";
  note("activation: " + JSON.stringify(await pg.evaluate(() => ({ was: navigator.userActivation?.hasBeenActive, state: document.visibilityState }))));
  await pg.evaluate(() => { setTimeout(() => location.reload(), 10); }); await sleep(4000);
  note(`after dismissed reload: page alive ${!pg.isClosed()}, engine state ${states.at(-1)}, joined screen hidden ${await pg.evaluate(() => document.getElementById("gate").hidden)}`);
  // Now really leave mid-fight: the server should hand the seat to a stand-in bot and keep fighting.
  await rcon("csp_debug 2");
  await pg.evaluate(() => { try { __csp._CL_Disconnect(); } catch (e) {} });   // what pagehide does
  await sleep(300); await pg.close(); await sleep(15000);
  note("closed the page");
  await browser.close();
  note("done");
})().catch((e) => { note("SCRIPT ERROR " + e.stack); process.exit(1); });
