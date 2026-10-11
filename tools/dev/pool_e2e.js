// Lobby servers end to end in real browsers (#4154): two players make and join a party, ready up, and the
// pool-agent starts a game server container just for them; both land in it. Both players are called "Alice", and
// both drop and come back in the opposite order: each must get their own seat back (setinfo _csp_pid), not the
// other's. Then the match ends, both pages go back to the lobby on their own, and the container goes away.
//
// Needs: the lobby Worker under `wrangler dev` (POOL '[]'), web/relay.js with POOL_AGENT, web/pool-agent.js with
// RCON_PASSWORD and EXTRA_CVARS (a short match: "csp_turns 2;csp_turn_timeout 8"), Node playwright@1.55.0.
//   LOBBY=http://127.0.0.1:8794 AGENT=http://127.0.0.1:8254 RCON_PW=... OUT=/work/shots node pool_e2e.js
const { chromium } = require("playwright");
const dgram = require("node:dgram");
const fs = require("node:fs");

const LOBBY = process.env.LOBBY || "http://127.0.0.1:8794";
const AGENT = process.env.AGENT || "http://127.0.0.1:8254";
const RPW = process.env.RCON_PW || "";
const OUT = process.env.OUT || "/work/shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `+${Math.round((Date.now() - T0) / 1000)}s`, ...a);
let failed = 0;
const check = (ok, what) => { log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; return ok; };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 90000 }).catch((e) => log(`screenshot ${name}: ${e.message.split("\n")[0]}`));
const until = async (fn, ms, every = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return null; };

const rcon = (port, cmd) => new Promise((resolve) => {
  const s = dgram.createSocket("udp4"); let out = "", stage = 0;
  const done = () => { try { s.close(); } catch {} resolve(out); };
  const t = setTimeout(done, 2500);
  s.on("message", (m) => {
    const txt = m.toString("latin1").slice(4);
    if (stage === 0) { const c = /challenge rcon (\d+)/.exec(txt); if (!c) return; stage = 1;
      s.send(Buffer.from(`\xff\xff\xff\xffrcon ${c[1]} "${RPW}" ${cmd}\n`, "latin1"), port, "127.0.0.1"); }
    else { out += txt.replace(/^l/, ""); clearTimeout(t); setTimeout(done, 300); }
  });
  s.send(Buffer.from("\xff\xff\xff\xffchallenge rcon\n", "latin1"), port, "127.0.0.1");
});
const agent = async () => (await fetch(`${AGENT}/status`)).json();
const lobbyOf = async (code) => (await agent()).detail.find((l) => l.code === code);
const events = async (code, name) => ((await lobbyOf(code))?.events || []).filter((e) => !name || e.name === name);
// seat table from the plugin: seatN -> {pid (owner), ppid (who sits there now)}
const seats = async (port) => {
  const out = await rcon(port, "csp_state"), r = {};
  for (const m of out.matchAll(/seat(\d) .*? pid=(\S+) player=.*? ppid=(\S+)/g)) r[m[1]] = { pid: m[2], ppid: m[3] };
  return r;
};

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const player = async (tag) => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    await ctx.addInitScript(() => { if (!localStorage.getItem("csp_name")) localStorage.setItem("csp_name", "Alice"); });   // both "Alice"
    const page = await ctx.newPage();
    page.on("console", (m) => { const t = m.text(); if (/\[boot\]|Server issued|CSP_BACK|error/i.test(t)) log(`[${tag}] ${t.slice(0, 160)}`); });
    return { ctx, page, tag };
  };
  const A = await player("A"), B = await player("B");
  await A.page.goto(LOBBY);
  const gpu = await A.page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl"); const e = gl?.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; });
  log("WebGL renderer:", gpu);

  // --- party
  await A.page.click("#create");
  await A.page.waitForSelector("#lobby:not([hidden])");
  await A.page.locator('.char:has(input[value="2"])').click();
  const code = (await A.page.textContent("#lobby-code")).trim();
  check(/^[A-Z2-9]{5}$/.test(code), `A created party ${code}`);
  await B.page.goto(`${LOBBY}/?code=${code}`);
  await B.page.waitForSelector("#lobby:not([hidden])");
  await B.page.locator('.char:has(input[value="5"])').click();
  await A.page.waitForFunction(() => document.querySelectorAll(".seat:not(.empty)").length >= 2, null, { timeout: 15000 }).catch(() => {});
  await A.page.click("#ready"); await B.page.click("#ready");
  const starting = await until(async () => /Starting your party's server/.test(await A.page.textContent("#lobby-status")), 30000, 300);
  check(!!starting, "everyone ready -> lobby says it is starting the party's server");
  await shot(A.page, "pha4154-1-starting");
  const t0 = Date.now();
  const lob = await until(() => lobbyOf(code), 20000, 500);
  check(!!lob, `agent is starting a container for ${code} on :${lob?.port}`);

  // --- hand-off: both pages go to the relay with the lobby's key and a game pid
  const went = await until(async () => /[?&]key=/.test(A.page.url()) && /[?&]key=/.test(B.page.url()), 300000, 1000);
  check(!!went, `server up, both sent to it after ${Math.round((Date.now() - t0) / 1000)} s`);
  const pidA = new URL(A.page.url()).searchParams.get("pid"), pidB = new URL(B.page.url()).searchParams.get("pid");
  check(!!pidA && !!pidB && pidA !== pidB, `each player has their own game pid (${pidA}, ${pidB})`);
  const port = (await lobbyOf(code))?.port;
  const both = await until(async () => (await events(code, "humans")).some((e) => e.data.n === 2), 420000, 3000);
  check(!!both, "both players are on the lobby's server (plugin: humans 2)");
  const started = await until(async () => (await events(code, "match_started")).length, 120000, 2000);
  check(!!started, "the match started on the lobby server");
  await sleep(8000);
  await shot(A.page, "pha4154-2-ingame-A"); await shot(B.page, "pha4154-3-ingame-B");

  // --- same name, own seats
  let st = await until(async () => { const s = await seats(port); const v = Object.values(s); return v.some((x) => x.pid === pidA) && v.some((x) => x.pid === pidB) ? s : null; }, 120000, 3000);
  const seatOf = (s, pid) => Object.keys(s || {}).find((k) => s[k].pid === pid);
  const sA = seatOf(st, pidA), sB = seatOf(st, pidB);
  check(sA != null && sB != null && sA !== sB, `both "Alice"s own a seat by pid (A seat ${sA}, B seat ${sB})`);
  // both drop: B first, then A; A comes back first. By name, A would get whichever "Alice" seat comes first.
  const drop = async (P) => { await P.page.evaluate(() => { try { window.__csp?._CL_Disconnect?.(); } catch {} location.reload(); }); };
  await drop(B); await sleep(1500); await drop(A);
  const gone = await until(async () => (await events(code, "humans")).at(-1)?.data.n === 0, 60000, 1000);
  check(!!gone, "both dropped (humans 0); seats held");
  await sleep(4000);
  const rejoin = async (P) => { await P.page.waitForSelector("#go", { timeout: 60000 }); await P.page.click("#go"); };
  await rejoin(A); await sleep(12000); await rejoin(B);
  const back = await until(async () => (await events(code, "reconnect")).filter((e) => e.data.outcome === "reattached").length >= 2, 240000, 3000);
  check(!!back, "both reattached to a seat (plugin: reconnect reattached x2)");
  st = await seats(port);
  check(st[sA]?.ppid === pidA && st[sB]?.ppid === pidB, `each "Alice" is back in their own seat (seat ${sA}: ${st[sA]?.ppid}, seat ${sB}: ${st[sB]?.ppid})`);
  const expired = (await events(code, "reconnect")).filter((e) => e.data.outcome === "expired");
  check(expired.length === 0, "no seat went to a bot inside the 90 s grace");
  await sleep(6000);
  await shot(A.page, "pha4154-4-rejoined-A");

  // --- lobby page during the match shows progress (a third tab, spectator view of the lobby)
  const W = await player("W");
  await W.page.goto(`${LOBBY}/?code=${code}`);
  await until(async () => /Match in progress/.test(await W.page.textContent("#lobby-status")), 30000, 500);
  await shot(W.page, "pha4154-5-lobby-during-match");
  await W.ctx.close();

  // --- the end: match_finished, both pages back at the lobby, container gone
  const fin = await until(async () => (await events(code, "match_finished")).length, 1500000, 5000);
  check(!!fin, "match finished on the lobby server");
  await shot(A.page, "pha4154-6-results");
  const home = await until(async () => A.page.url().startsWith(LOBBY) && B.page.url().startsWith(LOBBY), 120000, 1000);
  check(!!home, "both pages went back to the lobby on their own");
  const open = await until(async () => /ready|Waiting/i.test(await A.page.textContent("#lobby-status")) && !(await A.page.isHidden("#ready")), 30000, 500);
  check(!!open, "lobby open again for a rematch, same party");
  await shot(A.page, "pha4154-7-back-in-lobby");

  // --- rematch right away, while the finished server may still linger: a fresh one, same party
  const oldAge = (await lobbyOf(code))?.ageSecs;
  log(`finished server still there: ${oldAge != null ? `yes (${oldAge} s old)` : "no"}`);
  await A.page.click("#ready"); await B.page.click("#ready");
  const went2 = await until(async () => /[?&]key=/.test(A.page.url()) && /[?&]key=/.test(B.page.url()), 300000, 1000);
  check(!!went2, "rematch: both sent to a fresh server");
  const fresh = await until(async () => { const l = await lobbyOf(code); return l && l.state === "ready" && (oldAge == null || l.ageSecs < oldAge) && l.events.some((e) => e.name === "humans" && e.data.n === 2) && l; }, 300000, 3000);
  check(!!fresh, `rematch: both on the new server (:${fresh?.port})`);
  // the host ends it from the lobby page (a second tab): the server goes, the lobby opens
  const H = await A.ctx.newPage();
  H.on("dialog", (d) => d.accept());   // "End the match for everyone…?"
  await H.goto(`${LOBBY}/?code=${code}`);
  await H.waitForSelector("#end:not([hidden])", { timeout: 30000 }).catch(() => {});
  await H.click("#end");
  const stopped = await until(async () => !(await lobbyOf(code)), 60000, 2000);
  check(!!stopped, "host ends the match -> the lobby's container is gone");
  check(!!(await until(async () => !(await H.isHidden("#ready")), 15000, 500)), "and the lobby is open");

  await browser.close();
  log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
