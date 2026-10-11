// Analytics events and the admin API end to end (#3991), against `wrangler dev` and a real web/relay.js.
// Same setup as lobby_test.mjs (fresh .wrangler state; .dev.vars has ADMIN_TOKEN and LOBBY_SECRET):
//   relay:   PORT=18095 GAME=127.0.0.1:27999 PARTY_KEY=statickey LOBBY_SECRET=dev-secret-change-me RELAY_ID=raid1 node web/relay.js
//   worker:  npx wrangler dev --port 8787 --var 'POOL:[{"id":"raid1","url":"http://127.0.0.1:18095"}]' --var AUTOSTART_SECS:3
//   node test/admin_test.mjs   [LOBBY=… ADMIN_TOKEN=… LOBBY_SECRET=…]
// The last check locks the admin API for 15 minutes from this IP: restart wrangler dev (rm -rf .wrangler) to rerun.
import { createHmac } from "node:crypto";
const LOBBY = process.env.LOBBY || "http://127.0.0.1:8787";
const TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token-change-me-0123456789";
const SECRET = process.env.LOBBY_SECRET || "dev-secret-change-me";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

const admin = async (path, body, token = TOKEN) => {
  const r = await fetch(`${LOBBY}/api/admin/${path}`, { method: body ? "POST" : "GET",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text, type: r.headers.get("Content-Type") || "" };
};
const act = (body) => admin("action", body);
const create = async (pid, name, extra = {}) => {
  const r = await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid, name, ...extra }) });
  return { status: r.status, body: await r.json() };
};
const stats = async () => {
  const s = (await admin("stats?range=24h")).body;
  const T = {};
  for (const r of s.totals) (T[r.e] ||= {})[r.k] = r;
  return { s, n: (e, k) => (k == null ? Object.values(T[e] || {}).reduce((a, v) => a + v.n, 0) : T[e]?.[k]?.n || 0) };
};
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

class Member {
  constructor(code, pid, name, via = "code") {
    this.states = []; this.msgs = [];
    const q = new URLSearchParams({ pid, name, char: "-1", via });
    this.ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${code}/ws?${q}`);
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); (m.t === "state" ? this.states : this.msgs).push(m); };
    this.closed = new Promise((r) => { this.ws.onclose = (e) => r({ code: e.code, reason: e.reason }); });
    this.open = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
  }
  get s() { return this.states.at(-1); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  until(pred, ms = 8000) { return until(() => this.s && pred(this.s) && this.s, ms); }
}
const signed = (slot, body, ts = Math.floor(Date.now() / 1000), secret = SECRET) => fetch(`${LOBBY}/api/events`, { method: "POST", body,
  headers: { "X-CSP-Slot": slot, "X-CSP-Time": String(ts), "X-CSP-Sig": createHmac("sha256", secret).update(`csp-ev|${slot}|${ts}|${body}`).digest("base64url") } });

// --- auth
check((await admin("live", null, null)).status === 401, "no token -> 401");
check((await admin("live", null, "x".repeat(40))).status === 401, "wrong token -> 401");
let live = await admin("live");
check(live.status === 200 && Array.isArray(live.body.hosts) && live.body.hosts[0]?.id === "raid1", "right token -> live view with the pool server");
check(live.body.hosts[0].ok === true, "the server's relay answers its health probe");
check((await admin("nope")).status === 404, "unknown admin path -> 404");
check((await admin("action")).status === 405, "action needs POST");
check((await act({ action: "caps", createCap: 200 })).status === 200, "caps: raise the per-IP create cap for this test");

// --- a lobby's life produces the funnel
const a = await create("pid-adm-alice", "Alice");
const code = a.body.code;
const A = new Member(code, "pid-adm-alice", "Alice", "create"); await A.open;
const B = new Member(code, "pid-adm-bobby", "Bob", "link"); await B.open;
await A.until((s) => s.members.length === 2);
live = (await admin("live")).body;
const row = live.lobbies.find((l) => l.code === code);
check(row?.host === "Alice" && row.online === 2 && row.players === 2, `live lobby table: ${code} host Alice, 2 online`);
A.send({ t: "ready", ready: true }); B.send({ t: "ready", ready: true });
check(!!(await A.until((s) => s.state === "in_match", 12000)), "everyone ready -> match");
const detail = (await admin(`lobby?code=${code}`)).body;
check(detail.members.length === 2 && detail.match?.slot === "raid1", "lobby detail: roster and the server it holds");
check(["lobby_created", "lobby_joined", "lobby_ready", "lobby_all_ready", "match_started"].every((e) => detail.log.some((x) => x.e === e)), "lobby timeline has created, joined, ready, all ready, started");
check(!JSON.stringify(detail).includes("pid-adm"), "no player ids in the admin view");

// --- game events from the server (P2 pool-agent path)
const evBody = JSON.stringify({ events: [{ e: "minigame_picked", b: ["hns", "2v2"], d: [3] }, { e: "turn_taken", b: ["4"], d: [7] },
  { e: "lobby_created", b: ["x"] }, { e: "minigame_result", b: ["hns", "4"], d: [62, 4] }] });
check((await signed("raid1", evBody, undefined, "wrong-secret")).status === 401, "events: wrong signature -> 401");
check((await signed("raid1", evBody, Math.floor(Date.now() / 1000) - 900)).status === 401, "events: stale timestamp -> 401");
check((await signed("nope", evBody)).status === 401, "events: unknown server -> 401");
let ing = await (await signed("raid1", evBody)).json();
check(ing.accepted === 3 && ing.dropped === 1 && ing.code === code, `events: 3 game events taken for ${code}, the lobby event refused`);
live = (await admin("live")).body;
check(live.lobbies.find((l) => l.code === code)?.round === 3, "minigame round shows in the lobby table");
A.send({ t: "end" });
await A.until((s) => s.state === "open");
let st = await stats();
check(st.n("match_outcome", "unfinished") === 1 && st.n("quit_after", "hns") === 1, "match ended after a minigame without a finish -> unfinished, quit after hns");
// second match, finished
A.send({ t: "start" });
await A.until((s) => s.state === "in_match");
ing = await (await signed("raid1", JSON.stringify({ events: [{ e: "match_finished", b: ["4", "2"], d: [600, 8, 2] }] }))).json();
check(ing.accepted === 1, "events: match_finished taken");
A.send({ t: "end" });
await A.until((s) => s.state === "open");
st = await stats();
check(st.n("funnel", "created") >= 1 && st.n("funnel", "second") >= 1 && st.n("funnel", "all_ready") >= 1 && st.n("funnel", "started") >= 1 && st.n("funnel", "finished") === 1,
  "funnel: created, 2nd joiner, all ready, started, finished");
check(st.n("tts", "lt30s") >= 1, "time-to-start distribution has the lobby (under 30 s)");
check(st.n("match_started", "all_ready") >= 1 && st.n("match_started", "host_force") >= 1, "start modes: all ready and host");
check(st.n("match_closed", "host_end") === 2 && st.n("match_outcome", "finished") === 1, "matches closed by the host, one finished");
check(st.n("minigame_picked", "hns") === 1 && st.n("minigame_winner", "4") === 1 && st.n("match_finished", "4") === 1, "minigame pick, minigame winner, match winner");
check(st.n("lobby_ready") >= 2 && st.n("lobby_joined", "guest") >= 1, "ready and join events counted");
check(st.s.players.at(-1).unique >= 2, `unique players today: ${st.s.players.at(-1).unique}`);

// --- broadcast reaches open lobbies, and the start page
check((await act({ action: "broadcast", msg: "Server restart in 5 minutes", minutes: 5 })).status === 200, "broadcast sent");
check(!!(await A.until((s) => s.notice === "Server restart in 5 minutes", 8000)), "a lobby already open shows the broadcast");
check((await (await fetch(`${LOBBY}/api/status`)).json()).notice === "Server restart in 5 minutes", "/api/status carries it for the start page");
await act({ action: "broadcast", msg: "" });
check(!!(await A.until((s) => s.notice === "", 8000)), "cleared broadcast disappears");

// --- pause
await act({ action: "pause", on: true, msg: "Back at 9" });
let c = await create("pid-adm-carol", "Carol");
check(c.status === 503 && c.body.error === "Back at 9", "paused: create refused with the banner text");
check((await (await fetch(`${LOBBY}/api/status`)).json()).paused === true, "/api/status says paused");
await act({ action: "pause", on: false });
check((await create("pid-adm-carol", "Carol")).status === 200, "resumed: create works");

// --- drain
await act({ action: "drain", id: "raid1", on: true });
live = (await admin("live")).body;
check(live.hosts[0].drained === true, "drained server shows in the live view");
A.send({ t: "start" });
check(!!(await A.until((s) => s.state === "queued")), "drained server: a start queues instead");
await act({ action: "drain", id: "raid1", on: false });
check(!!(await A.until((s) => s.state === "in_match", 15000)), "undrained: the queued lobby starts");
A.send({ t: "end" }); await A.until((s) => s.state === "open");
check((await act({ action: "drain", id: "nope", on: true })).status === 400, "drain: unknown server -> 400");

// --- kick and ban
const kicked = await act({ action: "kick", code, n: B.s.you, hours: 1 });
check(kicked.status === 200, "kick + ban Bob");
let closed = await B.closed;
check(closed.code === 4003, `Bob's socket closed 4003 (${closed.reason})`);
check(!!(await A.until((s) => s.members.length === 1)), "Bob is gone from the roster");
const B2 = new Member(code, "pid-adm-bobby", "Bob");
closed = await B2.closed;
check(closed.code === 4003, "banned Bob can't rejoin");
check((await create("pid-adm-bobby", "Bob")).status === 403, "banned Bob can't make a party");
live = (await admin("live")).body;
check(live.bans.length >= 1 && live.bans.every((b) => /^[A-Za-z0-9_-]{16}$/.test(b.key)), `bans listed by hash (${live.bans.map((b) => b.kind).join(", ")})`);
for (const b of live.bans) await act({ action: "unban", key: b.key });
const B3 = new Member(code, "pid-adm-bobby", "Bob"); await B3.open;
check(!!(await A.until((s) => s.members.length === 2)), "unbanned Bob joins again");
check(live.topCreators.length >= 1 && live.topCreators[0].n >= 1, "top creators by IP hash");

// --- public off
await act({ action: "caps", publicOff: true });
const p = await create("pid-adm-dave1", "Dave", { public: true });
check((await (await fetch(`${LOBBY}/api/public`)).json()).lobbies.length === 0, "public listings off: nothing listed");
check((await (await fetch(`${LOBBY}/api/lobbies/${p.body.code}`)).json()).public === false, "public listings off: a public create is made private");
await act({ action: "caps", publicOff: false });

// --- max lobbies
await act({ action: "caps", maxLobbies: 1 });
check((await create("pid-adm-erin1", "Erin")).status === 503, "max lobbies reached -> 503");
await act({ action: "caps", maxLobbies: 0 });

// --- kill
const killed = await act({ action: "kill", code, msg: "Closed for testing" });
check(killed.status === 200, "kill lobby");
closed = await A.closed;
check(closed.code === 4010 && A.msgs.some((m) => m.t === "closed" && m.msg === "Closed for testing"), "members told why and disconnected (4010)");
check((await fetch(`${LOBBY}/api/lobbies/${code}`)).status === 404, "killed lobby is gone");
check(!(await admin("live")).body.lobbies.some((l) => l.code === code), "and gone from the live view");
check((await act({ action: "kill", code: "AB0O1" })).status === 400, "kill: bad code -> 400");
check((await act({ action: "frobnicate" })).status === 400, "unknown action -> 400");

// --- CSV, audit, Analytics Engine panel
const csv = await admin("export.csv?range=7d");
check(csv.status === 200 && csv.type.startsWith("text/csv") && csv.text.startsWith("hour_utc,event,key,count,sum\n") && /,funnel,created,/.test(csv.text), "CSV export of the hourly counters");
const audit = (await admin("live")).body.audit.map((x) => x.action);
check(["kill", "kick", "unban", "pause", "drain", "broadcast", "caps"].every((x) => audit.includes(x)), `audit log has every action (${[...new Set(audit)].join(", ")})`);
const ae = (await admin("ae?preset=events")).body;
check(ae.configured === false && ae.presets.includes("countries"), "AE panel says it isn't set up without the read token");
st = await stats();
check(st.n("rejected", "banned_join") >= 1 && st.n("rejected", "paused") >= 1 && st.n("auth_failed") >= 1, "errors panel: banned join, paused create, wrong token counted");

// --- lockout: 10 wrong tokens from one IP, then even the right one is refused for a while
for (let i = 0; i < 10; i++) await admin("live", null, `wrong-${i}`.padEnd(30, "x"));
check((await admin("live")).status === 429, "10 wrong tokens -> locked out (429), right token included");
check((await admin("live", null, null)).status === 401, "no token still just 401 (not counted)");

for (const m of [B3]) m.ws.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
