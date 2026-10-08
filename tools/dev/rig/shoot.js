// ISSUE: long-lived browser player on the isolated test stack, driven through a command file.
// Append lines to /work/cmd.txt; each is run once, in order:
//   rcon <cmd> | shot <name> | wait <ms> | key <k> | down <k> | up <k> | type <text> | eval <js>
//   frames <on|off> [everyMs]   (CDP screencast -> /work/out/frames/<t>.jpg)
//   reload | quit
// env: KEY, RPW, RPORT, RELAY, NAME, CHAR, PHONE=1, VW, VH
const { chromium, devices } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const OUT = "/work/out"; fs.mkdirSync(OUT + "/frames", { recursive: true });
const CMD = "/work/cmd.txt";
const RPORT = +(process.env.RPORT || 27047);
const URL = `${process.env.RELAY || "http://127.0.0.1:8147"}/?key=${process.env.KEY}&nosound=1${process.env.EXTRA || ""}`;
const t0 = Date.now();
const note = (s) => { const l = `[${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 1000).toFixed(0)}] ${s}`; console.log(l); fs.appendFileSync("/work/log.txt", l + "\n"); };
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
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${process.env.RPW}" ${cmd}\n`)]), RPORT, "127.0.0.1");
      else { out += t.replace(/^l/, ""); clearTimeout(timer); timer = setTimeout(done, 600); }
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), RPORT, "127.0.0.1");
  });
}

(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const vw = +(process.env.VW || 1280), vh = +(process.env.VH || 720);
  const ctxOpts = process.env.PHONE ? { viewport: { width: vw, height: vh }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: devices["Pixel 7"].userAgent }
                                    : { viewport: { width: vw, height: vh } };
  const ctx = await browser.newContext(ctxOpts);
  const pg = await ctx.newPage();
  pg.on("console", (m) => { const t = m.text(); if (/\[watch\] state|Host_Error|Sys_Error|abort|disconnect|kicked/i.test(t)) note(`console: ${t.slice(0, 200)}`); });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note("renderer: " + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  if (!fs.existsSync(CMD)) fs.writeFileSync(CMD, "");
  let done = 0, cdp = null, fn = 0;
  const snap = async (name) => { try { await pg.screenshot({ path: `${OUT}/${name}.png`, timeout: 20000 }); note(`shot ${name}`); } catch (e) { note(`shot ${name} FAILED ${e.message.slice(0, 80)}`); } };
  for (;;) {
    const lines = fs.readFileSync(CMD, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length <= done) { await sleep(300); continue; }
    const line = lines[done++]; const sp = line.indexOf(" ");
    const op = sp < 0 ? line : line.slice(0, sp), arg = sp < 0 ? "" : line.slice(sp + 1);
    try {
      if (op === "rcon") note(`rcon ${arg} => ${(await rcon(arg)).trim().slice(0, 1500)}`);
      else if (op === "shot") await snap(arg);
      else if (op === "fshot") { await pg.screenshot({ path: `${OUT}/${arg}.png`, fullPage: true, timeout: 20000 }); note(`fshot ${arg}`); }
      else if (op === "eshot") { const [sel, name] = arg.split(" "); await pg.locator(sel).screenshot({ path: `${OUT}/${name}.png`, timeout: 20000 }); note(`eshot ${name}`); }
      else if (op === "wait") await sleep(+arg);
      else if (op === "vp") { const [w, h] = arg.split(" ").map(Number); await pg.setViewportSize({ width: w, height: h }); }
      else if (op === "key") await pg.keyboard.press(arg);
      else if (op === "down") await pg.keyboard.down(arg);
      else if (op === "up") await pg.keyboard.up(arg);
      else if (op === "type") await pg.keyboard.type(arg);
      else if (op === "click") { const [x, y] = arg.split(" ").map(Number); await pg.mouse.click(x, y); }
      else if (op === "tap") { const [x, y] = arg.split(" ").map(Number); await pg.touchscreen.tap(x, y); }
      else if (op === "eval") note(`eval => ${String(JSON.stringify(await pg.evaluate(arg))).slice(0, 1500)}`);
      else if (op === "reload") await pg.goto(URL, { waitUntil: "domcontentloaded" });
      else if (op === "frames") {
        const [mode, every] = arg.split(" ");
        if (mode === "on" && !cdp) {
          cdp = await ctx.newCDPSession(pg); let last = 0; const gap = +(every || 1000);
          cdp.on("Page.screencastFrame", async (f) => {
            try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
            const now = Date.now(); if (now - last < gap) return; last = now;
            fs.writeFileSync(`${OUT}/frames/${new Date(now).toISOString().slice(11, 19).replace(/:/g, "")}-${String(fn++).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64"));
          });
          await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: vw, maxHeight: vh });
          note("frames on");
        } else if (mode === "off" && cdp) { await cdp.send("Page.stopScreencast"); await cdp.detach(); cdp = null; note("frames off"); }
      }
      else if (op === "quit") break;
      else note(`?? ${line}`);
    } catch (e) { note(`ERR ${line}: ${e.message.slice(0, 200)}`); }
  }
  await browser.close();
  note("done");
})().catch((e) => { note("FAIL " + e.stack); process.exit(1); });
