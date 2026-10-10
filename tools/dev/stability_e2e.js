// #3965 (tools/dev/stability_e2e.js) stability test: 4 seated browser players + 4 browser spectators on an isolated copy of the live stack
// (server cs-party-server:0.5.16-vq on :27030, relay 0.4.18 on :8096, MAXPLAYERS=10 like live).
// Players join first and the lobby autostarts the match; spectators join mid-match (late spectators).
// Forces a map-change minigame (Surf Race) first, then lets the match run. Mid-test churn: a player drops and
// rejoins (seat hold), a spectator reloads. Logs every client state change, page crash and server state.
const { chromium } = require("playwright");
const dgram = require("dgram"), fs = require("fs");
const OUT = "/work/out"; fs.mkdirSync(OUT, { recursive: true });
const DUR = +(process.env.DUR || 1800) * 1000, RPW = process.env.RPW, KEY = process.env.KEY;
const URL = `http://127.0.0.1:8096/?key=${KEY}&nosound=1`;
const t0 = Date.now();
const log = (s) => { const l = `${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`; console.log(l); fs.appendFileSync(`${OUT}/events.log`, l + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"), H = Buffer.from([255, 255, 255, 255]); let buf = "", t;
    const done = () => { try { s.close(); } catch {} ok(buf || "timeout"); }; t = setTimeout(done, 3000);
    s.on("message", (m) => { const x = m.slice(4).toString(), c = /^challenge rcon (\d+)/.exec(x);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${RPW}" ${cmd}\n`)]), 27030, "127.0.0.1");
      else { buf += x.slice(1); clearTimeout(t); t = setTimeout(done, 600); } });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), 27030, "127.0.0.1");
  });
}

const clients = [];
async function join(browser, name, role) {
  const c = { name, role, st: -1, changes: 0, drops: 0, crashed: false, errors: 0 };
  c.ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  c.pg = await c.ctx.newPage();
  c.pg.on("console", (m) => { const t = m.text(), s = /\[watch\] state (-?\d) -> (\d)/.exec(t);
    if (s) { const prev = c.st; c.st = +s[2]; c.changes++; if (prev === 4 && c.st !== 4) c.drops++; log(`${name} state ${prev}->${c.st}`);
      if (c.st === 0 && prev >= 1 && !c.paused && !c.rejoining) { c.lost = (c.lost || 0) + 1; rejoin(c); } }
    else if (/Host_Error|Sys_Error|abort|assert|disconnect|kicked|Server shutting|overflow|timed out/i.test(t)) log(`${name} console: ${t.slice(0, 200)}`); });
  c.pg.on("pageerror", (e) => { c.errors++; log(`${name} PAGEERROR ${e.message.slice(0, 200)}`); });
  c.pg.on("crash", () => { c.crashed = true; log(`${name} PAGE CRASHED`); });
  c.pg.on("dialog", (d) => d.dismiss().catch(() => {}));
  await c.pg.goto(URL, { waitUntil: "domcontentloaded" });
  await c.pg.fill("#name", name); await c.pg.click("#go");
  log(`${name} (${role}) joining`);
  clients.push(c); return c;
}
async function rejoin(c) {   // what a player does after "Lost the party": rejoin from the join screen
  c.rejoining = true; log(`${c.name} LOST (#${c.lost}), rejoining in 5 s`);
  await c.pg.screenshot({ path: `${OUT}/${c.name}-lost-${c.lost}.png` }).catch(() => {});
  await sleep(5000); await c.pg.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await c.pg.fill("#name", c.name).catch(() => {}); await c.pg.click("#go").catch(() => {});
  c.rejoining = false;
}
const unpause = (c) => c.pg.evaluate(() => { const p = document.getElementById("pause"); if (p) p.hidden = true; document.getElementById("canvas").focus(); }).catch(() => {});
const humans = (st) => (st.match(/^#\s*\d+ "[^"]+" .*$/gm) || []).filter((l) => !/BOT/.test(l)).length;

let stopDrive = false;
async function drive(c) {   // seated players: press Jump (crate / menu pick) and wander so minigames have movement
  const keys = ["w", "a", "d", "s"];
  while (!stopDrive) {
    if (c.role === "player" && c.st === 4 && !c.paused) {
      await unpause(c);
      const k = keys[Math.floor(Math.random() * 4)];
      await c.pg.keyboard.down(k).catch(() => {}); await sleep(300 + Math.random() * 600); await c.pg.keyboard.up(k).catch(() => {});
      await c.pg.keyboard.press(" ").catch(() => {});
    } else if (c.st === 4 && Math.random() < 0.1) await unpause(c);
    await sleep(900 + Math.random() * 800);
  }
}
async function waitAll(list, secs) { for (let i = 0; i < secs * 2; i++) { if (list.every((c) => c.st === 4)) return true; await sleep(500); } return false; }

(async () => {
  for (const cmd of [...(process.env.FIX ? ["sv_rehlds_maxclients_from_single_ip 32"] : []), "sv_rehlds_maxclients_from_single_ip", "csp_turns 4", "csp_force_mg 8"]) log(`rcon ${cmd}: ${(await rcon(cmd)).trim().slice(0, 80)}`);
  const b = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"] });
  const P = [], S = [];
  for (let i = 1; i <= 4; i++) { P.push(await join(b, `stab-p${i}`, "player")); await sleep(3000); }
  log(`renderer ${await P[0].pg.evaluate(() => { const g = document.createElement("canvas").getContext("webgl"); const e = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(e.UNMASKED_RENDERER_WEBGL); })}`);
  log(`players connected: ${await waitAll(P, 180)}`);
  P.forEach((c) => drive(c));
  let state = "";
  for (let i = 0; i < 90; i++) { state = await rcon("csp_state"); if (/state=[1-9]/.test(state)) break; await sleep(2000); }
  log(`match: ${(state.match(/state=\S+ turn=\S+/) || ["not started"])[0]}`);
  log(state.split("\n").filter((l) => /seat\d/.test(l)).map((l) => l.trim()).join(" | "));
  for (let i = 1; i <= 4; i++) { S.push(await join(b, `stab-s${i}`, "spectator")); await sleep(4000); }
  log(`spectators connected: ${await waitAll(S, 180)}`);
  S.forEach((c) => drive(c));

  let churned = false, shotN = 0;
  while (Date.now() - t0 < DUR) {
    const st = await rcon("status"), cs = await rcon("csp_state");
    const fps = (await rcon("stats")).trim().split("\n").pop();
    log(`MON humans=${humans(st)} ${(cs.match(/state=\S+ turn=\S+/) || ["csp_state " + cs.trim().slice(0, 40)])[0]} stats=[${fps.trim()}] clients=${clients.map((c) => `${c.name.slice(5)}:${c.st}`).join(",")}`);
    if (++shotN % 8 === 0) for (const c of clients) await c.pg.screenshot({ path: `${OUT}/${c.name}-${String(shotN).padStart(3, "0")}.png` }).catch(() => {});
    if (!churned && Date.now() - t0 > DUR * 0.45) {   // churn: a seated player leaves and rejoins inside the seat hold, a spectator reloads
      churned = true;
      log("CHURN p2 disconnect"); P[1].paused = true;
      await P[1].pg.evaluate(() => window.__csp && window.__csp._CL_Disconnect && window.__csp._CL_Disconnect()).catch(() => {});
      log("CHURN s3 reload"); await S[2].pg.reload({ waitUntil: "domcontentloaded" }).catch((e) => log("reload err " + e.message));
      await S[2].pg.fill("#name", "stab-s3").catch(() => {}); await S[2].pg.click("#go").catch(() => {});
      await sleep(15000);
      await P[1].pg.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await P[1].pg.fill("#name", "stab-p2").catch(() => {}); await P[1].pg.click("#go").catch(() => {}); P[1].paused = false;
      log(`churn rejoin: ${await waitAll([P[1], S[2]], 180)}`);
      log((await rcon("csp_state")).split("\n").filter((l) => /seat\d/.test(l)).map((l) => l.trim()).join(" | "));
    }
    await sleep(15000);
  }
  stopDrive = true;
  log("SUMMARY " + clients.map((c) => `${c.name} st=${c.st} changes=${c.changes} drops=${c.drops} errors=${c.errors} lost=${c.lost || 0} crashed=${c.crashed}`).join("; "));
  log(await rcon("csp_state"));
  log(await rcon("status"));
  for (const c of clients) await c.pg.evaluate(() => window.__csp && window.__csp._CL_Disconnect && window.__csp._CL_Disconnect()).catch(() => {});
  await b.close(); log("done");
})().catch((e) => { log("ERR " + e.stack); process.exit(1); });
