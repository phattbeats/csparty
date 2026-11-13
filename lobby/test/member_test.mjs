// PHATT ID members end to end (PHA-4091) against `wrangler dev`, with this script playing the PHATT ID hub (its /key and a
// signed assertion), the arcade (POST /api/events, HMAC checked) and the pool-agent. A member and a guest play one match:
// only the member's results reach the arcade, under their PHATT ID, and a second device takes the member's seat over.
//   worker: npx wrangler dev --port 8789 --var 'POOL:[]' --var AUTOSTART_SECS:3 --var PHATT_HUB:http://127.0.0.1:18098 \
//             --var ARCADE_URL:http://127.0.0.1:18098   (.dev.vars: LOBBY_SECRET, ARCADE_KID=k1, ARCADE_SECRET=dev-arcade-secret)
//   node test/member_test.mjs   [LOBBY=http://127.0.0.1:8789]   (needs web/node_modules)
import crypto from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
const { WebSocket: WS } = createRequire(import.meta.url)("../../web/node_modules/ws");

const LOBBY = process.env.LOBBY || "http://127.0.0.1:8789";
const SECRET = process.env.LOBBY_SECRET || "dev-secret-change-me";
const ARCADE_SECRET = process.env.ARCADE_SECRET || "dev-arcade-secret";
const HOST = "memb1", AUD = new URL(LOBBY).hostname, SUB = crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
const until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(50); } return null; };

// --- the hub: an Ed25519 key, and assertions like clubhouse-games server/phattid.js makes
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const x = publicKey.export({ format: "jwk" }).x;
const assertion = (claims) => {
  const t = Math.floor(Date.now() / 1000), body = Buffer.from(JSON.stringify({ sub: SUB, aud: AUD, iat: t, exp: t + 300, display: "Brandy", ...claims })).toString("base64url");
  return `pa1.${body}.${crypto.sign(null, Buffer.from("pa1." + body), privateKey).toString("base64url")}`;
};
// --- the arcade: checks the csparty surface signature, records the lines
const arcade = [];
let badSig = 0;
http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/auth/phatt-id/key") return res.end(JSON.stringify({ alg: "Ed25519", kid: "t", x }));
    if (req.url !== "/api/events") { res.statusCode = 404; return res.end(); }
    const h = req.headers, want = crypto.createHmac("sha256", ARCADE_SECRET).update(`${h["x-arcade-ts"]}.${raw}`).digest("base64url");
    if (h["x-arcade-surface"] !== "csparty" || h["x-arcade-kid"] !== "k1" || h["x-arcade-sig"] !== want) { badSig++; res.statusCode = 401; return res.end("{}"); }
    const lines = raw.split("\n").map((l) => JSON.parse(l));
    arcade.push(...lines);
    res.end(JSON.stringify({ accepted: lines.length, duplicate: 0, rejected: [], unlocked: [{ arcade_id: SUB, game: "csparty", key: "winner_winner" }] }));
  });
}).listen(18098, "127.0.0.1");

class Member {
  constructor(code, pid, name, pa) {
    this.states = []; this.closedWith = null;
    const q = new URLSearchParams({ pid, name }); if (pa) q.set("pa", pa);
    this.ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${code}/ws?${q}`);
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "state") this.states.push(m); };
    this.ws.onclose = (e) => { this.closedWith = e.code; };
    this.open = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
  }
  get s() { return this.states.at(-1); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  until(pred, ms = 8000) { return until(() => this.s && pred(this.s) && this.s, ms); }
}
class Agent {
  constructor() {
    const ts = Math.floor(Date.now() / 1000), sig = crypto.createHmac("sha256", SECRET).update(`csp-agent|${HOST}|${ts}`).digest("base64url");
    this.got = [];
    this.ws = new WS(`${LOBBY.replace(/^http/, "ws")}/api/agent?host=${HOST}`, { headers: { Authorization: `CSP-Agent ${ts}.${sig}` } });
    this.ws.on("message", (d) => { const s = d.toString(); if (s !== "pong") this.got.push(JSON.parse(s)); });
    this.status = new Promise((r) => { this.ws.on("open", () => r(101)); this.ws.on("unexpected-response", (q, res) => r(res.statusCode)); });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  take(pred, ms = 8000) { return until(() => { const i = this.got.findIndex(pred); return i >= 0 ? this.got.splice(i, 1)[0] : null; }, ms); }
}

const ag = new Agent();
check((await ag.status) === 101, "agent connects");
ag.send({ t: "hello", host: HOST, version: "test", url: "http://127.0.0.1:1", max: 2, drain: false, lobbies: [] });
ag.send({ t: "cap", running: 0, max: 2, load: 0, cpu: 0, upKbps: 0, lobbies: [] });
await sleep(300);

// --- a member hosts, a guest joins
const code = (await (await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: "pid-member-phone", name: "typed" }) })).json()).code;
const M = new Member(code, "pid-member-phone", "TypedName", assertion());
await M.open;
check(!!(await M.until((s) => s.members.some((m) => m.name === "Brandy"))), "member seated under the hub's display name, not the typed one");
M.send({ t: "name", name: "Imposter" }); await sleep(300);
check(M.s.members.some((m) => m.name === "Brandy") && !M.s.members.some((m) => m.name === "Imposter"), "member can't rename themselves in the lobby");
const G = new Member(code, "pid-guest-xxxx", "Guesty", assertion({ aud: "elsewhere.example" }));
await G.open;
check(!!(await M.until((s) => s.members.some((m) => m.name === "Guesty") && s.members.length === 2)), "assertion for another host = guest, keeps own name");

// --- second device: same PHATT ID takes the seat over, keeps the game pid
const M2 = new Member(code, "pid-member-laptop", "laptop", assertion());
await M2.open;
check(!!(await M2.until((s) => s.members.length === 2 && s.members.filter((m) => m.name === "Brandy").length === 1)), "second device takes the member's seat (still 2 seats, one Brandy)");
check(!!(await until(() => M.closedWith)), `first device dropped (close ${M.closedWith})`);
check(!!(await M2.until((s) => s.members[0]?.name === "Brandy" && s.you && s.you === s.host)), `the second device is still the host, first seat (${JSON.stringify(M2.s && { host: M2.s.host, you: M2.s.you, first: M2.s.members[0] })})`);

// --- match: the member's and the guest's go links carry their game pids
M2.send({ t: "start" });
check(!!(await ag.take((m) => m.t === "start" && m.code === code)), "host start -> agent told to start");
ag.send({ t: "started", code, url: "http://127.0.0.1:1" });
const sM = await M2.until((s) => s.state === "in_match" && s.go), sG = await G.until((s) => s.state === "in_match" && s.go);
const pM = sM && new URL(sM.go).searchParams.get("pid"), pG = sG && new URL(sG.go).searchParams.get("pid");
check(!!pM && !!pG && pM !== pG, `both have game pids (${pM}, ${pG})`);

// --- the plugin's per-seat results, as the pool-agent forwards them
const res = (pid, place, o = {}) => ({ t: "seat_result", code, at: Date.now(), data: { pid, seat: place, place, stars: 5 - place, money: 40, mg_wins: 3, awards: 0, timeouts: 1, turns: 10, secs: 900, ...o } });
ag.send(res(pM, 1)); ag.send(res(pG, 2, { timeouts: 0 }));
ag.send({ t: "ev", code, name: "match_finished", data: { winner: "GSG-9", secs: 900 }, at: Date.now() });
const got = await until(() => arcade.length >= 2 && arcade, 10000);
check(!!got, `arcade got the member's events (${arcade.length} lines, ${badSig} bad signatures)`);
const me = arcade.find((e) => e.type === "match_end");
check(me?.arcade_id === SUB && me.game === "csparty", "match_end is under the member's PHATT ID");
check(JSON.stringify(me?.payload) === JSON.stringify({ players: 2, party_size: 2, placement: 1, score: 4, rounds: 10, winner: true, awards: 0, mg_wins: 3, timeouts: 1 }), `match_end payload (${JSON.stringify(me?.payload)})`);
check(arcade.filter((e) => e.type === "turn_timeout").length === 1, "one turn_timeout for the one timed-out turn");
await sleep(1500);
check(arcade.every((e) => e.arcade_id === SUB) && !JSON.stringify(arcade).includes(pG) && !JSON.stringify(arcade).includes("Guesty"), "nothing about the guest reached the arcade");
const hz = await (await fetch(`${LOBBY}/healthz`)).json();
check(hz.arcade?.on && hz.arcade.queued === 0 && hz.arcade.sent >= 1 && hz.arcade.unlocked >= 1, `/healthz shows the sender (${JSON.stringify(hz.arcade)})`);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
