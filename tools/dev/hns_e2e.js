// #3983 (tools/dev/hns_e2e.js): Hide and Seek arenas with a browser client. One player joins the board, then for
// every arena of every map in MAPS: force Hide and Seek in that arena, screenshot the intro card (arena name), the hide
// phase (red fence), a walk, and the corner escape test run on the browser player's own seat (csp_hns_corners <seat>).
// The server console has the results ("placed at", "corner test ... back inside/ESCAPED", "left the arena").
// Runs in the Playwright image on game-host (GPU) against an isolated stack. env: RELAY, KEY, RCON_PORT, RPW,
// MAPS (de_dust2,de_inferno,...), ARENAS (optional "0 2": only these), FENCE=1 (instead of the walk and corner test: two
// shots facing open stretches of fence, csp_hns_fenceview). Writes /work/out.
const { chromium } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8123";
const URL = `${RELAY}/?key=${encodeURIComponent(process.env.KEY || "")}&nosound=1&dev=1`;
const RPORT = +(process.env.RCON_PORT || 27093);
const MAPS = (process.env.MAPS || "de_dust2").split(",");
const FENCE = !!process.env.FENCE;
const ONLY = process.env.ARENAS ? process.env.ARENAS.split(/\s+/).map(Number) : null;
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
async function state() {
  const t = await rcon("csp_state"); const m = /state=(\d+)/.exec(t);
  const seat = (t.match(/seat(\d) .*player=phaTT(?!\[bot\])/) || [])[1];
  return { st: m ? +m[1] : -1, seat: seat === undefined ? -1 : +seat };
}

(async => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const pg = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const states = [];
  pg.on("console", (m) => {
    const t = m.text(); const s = /\[watch\] state (-?\d) -> (\d)/.exec(t); if (s) states.push(+s[2]);
    if (/watch|Host_Error|Sys_Error|couldn't|can't find|abort/i.test(t)) note(`console.${m.type()}: ${t.slice(0, 300)}`);
  });
  pg.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  pg.on("crash", => note("PAGE CRASHED"));
  const joins = => states.filter((s) => s === 4).length;
  const waitJoins = async (n, secs) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { if (joins() >= n) return true; await sleep(500); } return false; };
  const shot = async (name) => {
    await pg.evaluate(() => { const p = document.getElementById("pause"); if (p) p.hidden = true; document.getElementById("canvas").focus(); });
    await pg.screenshot({ path: `${OUT}/${name}.png` });
  };

  await pg.goto(URL, { waitUntil: "domcontentloaded" });
  note("renderer: " + await pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl2"); const x = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(x.UNMASKED_RENDERER_WEBGL); }));
  await pg.fill("#name", "phaTT"); await pg.click("#go");
  note("joined: " + await waitJoins(1, 240));
  await sleep(8000);

  for (const map of MAPS) {
    const cur = /map\s*:\s*(\S+)/.exec(await rcon("status"));
    if (!cur || cur[1] !== map) {
      const before = joins();
      await rcon("csp_stop"); await rcon(`changelevel ${map}`);
      note(`changelevel ${map}: rejoined ${await waitJoins(before + 1, 240)}`);
      await sleep(8000);
    }
    let n = 0;   // right after a map change the reply can time out
    for (let k = 0; k < 5 && !n; k++) { n = +((/hns arenas: (\d+)/.exec(await rcon("csp_hns_probe")) || [0, 0])[1]); if (!n) await sleep(3000); }
    note(`${map}: ${n} arenas`);
    for (let a = 0; a < n; a++) {
      if (ONLY && !ONLY.includes(a)) continue;
      const tag = `${map}-a${a}`;
      await rcon("csp_stop"); await sleep(3000);
      await rcon("csp_force_mg 7"); await rcon(`csp_hns_arena ${a}`); await rcon("csp_start");
      let s = await state(), t = Date.now(), introShot = false;
      while (s.st !== 3 && Date.now() - t < 240000) {
        if (s.st === 2 && !introShot) { await sleep(1500); await shot(`${tag}-intro`); introShot = true; }
        await sleep(1000); s = await state();
      }
      if (s.st !== 3) { note(`${tag}: Hide and Seek never started (state ${s.st})`); continue; }
      note(`${tag}: started, browser player in seat ${s.seat}`);
      await sleep(2000); await shot(`${tag}-hide`);
      if (FENCE) {
        await sleep(15000);   // the seeker's blindfold comes off at 15 s
        for (const k of [0, 3]) {
          note(`${tag}: ${(await rcon(`csp_hns_fenceview ${s.seat} ${k}`)).trim()}`);
          await sleep(1500); await shot(`${tag}-fence${k}`);
        }
        note(`${tag}: done`); continue;
      }
      // corner test during the hide phase (nobody can die before 15 s), then a walk to meet the fence
      if (s.seat >= 0) {
        await rcon(`csp_hns_corners ${s.seat}`);
        await sleep(4000); await shot(`${tag}-corners`);
        await sleep(6000);
      }
      await pg.keyboard.down("w"); await sleep(5000); await pg.keyboard.up("w");
      await pg.mouse.move(480, 300); await pg.mouse.move(780, 300);
      await pg.keyboard.down("w"); await sleep(5000); await pg.keyboard.up("w");
      await shot(`${tag}-walk`);
      note(`${tag}: done`);
    }
  }
  await rcon("csp_stop");
  await pg.evaluate(() => { try { __csp._CL_Disconnect(); } catch (e) {} });
  await sleep(500);
  await browser.close();
  note("done");
})().catch((e) => { note("FAILED " + e.stack); process.exit(1); });
