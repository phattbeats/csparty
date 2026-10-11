// Admin dashboard API (#3991, docs/lobby-design.md section 9) and game event ingest.
//
// Auth: `Authorization: Bearer <ADMIN_TOKEN>` (a Worker secret, at least 24 characters; unset = admin off).
// Failed tokens are counted per IP hash: 10 in 15 minutes locks that IP out of /api/admin for 15 minutes, and
// 500 failures an hour from anywhere locks everyone out (a compute guard; the token itself is unguessable).
// While locked, even the right token gets 429, so a lock can't be used to confirm a guess.
//
//   GET  /api/admin/live                 lobbies, servers, switches, bans, top creators, audit log (dashboard polls it)
//   GET  /api/admin/stats?range=24h|7d|30d|90d   hourly counters for the funnel, game, traffic and abuse panels
//   GET  /api/admin/lobby?code=ABCDE     one lobby: roster and timeline
//   GET  /api/admin/export.csv?range=    the hourly counters as CSV
//   GET  /api/admin/ae?preset=&range=    Analytics Engine SQL API, fixed queries only (needs AE_READ_TOKEN + AE_ACCOUNT_ID)
//   POST /api/admin/action {action, ...} kill, kick, ban, unban, pause, caps, drain, broadcast. Every one is audited.
//
// Game events (P2 pool-agent): POST /api/events {events: [{e, b: [...], d: [...]}]} with headers X-CSP-Slot (the
// server's POOL id), X-CSP-Time (unix seconds, within 5 minutes) and X-CSP-Sig = base64url HMAC-SHA256 with
// LOBBY_SECRET over `csp-ev|<slot>|<time>|<body>`. Only the game events in analytics.js are taken.
import { json, safeEqual, hmac, b64url, pool, CODE_RE, nick } from "./util.js";
import { DATASET, GAME_EVENTS, EVENTS, blob, num, hourOf, dayOf } from "./analytics.js";

const LOCK_PER_IP = 10, LOCK_WINDOW_MS = 15 * 60e3, LOCK_GLOBAL_PER_HOUR = 500;
const RANGES = { "24h": 24, "7d": 168, "30d": 720, "90d": 2160 };
const OPS = { live: "GET", stats: "GET", lobby: "GET", "export.csv": "GET", ae: "GET", action: "POST" };
const KEY_RE = /^[A-Za-z0-9_-]{16}$/;

// ------------------------------------------------------------------------------------------- Worker side
export async function adminFetch(req, env, dir, ip) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return json({ error: "Admin is off: set the ADMIN_TOKEN secret (24+ characters)." }, 503);
  const url = new URL(req.url), op = url.pathname.slice("/api/admin/".length);
  const m = /^Bearer\s+(\S{1,256})$/i.exec(req.headers.get("Authorization") || "");
  // no token at all isn't a guess: refuse without counting it
  if (!m) return json({ error: "Sign in with the admin token." }, 401, { "WWW-Authenticate": "Bearer" });
  const state = (await safeEqual(m[1], env.ADMIN_TOKEN)) ? "ok" : "bad";
  let args = Object.fromEntries(url.searchParams);
  if (state === "ok" && OPS[op] && req.method !== OPS[op]) return json({ error: "method not allowed" }, 405);
  if (state === "ok" && req.method === "POST") {
    const text = await req.text();
    if (text.length > 4096) return json({ error: "too big" }, 413);
    try { args = { ...args, ...JSON.parse(text || "{}") }; } catch { return json({ error: "bad JSON" }, 400); }
  }
  const r = await dir.admin(ip, state, OPS[op] ? op : "", args);
  if (r.status !== 200) return json(r.body, r.status);
  if (op === "ae") return json(await aeQuery(env, args));
  if (r.csv != null) return new Response(r.csv, { headers: { "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${r.filename}"`, "Cache-Control": "no-store" } });
  return json(r.body);
}

export async function ingestFetch(req, env, dir) {
  if (!env.LOBBY_SECRET) return json({ error: "no LOBBY_SECRET" }, 503);
  const slot = req.headers.get("X-CSP-Slot") || "", ts = +(req.headers.get("X-CSP-Time") || NaN), sig = req.headers.get("X-CSP-Sig") || "";
  const body = await req.text();
  if (body.length > 32768) return json({ error: "too big" }, 413);
  const fresh = Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) <= 300;
  const want = b64url(await hmac(env.LOBBY_SECRET, `csp-ev|${slot}|${ts}|${body}`));
  if (!pool(env).some((s) => s.id === slot) || !fresh || !(await safeEqual(sig, want))) return json({ error: "bad signature" }, 401);
  let events;
  try { events = JSON.parse(body).events; } catch {}
  if (!Array.isArray(events)) return json({ error: "expected {events: [...]}" }, 400);
  const r = await dir.ingest(slot, events);
  return json(r.body, r.status);
}

// Fixed Analytics Engine queries. The range is one of a few numbers, so nothing from the request reaches the SQL.
const AE_PRESETS = {
  events: (d) => `SELECT blob1 AS event, SUM(_sample_interval) AS n FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY GROUP BY event ORDER BY n DESC`,
  countries: (d) => `SELECT blob6 AS country, SUM(_sample_interval) AS n FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND blob1 IN ('lobby_created', 'lobby_joined') AND blob6 != '' GROUP BY country ORDER BY n DESC LIMIT 30`,
  players_per_day: (d) => `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, COUNT(DISTINCT blob7) AS players FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND blob7 != '' GROUP BY day ORDER BY day`,
  start_modes: (d) => `SELECT blob3 AS mode, SUM(_sample_interval) AS matches, AVG(double1) AS avg_humans, AVG(double3) AS avg_queue_s FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND blob1 = 'match_started' GROUP BY mode ORDER BY matches DESC`,
  minigames: (d) => `SELECT blob2 AS minigame, blob1 AS event, SUM(_sample_interval) AS n, AVG(double1) AS avg_double1 FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND blob1 IN ('minigame_picked', 'minigame_result') GROUP BY minigame, event ORDER BY n DESC LIMIT 100`,
  capacity: (d) => `SELECT blob2 AS server, toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, MAX(double1) AS held, MAX(double3) AS max_peers, MAX(double4) AS max_downloads FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND blob1 = 'capacity' GROUP BY server, hour ORDER BY hour DESC LIMIT 200`,
};
async function aeQuery(env, args) {
  const presets = Object.keys(AE_PRESETS);
  if (!env.AE_READ_TOKEN || !env.AE_ACCOUNT_ID) return { configured: false, presets };
  const preset = AE_PRESETS[args.preset] ? args.preset : "events";
  const days = Math.ceil((RANGES[args.range] || 24) / 24);
  const sql = AE_PRESETS[preset](days);
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.AE_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST", headers: { Authorization: `Bearer ${env.AE_READ_TOKEN}` }, body: `${sql} FORMAT JSON`, signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    if (!r.ok) return { configured: true, presets, preset, sql, error: `HTTP ${r.status}: ${text.slice(0, 300)}` };
    const j = JSON.parse(text);
    return { configured: true, presets, preset, sql, meta: j.meta, data: j.data, rows: j.rows };
  } catch (e) { return { configured: true, presets, preset, sql, error: String(e) }; }
}

// ------------------------------------------------------------------------------------- Directory side
// Runs inside the directory Durable Object (d), so its SQL is synchronous and nothing races it.
export async function adminOp(d, ip, state, op, args) {
  if (state === "ingest") return { status: 200, ...(await ingest(d, args.slot, args.events, args.code)) };
  const now = Date.now();
  const mine = d.sql.exec("SELECT COUNT(*) AS n FROM authfail WHERE ip = ? AND at > ?", ip, now - LOCK_WINDOW_MS).one().n;
  const all = d.sql.exec("SELECT COUNT(*) AS n FROM authfail WHERE at > ?", now - 3600e3).one().n;
  if (mine >= LOCK_PER_IP || all >= LOCK_GLOBAL_PER_HOUR) {
    await d.record("", [{ e: "rate_limited", b: ["admin_auth"] }]);
    return { status: 429, body: { error: "Too many wrong tokens. Admin is locked for 15 minutes." } };
  }
  if (state !== "ok") {
    d.sql.exec("INSERT INTO authfail VALUES (?, ?)", ip, now);
    await d.record("", [{ e: "auth_failed" }]);
    return { status: 401, body: { error: "Wrong admin token." } };
  }
  try {
    switch (op) {
      case "live": return { status: 200, body: await live(d) };
      case "stats": return { status: 200, body: stats(d, args) };
      case "lobby": {
        const code = String(args.code || "").toUpperCase();
        const info = CODE_RE.test(code) ? await lobbyStub(d, code).adminInfo() : null;
        return info ? { status: 200, body: info } : { status: 404, body: { error: "no such lobby" } };
      }
      case "export.csv": return { status: 200, ...csv(d, args) };
      case "ae": return { status: 200, body: {} };
      case "action": return await action(d, args, ip);
      default: return { status: 404, body: { error: "not found" } };
    }
  } catch (e) {
    console.log(`admin ${op}: ${e.stack || e}`);
    return { status: 500, body: { error: String(e.message || e) } };
  }
}

const lobbyStub = (d, code) => d.env.LOBBY.get(d.env.LOBBY.idFromName(code));
const rangeHours = (r) => RANGES[r] || 24;

async function live(d) {
  const now = Date.now(), cfg = d.cfg();
  const lobbies = d.sql.exec(`SELECT l.code, l.state, l.public, l.seeking, l.players, l.online, l.ready, l.host, l.created, l.updated,
      l.round, l.lastmg, l.fin, COALESCE(s.id, p.host) AS slot, COALESCE(s.since, p.since) AS since FROM lobbies l
      LEFT JOIN slots s ON s.code = l.code LEFT JOIN pmatch p ON p.code = l.code
      WHERE l.updated > ? ORDER BY l.created DESC LIMIT 500`, now - 24 * 3600e3).toArray();
  // server health: probe again if the last look is more than 10 s old
  const last = d.sql.exec("SELECT MIN(at) AS at FROM hosts").one().at || 0;
  const n = d.sql.exec("SELECT COUNT(*) AS n FROM hosts").one().n;
  if (now - last > 10e3 || n < pool(d.env).length) await d.probe(false);
  const hostRows = new Map(d.sql.exec("SELECT * FROM hosts").toArray().map((r) => [r.id, r]));
  const held = new Map(d.sql.exec("SELECT id, code, since FROM slots").toArray().map((r) => [r.id, r]));
  const hosts = pool(d.env).map((srv) => {
    const h = hostRows.get(srv.id) || {}, s = held.get(srv.id);
    return { id: srv.id, url: srv.url, ok: !!h.ok, peers: h.peers ?? 0, downloads: h.downloads ?? 0, uptime: h.uptime ?? 0,
      rejected: h.rejected ?? 0, at: h.at ?? 0, code: s?.code || "", since: s?.since || 0, max: 1, drained: cfg.drained.includes(srv.id) };
  });
  // pool-agent hosts (#4154): one row each, their lobby servers counted (codes are in the lobby table)
  for (const a of d.sql.exec("SELECT * FROM agents").toArray()) {
    let ls = []; try { ls = JSON.parse(a.info || "[]"); } catch {}
    hosts.push({ id: a.id, url: a.url, ok: !!a.connected && now - a.beat < 90e3, agent: true, peers: ls.reduce((n, l) => n + (+l.peers || 0), 0),
      downloads: 0, uptime: 0, rejected: 0, at: a.beat, code: ls.map((l) => l.code).join(" "), since: 0, max: a.max, running: a.running,
      load: a.load, cpu: a.cpu, upKbps: a.up_kbps, version: a.version, drained: cfg.drained.includes(a.id) || !!a.drain });
  }
  const byState = {};
  for (const l of lobbies) byState[l.state] = (byState[l.state] || 0) + 1;
  const active = lobbies.filter((l) => l.online > 0 || l.state === "in_match");
  return {
    now, cfg, notice: d.noticeNow(), broadcasting: !!d.kv("fanout"),
    totals: {
      lobbies: lobbies.length, byState, active: active.length,
      online: lobbies.reduce((a, l) => a + (l.online || 0), 0),
      publicOpen: lobbies.filter((l) => l.public && l.state === "open").length,
      queued: byState.queued || 0,
      oldest: active.length ? now - Math.min(...active.map((l) => l.created || l.updated)) : 0,
    },
    lobbies, hosts,
    bans: d.sql.exec("SELECT key, kind, until, note, at FROM bans WHERE until > ? ORDER BY at DESC LIMIT 100", now).toArray(),
    topCreators: d.sql.exec(`SELECT c.ip AS key, COUNT(*) AS n, MAX(c.at) AS last, EXISTS(SELECT 1 FROM bans b WHERE b.key = c.ip AND b.until > ?) AS banned
      FROM creates c WHERE c.at > ? GROUP BY c.ip ORDER BY n DESC LIMIT 10`, now, now - 24 * 3600e3).toArray(),
    authFails: d.sql.exec("SELECT COUNT(*) AS n FROM authfail WHERE at > ?", now - 3600e3).one().n,
    audit: d.sql.exec("SELECT at, action, target, detail, who FROM audit ORDER BY id DESC LIMIT 50").toArray(),
  };
}

function stats(d, args) {
  const now = Date.now(), hours = rangeHours(args.range), from = hourOf(now) - (hours - 1) * 3600e3;
  const today = dayOf(now), u = d.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(lobbies >= 2), 0) AS r FROM uniq WHERE day = ?", today).one();
  const days = d.sql.exec("SELECT hour, k, SUM(n) AS n FROM rollup WHERE e = 'players' AND hour >= ? GROUP BY hour, k ORDER BY hour", from - 24 * 3600e3).toArray();
  const perDay = {};
  for (const r of days) (perDay[dayOf(r.hour)] ||= { unique: 0, returning: 0 })[r.k] = r.n;
  perDay[today] = { unique: u.n, returning: u.r };
  return {
    range: args.range in RANGES ? args.range : "24h", from, now,
    totals: d.sql.exec("SELECT e, k, SUM(n) AS n, SUM(sum) AS sum FROM rollup WHERE hour >= ? AND e != 'players' GROUP BY e, k", from).toArray(),
    series: d.sql.exec(`SELECT hour, e, SUM(n) AS n FROM rollup WHERE hour >= ? AND e IN ('lobby_created', 'lobby_joined', 'match_started', 'match_closed')
      GROUP BY hour, e ORDER BY hour`, from).toArray(),
    players: Object.entries(perDay).map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

function csv(d, args) {
  const hours = rangeHours(args.range), from = hourOf(Date.now()) - (hours - 1) * 3600e3;
  // a leading = + - @ makes a spreadsheet treat the cell as a formula
  const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = d.sql.exec("SELECT hour, e, k, n, sum FROM rollup WHERE hour >= ? ORDER BY hour, e, k", from).toArray();
  const lines = ["hour_utc,event,key,count,sum", ...rows.map((r) => [new Date(r.hour).toISOString(), r.e, r.k, r.n, r.sum].map(cell).join(","))];
  return { csv: lines.join("\n") + "\n", filename: `csparty-rollups-${args.range in RANGES ? args.range : "24h"}-${dayOf(Date.now())}.csv` };
}

async function action(d, a, ip) {
  const now = Date.now(), cfg = d.cfg();
  const bad = (error) => ({ status: 400, body: { error } });
  const int = (v, lo, hi, dflt) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  const code = String(a.code || "").toUpperCase();
  let target = "", detail = {}, result = {};
  switch (a.action) {
    case "kill": {
      if (!CODE_RE.test(code)) return bad("bad code");
      const msg = text(a.msg, 120);
      const r = await lobbyStub(d, code).adminClose(msg);
      await d.remove(code, r?.events || []);
      target = code; detail = { msg, slot: r?.slot || "", existed: !!r };
      break;
    }
    case "kick": {
      if (!CODE_RE.test(code)) return bad("bad code");
      const n = int(a.n, 1, 1e6, 0), hours = int(a.hours, 0, 24 * 30, 0), msg = text(a.msg, 120);
      const r = await lobbyStub(d, code).adminKick(n, msg);
      if (!r) return { status: 404, body: { error: "no such member" } };
      await d.report(code, r.summary, r.events);
      if (hours > 0) for (const [kind, key] of Object.entries(r.keys)) if (key)
        d.sql.exec("INSERT OR REPLACE INTO bans VALUES (?, ?, ?, ?, ?)", key, kind, now + hours * 3600e3, `kicked from ${code} #${n}`, now);
      target = `${code} #${n}`; detail = { hours, msg, keys: Object.values(r.keys).filter(Boolean).length };
      break;
    }
    case "ban": {
      if (!KEY_RE.test(a.key || "")) return bad("bad key");
      const hours = int(a.hours, 1, 24 * 365, 24), kind = a.kind === "pid" ? "pid" : "ip";
      d.sql.exec("INSERT OR REPLACE INTO bans VALUES (?, ?, ?, ?, ?)", a.key, kind, now + hours * 3600e3, nick(a.note || "manual"), now);
      target = `${kind}:${a.key}`; detail = { hours };
      break;
    }
    case "unban": {
      if (!KEY_RE.test(a.key || "")) return bad("bad key");
      d.sql.exec("DELETE FROM bans WHERE key = ?", a.key);
      target = a.key;
      break;
    }
    case "pause": {
      cfg.paused = !!a.on; cfg.pauseMsg = text(a.msg, 160);
      d.setKv("cfg", cfg);
      target = cfg.paused ? "on" : "off"; detail = { msg: cfg.pauseMsg };
      break;
    }
    case "caps": {
      if (a.maxLobbies != null) cfg.maxLobbies = int(a.maxLobbies, 0, 100000, cfg.maxLobbies);
      if (a.createCap != null) cfg.createCap = int(a.createCap, 1, 1000, cfg.createCap);
      if (a.publicOff != null) cfg.publicOff = !!a.publicOff;
      d.setKv("cfg", cfg);
      detail = { maxLobbies: cfg.maxLobbies, createCap: cfg.createCap, publicOff: cfg.publicOff };
      break;
    }
    case "drain": {
      // a static pool server, or a pool-agent's host (#4154): either way it gets no new lobbies
      if (!pool(d.env).some((s) => s.id === a.id) && !d.sql.exec("SELECT 1 FROM agents WHERE id = ?", String(a.id || "")).toArray().length) return bad("no such server");
      cfg.drained = cfg.drained.filter((x) => x !== a.id);
      if (a.on) cfg.drained.push(a.id);
      d.setKv("cfg", cfg);
      target = a.id; detail = { on: !!a.on };
      break;
    }
    case "broadcast": {
      const msg = text(a.msg, 160), minutes = int(a.minutes, 1, 24 * 60, 30);
      const notice = msg ? { id: now, text: msg, until: now + minutes * 60e3 } : null;
      d.setKv("notice", notice);
      d.setKv("fanout", { notice, cursor: "" });
      await d.wake(50);
      target = msg ? `${minutes} min` : "cleared"; detail = { msg };
      break;
    }
    default: return bad("unknown action");
  }
  d.sql.exec("INSERT INTO audit (at, action, target, detail, who) VALUES (?, ?, ?, ?, ?)", now, a.action, target, JSON.stringify(detail), String(ip).slice(0, 8));
  await d.record("", [{ e: "admin_action", b: [a.action] }]);
  return { status: 200, body: { ok: true, action: a.action, target, ...result } };
}

// Game server events. The server only says which pool slot it is; the directory knows which lobby holds it.
// (A pool-agent's lobby server: the directory passes the lobby code, slot is the agent's host id.)
async function ingest(d, slot, events, known = "") {
  const code = known || d.sql.exec("SELECT code FROM slots WHERE id = ?", slot).toArray()[0]?.code || "";
  let accepted = 0, dropped = 0;
  const out = [];
  for (const ev of events.slice(0, 50)) {
    if (!ev || !GAME_EVENTS.has(ev.e) || !Array.isArray(ev.b ?? []) || !Array.isArray(ev.d ?? [])) { dropped++; continue; }
    const [bn, dn] = EVENTS[ev.e];
    const b = (ev.b || []).slice(0, bn.length).map(blob), dd = (ev.d || []).slice(0, dn.length).map(num);
    const x = { e: ev.e, code, b, d: dd, slot };
    if (ev.e === "capacity") { b[0] = slot; x.noRoll = true; }
    if (code && ev.e === "minigame_picked") d.sql.exec("UPDATE lobbies SET round = ?, lastmg = ? WHERE code = ?", Math.round(dd[0] || 0), b[0] || "", code);
    if (code && ev.e === "match_finished") {
      const first = d.sql.exec("SELECT fin FROM lobbies WHERE code = ?", code).toArray()[0]?.fin === 0;
      d.sql.exec("UPDATE lobbies SET fin = 1 WHERE code = ?", code);
      if (first) x.roll = [["funnel", "finished"]];
    }
    out.push(x); accepted++;
  }
  await d.record(code, out);
  if (events.length > 50) dropped += events.length - 50;
  return { body: { ok: true, accepted, dropped, code } };
}
