// Lobby servers from pool-agents (#4154) end to end against `wrangler dev` and a real web/relay.js, with this script
// playing the pool-agent (the real one, web/pool-agent.js, runs Docker; tools/dev/pool_e2e.sh tests that on a host).
//   relay:   PORT=18096 GAME=127.0.0.1:27999 PARTY_KEY=statickey LOBBY_SECRET=dev-secret-change-me RELAY_ID=fake1 POOL_AGENT=http://127.0.0.1:18097 node web/relay.js
//   worker:  npx wrangler dev --port 8788 --var 'POOL:[]' --var AUTOSTART_SECS:3   (.dev.vars with LOBBY_SECRET and ADMIN_TOKEN)
//   node test/pool_test.mjs   [LOBBY=http://127.0.0.1:8788 RELAY=http://127.0.0.1:18096]   (needs web/node_modules)
import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
const { WebSocket: WS } = createRequire(import.meta.url)("../../web/node_modules/ws");

const LOBBY = process.env.LOBBY || "http://127.0.0.1:8788";
const RELAY = process.env.RELAY || "http://127.0.0.1:18096";
const SECRET = process.env.LOBBY_SECRET || "dev-secret-change-me";
const HOST = "fake1";
const ADMIN = process.env.ADMIN_TOKEN || "dev-admin-token-change-me-0123456789";
const admin = async (op, body) => (await fetch(`${LOBBY}/api/admin/${op}`, body ? { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }
  : { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
const until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(50); } return null; };

const create = async (pid, name) => {
  const r = await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid, name }) });
  return (await r.json()).code;
};
class Member {
  constructor(code, pid, name) {
    this.states = [];
    this.ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${code}/ws?${new URLSearchParams({ pid, name })}`);
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") this.states.push(m); };
    this.open = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
  }
  get s() { return this.states.at(-1); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  until(pred, ms = 8000) { return until(() => this.s && pred(this.s) && this.s, ms); }
}
const party = async (n) => { const code = await create(`pid-host${n}xxxx`, `Host${n}`); const m = new Member(code, `pid-host${n}xxxx`, `Host${n}`); await m.open; await m.until((s) => s.members.length === 1); return { code, m }; };

// --- the fake agent: what the Worker sends it, and what we answer
class Agent {
  constructor(ts = Math.floor(Date.now() / 1000), sig) {
    sig ??= crypto.createHmac("sha256", SECRET).update(`csp-agent|${HOST}|${ts}`).digest("base64url");
    this.got = [];
    this.ws = new WS(`${LOBBY.replace(/^http/, "ws")}/api/agent?host=${HOST}`, { headers: { Authorization: `CSP-Agent ${ts}.${sig}` } });
    this.ws.on("message", (d) => { const s = d.toString(); if (s !== "pong") this.got.push(JSON.parse(s)); });
    this.status = new Promise((r) => { this.ws.on("open", () => r(101)); this.ws.on("unexpected-response", (q, res) => r(res.statusCode)); this.ws.on("error", () => r(0)); });
    this.closed = new Promise((r) => this.ws.on("close", r));
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  take(pred, ms = 8000) { return until(() => { const i = this.got.findIndex(pred); return i >= 0 ? this.got.splice(i, 1)[0] : null; }, ms); }
}
// what the real agent tells the relay: lobby code -> game port (POST /sync)
const routes = {};
let syncs = 0;
http.createServer((req, res) => { req.resume(); req.on("end", () => { syncs++; res.end(JSON.stringify({ routes })); }); }).listen(18097, "127.0.0.1");
const relayOpens = async (key) => {   // "open", or the close code the relay refused it with
  const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/relay?key=${encodeURIComponent(key)}`, "binary");
  const r = await Promise.race([new Promise((ok) => { ws.onclose = (e) => ok(e.code); }), sleep(2500).then(() => "open")]);
  try { ws.close(); } catch {}
  return r;
};

// --- auth
check((await new Agent(Math.floor(Date.now() / 1000), "x".repeat(43)).status) === 401, "agent with a bad signature -> 401");
check((await new Agent(Math.floor(Date.now() / 1000) - 600).status) === 401, "agent with a 10-minute-old signature -> 401");
let ag = new Agent();
check((await ag.status) === 101, "agent with a good signature connects");
ag.send({ t: "hello", host: HOST, version: "test", url: RELAY, max: 2, drain: false, lobbies: [] });
ag.send({ t: "cap", running: 0, max: 2, load: 1.5, cpu: 0, upKbps: 0, lobbies: [] });
await sleep(300);
let cap = await (await fetch(`${LOBBY}/api/capacity`)).json();
const h = cap.hosts.find((x) => x.id === HOST);
check(h?.online && h.max === 2 && h.load === 1.5, `capacity lists the host online, max 2 (${JSON.stringify(h)})`);
check(!JSON.stringify(cap).match(/"code"/), "capacity lists no lobby codes");

// --- start: the agent is asked, the lobby waits for it, then everyone gets a key for that lobby's server
const A = await party("a");
A.m.send({ t: "start" });
const stA = await ag.take((m) => m.t === "start" && m.code === A.code);
check(!!stA, `host start -> agent told to start ${A.code}`);
check(!!(await A.m.until((s) => s.state === "starting")), "lobby shows starting while the server comes up");
routes[A.code] = 27999;
ag.send({ t: "started", code: A.code, url: RELAY });
const sA = await A.m.until((s) => s.state === "in_match" && s.go);
check(!!sA, "agent says started -> lobby in match with a go link");
const goA = sA ? new URL(sA.go) : null, keyA = goA?.searchParams.get("key") || "";
check(goA?.origin === new URL(RELAY).origin && /^[\w-]{12}$/.test(goA.searchParams.get("pid") || ""), `go link to the agent's relay with a game pid (${goA?.searchParams.get("pid")})`);
check(await relayOpens(keyA) === "open", "relay routes that lobby's key to its server");
delete routes[A.code];
await sleep(2500);   // relay syncs every 2 s
check(await relayOpens(keyA) === 4004, "lobby server gone from the routes -> relay refuses its key with 4004");
routes[A.code] = 27999;
check(await relayOpens(keyA) === "open", "route back (the relay asks the agent again on a miss)");
check(await relayOpens("statickey") === "open", "static party key still opens the relay's own server");

// --- match news and the end of the match
ag.send({ t: "ev", code: A.code, name: "turn", data: { turn: 4, of: 15 }, at: Date.now() });
check(!!(await A.m.until((s) => s.progress?.turn === 4 && s.progress.of === 15)), "plugin turn event shows in the lobby");
ag.send({ t: "ev", code: A.code, name: "minigame_picked", data: { mg: "Knife Fight", fmt: "FREE-FOR-ALL", turn: 4 }, at: Date.now() });
await sleep(500);
let live = await admin("live");
const la = live.lobbies?.find((l) => l.code === A.code), ha = live.hosts?.find((x) => x.id === HOST);
check(la?.slot === HOST && la.round === 4 && la.lastmg === "KnifeFight", `admin: the lobby is on the agent's host, round 4, last minigame from the plugin (${JSON.stringify(la && { slot: la.slot, round: la.round, lastmg: la.lastmg })})`);
check(ha?.agent && ha.ok && ha.max === 2, `admin: the agent host is listed with the servers (${JSON.stringify(ha && { ok: ha.ok, max: ha.max, running: ha.running })})`);
ag.send({ t: "ev", code: A.code, name: "match_finished", data: { winner: "GSG-9", secs: 900 }, at: Date.now() });
check(!!(await A.m.until((s) => s.state === "open" && !s.go)), "match_finished -> lobby open for a rematch");
await sleep(200); cap = await (await fetch(`${LOBBY}/api/capacity`)).json();
// rematch while the finished server still lingers: the old one is stopped, a new one started
A.m.send({ t: "start" });
check(!!(await ag.take((m) => m.t === "stop" && m.code === A.code && m.reason === "rematch")), "rematch -> the lingering finished server is stopped");
check(!!(await ag.take((m) => m.t === "start" && m.code === A.code)), "rematch -> a fresh server is started");
ag.send({ t: "started", code: A.code, url: RELAY });
check(!!(await A.m.until((s) => s.state === "in_match")), "rematch in match");

// --- capacity: max 2, so the third lobby queues in order
const B = await party("b"), C = await party("c"), D = await party("d");
B.m.send({ t: "start" });
check(!!(await ag.take((m) => m.t === "start" && m.code === B.code)), "second lobby -> started on the agent");
C.m.send({ t: "start" }); await sleep(300); D.m.send({ t: "start" });
check(!!(await C.m.until((s) => s.state === "queued" && s.queuePos === 1)), "third lobby queued, number 1 in line");
check(!!(await D.m.until((s) => s.state === "queued" && s.queuePos === 2)), "fourth lobby queued, number 2 in line");
check(!ag.got.some((m) => m.t === "start" && (m.code === C.code || m.code === D.code)), "agent not asked beyond its cap");
ag.send({ t: "started", code: B.code, url: RELAY });
await B.m.until((s) => s.state === "in_match");
// the server crashes: lobby reopens with a message, and capacity frees up for the line, first come first served
ag.send({ t: "ended", code: B.code, reason: "crashed" });
check(!!(await B.m.until((s) => s.state === "open" && /stopped unexpectedly/.test(s.error))), "server crash -> lobby open, says so");
const stC = await ag.take((m) => m.t === "start" && (m.code === C.code || m.code === D.code), 15000);
check(stC?.code === C.code, `freed slot goes to the first in line (${stC?.code === C.code ? "C" : stC?.code === D.code ? "D, wrong" : "nobody"})`);
check(!!(await D.m.until((s) => s.state === "queued" && s.queuePos === 1, 15000)), "fourth lobby moves up to number 1");

// --- a server that fails to start: back in line, retried
ag.send({ t: "start_failed", code: C.code, error: "boom" });
check(!!(await C.m.until((s) => s.state === "queued" && /didn't start/.test(s.error))), "start_failed -> lobby back in line with a message");
// C rejoins the line behind D, which was waiting already
const next = await ag.take((m) => m.t === "start" && (m.code === C.code || m.code === D.code), 15000);
check(!!next, `the free slot is offered again (${next?.code === C.code ? "C" : "D"})`);
ag.send({ t: "started", code: next.code, url: RELAY });

// --- the host ends a match: the agent is told to stop that server
A.m.send({ t: "end" });
check(!!(await ag.take((m) => m.t === "stop" && m.code === A.code)), "host ends the match -> agent told to stop it");
check(!!(await A.m.until((s) => s.state === "open")), "and the lobby is open");

// --- agent restart: hello lists what still runs; the Worker drops what's gone and stops what it doesn't know
ag.ws.terminate(); await ag.closed;
await sleep(500);
cap = await (await fetch(`${LOBBY}/api/capacity`)).json();
check(cap.hosts.find((x) => x.id === HOST)?.online === false, "agent gone -> host offline in capacity");
ag = new Agent(); await ag.status;
ag.send({ t: "hello", host: HOST, version: "test", url: RELAY, max: 2, drain: false, lobbies: [{ code: "ZZZZ9", state: "ready" }] });
check(!!(await ag.take((m) => m.t === "stop" && m.code === "ZZZZ9")), "unknown server on the agent -> stop");
const runner = next.code === C.code ? C : D;
check(!!(await runner.m.until((s) => s.state === "open" && /restarted/.test(s.error))), "a match the agent no longer has -> lobby open, says the server restarted");

// --- drain (the admin's switch): no new lobbies go to a draining host
check((await admin("action", { action: "drain", id: HOST, on: true })).ok === true, "admin drains the agent host");
const E = await party("e"); E.m.send({ t: "start" });
check(!!(await E.m.until((s) => s.state === "queued")), "draining host -> new lobby queues");
check(!(await ag.take((m) => m.t === "start" && m.code === E.code, 1500)), "draining host isn't asked to start anything");
check((await admin("action", { action: "drain", id: HOST, on: false })).ok === true, "admin undrains it");
check(!!(await ag.take((m) => m.t === "start" && m.code === E.code, 15000)), "drain off -> the queued lobby starts");
// the agent's own drain (DRAIN=1) works the same way
ag.send({ t: "started", code: E.code, url: RELAY });
ag.send({ t: "cap", running: 1, max: 2, drain: true, load: 1, cpu: 0, upKbps: 0, lobbies: [] });
await sleep(300);
const F = await party("f"); F.m.send({ t: "start" });
check(!!(await F.m.until((s) => s.state === "queued")) && !(await ag.take((m) => m.t === "start" && m.code === F.code, 1500)), "agent says it is draining -> new lobby queues");
// the admin closes a lobby whose server is running: the agent is told to stop it
check((await admin("action", { action: "kill", code: E.code, msg: "test" })).ok === true, "admin closes a lobby with a running server");
check(!!(await ag.take((m) => m.t === "stop" && m.code === E.code)), "-> agent told to stop its server");

check(syncs > 3, `relay polled the agent (${syncs} syncs)`);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
