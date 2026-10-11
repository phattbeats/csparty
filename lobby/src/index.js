// CS Party lobby API (#3989): party codes, roster, ready-up, and handing a lobby a game server.
// Design: docs/lobby-design.md. Phase 1: the "capacity" is a static pool of game servers that are already
// running (env POOL), each behind web/relay.js. Starting a match picks a free one and gives every member a
// link to it carrying a per-lobby party key (an HMAC token the relay checks with the shared LOBBY_SECRET).
// The plugin's own lobby countdown (csp_autostart) then starts the match on the server, bots filling seats.
// Phase 3 (#3991): analytics events (src/analytics.js) and the admin dashboard and its actions (src/admin.js).
//
//   POST /api/lobbies            {pid, name, char, public, seeking}  -> {code}
//   POST /api/quickplay          {pid, name, char}  -> {code, created}  join the fullest open public lobby, or make one
//   GET  /api/lobbies/:code      -> {code, state, players, public}  (404 if no such lobby)
//   GET  /api/lobbies/:code/ws?pid=&name=&char=&via=   WebSocket: roster, ready, start (see Lobby.webSocketMessage)
//   GET  /api/public             -> open public lobbies
//   GET  /api/capacity           -> lobby servers: hosts (running/max/load), queue length. No lobby codes.
//   GET  /api/agent?host=ID      WebSocket for a pool-agent (web/pool-agent.js), "Authorization: CSP-Agent ts.sig"
//   GET  /api/status             -> {paused, message, notice}: maintenance banner for the lobby page
//   POST /api/events             game server events, signed with LOBBY_SECRET (see admin.js ingest)
//   /api/admin/*                 admin dashboard API, bearer ADMIN_TOKEN (see admin.js)
//   GET  /healthz
//
// Phase 2 (#4154): pool-agents on game hosts connect out to the directory and start one game server container
// per lobby. A lobby goes to a pool-agent first, then to a free static POOL server, else it queues (first come,
// first served, with its place in line shown).
import { DurableObject } from "cloudflare:workers";
import { SEATS, ALPHABET, CODE_RE, PID_RE, json, nick, charOf, pool, hmac, b64url, sha, safeEqual, ipKey, pidKey, relayHealth, isFree } from "./util.js";
import { EVENTS, datapoint, blob, num, secs, hourOf, dayOf, ttsBucket } from "./analytics.js";
import { adminFetch, ingestFetch, adminOp } from "./admin.js";

const EXPIRE_MS = 15 * 60e3;          // lobby with nobody in it for this long is gone
const SEAT_GRACE_MS = 90e3;           // a dropped tab keeps its seat this long while the lobby is open
const QUEUE_RETRY_MS = 10e3;          // no free server: try again this often
const QUICK_FRESH_MS = 10 * 60e3;     // quick play only joins lobbies that changed this recently
const CREATES_PER_10MIN = 10;         // per IP (admin can change it)
const MATCH_MAX_MS = 3 * 3600e3;      // hard cap on how long a lobby holds a server
const START_TIMEOUT_MS = 7 * 60e3;    // a lobby server that hasn't come up by now isn't going to
const HOST_STALE_MS = 90e3;           // a pool-agent heard from less recently than this takes no new lobbies
const ORPHAN_MS = 10 * 60e3;          // its agent gone this long: the lobby's match is written off
const START_FAILS = 3;                // lobby servers failing to start in a row before the lobby gives up
const ACTIVE_MS = 30 * 60e3;          // the directory probes servers every minute while a lobby changed this recently
const VIA = new Set(["code", "link", "public", "quick", "create"]);

// Party key for one lobby on one server: CODE.EXPIRY.SIG. web/relay.js checks it the same way (lobbyKeyOk).
export const lobbyToken = async (secret, slotId, code, exp) =>
  `${code}.${exp}.${b64url((await hmac(secret, `csp-lobby|${slotId}|${code}|${exp}`)).slice(0, 18))}`;
// A pool-agent proves it holds LOBBY_SECRET: "CSP-Agent <ts>.<sig>", sig = HMAC("csp-agent|<host>|<ts>"), ts within 5 min.
const agentAuthOk = async (env, host, auth) => {
  const m = /^CSP-Agent (\d{9,11})\.([\w-]{43})$/.exec(auth || "");
  if (!env.LOBBY_SECRET || !/^[\w-]{1,32}$/.test(host) || !m || Math.abs(Date.now() / 1000 - +m[1]) > 300) return false;
  return safeEqual(m[2], b64url(await hmac(env.LOBBY_SECRET, `csp-agent|${host}|${m[1]}`)));
};
// The plugin's [CSPEV] lines (shipped by the pool-agent) as analytics game events (analytics.js EVENTS); null if not one.
const cspev = (name, d) => {
  switch (name) {
    case "turn": return { e: "turn_taken", b: [""], d: [d.turn] };
    case "minigame_picked": return { e: "minigame_picked", b: [d.mg, d.fmt], d: [d.turn] };
    case "minigame_result": return { e: "minigame_result", b: [d.mg, (Array.isArray(d.winners) ? d.winners : []).join("+") || "none"], d: [d.secs, d.participants] };
    case "match_finished": return { e: "match_finished", b: [d.winner, String(d.awards ?? "")], d: [d.secs, d.turns, d.humans] };
    case "match_aborted": return { e: "match_abandoned", b: ["stopped"], d: [d.secs, d.turn] };
    default: return null;
  }
};
// the id a member's game client carries (setinfo _csp_pid): their seat across a dropped connection. Not their
// lobby player id, which never leaves the lobby.
const gamePid = () => b64url(crypto.getRandomValues(new Uint8Array(9)));
// a first visit downloads for minutes with no peer open; the gaps between the download and joining are short
const IDLE_RELEASE_SECS = 90;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/healthz") return json({ ok: true });
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    const ip = req.headers.get("cf-connecting-ip") || "local";
    const cc = blob(req.headers.get("cf-ipcountry") || "");
    if (p.startsWith("/api/admin/")) return adminFetch(req, env, dir, await ipKey(ip, env));
    if (p === "/api/events" && req.method === "POST") return ingestFetch(req, env, dir);
    if (p === "/api/status" && req.method === "GET") return json(await dir.status());
    const makeLobby = async (body, pub, seeking, via) => {
      const r = await dir.reserveCode(await ipKey(ip, env), await pidKey(body.pid, env));
      if (r.error) return json({ error: r.error }, r.status || 429);
      if (r.publicOff) pub = seeking = false;
      await env.LOBBY.get(env.LOBBY.idFromName(r.code)).init(r.code,
        { pid: body.pid, name: nick(body.name), char: charOf(body.char), public: pub || seeking, seeking, via, cc });
      return json({ code: r.code, created: true });
    };
    if ((p === "/api/lobbies" || p === "/api/quickplay") && req.method === "POST") {
      let body = {}; try { body = await req.json(); } catch {}
      if (!PID_RE.test(body.pid || "")) return json({ error: "bad player id" }, 400);
      if (p === "/api/lobbies") return makeLobby(body, !!body.public, !!body.seeking, "create");
      // quick play: the fullest open public lobby (one looking for players first); none: start one that is
      for (let i = 0; i < 3; i++) {
        const code = await dir.quickMatch();
        if (!code) break;
        if (await env.LOBBY.get(env.LOBBY.idFromName(code)).info()) return json({ code, created: false });
        await dir.remove(code);   // the directory listed a lobby that is gone
      }
      return makeLobby(body, true, true, "quick");
    }
    if (p === "/api/pool" && req.method === "GET") {   // ops: what the Worker sees of each pool server
      return json({ slots: await dir.slotList(), servers: await Promise.all(pool(env).map(async (s) => {
        try {
          const r = await fetch(`${s.url.replace(/\/$/, "")}/healthz?t=${Date.now()}`, { cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(4000) });
          return { id: s.id, host: new URL(s.url).host, status: r.status, body: (await r.text()).slice(0, 160) };
        } catch (e) { return { id: s.id, host: new URL(s.url).host, error: String(e).slice(0, 160) }; }
      })) });
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
      // what the lobby may know about this connection, set here so a client can't supply it
      const ik = await ipKey(ip, env), pid = url.searchParams.get("pid") || "";
      if (PID_RE.test(pid) && (await dir.gate(ik, await pidKey(pid, env))).banned) {
        // accept and close at once with a reason the page shows (a refused upgrade just looks like a network error)
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.close(4003, "You can't join parties right now.");
        return new Response(null, { status: 101, webSocket: client });
      }
      const h = new Headers(req.headers);
      h.set("X-CSP-IpKey", ik); h.set("X-CSP-CC", cc);
      return lobby.fetch(new Request(req, { headers: h }));
    }
    if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};

// ---------------------------------------------------------------------------------------------- one lobby
// State lives in one storage key, cached in memory and reloaded when the object wakes from hibernation.
// Members are keyed by playerId (a random id in the browser's localStorage): a reloaded tab gets its seat back.
// Other members only ever see a member's short public number (n), never their playerId.
// Analytics: ev() queues an event; the queue goes to the directory with the next report (no extra requests).
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.closing = new Set();
    this.evq = [];
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => { this.s = (await this.ctx.storage.get("s")) || null; });
  }
  dir() { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("directory")); }
  async save() { await this.ctx.storage.put("s", this.s); }

  // e: event name (analytics.js EVENTS), b/d: its fields, x: {pid, cc, slot, k, v, roll: [[event, key, value]]}
  ev(e, b = [], d = [], x = {}) {
    const s = this.s;
    this.evq.push({ e, code: s.code, b, d, ...x });
    if (this.evq.length > 200) this.evq.shift();
    // the admin's lobby timeline (no ids in it)
    (s.log ||= []).push({ at: Date.now(), e, b: b.filter((v) => v !== "").join(" "), ...(x.n ? { n: x.n } : {}) });
    if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
  }
  flush() { const q = this.evq; this.evq = []; return q; }
  summary() {
    const s = this.s, on = this.online();
    return { state: s.state, public: s.public, seeking: s.seeking, players: s.order.length,
      online: s.order.filter((p) => on.has(p)).length, ready: s.order.filter((p) => s.members[p].ready).length,
      host: s.members[s.host]?.name || "", created: s.created };
  }

  async init(code, { pid, name, char, public: pub, seeking, via, cc }) {
    const now = Date.now();
    this.s = { code, created: now, host: pid, state: "open", public: pub, seeking: !!seeking, fillAt: 0, nextN: 1, members: {}, order: [],
      readyAt: 0, match: null, queuedAt: 0, error: "", emptySince: now, f: {}, matches: 0, log: [], notice: null };
    const m = this.addMember(pid, name, char);
    m.cc = cc;
    this.ev("lobby_created", [seeking ? "seeking" : pub ? "public" : "private", "-", via], [SEATS], { pid, cc, n: m.n, roll: [["funnel", "created"]] });
    await this.save();
    await this.schedule();
    await this.report();   // listed before anyone connects
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
  removeMember(pid, reason) {
    const s = this.s, m = s.members[pid];
    if (m && reason) this.ev("lobby_left", [s.state, reason], [secs(Date.now() - m.joined)], { pid, cc: m.cc, n: m.n });
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
    const cc = req.headers.get("X-CSP-CC") || "";
    server.serializeAttachment({ pid, ip: req.headers.get("X-CSP-IpKey") || "" });
    const s = this.s, old = s.members[pid], gone = old?.gone || 0;
    const m = this.addMember(pid, nick(url.searchParams.get("name")), charOf(url.searchParams.get("char")));
    m.cc = cc;
    if (!old) {
      const via = VIA.has(url.searchParams.get("via")) ? url.searchParams.get("via") : "code";
      const seat = s.order.indexOf(pid), second = s.order.length >= 2 && !s.f.second;
      if (second) s.f.second = 1;
      this.ev("lobby_joined", [seat < SEATS ? "guest" : "spectator", via], [s.order.length],
        { pid, cc, n: m.n, roll: second ? [["funnel", "second"]] : [] });
    } else if (gone) this.ev("reconnect", ["reattached"], [secs(Date.now() - gone)], { pid, cc, n: m.n });
    if (!s.host || !s.members[s.host]) s.host = pid;
    s.emptySince = 0;
    s.origin = url.origin;   // where the game page sends people back to
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
      case "ready":
        if (open && m.ready !== !!msg.ready) {
          m.ready = !!msg.ready;
          this.ev(m.ready ? "lobby_ready" : "lobby_unready", [], [secs(Date.now() - m.joined)], { pid, cc: m.cc, n: m.n });
        }
        break;
      case "public": if (isHost) { s.public = !!msg.public; if (!s.public) s.seeking = false; } break;
      // host: look for random players to fill the empty seats (lists the party publicly, quick play sends people here)
      case "seeking": if (isHost) { s.seeking = !!msg.seeking; if (s.seeking) s.public = true; } break;
      case "start": if (isHost && open) return this.start("host_force"); break;
      // host: everyone back to the lobby (match over, or stuck). Frees the server for the next lobby.
      case "end": if (isHost && s.state !== "open") { await this.dir().releaseSlot(s.code); return this.matchEnded(false, "host_end"); } break;
      case "leave":
        this.removeMember(pid, "leave");
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

  // a looking-for-players party also starts on its own FILL_SECS after it has enough people, ready or not
  seatedOnline() { const on = this.online(); return this.s.order.slice(0, SEATS).filter((p) => on.has(p)).length; }
  tick() {
    const s = this.s;
    if (s.state !== "open") { s.readyAt = 0; s.fillAt = 0; return; }
    const was = s.readyAt;
    if (this.allReady()) s.readyAt ||= Date.now(); else s.readyAt = 0;
    if (!was && s.readyAt) {
      const first = !s.f.allReady; s.f.allReady = 1;
      this.ev("lobby_all_ready", [], [secs(Date.now() - s.created), this.seatedOnline()], { roll: first ? [["funnel", "all_ready"]] : [] });
    }
    if (s.seeking && this.seatedOnline() >= +(this.env.MIN_HUMANS || 2)) s.fillAt ||= Date.now(); else s.fillAt = 0;
  }
  startAt() {
    const s = this.s, t = [];
    if (s.readyAt) t.push(s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5));
    if (s.fillAt) t.push(s.fillAt + 1000 * +(this.env.FILL_SECS || 20));
    return t.length ? Math.min(...t) : 0;
  }
  // report: tell the directory (not when the directory is the caller: a call back into it waits on itself)
  async changed(report = true) {
    this.tick();
    await this.save();
    await this.schedule();
    if (report) await this.report();
    this.broadcast();
  }
  // Roster summary and queued events to the directory. A failed call keeps the events for the next one. The
  // answer carries the current admin notice (broadcast), so a lobby made after a broadcast still shows it.
  async report() {
    const s = this.s, events = this.flush();
    try {
      const r = await this.dir().report(s.code, this.summary(), events);
      if (r && JSON.stringify(r.notice || null) !== JSON.stringify(s.notice || null)) { s.notice = r.notice || null; await this.save(); }
    } catch (e) {
      this.evq.unshift(...events);
      console.log(`lobby ${s.code}: report failed: ${e}`);
    }
  }

  async start(mode) {
    const s = this.s;
    s.state = "starting"; s.readyAt = 0; s.fillAt = 0; s.startMode = mode;
    await this.save(); this.broadcast();
    const slot = await this.dir().claimSlot(s.code);
    if (slot?.pending) {
      // a pool-agent is starting this lobby's own server; the directory calls matchReady when it's up
      s.state = "starting"; s.startingSince ||= Date.now(); s.queuePos = 0; s.error = "";
      return this.changed();
    }
    if (!slot?.url) {
      if (!s.queuedAt) this.ev("start_queued", [mode]);
      s.state = "queued"; s.queuedAt ||= Date.now(); s.queuePos = slot?.position || 0; s.startingSince = 0;
      s.error = s.queuePos ? `Every server is busy. You're number ${s.queuePos} in line…` : "Every server is busy. Waiting for one to free up…";
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
    const humans = this.seatedOnline(), first = !s.f.started, mode = s.startMode, wait = s.queuedAt ? secs(Date.now() - s.queuedAt) : 0;
    s.f.started = 1;
    this.ev("match_started", ["-", mode, slotId], [humans, Math.max(0, SEATS - humans), wait],
      { slot: slotId, k: mode, v: wait, roll: first ? [["funnel", "started"], ["tts", ttsBucket(secs(Date.now() - s.created))]] : [] });
    s.matches = (s.matches || 0) + 1;
    s.match = { slot: slotId, url: url.replace(/\/$/, ""), key, started: Date.now(), mode, pool, progress: null };
    s.state = "in_match"; s.queuedAt = 0; s.queuePos = 0; s.startingSince = 0; s.startFails = 0; s.error = "";
    for (const m of Object.values(s.members)) m.ready = false;
    await this.changed(!pool);   // pool: the directory is the caller
  }

  // ----- called by the directory (they never call back into it: a call cycle stalls both objects)
  // This lobby's server is up. false: the lobby has moved on (host ended it, expired), so the server should go.
  // Returns its analytics events (match_started), or null.
  async matchReady(host, url) {
    const s = this.s;
    if (!s || s.state !== "starting") return null;
    await this.inMatch(`${host}.pool`, url, true);
    return this.flush();
  }
  // The server didn't come up: try again from the queue, a few times
  async matchFailed(error, counts = true) {
    const s = this.s;
    if (!s || (s.state !== "starting" && s.state !== "in_match")) return [];
    s.match = null; s.startingSince = 0;
    if (counts) s.startFails = (s.startFails || 0) + 1;
    if (s.startFails >= START_FAILS) {
      s.state = "open"; s.startFails = 0; s.error = "Couldn't start a game server. Try again in a minute.";
    } else {
      s.state = "queued"; s.queuedAt = Date.now(); s.queuePos = 0; s.error = "The game server didn't start. Trying again…";
    }
    console.log(`lobby ${s.code}: server failed (${error})`);
    await this.changed(false);
    return this.flush();
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

  // the directory saw the server empty out or the match end (or the host ended it): back to the lobby for a
  // rematch. error: what the lobby page says about it. Called by the directory: no report back into it; the
  // events go back as the return value instead.
  async matchEnded(fromDirectory = false, reason = "server_empty", error = "") {
    if (!this.s) return [];
    const s = this.s;
    if (s.match) this.ev("match_closed", [reason, "", ""], [secs(Date.now() - s.match.started), 0], { slot: s.match.slot });
    s.state = "open"; s.match = null; s.queuedAt = 0; s.readyAt = 0; s.fillAt = 0; s.startingSince = 0; s.error = error;
    // members still in the game have no lobby socket: they get the usual seat grace from now to come back
    const on = this.online();
    for (const [pid, m] of Object.entries(s.members)) { m.ready = false; if (!on.has(pid)) m.gone = Date.now(); }
    if (on.size === 0) s.emptySince = Date.now();
    await this.changed(!fromDirectory);
    return fromDirectory ? this.flush() : [];
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
      this.ev("lobby_expired", [s.matches ? "played" : s.f?.second ? "joined" : "alone"], [secs(now - s.created), s.matches || 0]);
      await this.dir().remove(s.code, this.flush());
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    if (s.state === "queued") return this.start(s.startMode || "queued");
    if (s.state === "starting" && s.startingSince && now >= s.startingSince + START_TIMEOUT_MS) {
      await this.dir().releaseSlot(s.code);
      return this.matchEnded(false, "start_timeout", "The game server didn't start. Try again.");
    }
    if (s.state === "open") {
      for (const [pid, m] of Object.entries(s.members)) if (m.gone && now >= m.gone + SEAT_GRACE_MS) {
        this.ev("reconnect", ["expired"], [secs(now - m.gone)], { pid, cc: m.cc, n: m.n });
        this.removeMember(pid, "timeout");
      }
      this.tick();
      const at = this.startAt();
      if (at && now >= at) return this.start(s.readyAt && now >= s.readyAt + 1000 * +(this.env.AUTOSTART_SECS || 5) ? "all_ready" : "fill");
    }
    await this.changed();
  }

  // ---- admin (called by the directory, so none of these call back into it)
  adminInfo() {
    const s = this.s;
    if (!s) return null;
    const on = this.online();
    return { ...this.summary(), code: s.code, match: s.match ? { slot: s.match.slot, started: s.match.started, mode: s.match.mode } : null,
      queuedAt: s.queuedAt, error: s.error, matches: s.matches || 0, notice: s.notice, log: s.log || [],
      members: s.order.map((p, i) => {
        const m = s.members[p];
        return { n: m.n, name: m.name, char: m.char, ready: m.ready, online: on.has(p), host: p === s.host,
          role: i < SEATS ? "player" : "spectator", joined: m.joined, gone: m.gone, cc: m.cc || "" };
      }) };
  }
  // Close the lobby for good: members are told why and sent back to the start page.
  async adminClose(msg) {
    const s = this.s;
    if (!s) return null;
    const slot = s.match?.slot || "";
    if (s.match) this.ev("match_closed", ["admin_kill", "", ""], [secs(Date.now() - s.match.started), 0], { slot });
    this.ev("lobby_closed", ["admin"], [secs(Date.now() - s.created)]);
    const text = String(msg || "This party was closed by an admin.").slice(0, 120);
    for (const ws of this.ctx.getWebSockets()) { this.send(ws, { t: "closed", msg: text }); try { ws.close(4010, text); } catch {} }
    const events = this.flush();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.s = null;
    return { events, slot };
  }
  // Remove one member (by their public number). Returns the keys the directory needs to ban them.
  async adminKick(n, msg) {
    const s = this.s;
    const pid = s && s.order.find((p) => s.members[p].n === n);
    if (!pid) return null;
    let ip = "";
    const text = String(msg || "An admin removed you from this party.").slice(0, 120);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.pid !== pid) continue;
      ip ||= a.ip || "";
      this.send(ws, { t: "closed", msg: text });
      try { ws.close(4003, text); } catch {}
    }
    this.removeMember(pid, "kicked");
    if (this.online().size === 0) s.emptySince ||= Date.now();
    await this.changed(false);
    return { summary: this.summary(), events: this.flush(), keys: { pid: await pidKey(pid, this.env), ip } };
  }
  async notice(n) {
    if (!this.s) return;
    this.s.notice = n || null;
    await this.save();
    this.broadcast();
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
    const notice = s.notice && s.notice.until > Date.now() ? s.notice.text : "";
    return {
      t: "state", code: s.code, state: s.state, public: s.public, seeking: s.seeking, fill, seats: SEATS, minHumans: +(this.env.MIN_HUMANS || 2),
      you: me?.n ?? 0, host: s.members[s.host]?.n ?? 0, startsIn, error: s.error, go, notice,
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
// One instance: which codes exist (for uniqueness and the public list), create rate limits, which pool
// server each lobby holds, and everything the admin dashboard reads: analytics rollups, bans, switches, the
// audit log. Its alarm runs every minute while anything is happening (hourly otherwise): it probes the pool
// servers, hands a held server back once its relay has been empty (no peers, no downloads) for
// IDLE_RELEASE_SECS, delivers admin broadcasts, and cleans up.
export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lobbies(code TEXT PRIMARY KEY, state TEXT, public INTEGER, players INTEGER, updated INTEGER, seeking INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY, code TEXT NOT NULL, since INTEGER, empty INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS creates(ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS rollup(hour INTEGER, e TEXT, k TEXT, n INTEGER, sum REAL, PRIMARY KEY(hour, e, k));
      CREATE TABLE IF NOT EXISTS uniq(day TEXT, h TEXT, lobbies INTEGER, PRIMARY KEY(day, h));
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS bans(key TEXT PRIMARY KEY, kind TEXT, until INTEGER, note TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, action TEXT, target TEXT, detail TEXT, who TEXT);
      CREATE TABLE IF NOT EXISTS authfail(ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS hosts(id TEXT PRIMARY KEY, at INTEGER, ok INTEGER, peers INTEGER, downloads INTEGER, uptime INTEGER, rejected INTEGER);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, url TEXT DEFAULT '', max INTEGER DEFAULT 0, running INTEGER DEFAULT 0,
        drain INTEGER DEFAULT 0, load REAL DEFAULT 0, cpu REAL DEFAULT 0, up_kbps INTEGER DEFAULT 0, version TEXT DEFAULT '',
        beat INTEGER DEFAULT 0, connected INTEGER DEFAULT 0, gone INTEGER DEFAULT 0, info TEXT DEFAULT '[]', capat INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pmatch(code TEXT PRIMARY KEY, host TEXT NOT NULL, state TEXT NOT NULL, since INTEGER, url TEXT);
      CREATE TABLE IF NOT EXISTS queue(code TEXT PRIMARY KEY, at INTEGER, seen INTEGER);`);
    // tables from before quick play / analytics
    for (const col of ["seeking INTEGER DEFAULT 0", "online INTEGER DEFAULT 0", "ready INTEGER DEFAULT 0", "host TEXT DEFAULT ''",
      "created INTEGER DEFAULT 0", "round INTEGER DEFAULT 0", "lastmg TEXT DEFAULT ''", "fin INTEGER DEFAULT 0"])
      try { this.sql.exec(`ALTER TABLE lobbies ADD COLUMN ${col}`); } catch {}
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));   // pool-agent keepalive, no wake-up
    ctx.blockConcurrencyWhile(async () => { if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 60e3); });
  }
  lobby(code) { return this.env.LOBBY.get(this.env.LOBBY.idFromName(code)); }

  // ---- settings the admin can change (kv 'cfg') and the current broadcast (kv 'notice')
  kv(k, dflt = null) { const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]; try { return r ? JSON.parse(r.v) : dflt; } catch { return dflt; } }
  setKv(k, v) { if (v == null) this.sql.exec("DELETE FROM kv WHERE k = ?", k); else this.sql.exec("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, JSON.stringify(v)); }
  cfg() {
    return { paused: false, pauseMsg: "", maxLobbies: 0, createCap: CREATES_PER_10MIN, publicOff: false, drained: [], ...this.kv("cfg", {}) };
  }
  noticeNow() { const n = this.kv("notice"); return n && n.until > Date.now() ? n : null; }
  status() {
    const c = this.cfg();
    return { paused: c.paused, message: c.paused ? c.pauseMsg || "New parties are paused for maintenance. Back soon." : "", notice: this.noticeNow()?.text || "" };
  }
  banned(...keys) {
    const now = Date.now();
    return keys.some((k) => k && this.sql.exec("SELECT 1 FROM bans WHERE key = ? AND until > ?", k, now).toArray().length);
  }
  async gate(ipK, pidK) {
    const banned = this.banned(ipK, pidK);
    if (banned) await this.record("", [{ e: "rejected", b: ["banned_join"] }]);
    return { banned };
  }

  async reserveCode(ipK, pidK) {
    const now = Date.now(), c = this.cfg();
    if (this.banned(ipK, pidK)) { await this.record("", [{ e: "rejected", b: ["banned_create"] }]); return { error: "You can't make parties right now.", status: 403 }; }
    if (c.paused) { await this.record("", [{ e: "rejected", b: ["paused"] }]); return { error: this.status().message, status: 503 }; }
    if (c.maxLobbies > 0 && this.sql.exec("SELECT COUNT(*) AS n FROM lobbies WHERE updated > ?", now - ACTIVE_MS).one().n >= c.maxLobbies) {
      await this.record("", [{ e: "rejected", b: ["max_lobbies"] }]);
      return { error: "We're full right now. Try again in a few minutes.", status: 503 };
    }
    this.sql.exec("DELETE FROM creates WHERE at < ?", now - 24 * 3600e3);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM creates WHERE ip = ? AND at > ?", ipK, now - 600e3).one().n >= c.createCap) {
      await this.record("", [{ e: "rate_limited", b: ["create"] }]);
      return { error: "Too many lobbies from here. Try again in a few minutes.", status: 429 };
    }
    for (let tries = 0; tries < 20; tries++) {
      const rnd = crypto.getRandomValues(new Uint8Array(5));
      const code = [...rnd].map((b) => ALPHABET[b % ALPHABET.length]).join("");
      if (this.sql.exec("SELECT 1 FROM lobbies WHERE code = ?", code).toArray().length) continue;
      this.sql.exec("INSERT INTO lobbies (code, state, public, players, updated, created) VALUES (?, 'open', 0, 0, ?, ?)", code, now, now);
      this.sql.exec("INSERT INTO creates VALUES (?, ?)", ipK, now);
      return { code, publicOff: c.publicOff };
    }
    return { error: "Couldn't make a code, try again.", status: 503 };
  }

  async report(code, info, events = []) {
    const { state, public: pub, seeking, players, online = 0, ready = 0, host = "", created = 0 } = info;
    this.sql.exec(`INSERT INTO lobbies (code, state, public, players, updated, seeking, online, ready, host, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET state = excluded.state, public = excluded.public, players = excluded.players, updated = excluded.updated,
        seeking = excluded.seeking, online = excluded.online, ready = excluded.ready, host = excluded.host, created = excluded.created`,
      code, state, pub ? 1 : 0, players, Date.now(), seeking ? 1 : 0, online, ready, String(host).slice(0, 20), created);
    await this.record(code, events);
    return { notice: this.noticeNow() };
  }
  // Quick play: an open public lobby with a free seat. Ones looking for players first, then the fullest.
  // The seat is held at once (players + 1) so two people arriving together don't both count on the last one.
  quickMatch() {
    if (this.cfg().publicOff) return null;
    const row = this.sql.exec(`SELECT code FROM lobbies WHERE public = 1 AND state = 'open' AND players > 0 AND players < ? AND updated > ?
      ORDER BY seeking DESC, players DESC, updated DESC LIMIT 1`, SEATS, Date.now() - QUICK_FRESH_MS).toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE lobbies SET players = players + 1 WHERE code = ?", row.code);
    return row.code;
  }
  async remove(code, events = []) {
    await this.record(code, events);
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
    if (this.cfg().publicOff) return [];
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
    const servers = pool(this.env), drained = new Set(this.cfg().drained);
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
        this.sql.exec("UPDATE lobbies SET round = 0, lastmg = '', fin = 0 WHERE code = ?", code);
        await this.wake(60e3);
        return { pending: true, host: h.id };
      }
    }
    // no lobby server free: a static pool server nobody is on, for whoever is first in line
    if (ahead === 0) for (const srv of servers) {
      if (drained.has(srv.id) || this.sql.exec("SELECT 1 FROM slots WHERE id = ?", srv.id).toArray().length) continue;
      this.sql.exec("INSERT INTO slots (id, code, since) VALUES (?, ?, ?)", srv.id, code, Date.now());
      if (isFree(await relayHealth(srv.url))) {
        this.sql.exec("DELETE FROM queue WHERE code = ?", code);
        this.sql.exec("UPDATE lobbies SET round = 0, lastmg = '', fin = 0 WHERE code = ?", code);
        await this.wake(60e3);
        return srv;
      }
      this.sql.exec("DELETE FROM slots WHERE id = ? AND code = ?", srv.id, code);   // busy (friends on it) or down
    }
    await this.wake(60e3);
    return { position: ahead + 1 };
  }
  slotList() { return this.sql.exec("SELECT id, code, since FROM slots").toArray(); }
  releaseSlot(code) { this.sql.exec("DELETE FROM slots WHERE code = ?", code); this.dropPool(code); }

  // ------------------------------------------------------------------ pool-agents (web/pool-agent.js)
  // Hosts taking lobbies now, most room first: connected, heard from lately, not draining, below their cap.
  freeHosts() {
    const now = Date.now(), drained = new Set(this.cfg().drained);   // the admin's drain switch, as for static servers
    return this.sql.exec("SELECT id, url, max, running, drain FROM agents WHERE connected = 1 AND beat > ?", now - HOST_STALE_MS).toArray()
      .filter((h) => !h.drain && !drained.has(h.id) && h.url && this.ctx.getWebSockets(`host:${h.id}`).length)
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
      hosts: this.sql.exec("SELECT * FROM agents").toArray().map((h) => ({ id: h.id, online: !!h.connected && now - h.beat < HOST_STALE_MS,
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
    this.sql.exec("INSERT INTO agents (id, connected, beat) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET connected = 1, beat = excluded.beat, gone = 0", host, Date.now());
    await this.wake(60e3);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const host = ws.deserializeAttachment()?.host;
    if (!host || typeof raw !== "string" || raw.length > 65536) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    this.sql.exec("UPDATE agents SET beat = ?, connected = 1, gone = 0 WHERE id = ?", now, host);
    const code = /^[A-Z2-9]{5}$/.test(m.code || "") ? m.code : "";
    const row = code ? this.sql.exec("SELECT * FROM pmatch WHERE code = ? AND host = ?", code, host).toArray()[0] : null;
    switch (m.t) {
      case "hello": case "cap": {
        const h = this.sql.exec("SELECT * FROM agents WHERE id = ?", host).one();
        this.sql.exec("UPDATE agents SET url = ?, max = ?, drain = ?, running = ?, load = ?, cpu = ?, up_kbps = ?, version = ?, info = ? WHERE id = ?",
          String(m.url ?? h.url).slice(0, 200), +(m.max ?? h.max) || 0, m.drain ? 1 : 0, +(m.running ?? m.lobbies?.length ?? h.running) || 0,
          +(m.load ?? h.load) || 0, +(m.cpu ?? h.cpu) || 0, +(m.upKbps ?? h.up_kbps) || 0, String(m.version ?? h.version).slice(0, 20),
          m.t === "cap" ? JSON.stringify(m.lobbies || []).slice(0, 8000) : h.info, host);
        if (m.t === "hello") await this.reconcile(host, m.lobbies || []);
        else if (now - (h.capat || 0) >= 60e3) {   // the capacity datapoint, once a minute per host like the static servers'
          this.sql.exec("UPDATE agents SET capat = ? WHERE id = ?", now, host);
          const peers = (Array.isArray(m.lobbies) ? m.lobbies : []).reduce((a, l) => a + (+l.peers || 0), 0);
          await this.record("", [{ e: "capacity", b: [host, m.drain || this.cfg().drained.includes(host) ? "drained" : "up"],
            d: [+m.running || 0, +m.max || 0, peers, 0], slot: host, noRoll: true }]);
        }
        break;
      }
      case "started": {
        if (!row) { this.sendHost(host, { t: "stop", code, reason: "no such lobby match" }); break; }
        const url = String(row.url || m.url);
        this.sql.exec("UPDATE pmatch SET state = 'running', since = ? WHERE code = ?", now, code);
        this.sql.exec("UPDATE lobbies SET state = 'in_match', updated = ? WHERE code = ?", now, code);
        const evs = await this.lobby(code).matchReady(host, url);
        if (!evs) {
          this.sendHost(host, { t: "stop", code, reason: "lobby moved on" });
          this.sql.exec("DELETE FROM pmatch WHERE code = ?", code);
        } else await this.record(code, evs);
        break;
      }
      case "start_failed":
        if (!row) break;
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", code);
        // a full or draining host isn't the lobby's fault: it just goes back in line
        await this.record(code, await this.lobby(code).matchFailed(String(m.error), m.error !== "full" && m.error !== "draining"));
        break;
      case "ended":
        if (!row) break;
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", code);
        if (row.state === "starting") await this.record(code, await this.lobby(code).matchFailed(String(m.reason)));
        else if (row.state === "running") await this.record(code, await this.lobby(code).matchEnded(true, m.reason === "crashed" ? "server_crashed" : "server_empty",
          m.reason === "crashed" ? "The game server stopped unexpectedly." : ""));
        break;   // finished: the lobby reopened when the match did
      case "ev": {
        if (!row) break;
        const name = String(m.name || ""), data = m.data && typeof m.data === "object" ? m.data : {};
        // into the analytics (admin.js ingest: game events only, keeps the lobby's round and last minigame)
        const ev = cspev(name, data);
        if (ev) await this.ingest(host, [ev], code);
        if (name === "reconnect") await this.record(code, [{ e: "reconnect", b: [`game_${blob(data.outcome)}`], d: [+data.gap_s || 0], slot: host }]);
        if (name === "match_finished" && row.state === "running") {
          // back to the lobby for a rematch; the server lingers on the results (the agent stops it)
          this.sql.exec("UPDATE pmatch SET state = 'finished' WHERE code = ?", code);
          this.sql.exec("UPDATE lobbies SET state = 'open', updated = ? WHERE code = ?", now, code);
          await this.record(code, await this.lobby(code).matchEnded(true, "finished"));
        } else if (row.state === "running") await this.lobby(code).progress(name, data);
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
      if (row.state === "starting") await this.record(row.code, await this.lobby(row.code).matchFailed("agent restarted", false));
      else if (row.state === "running") await this.record(row.code, await this.lobby(row.code).matchEnded(true, "agent_restart", "The game server restarted. Start again when you're ready."));
    }
    for (const code of running)
      if (!this.sql.exec("SELECT 1 FROM pmatch WHERE code = ? AND host = ?", code, host).toArray().length) this.sendHost(host, { t: "stop", code, reason: "unknown" });
  }

  async webSocketClose(ws) {
    try { ws.close(1000); } catch {}
    const host = ws.deserializeAttachment()?.host;
    if (!host || this.ctx.getWebSockets(`host:${host}`).some((w) => w !== ws)) return;   // replaced by a newer one
    this.sql.exec("UPDATE agents SET connected = 0, gone = ? WHERE id = ?", Date.now(), host);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }

  // ---- analytics
  // The day's salt for player hashes: random, kept for the UTC day only. When the day turns, yesterday's
  // per-player rows become two counters and are deleted along with the salt.
  salt() {
    const day = dayOf(Date.now());
    let s = this.kv("salt");
    if (s?.day === day) return s.salt;
    for (const { day: d } of this.sql.exec("SELECT DISTINCT day FROM uniq WHERE day < ?", day).toArray()) {
      const t = Date.parse(`${d}T00:00:00Z`);
      const u = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(lobbies >= 2), 0) AS r FROM uniq WHERE day = ?", d).one();
      this.rollAt(t, "players", "unique", 0, u.n);
      this.rollAt(t, "players", "returning", 0, u.r);
      this.sql.exec("DELETE FROM uniq WHERE day = ?", d);
    }
    s = { day, salt: b64url(crypto.getRandomValues(new Uint8Array(18))) };
    this.setKv("salt", s);
    return s.salt;
  }
  rollAt(t, e, k, v = 0, n = 1) {
    this.sql.exec(`INSERT INTO rollup VALUES (?, ?, ?, ?, ?) ON CONFLICT(hour, e, k) DO UPDATE SET n = n + excluded.n, sum = sum + excluded.sum`,
      hourOf(t), e, blob(k), n, num(v));
  }
  // One place every event goes through: hash the player, fill in what only the directory knows, write the
  // Analytics Engine datapoint and the hourly counters.
  async record(code, events) {
    if (!events?.length) return;
    const now = Date.now();
    let salt = null;
    for (const raw of events) {
      if (!raw || !EVENTS[raw.e]) continue;
      const ev = { ...raw, code: raw.code ?? code, b: [...(raw.b || [])], d: [...(raw.d || [])] };
      if (ev.pid) {   // sha256(playerId + salt of the day); the salt never leaves the directory
        salt ??= this.salt();
        ev.h = await sha(`${ev.pid}|${salt}`);
        delete ev.pid;
      }
      const roll = [...(ev.roll || [])];
      if (ev.e === "match_closed" && ev.code) {
        const row = this.sql.exec("SELECT round, lastmg, fin FROM lobbies WHERE code = ?", ev.code).toArray()[0] || {};
        const outcome = row.fin ? "finished" : row.lastmg ? "unfinished" : "unknown";
        ev.b[1] = outcome; ev.b[2] = row.lastmg || ""; ev.d[1] = row.round || 0;
        roll.push(["match_outcome", outcome]);
        if (outcome === "unfinished") roll.push(["quit_after", row.lastmg]);
      }
      if (ev.e === "minigame_result" && ev.b[1]) roll.push(["minigame_winner", ev.b[1]]);
      if (ev.cc && (ev.e === "lobby_created" || ev.e === "lobby_joined")) roll.push(["country", ev.cc]);
      if (ev.h && (ev.e === "lobby_created" || ev.e === "lobby_joined"))
        this.sql.exec("INSERT INTO uniq VALUES (?, ?, 1) ON CONFLICT(day, h) DO UPDATE SET lobbies = lobbies + 1", dayOf(now), ev.h);
      try { this.env.EVENTS?.writeDataPoint(datapoint(ev)); } catch (e) { console.log(`analytics engine: ${e}`); }
      if (!ev.noRoll) this.rollAt(now, ev.e, ev.k ?? ev.b[0] ?? "", ev.v ?? ev.d[0] ?? 0);
      for (const [e, k, v] of roll) this.rollAt(now, e, k, v || 0);
    }
  }

  // ---- admin dashboard (src/admin.js); auth is checked by the Worker, failures counted here
  admin(ip, tokenState, op, args) { return adminOp(this, ip, tokenState, op, args); }
  ingest(slot, events, code = "") { return adminOp(this, "", "ingest", "ingest", { slot, events, code }); }
  async wake(ms) {
    const at = await this.ctx.storage.getAlarm(), want = Date.now() + ms;
    if (!at || at > want) await this.ctx.storage.setAlarm(want);
  }

  // probe every pool server (in parallel) and remember what it said; the minute check also logs it
  async probe(log = true) {
    const now = Date.now();
    const out = await Promise.all(pool(this.env).map(async (srv) => [srv, await relayHealth(srv.url)]));
    const held = new Map(this.sql.exec("SELECT id, code FROM slots").toArray().map((r) => [r.id, r.code]));
    const drained = new Set(this.cfg().drained);
    for (const [srv, h] of out) {
      this.sql.exec("INSERT OR REPLACE INTO hosts VALUES (?, ?, ?, ?, ?, ?, ?)", srv.id, now, h ? 1 : 0, h?.peers ?? 0, h?.downloads ?? 0, h?.uptime ?? 0, h?.rejected ?? 0);
      if (log) await this.record("", [{ e: "capacity", b: [srv.id, !h ? "down" : drained.has(srv.id) ? "drained" : "up"],
        d: [held.has(srv.id) ? 1 : 0, 1, h?.peers ?? 0, h?.downloads ?? 0], slot: srv.id, noRoll: true }]);
    }
    return new Map(out.map(([srv, h]) => [srv.id, h]));
  }

  async alarm() {
    const now = Date.now();
    // pool-agents: silent ones take no new lobbies; matches whose server never came up, or whose agent is long gone, end
    this.sql.exec("UPDATE agents SET connected = 0, gone = ? WHERE connected = 1 AND beat < ?", now, now - HOST_STALE_MS);
    for (const row of this.sql.exec("SELECT p.*, h.connected, h.gone FROM pmatch p LEFT JOIN agents h ON h.id = p.host").toArray()) {
      const lost = !row.connected && now - (row.gone || 0) > ORPHAN_MS;
      if (row.state === "starting" && now - row.since > START_TIMEOUT_MS) {
        this.sendHost(row.host, { t: "stop", code: row.code, reason: "start timeout" });
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", row.code);
        await this.record(row.code, await this.lobby(row.code).matchFailed("start timeout"));
      } else if (lost || now - row.since > MATCH_MAX_MS) {
        this.sendHost(row.host, { t: "stop", code: row.code, reason: lost ? "orphaned" : "max time" });
        this.sql.exec("DELETE FROM pmatch WHERE code = ?", row.code);
        if (row.state !== "finished") await this.record(row.code, await this.lobby(row.code).matchEnded(true, lost ? "orphaned" : "max_time", lost ? "Lost the game server." : ""));
      }
    }
    this.sql.exec("DELETE FROM queue WHERE seen < ?", now - 60e3);
    const servers = pool(this.env);
    let busy = false;
    try { busy = await this.fanout(); } catch (e) { console.log(`broadcast: ${e}`); }
    const active = this.sql.exec("SELECT COUNT(*) AS n FROM slots").one().n > 0
      || this.sql.exec("SELECT COUNT(*) AS n FROM lobbies WHERE updated > ?", now - ACTIVE_MS).one().n > 0
      || this.sql.exec("SELECT (SELECT COUNT(*) FROM pmatch) + (SELECT COUNT(*) FROM queue) + (SELECT COUNT(*) FROM agents WHERE connected = 1) AS n").one().n > 0;
    const health = active ? await this.probe() : new Map();
    // a started server isn't checked for "everyone left" before this (downloads, map load)
    const grace = 1000 * +(this.env.MATCH_GRACE_SECS ?? 240);
    for (const row of this.sql.exec("SELECT id, code, since, empty FROM slots").toArray()) {
      const srv = servers.find((s) => s.id === row.id);
      let reason = !srv ? "slot_removed" : now - row.since > MATCH_MAX_MS ? "max_time" : "";
      if (!reason && now - row.since > grace) {
        const h = health.get(row.id);
        const empty = isFree(h) && h.idleSecs >= IDLE_RELEASE_SECS ? row.empty + 1 : 0;
        this.sql.exec("UPDATE slots SET empty = ? WHERE id = ?", empty, row.id);
        if (empty >= 2) reason = "server_empty";   // two checks a minute apart: a map change can blip the count
      }
      if (reason) {
        this.sql.exec("DELETE FROM slots WHERE id = ?", row.id);
        this.sql.exec("UPDATE lobbies SET state = 'open', updated = ? WHERE code = ?", now, row.code);
        try { await this.record(row.code, await this.env.LOBBY.get(this.env.LOBBY.idFromName(row.code)).matchEnded(true, reason)); }
        catch (e) { console.log(`release ${row.code}: ${e}`); }
      }
    }
    // housekeeping
    this.sql.exec("DELETE FROM lobbies WHERE updated < ?", now - 24 * 3600e3);
    this.sql.exec("DELETE FROM creates WHERE at < ?", now - 24 * 3600e3);
    this.sql.exec("DELETE FROM authfail WHERE at < ?", now - 3600e3);
    this.sql.exec("DELETE FROM bans WHERE until < ?", now);
    this.sql.exec("DELETE FROM rollup WHERE hour < ?", now - 400 * 24 * 3600e3);
    this.sql.exec("DELETE FROM audit WHERE at < ?", now - 400 * 24 * 3600e3);
    this.salt();   // turns the day over even when nothing happens
    await this.ctx.storage.setAlarm(now + (busy ? 250 : active ? 60e3 : 3600e3));
  }

  // Admin broadcast to every lobby with people in it, 25 lobbies per alarm run (a request may only make so
  // many calls). true while there is more to send.
  async fanout() {
    const f = this.kv("fanout");
    if (!f) return false;
    const rows = this.sql.exec("SELECT code FROM lobbies WHERE code > ? AND players > 0 AND updated > ? ORDER BY code LIMIT 25",
      f.cursor || "", Date.now() - 6 * 3600e3).toArray();
    await Promise.allSettled(rows.map((r) => this.env.LOBBY.get(this.env.LOBBY.idFromName(r.code)).notice(f.notice)));
    if (rows.length < 25) { this.setKv("fanout", null); return false; }
    this.setKv("fanout", { ...f, cursor: rows.at(-1).code });
    return true;
  }
}
