// CS Party lobby API (#3989): party codes, roster, ready-up, and handing a lobby a game server.
// Design: docs/lobby-design.md. Phase 1: the "capacity" is a static pool of game servers that are already
// running (env POOL), each behind web/relay.js. Starting a match picks a free one and gives every member a
// link to it carrying a per-lobby party key (an HMAC token the relay checks with the shared LOBBY_SECRET).
// The plugin's own lobby countdown (csp_autostart) then starts the match on the server, bots filling seats.
//
//   POST /api/lobbies            {pid, name, char, public, seeking}  -> {code}
//   POST /api/quickplay          {pid, name, char}  -> {code, created}  join the fullest open public lobby, or make one
//   GET  /api/lobbies/:code      -> {code, state, players, public}  (404 if no such lobby)
//   GET  /api/lobbies/:code/ws?pid=&name=&char=   WebSocket: roster, ready, start (see Lobby.webSocketMessage)
//   GET  /api/public             -> open public lobbies
//   GET  /api/capacity           -> lobby servers: hosts (running/max/load), queue length. No lobby codes.
//   GET  /api/agent?host=ID      WebSocket for a pool-agent (web/pool-agent.js), "Authorization: CSP-Agent ts.sig"
//   GET  /healthz
//
// Phase 2 (#4154): pool-agents on game hosts connect out to the directory and start one game server container
// per lobby. A lobby goes to a pool-agent first, then to a free static POOL server, else it queues (first come,
// first served, with its place in line shown).
import { DurableObject } from "cloudflare:workers";

const SEATS = 4;
// 5 characters, no 0/O/1/I/L: 31^5 is about 29M codes
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const PID_RE = /^[A-Za-z0-9-]{8,64}$/;
const EXPIRE_MS = 15 * 60e3;          // lobby with nobody in it for this long is gone
const SEAT_GRACE_MS = 90e3;           // a dropped tab keeps its seat this long while the lobby is open
const QUEUE_RETRY_MS = 10e3;          // no free server: try again this often
const QUICK_FRESH_MS = 10 * 60e3;     // quick play only joins lobbies that changed this recently
const CREATES_PER_10MIN = 10;         // per IP
const MATCH_MAX_MS = 3 * 3600e3;      // hard cap on how long a lobby holds a server
const START_TIMEOUT_MS = 7 * 60e3;    // a lobby server that hasn't come up by now isn't going to
const HOST_STALE_MS = 90e3;           // a pool-agent heard from less recently than this takes no new lobbies
const ORPHAN_MS = 10 * 60e3;          // its agent gone this long: the lobby's match is written off
const START_FAILS = 3;                // lobby servers failing to start in a row before the lobby gives up

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const nick = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f"\\;]/g, "").trim().slice(0, 20) || "Player";
const charOf = (c) => (Number.isInteger(+c) && +c >= 0 && +c <= 7 ? +c : -1);
const pool = (env) => { try { return JSON.parse(env.POOL || "[]"); } catch { return []; } };

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hmac = async (secret, msg) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
};
// Party key for one lobby on one server: CODE.EXPIRY.SIG. web/relay.js checks it the same way (lobbyKeyOk).
export const lobbyToken = async (secret, slotId, code, exp) =>
  `${code}.${exp}.${b64url((await hmac(secret, `csp-lobby|${slotId}|${code}|${exp}`)).slice(0, 18))}`;
const sha = async (s) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 16);
// A pool-agent proves it holds LOBBY_SECRET: "CSP-Agent <ts>.<sig>", sig = HMAC("csp-agent|<host>|<ts>"), ts within 5 min.
const agentAuthOk = async (env, host, auth) => {
  const m = /^CSP-Agent (\d{9,11})\.([\w-]{43})$/.exec(auth || "");
  if (!env.LOBBY_SECRET || !/^[\w-]{1,32}$/.test(host) || !m || Math.abs(Date.now() / 1000 - +m[1]) > 300) return false;
  const want = new TextEncoder().encode(b64url(await hmac(env.LOBBY_SECRET, `csp-agent|${host}|${m[1]}`)));
  const got = new TextEncoder().encode(m[2]);
  return want.byteLength === got.byteLength && crypto.subtle.timingSafeEqual(want, got);
};
// the id a member's game client carries (setinfo _csp_pid): their seat across a dropped connection. Not their
// lobby player id, which never leaves the lobby.
const gamePid = () => b64url(crypto.getRandomValues(new Uint8Array(9)));

// What a relay's /healthz says: connected browser peers, game data downloads in flight, seconds since either.
// null if it doesn't answer. Cache-busted: Cloudflare cached probes before.
const relayHealth = async (url) => {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/healthz?t=${Date.now()}`, { cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const h = await r.json();
    const g = h.game || h;   // relays with lobby servers (#4154) count their own server's players apart
    return Number.isInteger(g.peers) ? { peers: g.peers, downloads: g.downloads || 0, idleSecs: g.idleSecs ?? Infinity } : null;
  } catch { return null; }
};
const isFree = (h) => !!h && h.peers === 0 && h.downloads === 0;
// a first visit downloads for minutes with no peer open; the gaps between the download and joining are short
const IDLE_RELEASE_SECS = 90;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/healthz") return json({ ok: true });
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    const makeLobby = async (body, pub, seeking) => {
      const ip = req.headers.get("cf-connecting-ip") || "local";
      const ipHash = await sha(`${ip}|${new Date().toISOString().slice(0, 10)}|${env.LOBBY_SECRET || ""}`);
      const r = await dir.reserveCode(ipHash);
      if (r.error) return json(r, 429);
      await env.LOBBY.get(env.LOBBY.idFromName(r.code)).init(r.code, { pid: body.pid, name: nick(body.name), char: charOf(body.char), public: pub || seeking, seeking });
      return json({ code: r.code, created: true });
    };
    if ((p === "/api/lobbies" || p === "/api/quickplay") && req.method === "POST") {
      let body = {}; try { body = await req.json(); } catch {}
      if (!PID_RE.test(body.pid || "")) return json({ error: "bad player id" }, 400);
      if (p === "/api/lobbies") return makeLobby(body, !!body.public, !!body.seeking);
      // quick play: the fullest open public lobby (one looking for players first); none: start one that is
      for (let i = 0; i < 3; i++) {
        const code = await dir.quickMatch();
        if (!code) break;
        if (await env.LOBBY.get(env.LOBBY.idFromName(code)).info()) return json({ code, created: false });
        await dir.remove(code);   // the directory listed a lobby that is gone
      }
      return makeLobby(body, true, true);
    }
    if (p === "/api/public" && req.method === "GET") return json({ lobbies: await dir.listPublic() });
    if (p === "/api/capacity" && req.method === "GET") return json(await dir.capacity());
    if (p === "/api/agent") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket only" }, 426);
      const host = url.searchParams.get("host") || "";
      if (!(await agentAuthOk(env, host, req.headers.get("Authorization")))) return json({ error: "unauthorized" }, 401);
      const fwd = new Request(req); fwd.headers.set("X-CSP-Agent-Host", host);
      return dir.fetch(fwd);
    }
    const m = /^\/api\/lobbies\/([^/]+)(\/ws)?$/.exec(p);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "no such lobby" }, 404);
      const lobby = env.LOBBY.get(env.LOBBY.idFromName(code));
      if (!m[2]) {
        const info = req.method === "GET" ? await lobby.info() : null;
        return info ? json(info) : json({ error: "no such lobby" }, 404);
      }
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket only" }, 426);
      return lobby.fetch(req);
    }
    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};

// ---------------------------------------------------------------------------------------------- one lobby
// State lives in one storage key, cached in memory and reloaded when the object wakes from hibernation.
// Members are keyed by playerId (a random id in the browser's localStorage): a reloaded tab gets its seat back.
// Other members only ever see a member's short public number (n), never their playerId.
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.closing = new Set();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => { this.s = (await this.ctx.storage.get("s")) || null; });
  }
  dir() { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")); }
  async save() { await this.ctx.storage.put("s", this.s); }

  async init(code, { pid, name, char, public: pub, seeking }) {
    const now = Date.now();
    this.s = { code, created: now, host: pid, state: "open", public: pub, seeking: !!seeking, fillAt: 0, nextN: 1, members: {}, order: [],
      readyAt: 0, match: null, queuedAt: 0, error: "", emptySince: now };
    this.addMember(pid, name, char);
    await this.save();
    await this.schedule();
    await this.dir().report(code, { state: "open", public: pub, seeking: !!seeking, players: 1 });   // listed before anyone connects
  }

  async info() {
    if (!this.s) return null;
    return { code: this.s.code, state: this.s.state, public: this.s.public, players: this.s.order.length, seats: SEATS, seeking: this.s.seeking };
  }

  addMember(pid, name, char) {
    const s = this.s;
    if (!s.members[pid]) {
      s.members[pid] = { n: s.nextN++, name, char: -1, ready: false, joined: Date.now(), gone: 0, gpid: gamePid() };
      s.order.push(pid);
    }
    const m = s.members[pid];
    m.name = name; m.gone = 0; m.gpid ||= gamePid();
    if (char >= 0 && !this.charTaken(char, pid)) m.char = char;
    return m;
  }
  charTaken(char, pid) { return Object.entries(this.s.members).some(([p, m]) => p !== pid && m.char === char); }
  removeMember(pid) {
    const s = this.s;
    delete s.members[pid];
    s.order = s.order.filter((p) => p !== pid);
    if (s.host === pid) s.host = s.order[0] || "";
  }
  // sockets still listed include one that is closing right now (webSocketClose): it doesn't count
  sockets() { return this.ctx.getWebSockets().filter((ws) => !this.closing.has(ws)); }
  online() { return new Set(this.sockets().map((ws) => ws.deserializeAttachment()?.pid)); }

  async fetch(req) {
    if (!this.s) return new Response("no such lobby", { status: 404 });
    const url = new URL(req.url);
    const pid = url.searchParams.get("pid") || "";
    if (!PID_RE.test(pid)) return new Response("bad player id", { status: 400 });
    // one socket per player: a second tab takes over
    for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.pid === pid) try { ws.close(4000, "opened in another tab"); } catch {}
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid });
    this.addMember(pid, nick(url.searchParams.get("name")), charOf(url.searchParams.get("char")));
    if (!this.s.host || !this.s.members[this.s.host]) this.s.host = pid;
    this.s.emptySince = 0;
    this.s.origin = url.origin;   // where the game page sends people back to
    await this.changed();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (!this.s || typeof raw !== "string" || raw.length > 512) return;
    const pid = ws.deserializeAttachment()?.pid, m = this.s.members[pid];
    if (!m) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const s = this.s, isHost = s.host === pid, open = s.state === "open";
    s.error = "";
    switch (msg.t) {
      case "name": m.name = nick(msg.name); break;
      case "char": {
        const c = charOf(msg.char);
        if (c >= 0 && this.charTaken(c, pid)) { this.send(ws, { t: "error", msg: "Someone already picked that character." }); return; }
        m.char = c; break;
      }
      case "ready": if (open) m.ready = !!msg.ready; break;
      case "public": if (isHost) { s.public = !!msg.public; if (!s.public) s.seeking = false; } break;
      // host: look for random players to fill the empty seats (lists the party publicly, quick play sends people here)
      case "seeking": if (isHost) { s.seeking = !!msg.seeking; if (s.seeking) s.public = true; } break;
      case "start": if (isHost && open) return this.start("host"); break;
      // host: everyone back to the lobby (match over, or stuck). Frees the server for the next lobby.
      case "end": if (isHost && s.state !== "open") { await this.dir().releaseSlot(s.code); return this.matchEnded(); } break;
      case "leave":
        this.removeMember(pid);
        try { ws.close(1000, "left"); } catch {}
        break;
      default: return;
    }
    await this.changed();
  }

  async webSocketClose(ws) {
    try { ws.close(1000); } catch {}
    if (!this.s) return;
    this.closing.add(ws);
    try {
      const pid = ws.deserializeAttachment()?.pid, m = this.s.members[pid];
      if (m && !this.online().has(pid)) { m.gone = Date.now(); m.ready = false; }
      if (this.online().size === 0) this.s.emptySince = Date.now();
      await this.changed();
    } finally { this.closing.delete(ws); }
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  // everyone seated and online is ready, and there are enough of them: start after AUTOSTART_SECS
  allReady() {
    const on = this.online();
    const players = this.s.order.slice(0, SEATS).filter((p) => on.has(p));
    return players.length >= +(this.env.MIN_HUMANS || 2) && players.every((p) => this.s.members[p].ready);
  }

  // report: tell the directory (not when the directory is the caller: a call back into it waits on itself)
  // a looking-for-players party also starts on its own FILL_SECS after it has enough people, ready or not
  seatedOnline() { const on = this.online(); return this.s.order.slice(0, SEATS).filter((p) => on.has(p)).length; }
  tick() {
    const s = this.s;
    if (s.state !== "open") { s.readyAt = 0; s.fillAt = 0; return; }
    if (this.allReady()) s.readyAt ||= Date.now(); else s.readyAt = 0;
    if (s.seeking && this.seatedOnline() >= +(this.env.MIN_HUMANS || 2)) s.fillAt ||= Date.now(); else s.fillAt = 0;
  }
  startAt() {
    const s = this.s, t = [];
    if (s.readyAt) t.push(s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5));
    if (s.fillAt) t.push(s.fillAt + 1000 * +(this.env.FILL_SECS || 20));
    return t.length ? Math.min(...t) : 0;
  }
  async changed(report = true) {
    const s = this.s;
    this.tick();
    await this.save();
    await this.schedule();
    this.broadcast();
    if (report) await this.dir().report(s.code, { state: s.state, public: s.public, seeking: s.seeking, players: s.order.length });
  }

  async start(mode) {
    const s = this.s;
    s.state = "starting"; s.readyAt = 0; s.fillAt = 0; s.startMode = mode;
    await this.save(); this.broadcast();
    const slot = await this.dir().claimSlot(s.code);
    if (slot?.pending) {
      // a pool-agent is starting this lobby's own server; the directory calls matchReady when it's up
      s.state = "starting"; s.startingSince ||= Date.now(); s.queuedAt = 0; s.queuePos = 0; s.error = "";
      return this.changed();
    }
    if (!slot?.url) {
      s.state = "queued"; s.queuedAt ||= Date.now(); s.queuePos = slot?.position || 0; s.startingSince = 0;
      s.error = s.queuePos ? `Every server is busy. You're number ${s.queuePos} in line…` : "Every server is busy. Waiting for one to free up…";
      return this.changed();
    }
    return this.inMatch(slot.id, slot.url);
  }

  async inMatch(slotId, url, pool = false) {
    const s = this.s;
    const exp = Math.floor(Date.now() / 1000) + 3600 * +(this.env.TOKEN_HOURS || 3);
    const key = await lobbyToken(this.env.LOBBY_SECRET || "", slotId, s.code, exp);
    s.match = { slot: slotId, url: url.replace(/\/$/, ""), key, started: Date.now(), mode: s.startMode, pool, progress: null };
    s.state = "in_match"; s.queuedAt = 0; s.queuePos = 0; s.startingSince = 0; s.startFails = 0; s.error = "";
    for (const m of Object.values(s.members)) m.ready = false;
    await this.changed(!pool);   // pool: the directory is the caller
  }

  // ----- called by the directory (they never call back into it: a call cycle stalls both objects)
  // This lobby's server is up. false: the lobby has moved on (host ended it, expired), so the server should go.
  async matchReady(host, url) {
    const s = this.s;
    if (!s || s.state !== "starting") return false;
    await this.inMatch(`${host}.pool`, url, true);
    return true;
  }
  // The server didn't come up: try again from the queue, a few times
  async matchFailed(error, counts = true) {
    const s = this.s;
    if (!s || (s.state !== "starting" && s.state !== "in_match")) return;
    s.match = null; s.startingSince = 0;
    if (counts) s.startFails = (s.startFails || 0) + 1;
    if (s.startFails >= START_FAILS) {
      s.state = "open"; s.startFails = 0; s.error = "Couldn't start a game server. Try again in a minute.";
    } else {
      s.state = "queued"; s.queuedAt = Date.now(); s.queuePos = 0; s.error = "The game server didn't start. Trying again…";
    }
    console.log(`lobby ${s.code}: server failed (${error})`);
    await this.changed(false);
  }
  // match news from the plugin ([CSPEV] lines via the pool-agent), for the "match in progress" view
  async progress(name, data) {
    const s = this.s;
    if (!s?.match) return;
    const p = s.match.progress ||= {};
    if (name === "turn") { p.turn = data.turn; p.of = data.of; }
    else if (name === "match_started") { p.turn = 1; p.of = data.turns; }
    else if (name === "minigame_picked") p.mg = data.mg;
    else if (name === "humans") p.humans = data.n;
    else return;
    await this.save(); this.broadcast();
  }

  // the directory saw the server empty out (or the host ended it): back to the lobby for a rematch
  async matchEnded(fromDirectory = false, error = "") {
    if (!this.s) return;
    const s = this.s;
    s.state = "open"; s.match = null; s.queuedAt = 0; s.readyAt = 0; s.fillAt = 0; s.startingSince = 0; s.error = error;
    // members still in the game have no lobby socket: they get the usual seat grace from now to come back
    const on = this.online();
    for (const [pid, m] of Object.entries(s.members)) { m.ready = false; if (!on.has(pid)) m.gone = Date.now(); }
    if (on.size === 0) s.emptySince = Date.now();
    await this.changed(!fromDirectory);
  }

  async schedule() {
    const s = this.s, t = [];
    if (this.startAt()) t.push(this.startAt());
    if (s.state === "queued") t.push(Date.now() + QUEUE_RETRY_MS);
    if (s.state === "starting" && s.startingSince) t.push(s.startingSince + START_TIMEOUT_MS);
    if (s.state === "open") for (const m of Object.values(s.members)) if (m.gone) t.push(m.gone + SEAT_GRACE_MS);
    if (s.emptySince && s.state !== "in_match") t.push(s.emptySince + EXPIRE_MS);
    if (t.length) await this.ctx.storage.setAlarm(Math.min(...t)); else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const s = this.s;
    if (!s) return;
    const now = Date.now();
    if (s.emptySince && s.state !== "in_match" && now >= s.emptySince + EXPIRE_MS) {
      await this.dir().remove(s.code);
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    if (s.state === "queued") return this.start(s.startMode || "queued");
    if (s.state === "starting" && s.startingSince && now >= s.startingSince + START_TIMEOUT_MS) {
      await this.dir().releaseSlot(s.code);
      return this.matchEnded(false, "The game server didn't start. Try again.");
    }
    if (s.state === "open") {
      for (const [pid, m] of Object.entries(s.members)) if (m.gone && now >= m.gone + SEAT_GRACE_MS) this.removeMember(pid);
      this.tick();
      const at = this.startAt();
      if (at && now >= at) return this.start(s.readyAt && now >= s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5) ? "all_ready" : "fill");
    }
    await this.changed();
  }

  view(pid) {
    const s = this.s, on = this.online(), me = s.members[pid];
    const at = this.startAt(), startsIn = at ? Math.max(0, at - Date.now()) : 0, fill = !!at && !s.readyAt;
    let go = null;
    if (s.match && me) {
      const q = new URLSearchParams({ key: s.match.key, name: me.name, lobby: `${s.origin}/?code=${s.code}`, pid: me.gpid || "" });
      if (me.char >= 0) q.set("char", String(me.char));
      go = `${s.match.url}/?${q}`;
    }
    return {
      t: "state", code: s.code, state: s.state, public: s.public, seeking: s.seeking, fill, seats: SEATS, minHumans: +(this.env.MIN_HUMANS || 2),
      you: me?.n ?? 0, host: s.members[s.host]?.n ?? 0, startsIn, error: s.error, go,
      queuePos: s.state === "queued" ? s.queuePos || 0 : 0, progress: s.match?.progress || null,
      members: s.order.map((p, i) => {
        const m = s.members[p];
        return { n: m.n, name: m.name, char: m.char, ready: m.ready, online: on.has(p), role: i < SEATS ? "player" : "spectator" };
      }),
    };
  }
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast() {
    if (!this.s) return;
    for (const ws of this.sockets()) this.send(ws, this.view(ws.deserializeAttachment()?.pid));
  }
}

// ------------------------------------------------------------------------------------------- directory
// One instance: which codes exist (for uniqueness and the public list), create rate limits, and which pool
// server each lobby holds. Checks held servers every minute and hands them back once their relay has
// been empty (no peers, no downloads) for IDLE_RELEASE_SECS.
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lobbies(code TEXT PRIMARY KEY, state TEXT, public INTEGER, players INTEGER, updated INTEGER, seeking INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, code TEXT NOT NULL, since INTEGER, empty INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS creates(ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, url TEXT DEFAULT '', max INTEGER DEFAULT 0, running INTEGER DEFAULT 0,
        drain INTEGER DEFAULT 0, load REAL DEFAULT 0, cpu REAL DEFAULT 0, up_kbps INTEGER DEFAULT 0, version TEXT DEFAULT '',
        beat INTEGER DEFAULT 0, connected INTEGER DEFAULT 0, gone INTEGER DEFAULT 0, info TEXT DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS pmatch(code TEXT PRIMARY KEY, host TEXT NOT NULL, state TEXT NOT NULL, since INTEGER, url TEXT);
      CREATE TABLE IF NOT EXISTS queue(code TEXT PRIMARY KEY, at INTEGER, seen INTEGER);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, host TEXT, code TEXT, name TEXT, data TEXT);`);
    try { this.sql.exec("ALTER TABLE lobbies ADD COLUMN seeking INTEGER DEFAULT 0"); } catch {}   // table from before quick play
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));   // agent keepalive, no wake-up
  }
  lobby(code) { return this.env.LOBBY.get(this.env.LOBBY.idFromName(code)); }
  async ensureAlarm() { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60e3); }

  reserveCode(ipHash) {
    const now = Date.now();
    this.sql.exec("DELETE FROM creates WHERE at < ?", now - 600e3);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM creates WHERE ip = ?", ipHash).one().n >= CREATES_PER_10MIN)
      return { error: "Too many lobbies from here. Try again in a few minutes." };
    for (let tries = 0; tries < 20; tries++) {
      const rnd = crypto.getRandomValues(new Uint8Array(5));
      const code = [...rnd].map((b) => ALPHABET[b % ALPHABET.length]).join("");
      if (this.sql.exec("SELECT 1 FROM lobbies WHERE code = ?", code).toArray().length) continue;
      this.sql.exec("INSERT INTO lobbies (code, state, public, players, updated) VALUES (?, 'open', 0, 0, ?)", code, now);
      this.sql.exec("INSERT INTO creates VALUES (?, ?)", ipHash, now);
      return { code };
    }
    return { error: "Couldn't make a code, try again." };
  }

  report(code, { state, public: pub, seeking, players }) {
    this.sql.exec("INSERT OR REPLACE INTO lobbies (code, state, public, players, updated, seeking) VALUES (?, ?, ?, ?, ?, ?)",
      code, state, pub ? 1 : 0, players, Date.now(), seeking ? 1 : 0);
  }
  // Quick play: an open public lobby with a free seat. Ones looking for players first, then the fullest.
  // The seat is held at once (players + 1) so two people arriving together don't both count on the last one.
  quickMatch() {
    const row = this.sql.exec(`SELECT code FROM lobbies WHERE public = 1 AND state = 'open' AND players > 0 AND players < ? AND updated > ?
      ORDER BY seeking DESC, players DESC, updated DESC LIMIT 1`, SEATS, Date.now() - QUICK_FRESH_MS).toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE lobbies SET players = players + 1 WHERE code = ?", row.code);
    return row.code;
  }
  remove(code) {
    this.sql.exec("DELETE FROM lobbies WHERE code = ?", code);
    this.sql.exec("DELETE FROM slots WHERE code = ?", code);
    this.dropPool(code);
  }
  // the lobby doesn't want its pool server (or its place in line) any more
  dropPool(code) {
    const pm = this.sql.exec("SELECT host FROM pmatch WHERE code = ?", code).toArray()[0];
    if (pm) { this.sendHost(pm.host, { t: "stop", code, reason: "lobby" }); this.sql.exec("DELETE FROM pmatch WHERE code = ?", code); }
    this.sql.exec("DELETE FROM queue WHERE code = ?", code);
  }
  listPublic() {
    return this.sql.exec("SELECT code, players, seeking FROM lobbies WHERE public = 1 AND state = 'open' AND players < ? AND updated > ? ORDER BY seeking DESC, updated DESC LIMIT 20",
      SEATS, Date.now() - 30 * 60e3).toArray();
  }

  // Where this lobby plays: {pending, host} a pool-agent is starting a server of its own (the lobby's matchReady
  // follows), {id, url} a free static POOL server, {position} its place in line. Rows are written before any
  // await: other calls run while one is awaiting, and must not take the same capacity.
  async claimSlot(code) {
    const now = Date.now();
    const pm = this.sql.exec("SELECT host, state FROM pmatch WHERE code = ?", code).toArray()[0];
    if (pm && pm.state !== "finished") return { pending: true, host: pm.host };
    if (pm) { this.sendHost(pm.host, { t: "stop", code, reason: "rematch" }); this.sql.exec("DELETE FROM pmatch WHERE code = ?", code); }
    const servers = pool(this.env);
    const held = this.sql.exec("SELECT id FROM slots WHERE code = ?", code).toArray()[0];
    if (held && servers.some((s) => s.id === held.id)) return servers.find((s) => s.id === held.id);
    // first come, first served: a lobby that asked earlier (and still asks, every 10 s) goes first
    this.sql.exec("DELETE FROM queue WHERE seen < ?", now - 60e3);
    this.sql.exec("INSERT INTO queue (code, at, seen) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET seen = excluded.seen", code, now, now);
    const at = this.sql.exec("SELECT at FROM queue WHERE code = ?", code).one().at;
    const ahead = this.sql.exec("SELECT COUNT(*) AS n FROM queue WHERE at < ? OR (at = ? AND code < ?)", at, at, code).one().n;
    const hosts = this.freeHosts();
    if (ahead < hosts.reduce((a, h) => a + h.free, 0)) {
      for (const h of hosts) {
        if (!this.sendHost(h.id, { t: "start", code })) continue;
        this.sql.exec("INSERT INTO pmatch (code, host, state, since, url) VALUES (?, ?, 'starting', ?, ?)", code, h.id, now, h.url);
        this.sql.exec("DELETE FROM queue WHERE code = ?", code);
        await this.ensureAlarm();
        return { pending: true, host: h.id };
      }
    }
    // no lobby server free: a static pool server nobody is on, for whoever is first in line
    if (ahead === 0) for (const srv of servers) {
      if (this.sql.exec("SELECT 1 FROM slots WHERE id = ?", srv.id).toArray().length) continue;
      this.sql.exec("INSERT INTO slots (id, code, since) VALUES (?, ?, ?)", srv.id, code, Date.now());
      if (isFree(await relayHealth(srv.url))) {
        this.sql.exec("DELETE FROM queue WHERE code = ?", code);
        await this.ensureAlarm();
        return srv;
      }
      this.sql.exec("DELETE FROM slots WHERE id = ? AND code = ?", srv.id, code);   // busy (friends on it) or down
    }
    await this.ensureAlarm();
    return { position: ahead + 1 };
  }
  releaseSlot(code) { this.sql.exec("DELETE FROM slots WHERE code = ?", code); this.dropPool(code); }

  // ------------------------------------------------------------------ pool-agents (web/pool-agent.js)
  // Hosts taking lobbies now, most room first: connected, heard from lately, not draining, below their cap.
  freeHosts() {
    const now = Date.now();
    return this.sql.exec("SELECT id, url, max, running, drain FROM hosts WHERE connected = 1 AND beat > ?", now - HOST_STALE_MS).toArray()
      .filter((h) => !h.drain && h.url && this.ctx.getWebSockets(`host:${h.id}`).length)
      .map((h) => ({ ...h, free: h.max - Math.max(h.running, this.sql.exec("SELECT COUNT(*) AS n FROM pmatch WHERE host = ?", h.id).one().n) }))
      .filter((h) => h.free > 0).sort((a, b) => b.free - a.free);
  }
  sendHost(host, o) {
    for (const ws of this.ctx.getWebSockets(`host:${host}`)) { try { ws.send(JSON.stringify(o)); return true; } catch {} }
    return false;
  }
  capacity() {
    const now = Date.now();
    return {
      hosts: this.sql.exec("SELECT * FROM hosts").toArray().map((h) => ({ id: h.id, online: !!h.connected && now - h.beat < HOST_STALE_MS,
        running: h.running, max: h.max, drain: !!h.drain, load: h.load, cpu: h.cpu, upKbps: h.up_kbps, version: h.version,
        beatSecs: h.beat ? Math.round((now - h.beat) / 1000) : null })),
      queued: this.sql.exec("SELECT COUNT(*) AS n FROM queue WHERE seen > ?", now - 60e3).one().n,
      static: pool(this.env).length,
    };
  }

  // a pool-agent connecting (the Worker checked its signature and passes the host id)
  async fetch(req) {
    const host = req.headers.get("X-CSP-Agent-Host");
    if (!host) return new Response("not found", { status: 404 });
    for (const ws of this.ctx.getWebSockets(`host:${host}`)) try { ws.close(4000, "replaced by a new connection"); } catch {}
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`host:${host}`]);
    server.serializeAttachment({ host });
    this.sql.exec("INSERT INTO hosts (id, connected, beat) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET connected = 1, beat = excluded.beat, gone = 0", host, Date.now());
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const host = ws.deserializeAttachment()?.host;
    if (!host || typeof raw !== "string" || raw.length > 65536) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    this.sql.exec("UPDATE hosts SET beat = ?, connected = 1, gone = 0 WHERE id = ?", now, host);
    const code = /^[A-Z2-9]{5}$/.test(m.code || "") ? m.code : "";
    const row = code ? this.sql.exec("SELECT * FROM pmatch WHERE code = ? AND host = ?", code, host).toArray()[0] : null;
    switch (m.t) {
      case "hello": case "cap": {
        const h = this.sql.exec("SELECT * FROM hosts WHERE id = ?", host).one();
        this.sql.exec("UPDATE hosts SET url = ?, max = ?, drain = ?, running = ?, load = ?, cpu = ?, up_kbps = ?, version = ?, info = ? WHERE id = ?",
          String(m.url ?? h.url).slice(0, 200), +(m.max ?? h.max) || 0, m.drain ? 1 : 0, +(m.running ?? m.lobbies?.length ?? h.running) || 0,
          +(m.load ?? h.load) || 0, +(m.cpu ?? h.cpu) || 0, +(m.upKbps ?? h.up_kbps) || 0, String(m.version ?? h.version).slice(0, 20),
          m.t === "cap" ? JSON.stringify(m.lobbies || []).slice(0, 8000) : h.info, host);
        if (m.t === "hello") await this.reconcile(host, m.lobbies || []);
        break;
      }
      case "started": {
        if (!row) { this.sendHost(host, { t: "stop", code, reason: "no such lobby match" }); break; }
        const url = String(row.url || m.url);
        this.sql.exec("UPDATE pmatch SET state = 'running', since = ? WHERE code = ?", now, code);
        this.sql.exec("UPDATE lobbies SET state = 'in_match', updated = ? WHERE code = ?", now, code);
        if (!(await this.lobby(code).matchReady(host, url))) {
          this.sendHost(host, { t: "stop", code, reason: "lobby moved on" });
          this.sql.exec("DELETE FROM pmatch WHERE code = ?", code);
        }
        break;
      }
      case "start_failed":
        if (!row) break;
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", code);
        // a full or draining host isn't the lobby's fault: it just goes back in line
        await this.lobby(code).matchFailed(String(m.error), m.error !== "full" && m.error !== "draining");
        break;
      case "ended":
        if (!row) break;
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", code);
        if (row.state === "starting") await this.lobby(code).matchFailed(String(m.reason));
        else if (row.state === "running") await this.lobby(code).matchEnded(true, m.reason === "crashed" ? "The game server stopped unexpectedly." : "");
        break;   // finished: the lobby reopened when the match did
      case "ev": {
        const name = String(m.name || "").slice(0, 32);
        this.sql.exec("INSERT INTO events (at, host, code, name, data) VALUES (?, ?, ?, ?, ?)", +m.at || now, host, code, name, JSON.stringify(m.data || {}).slice(0, 2000));
        if (!row) break;
        if (name === "match_finished" && row.state === "running") {
          // back to the lobby for a rematch; the server lingers on the results (the agent stops it)
          this.sql.exec("UPDATE pmatch SET state = 'finished' WHERE code = ?", code);
          this.sql.exec("UPDATE lobbies SET state = 'open', updated = ? WHERE code = ?", now, code);
          await this.lobby(code).matchEnded(true);
        } else if (row.state === "running") await this.lobby(code).progress(name, m.data || {});
        break;
      }
    }
  }

  // An agent (re)connected and says what it runs. Matches it no longer has are over; servers we know nothing of go.
  async reconcile(host, list) {
    const running = new Set(list.map((l) => l.code));
    for (const row of this.sql.exec("SELECT * FROM pmatch WHERE host = ?", host).toArray()) {
      if (running.has(row.code)) continue;
      this.sql.exec("DELETE FROM pmatch WHERE code = ?", row.code);
      if (row.state === "starting") await this.lobby(row.code).matchFailed("agent restarted", false);
      else if (row.state === "running") await this.lobby(row.code).matchEnded(true, "The game server restarted. Start again when you're ready.");
    }
    for (const code of running)
      if (!this.sql.exec("SELECT 1 FROM pmatch WHERE code = ? AND host = ?", code, host).toArray().length) this.sendHost(host, { t: "stop", code, reason: "unknown" });
  }

  async webSocketClose(ws) {
    try { ws.close(1000); } catch {}
    const host = ws.deserializeAttachment()?.host;
    if (!host || this.ctx.getWebSockets(`host:${host}`).some((w) => w !== ws)) return;   // replaced by a newer one
    this.sql.exec("UPDATE hosts SET connected = 0, gone = ? WHERE id = ?", Date.now(), host);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  async alarm() {
    const now = Date.now();
    // pool-agents: silent ones take no new lobbies; matches whose server never came up, or whose agent is long gone, end
    this.sql.exec("UPDATE hosts SET connected = 0, gone = ? WHERE connected = 1 AND beat < ?", now, now - HOST_STALE_MS);
    for (const row of this.sql.exec("SELECT p.*, h.connected, h.gone FROM pmatch p LEFT JOIN hosts h ON h.id = p.host").toArray()) {
      const lost = !row.connected && now - (row.gone || 0) > ORPHAN_MS;
      if (row.state === "starting" && now - row.since > START_TIMEOUT_MS) {
        this.sendHost(row.host, { t: "stop", code: row.code, reason: "start timeout" });
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", row.code);
        await this.lobby(row.code).matchFailed("start timeout");
      } else if (lost || now - row.since > MATCH_MAX_MS) {
        this.sendHost(row.host, { t: "stop", code: row.code, reason: lost ? "orphaned" : "max time" });
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", row.code);
        if (row.state !== "finished") await this.lobby(row.code).matchEnded(true, lost ? "Lost the game server." : "");
      }
    }
    this.sql.exec("DELETE FROM queue WHERE seen < ?", now - 60e3);
    this.sql.exec("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - 5000");
    const servers = pool(this.env);
    // a started server isn't checked for "everyone left" before this (downloads, map load)
    const grace = 1000 * +(this.env.MATCH_GRACE_SECS ?? 240);
    for (const row of this.sql.exec("SELECT id, code, since, empty FROM slots").toArray()) {
      const srv = servers.find((s) => s.id === row.id);
      let release = !srv || now - row.since > MATCH_MAX_MS;
      if (!release && now - row.since > grace) {
        const h = await relayHealth(srv.url);
        const empty = isFree(h) && h.idleSecs >= IDLE_RELEASE_SECS ? row.empty + 1 : 0;
        this.sql.exec("UPDATE slots SET empty = ? WHERE id = ?", empty, row.id);
        release = empty >= 2;   // two checks a minute apart: a map change can blip the count
      }
      if (release) {
        this.sql.exec("DELETE FROM slots WHERE id = ?", row.id);
        this.sql.exec("UPDATE lobbies SET state = 'open', updated = ? WHERE code = ?", now, row.code);
        await this.env.LOBBY.get(this.env.LOBBY.idFromName(row.code)).matchEnded(true);
      }
    }
    this.sql.exec("DELETE FROM lobbies WHERE updated < ?", now - 24 * 3600e3);
    const busy = this.sql.exec(`SELECT (SELECT COUNT(*) FROM slots) + (SELECT COUNT(*) FROM pmatch) + (SELECT COUNT(*) FROM queue)
      + (SELECT COUNT(*) FROM hosts WHERE connected = 1) AS n`).one().n;
    if (busy) await this.ctx.storage.setAlarm(now + 60e3);
  }
}
