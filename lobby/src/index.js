// CS Party lobby API (#3989): party codes, roster, ready-up, and handing a lobby a game server.
// Design: docs/lobby-design.md. Phase 1: the "capacity" is a static pool of game servers that are already
// running (env POOL), each behind web/relay.js. Starting a match picks a free one and gives every member a
// link to it carrying a per-lobby party key (an HMAC token the relay checks with the shared LOBBY_SECRET).
// The plugin's own lobby countdown (csp_autostart) then starts the match on the server, bots filling seats.
//
//   POST /api/lobbies            {pid, name, char, public}  -> {code}
//   GET  /api/lobbies/:code      -> {code, state, players, public}  (404 if no such lobby)
//   GET  /api/lobbies/:code/ws?pid=&name=&char=   WebSocket: roster, ready, start (see Lobby.webSocketMessage)
//   GET  /api/public             -> open public lobbies
//   GET  /healthz
import { DurableObject } from "cloudflare:workers";

const SEATS = 4;
// 5 characters, no 0/O/1/I/L: 31^5 is about 29M codes
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const PID_RE = /^[A-Za-z0-9-]{8,64}$/;
const EXPIRE_MS = 15 * 60e3;          // lobby with nobody in it for this long is gone
const SEAT_GRACE_MS = 90e3;           // a dropped tab keeps its seat this long while the lobby is open
const QUEUE_RETRY_MS = 10e3;          // no free server: try again this often
const CREATES_PER_10MIN = 10;         // per IP
const MATCH_MAX_MS = 3 * 3600e3;      // hard cap on how long a lobby holds a server

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

// What a relay's /healthz says: connected browser peers, game data downloads in flight, seconds since either.
// null if it doesn't answer. Cache-busted: Cloudflare cached probes before.
const relayHealth = async (url) => {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/healthz?t=${Date.now()}`, { cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const h = await r.json();
    return Number.isInteger(h.peers) ? { peers: h.peers, downloads: h.downloads || 0, idleSecs: h.idleSecs ?? Infinity } : null;
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
    if (p === "/api/lobbies" && req.method === "POST") {
      let body = {}; try { body = await req.json(); } catch {}
      if (!PID_RE.test(body.pid || "")) return json({ error: "bad player id" }, 400);
      const ip = req.headers.get("cf-connecting-ip") || "local";
      const ipHash = await sha(`${ip}|${new Date().toISOString().slice(0, 10)}|${env.LOBBY_SECRET || ""}`);
      const r = await dir.reserveCode(ipHash);
      if (r.error) return json(r, 429);
      await env.LOBBY.get(env.LOBBY.idFromName(r.code)).init(r.code, { pid: body.pid, name: nick(body.name), char: charOf(body.char), public: !!body.public });
      return json({ code: r.code });
    }
    if (p === "/api/public" && req.method === "GET") return json({ lobbies: await dir.listPublic() });
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
    this.ctx.blockConcurrencyWhile(async => { this.s = (await this.ctx.storage.get("s")) || null; });
  }
  dir() { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")); }
  async save() { await this.ctx.storage.put("s", this.s); }

  async init(code, { pid, name, char, public: pub }) {
    const now = Date.now();
    this.s = { code, created: now, host: pid, state: "open", public: pub, nextN: 1, members: {}, order: [],
      readyAt: 0, match: null, queuedAt: 0, error: "", emptySince: now };
    this.addMember(pid, name, char);
    await this.save();
    await this.schedule();
  }

  async info() {
    if (!this.s) return null;
    return { code: this.s.code, state: this.s.state, public: this.s.public, players: this.s.order.length, seats: SEATS };
  }

  addMember(pid, name, char) {
    const s = this.s;
    if (!s.members[pid]) {
      s.members[pid] = { n: s.nextN++, name, char: -1, ready: false, joined: Date.now(), gone: 0 };
      s.order.push(pid);
    }
    const m = s.members[pid];
    m.name = name; m.gone = 0;
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
      case "public": if (isHost) s.public = !!msg.public; break;
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
  async changed(report = true) {
    const s = this.s;
    if (s.state === "open") {
      if (this.allReady()) s.readyAt ||= Date.now();
      else s.readyAt = 0;
    }
    await this.save();
    await this.schedule();
    this.broadcast();
    if (report) await this.dir().report(s.code, { state: s.state, public: s.public, players: s.order.length });
  }

  async start(mode) {
    const s = this.s;
    s.state = "starting"; s.readyAt = 0; s.startMode = mode;
    await this.save(); this.broadcast();
    const slot = await this.dir().claimSlot(s.code);
    if (!slot) {
      s.state = "queued"; s.queuedAt ||= Date.now();
      s.error = "Every server is busy. Waiting for one to free up…";
      return this.changed();
    }
    const exp = Math.floor(Date.now() / 1000) + 3600 * +(this.env.TOKEN_HOURS || 3);
    const key = await lobbyToken(this.env.LOBBY_SECRET || "", slot.id, s.code, exp);
    s.match = { slot: slot.id, url: slot.url.replace(/\/$/, ""), key, started: Date.now(), mode };
    s.state = "in_match"; s.queuedAt = 0; s.error = "";
    for (const m of Object.values(s.members)) m.ready = false;
    await this.changed();
  }

  // the directory saw the server empty out (or the host ended it): back to the lobby for a rematch
  async matchEnded(fromDirectory = false) {
    if (!this.s) return;
    const s = this.s;
    s.state = "open"; s.match = null; s.queuedAt = 0; s.readyAt = 0;
    // members still in the game have no lobby socket: they get the usual seat grace from now to come back
    const on = this.online();
    for (const [pid, m] of Object.entries(s.members)) { m.ready = false; if (!on.has(pid)) m.gone = Date.now(); }
    if (on.size === 0) s.emptySince = Date.now();
    await this.changed(!fromDirectory);
  }

  async schedule() {
    const s = this.s, t = [];
    if (s.readyAt) t.push(s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5));
    if (s.state === "queued") t.push(Date.now() + QUEUE_RETRY_MS);
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
    if (s.state === "open") {
      for (const [pid, m] of Object.entries(s.members)) if (m.gone && now >= m.gone + SEAT_GRACE_MS) this.removeMember(pid);
      if (s.readyAt && this.allReady() && now >= s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5)) return this.start("all_ready");
    }
    await this.changed();
  }

  view(pid) {
    const s = this.s, on = this.online(), me = s.members[pid];
    const startsIn = s.readyAt ? Math.max(0, s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5) - Date.now()) : 0;
    let go = null;
    if (s.match && me) {
      const q = new URLSearchParams({ key: s.match.key, name: me.name, lobby: `${s.origin}/?code=${s.code}` });
      if (me.char >= 0) q.set("char", String(me.char));
      go = `${s.match.url}/?${q}`;
    }
    return {
      t: "state", code: s.code, state: s.state, public: s.public, seats: SEATS, minHumans: +(this.env.MIN_HUMANS || 2),
      you: me?.n ?? 0, host: s.members[s.host]?.n ?? 0, startsIn, error: s.error, go,
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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lobbies(code TEXT PRIMARY KEY, state TEXT, public INTEGER, players INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, code TEXT NOT NULL, since INTEGER, empty INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS creates(ip TEXT, at INTEGER);`);
  }

  reserveCode(ipHash) {
    const now = Date.now();
    this.sql.exec("DELETE FROM creates WHERE at < ?", now - 600e3);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM creates WHERE ip = ?", ipHash).one().n >= CREATES_PER_10MIN)
      return { error: "Too many lobbies from here. Try again in a few minutes." };
    for (let tries = 0; tries < 20; tries++) {
      const rnd = crypto.getRandomValues(new Uint8Array(5));
      const code = [...rnd].map((b) => ALPHABET[b % ALPHABET.length]).join("");
      if (this.sql.exec("SELECT 1 FROM lobbies WHERE code = ?", code).toArray().length) continue;
      this.sql.exec("INSERT INTO lobbies VALUES (?, 'open', 0, 0, ?)", code, now);
      this.sql.exec("INSERT INTO creates VALUES (?, ?)", ipHash, now);
      return { code };
    }
    return { error: "Couldn't make a code, try again." };
  }

  report(code, { state, public: pub, players }) {
    this.sql.exec("INSERT OR REPLACE INTO lobbies VALUES (?, ?, ?, ?, ?)", code, state, pub ? 1 : 0, players, Date.now());
  }
  remove(code) {
    this.sql.exec("DELETE FROM lobbies WHERE code = ?", code);
    this.sql.exec("DELETE FROM slots WHERE code = ?", code);
  }
  listPublic() {
    return this.sql.exec("SELECT code, players FROM lobbies WHERE public = 1 AND state = 'open' AND players < ? AND updated > ? ORDER BY updated DESC LIMIT 20",
      SEATS, Date.now() - 30 * 60e3).toArray();
  }

  // A free pool server for this lobby, or null. The slot row is written before the health probe: other calls
  // run while we await the fetch, and must not pick the same server.
  async claimSlot(code) {
    const held = this.sql.exec("SELECT id FROM slots WHERE code = ?", code).toArray()[0];
    const servers = pool(this.env);
    if (held) return servers.find((s) => s.id === held.id) || null;
    for (const srv of servers) {
      if (this.sql.exec("SELECT 1 FROM slots WHERE id = ?", srv.id).toArray().length) continue;
      this.sql.exec("INSERT INTO slots (id, code, since) VALUES (?, ?, ?)", srv.id, code, Date.now());
      if (isFree(await relayHealth(srv.url))) {
        if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60e3);
        return srv;
      }
      this.sql.exec("DELETE FROM slots WHERE id = ? AND code = ?", srv.id, code);   // busy (friends on it) or down
    }
    return null;
  }
  releaseSlot(code) { this.sql.exec("DELETE FROM slots WHERE code = ?", code); }

  async alarm() {
    const now = Date.now();
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
    if (this.sql.exec("SELECT COUNT(*) AS n FROM slots").one().n) await this.ctx.storage.setAlarm(now + 60e3);
  }
}
