// Lobby API end to end against `wrangler dev` and a real web/relay.js (ISSUE).
//   relay:   PORT=18095 GAME=127.0.0.1:27999 PARTY_KEY=statickey LOBBY_SECRET=dev-secret-change-me RELAY_ID=raid1 node web/relay.js
//   worker:  npx wrangler dev --port 8787 --var 'POOL:[{"id":"raid1","url":"http://127.0.0.1:18095"}]' --var AUTOSTART_SECS:3
//   node test/lobby_test.mjs   [LOBBY=http://127.0.0.1:8787 RELAY=http://127.0.0.1:18095]
const LOBBY = process.env.LOBBY || "http://127.0.0.1:8787";
const RELAY = process.env.RELAY || "http://127.0.0.1:18095";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

const create = async (pid, name, char = -1) => {
  const r = await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid, name, char }) });
  return { status: r.status, body: await r.json() };
};

class Member {
  constructor(code, pid, name, char = -1) {
    this.states = []; this.errors = [];
    const q = new URLSearchParams({ pid, name, char: String(char) });
    this.ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${code}/ws?${q}`);
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); (m.t === "state" ? this.states : this.errors).push(m); };
    this.closed = new Promise((r) => { this.ws.onclose = (e) => r(e.code); });
    this.open = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
  }
  get s() { return this.states.at(-1); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(pred, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (this.s && pred(this.s)) return this.s; await sleep(50); }
    return null;
  }
}

// relay accepts a key? (WebSocket: refused sockets close at once with 4001)
const relayAccepts = async (key) => {
  const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/relay?key=${encodeURIComponent(key)}`, "binary");
  const code = await Promise.race([new Promise((r) => { ws.onclose = (e) => r(e.code); }), sleep(1500).then(() => "open")]);
  try { ws.close(); } catch {}
  return code === "open";
};

// --- create + join
const a = await create("pid-aaaaaaaa", "Alice", 2);
check(a.status === 200 && /^[A-Z2-9]{5}$/.test(a.body.code) && !/[01OIL]/.test(a.body.code), `create -> code ${a.body.code}`);
const code = a.body.code;
const info = await (await fetch(`${LOBBY}/api/lobbies/${code.toLowerCase()}`)).json();
check(info.state === "open" && info.players === 1, "lookup is case-insensitive and shows 1 player");
check((await fetch(`${LOBBY}/api/lobbies/ZZZZZ`)).status === 404, "unknown code -> 404");
check((await fetch(`${LOBBY}/api/lobbies/AB0O1`)).status === 404, "code with ambiguous chars -> 404");

const A = new Member(code, "pid-aaaaaaaa", "Alice", 2); await A.open;
const B = new Member(code, "pid-bbbbbbbb", "Bob\";quit", 2); await B.open;
let s = await B.until((s) => s.members.length === 2);
check(!!s, "both members in the roster");
const bob = s?.members.find((m) => m.n === s.you);
check(bob?.name === "Bobquit", `nickname sanitised (${bob?.name})`);
check(bob?.char === -1, "Bob's pick of Alice's character was refused");
check(s?.host === s?.members[0].n && s?.members[0].char === 2, "Alice is host with character 2");
B.send({ t: "char", char: 2 });
await sleep(300);
check(B.errors.some((e) => /already picked/.test(e.msg)), "taking a held character -> error");
B.send({ t: "char", char: 5 });
check(!!(await A.until((s) => s.members[1].char === 5)), "Bob picks 5, Alice sees it");
B.send({ t: "start" }); await sleep(300);
check(A.s.state === "open", "non-host can't start");

// --- spectator: 5th member
const extra = [];
for (const n of ["Cara", "Dan", "Eve"]) { const m = new Member(code, `pid-${n.toLowerCase()}12345`, n); await m.open; extra.push(m); }
s = await A.until((s) => s.members.length === 5);
check(s?.members[4].role === "spectator" && s.members.slice(0, 4).every((m) => m.role === "player"), "5th member is a spectator");
// spectators leave again: ready-up is for the seated four
for (const m of extra) { m.send({ t: "leave" }); }
check(!!(await A.until((s) => s.members.length === 2)), "leave removes members");

// --- reconnect keeps the seat
B.ws.close(); await B.closed;
check(!!(await A.until((s) => s.members.length === 2 && !s.members[1].online)), "Bob dropped: still seated, shown away");
const B2 = new Member(code, "pid-bbbbbbbb", "Bob"); await B2.open;
s = await B2.until((s) => s.members.length === 2 && s.members[1].online);
check(s?.you === s?.members[1].n && s?.members[1].char === 5, "Bob reconnects to the same seat and character");

// --- all ready -> countdown -> in_match with a per-member game link
A.send({ t: "ready", ready: true }); B2.send({ t: "ready", ready: true });
s = await A.until((s) => s.startsIn > 0);
check(!!s, `countdown starts (${s?.startsIn} ms)`);
s = await A.until((s) => s.state === "in_match", 10000);
check(!!s?.go, `auto-start -> in_match, go=${s?.go}`);
const goA = new URL(s.go), goB = new URL((await B2.until((s) => !!s.go)).go);
check(goA.origin === RELAY && goA.searchParams.get("char") === "2" && goA.searchParams.get("name") === "Alice", "Alice's link: relay, her character and name");
check(goB.searchParams.get("char") === "5" && goB.searchParams.get("lobby").endsWith(`/?code=${code}`), "Bob's link: his character, lobby back-link");
const key = goA.searchParams.get("key");
check(await relayAccepts(key), "relay accepts the lobby key");
check((await fetch(`${RELAY}/gamedata.zip?key=${encodeURIComponent(key)}`)).status !== 403, "lobby key opens gamedata.zip");
const forged = key.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
check(!(await relayAccepts(forged)), "relay refuses a forged key");
const [kc, kexp, ksig] = key.split(".");
check(!(await relayAccepts(`${kc}.${+kexp + 1}.${ksig}`)), "relay refuses a key with a changed expiry");
check(await relayAccepts("statickey"), "relay still accepts its static party key");
check(!(await relayAccepts("nope")), "relay refuses a wrong key");

// --- second lobby: the only server is held -> queued; host ends the first match -> second gets it
const c2 = await create("pid-cccccccc", "Cara");
const C = new Member(c2.body.code, "pid-cccccccc", "Cara"); await C.open;
C.send({ t: "start" });
s = await C.until((s) => s.state === "queued");
check(!!s, "second lobby queues while the server is held");
A.send({ t: "end" });
check(!!(await A.until((s) => s.state === "open")), "host ends match -> lobby back to open");
s = await C.until((s) => s.state === "in_match", 15000);
check(!!s?.go, "queued lobby gets the freed server");
const k2 = new URL(s.go).searchParams.get("key");
check(await relayAccepts(k2), "second lobby's key works");
C.send({ t: "end" }); await C.until((s) => s.state === "open");

// --- a server with players on it is never handed out
const busy = new WebSocket(`${RELAY.replace(/^http/, "ws")}/relay?key=statickey`, "binary");
await new Promise((r) => { busy.onopen = r; });
await sleep(300);
A.send({ t: "start" });
s = await A.until((s) => s.state === "queued");
check(!!s, "relay with a peer on it -> queued, not assigned");
busy.close();
s = await A.until((s) => s.state === "in_match", 15000);
check(!!s, "peer leaves -> queued lobby starts");
A.send({ t: "end" }); await A.until((s) => s.state === "open");

// --- rate limit on creates
let limited = false;
for (let i = 0; i < 12 && !limited; i++) limited = (await create(`pid-rate${i}xxxx`, "R")).status === 429;
check(limited, "create is rate limited per IP");

// --- SLOW=1 (worker run with --var MATCH_GRACE_SECS:0): nobody joins the server -> the directory's minute
// check sees the relay empty twice and hands the lobby back. About 2-3 minutes.
if (process.env.SLOW) {
  A.send({ t: "start" });
  check(!!(await A.until((s) => s.state === "in_match")), "slow: match started");
  const t0 = Date.now();
  check(!!(await A.until((s) => s.state === "open", 240000)), `slow: empty server released, lobby open again after ${Math.round((Date.now() - t0) / 1000)} s`);
}

for (const m of [A, B2, C]) m.ws.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
