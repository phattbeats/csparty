// CS Party pool-agent (#4154, design: docs/lobby-design.md): makes a game host lobby capacity for the lobby Worker
// (lobby/). It runs next to web/relay.js, in a container of its own that holds the Docker socket and listens on
// loopback only, so the internet-facing relay never gets near Docker.
//
//   - Keeps one outbound WebSocket to the Worker (no inbound port: the host only exposes the relay, as before).
//   - On "start" it runs one game server container per lobby from the server image: its own UDP port on
//     127.0.0.1, CPU/memory/pids caps, read-only root (tmpfs for logs and the plugin's match state), no volumes,
//     no capabilities, no other container to talk to. It answers "started" once the plugin says the map is up.
//   - The relay asks it every 2 s which lobby is on which port (POST /sync) and hands it per-lobby peer counts in
//     the same call. That is how it knows a lobby server has emptied out and can go.
//   - Tails each container's console for the plugin's "[CSPEV] name {json}" lines and ships them to the Worker.
//   - MAX_LOBBIES caps how many run at once; the Worker queues lobbies when every host is full. Capacity (running,
//     max, CPU, upload) goes to the Worker every 30 s.
//   - Stateless: containers carry labels, and a restarted agent adopts the ones that are still running.
//
// Env: LOBBY_WS (wss://<worker>/api/agent), LOBBY_SECRET (same as the Worker's and the relay's), RELAY_ID (this
// host's id, same as the relay's), PUBLIC_URL (the relay URL players open), IMAGE (cs-party-server:<tag>),
// MAX_LOBBIES (6), PORT_BASE (27100), LISTEN (127.0.0.1:8097), CPUS (1.5), MEMORY_MB (1024), MAP (de_dust2),
// IDLE_SECS (90), NOSHOW_SECS (240), LINGER_SECS (120), READY_SECS (300), MAX_MATCH_SECS (10800), DRAIN (0),
// EXTRA_CVARS ("csp_turns 1;csp_speed 0.3": set on every lobby server once it is up; tests), RCON_PASSWORD (the
// same rcon password on every lobby server instead of a random one each; tests).
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import { WebSocket } from "ws";

const env = process.env;
const VERSION = "0.1.0";
const HOST_ID = env.RELAY_ID || "raid1";
const LOBBY_WS = env.LOBBY_WS || "";
const SECRET = env.LOBBY_SECRET || "";
const PUBLIC_URL = (env.PUBLIC_URL || "").replace(/\/$/, "");
const IMAGE = env.IMAGE || "";
const MAX_LOBBIES = +(env.MAX_LOBBIES || 6);
const PORT_BASE = +(env.PORT_BASE || 27100);
const [LISTEN_HOST, LISTEN_PORT] = (env.LISTEN || "127.0.0.1:8097").split(":");
const CPUS = +(env.CPUS || 1.5), MEMORY_MB = +(env.MEMORY_MB || 1024);
const MAP = env.MAP || "de_dust2";
const IDLE_MS = 1000 * +(env.IDLE_SECS || 90);          // everyone gone (no peers, no downloads) this long: stop
const NOSHOW_MS = 1000 * +(env.NOSHOW_SECS || 240);     // started, and nobody ever showed up
const LINGER_MS = 1000 * +(env.LINGER_SECS || 120);     // after the match ends (the plugin sends everyone back)
const READY_MS = 1000 * +(env.READY_SECS || 300);       // map load on a busy host takes up to ~2 min
const MAX_MATCH_MS = 1000 * +(env.MAX_MATCH_SECS || 10800);
const NET = "csp-lobbies";
const DOCKER_SOCK = env.DOCKER_SOCK || "/var/run/docker.sock";
let drain = env.DRAIN === "1";
const EXTRA_CVARS = (env.EXTRA_CVARS || "").split(";").map((c) => c.trim()).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ docker
// The Engine API over the unix socket. API 1.41 is Docker 20.10+.
const docker = (method, path, body, { raw = false, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath: DOCKER_SOCK, path: `/v1.41${path}`, method, timeout,
    headers: body ? { "Content-Type": "application/json" } : {} }, (res) => {
    if (raw && res.statusCode < 300) return resolve(res);
    let d = ""; res.setEncoding("utf8");
    res.on("data", (c) => { d += c; });
    res.on("end", () => {
      if (res.statusCode >= 300) return reject(Object.assign(new Error(`docker ${method} ${path.split("?")[0]}: ${res.statusCode} ${d.trim().slice(0, 200)}`), { status: res.statusCode }));
      try { resolve(d ? JSON.parse(d) : null); } catch { resolve(d); }
    });
  });
  req.on("error", reject);
  req.on("timeout", () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: timeout`)));
  req.end(body ? JSON.stringify(body) : undefined);
});

// ICC off: a lobby server can't reach another one (or anything else on the default bridge)
const ensureNetwork = async () => {
  const nets = await docker("GET", `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [NET] }))}`);
  if (nets.some((n) => n.Name === NET)) return;
  await docker("POST", "/networks/create", { Name: NET, Driver: "bridge", CheckDuplicate: true,
    Options: { "com.docker.network.bridge.enable_icc": "false" }, Labels: { "csparty.agent": HOST_ID } });
  log(`created network ${NET}`);
};

const containerSpec = (l) => ({
  Image: IMAGE,
  Env: [`MAP=${MAP}`, `PORT=${l.port}`, "SV_LAN=1", "MAXPLAYERS=10", `RCON_PASSWORD=${l.rcon}`],
  Labels: { "csparty.agent": HOST_ID, "csparty.lobby": l.code, "csparty.port": String(l.port), "csparty.rcon": l.rcon },
  ExposedPorts: { [`${l.port}/udp`]: {} },
  HostConfig: {
    NetworkMode: NET,
    PortBindings: { [`${l.port}/udp`]: [{ HostIp: "127.0.0.1", HostPort: String(l.port) }] },   // the relay is the only way in
    NanoCpus: Math.round(CPUS * 1e9), Memory: MEMORY_MB * 1048576, MemorySwap: MEMORY_MB * 1048576, PidsLimit: 256,
    ReadonlyRootfs: true,
    // HLDS and AMXX logs, and the plugin's match state across a race map change (state_path in cs_party.sma)
    Tmpfs: { "/tmp": "size=64m", "/hlds/cstrike/logs": "size=16m", "/hlds/cstrike/addons/amxmodx/logs": "size=16m",
      "/hlds/cstrike/addons/amxmodx/data/csp_state": "size=1m" },
    CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"],
    LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "1" } },
    RestartPolicy: { Name: "no" },   // a crashed match is over; the Worker reopens the lobby
  },
});

// ------------------------------------------------------------------------------------------------ rcon
// GoldSrc rcon over UDP: "challenge rcon" -> "challenge rcon N", then "rcon N "password" command".
const rcon = (port, password, cmd) => new Promise((resolve) => {
  const s = dgram.createSocket("udp4");
  const done = (v) => { try { s.close(); } catch {} resolve(v); };
  const t = setTimeout(() => done(null), 3000);
  s.on("error", () => { clearTimeout(t); done(null); });
  s.on("message", (m) => {
    const txt = m.toString("latin1").replace(/^\xff+/, "");
    const ch = /^challenge rcon (\d+)/.exec(txt);
    if (ch) { s.send(Buffer.from(`\xff\xff\xff\xffrcon ${ch[1]} "${password}" ${cmd}\n`, "latin1"), port, "127.0.0.1"); return; }
    clearTimeout(t); done(txt.replace(/^l/, "").replace(/\0/g, ""));
  });
  s.send(Buffer.from("\xff\xff\xff\xffchallenge rcon\n", "latin1"), port, "127.0.0.1");
});

// ------------------------------------------------------------------------------------------------ lobbies
// code -> { code, port, rcon, id, state: starting|ready|stopping, created, readyAt, active (ever had a peer or a
// download), idleSince, finishedAt, stats (from the relay), cpu, upKbps }
const lobbies = new Map();
let relay = { at: 0, lobbies: {}, downBytes: 0 };   // the relay's last /sync
let up = { at: Date.now(), bytes: 0, kbps: 0 };

const portFree = (port) => new Promise((resolve) => {
  const s = dgram.createSocket("udp4");
  s.once("error", () => resolve(false));
  s.bind(port, "127.0.0.1", () => s.close(() => resolve(true)));
});
// one at a time: two lobbies starting together would otherwise both find the same port free
let picking = Promise.resolve();
const pickPort = (l) => (picking = picking.then(async () => {
  const used = new Set([...lobbies.values()].map((x) => x.port));
  for (let p = PORT_BASE; p < PORT_BASE + MAX_LOBBIES * 4; p++) if (!used.has(p) && await portFree(p)) { l.port = p; return; }
}).catch(() => {}));

// Follow a container's console. Docker multiplexes stdout/stderr without a TTY: 8-byte frame headers.
const tail = async (l, since) => {
  let res;
  try { res = await docker("GET", `/containers/${l.id}/logs?follow=1&stdout=1&stderr=1&since=${since}`, null, { raw: true, timeout: 0 }); }
  catch (e) { log(`[${l.code}] logs: ${e.message}`); return; }
  l.logs = res;
  let buf = Buffer.alloc(0), text = "";
  res.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const n = buf.readUInt32BE(4);
      if (buf.length < 8 + n) break;
      text += buf.toString("utf8", 8, 8 + n); buf = buf.subarray(8 + n);
    }
    let i;
    while ((i = text.indexOf("\n")) >= 0) { onLine(l, text.slice(0, i).replace(/\r$/, "")); text = text.slice(i + 1); }
    if (text.length > 65536) text = "";
  });
  // the stream ends when the container stops: a crash, or our own stop
  res.on("end", () => { if (lobbies.get(l.code) === l && l.state !== "stopping") stopLobby(l, "crashed"); });
  res.on("error", () => {});
};

const onLine = (l, line) => {
  const m = /\[CSPEV\] (\w+) (\{.*\})\s*$/.exec(line);
  if (!m) return;
  let data = {}; try { data = JSON.parse(m[2]); } catch {}
  if (m[1] === "server_ready") l.onReady?.();
  if (m[1] === "humans") l.humans = data.n;
  if (m[1] === "match_finished") l.finishedAt = Date.now();
  (l.events ||= []).push({ at: Date.now(), name: m[1], data }); if (l.events.length > 40) l.events.shift();
  send({ t: "ev", code: l.code, name: m[1], data, at: Date.now() });
};

const startLobby = async (code) => {
  let have = lobbies.get(code);
  // a rematch: the Worker stops the finished server and starts a new one; the old one may still be going away
  if (have?.finishedAt && have.state !== "stopping") stopLobby(have, "rematch", false);
  if (have?.state === "stopping") { await have.stopped; have = lobbies.get(code); }
  if (have) { if (have.state === "ready") send({ t: "started", code, url: PUBLIC_URL }); return; }   // a repeat: same answer
  if (drain) return send({ t: "start_failed", code, error: "draining" });
  if (lobbies.size >= MAX_LOBBIES) return send({ t: "start_failed", code, error: "full" });
  const l = { code, port: 0, rcon: env.RCON_PASSWORD || crypto.randomBytes(12).toString("hex"), id: "", state: "starting", created: Date.now(),
    readyAt: 0, active: false, idleSince: 0, finishedAt: 0, humans: 0, cpu: 0, upKbps: 0, lastDown: 0 };
  lobbies.set(code, l);
  try {
    await pickPort(l);
    if (!l.port) throw new Error("no free port");
    await docker("DELETE", `/containers/csp-lobby-${code}?force=1`).catch(() => {});   // left over from a crash
    const c = await docker("POST", `/containers/create?name=csp-lobby-${code}`, containerSpec(l));
    l.id = c.Id;
    const ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server didn't come up in time")), READY_MS);
      l.onReady = () => { l.onReady = l.onFail = null; clearTimeout(t); resolve(); };
      l.onFail = (why) => { l.onReady = l.onFail = null; clearTimeout(t); reject(new Error(why)); };
    });
    ready.catch(() => {});
    const since = Math.floor(Date.now() / 1000) - 2;
    await docker("POST", `/containers/${l.id}/start`);
    log(`[${code}] starting on :${l.port} (${l.id.slice(0, 12)})`);
    await tail(l, since);   // from just before the start: the map takes 10 s or more, so nothing is missed
    await ready;
    // cvars ride rcon: on the command line they run before the plugin has registered them
    for (const c of ["csp_one_match 1", `hostname "CS Party ${code}"`, ...EXTRA_CVARS]) await rcon(l.port, l.rcon, c);
    l.state = "ready"; l.readyAt = Date.now();
    log(`[${code}] ready after ${Math.round((l.readyAt - l.created) / 1000)} s`);
    send({ t: "started", code, url: PUBLIC_URL });
  } catch (e) {
    if (l.state === "stopping") return;   // stopped while it loaded (and the Worker told, or the one asking)
    log(`[${code}] start failed: ${e.message}`);
    if (lobbies.get(code) === l) await stopLobby(l, "start_failed", false);
    send({ t: "start_failed", code, error: e.message });
  }
};

// tell: false when the Worker asked for it, or already heard (start_failed)
const stopLobby = (l, reason, tell = true) => {
  if (l.state === "stopping") return l.stopped;
  const was = l.state;
  l.state = "stopping"; l.onFail?.(reason);
  log(`[${l.code}] stopping (${reason}, was ${was}, up ${Math.round((Date.now() - l.created) / 1000)} s)`);
  try { l.logs?.destroy(); } catch {}
  return l.stopped = (async () => {
    if (l.id) await docker("DELETE", `/containers/${l.id}?force=1`).catch((e) => { if (e.status !== 404) log(`[${l.code}] remove: ${e.message}`); });
    if (lobbies.get(l.code) === l) lobbies.delete(l.code);
    if (tell) send({ t: "ended", code: l.code, reason });
    sendCap();
  })();
};

// Every 5 s: who can go. The relay's view (peers and game data downloads per lobby) decides "empty"; with no word
// from the relay for 30 s nothing is stopped for being empty (it may be restarting, its players reconnecting).
const reap = () => {
  const now = Date.now(), fresh = now - relay.at < 30000;
  for (const l of lobbies.values()) {
    if (l.state === "starting" && now - l.created > READY_MS + 30000) { stopLobby(l, "start_timeout"); continue; }
    if (l.state !== "ready") continue;
    if (now - l.readyAt > MAX_MATCH_MS) { stopLobby(l, "max_time"); continue; }
    if (l.finishedAt && now - l.finishedAt > LINGER_MS) { stopLobby(l, "finished"); continue; }
    if (!fresh) continue;
    const s = relay.lobbies[l.code];
    const busy = !!s && (s.peers > 0 || s.downloads > 0);
    if (busy) { l.active = true; l.idleSince = 0; continue; }
    if (!l.active) { if (now - l.readyAt > NOSHOW_MS) stopLobby(l, "no_show"); continue; }
    l.idleSince ||= now - 1000 * (s?.idleSecs || 0);
    // after the results everyone heads back to the lobby page: no need to wait the full idle time
    if (now - l.idleSince > (l.finishedAt ? 15000 : IDLE_MS)) stopLobby(l, l.finishedAt ? "finished" : "empty");
  }
};

// Adopt this host's lobby containers after a restart; remove dead ones.
const adopt = async () => {
  const list = await docker("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`csparty.agent=${HOST_ID}`] }))}`);
  for (const c of list) {
    const code = c.Labels["csparty.lobby"];
    if (c.State !== "running" || !code || lobbies.has(code)) { await docker("DELETE", `/containers/${c.Id}?force=1`).catch(() => {}); continue; }
    const l = { code, port: +c.Labels["csparty.port"], rcon: c.Labels["csparty.rcon"], id: c.Id, state: "starting", created: c.Created * 1000,
      readyAt: 0, active: true, idleSince: 0, finishedAt: 0, humans: 0, cpu: 0, upKbps: 0, lastDown: 0 };
    lobbies.set(code, l);
    // up already if the plugin has said so since its start
    const logs = await docker("GET", `/containers/${c.Id}/logs?stdout=1&stderr=1&tail=5000`).catch(() => "");
    if (String(logs).includes("[CSPEV] server_ready")) { l.state = "ready"; l.readyAt = Date.now(); }
    else l.onReady = () => { l.onReady = null; l.state = "ready"; l.readyAt = Date.now(); send({ t: "started", code, url: PUBLIC_URL }); };
    if (String(logs).includes("[CSPEV] match_finished")) l.finishedAt = Date.now();
    await tail(l, Math.floor(Date.now() / 1000));
    log(`[${code}] adopted (${l.state}, :${l.port})`);
  }
};

// ------------------------------------------------------------------------------------------------ capacity
// CPU per lobby container (100 = one core) from a one-shot stats read; upload from the relay's server->browser bytes.
const sampleCpu = async () => {
  for (const l of lobbies.values()) {
    if (!l.id || l.state === "stopping") continue;
    try {
      const s = await docker("GET", `/containers/${l.id}/stats?stream=false`, null, { timeout: 10000 });
      const cpu = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sys = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
      l.cpu = sys > 0 ? Math.round((cpu / sys) * (s.cpu_stats.online_cpus || 1) * 1000) / 10 : 0;
      l.memMb = Math.round((s.memory_stats.usage || 0) / 1048576);
    } catch {}
  }
};
const loadavg = () => { try { return +fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]; } catch { return -1; } };
const cap = () => ({
  t: "cap", host: HOST_ID, version: VERSION, url: PUBLIC_URL, max: MAX_LOBBIES, drain, running: lobbies.size, load: loadavg(),
  upKbps: up.kbps, cpu: Math.round([...lobbies.values()].reduce((a, l) => a + l.cpu, 0) * 10) / 10,
  lobbies: [...lobbies.values()].map((l) => ({ code: l.code, state: l.state, cpu: l.cpu, memMb: l.memMb || 0, upKbps: l.upKbps,
    peers: relay.lobbies[l.code]?.peers || 0, humans: l.humans, finished: !!l.finishedAt })),
});
const sendCap = () => send(cap());

// ------------------------------------------------------------------------------------------------ the Worker
// Auth: "CSP-Agent <ts>.<sig>", sig = HMAC-SHA256(LOBBY_SECRET, "csp-agent|<host>|<ts>"), checked within 5 min.
let ws = null, backoff = 1000, lastMsg = 0;
const send = (o) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const connect = () => {
  if (!LOBBY_WS) return;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", SECRET).update(`csp-agent|${HOST_ID}|${ts}`).digest("base64url");
  const url = `${LOBBY_WS}${LOBBY_WS.includes("?") ? "&" : "?"}host=${encodeURIComponent(HOST_ID)}`;
  const sock = ws = new WebSocket(url, { headers: { Authorization: `CSP-Agent ${ts}.${sig}` }, handshakeTimeout: 15000 });
  sock.on("open", () => {
    backoff = 1000; lastMsg = Date.now();
    log(`connected to ${LOBBY_WS}`);
    send({ t: "hello", host: HOST_ID, version: VERSION, url: PUBLIC_URL, max: MAX_LOBBIES, drain,
      lobbies: [...lobbies.values()].map((l) => ({ code: l.code, state: l.state })) });
    sendCap();
  });
  sock.on("message", (raw) => {
    lastMsg = Date.now();
    const s = raw.toString();
    if (s === "pong") return;
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.t === "start" && /^[A-Z2-9]{5}$/.test(m.code)) startLobby(m.code);
    else if (m.t === "stop" && lobbies.has(m.code)) stopLobby(lobbies.get(m.code), m.reason || "lobby", false);
    else if (m.t === "drain") { drain = !!m.on; log(`drain ${drain ? "on" : "off"}`); sendCap(); }
  });
  sock.on("unexpected-response", (req, res) => log(`Worker refused the agent: ${res.statusCode}`));
  sock.on("error", (e) => log(`Worker socket: ${e.message}`));
  sock.on("close", () => {
    if (ws === sock) ws = null;
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000);
  });
};
// keepalive both ways; the Durable Object answers "ping" without waking up
setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastMsg > 90000) { log("Worker socket silent for 90 s: reconnecting"); ws.terminate(); return; }
  ws.send("ping");
}, 30000).unref();

// ------------------------------------------------------------------------------------------------ loopback API
// POST /sync: the relay's per-lobby counts in, routes (code -> port) out. GET /status: everything, for people.
const server = http.createServer((req, res) => {
  const out = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o) + "\n"); };
  if (req.method === "POST" && req.url === "/sync") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        const now = Date.now();
        // upload = bytes the relay sent to browsers; per lobby too
        if (relay.at && j.downBytes >= relay.downBytes) up.kbps = Math.round(((j.downBytes - relay.downBytes) * 8) / Math.max(1, now - relay.at));
        for (const l of lobbies.values()) {
          const s = j.lobbies?.[l.code], prev = relay.lobbies[l.code];
          if (s && prev && relay.at) l.upKbps = Math.round(((s.downBytes - prev.downBytes) * 8) / Math.max(1, now - relay.at));
        }
        relay = { at: now, lobbies: j.lobbies || {}, downBytes: j.downBytes || 0 };
      } catch {}
      const routes = {};
      for (const l of lobbies.values()) if (l.state === "ready") routes[l.code] = l.port;
      out(200, { routes });
    });
    return;
  }
  if (req.method === "GET" && req.url === "/status") return out(200, { ...cap(), worker: ws?.readyState === WebSocket.OPEN,
    relaySecs: relay.at ? Math.round((Date.now() - relay.at) / 1000) : null,
    detail: [...lobbies.values()].map((l) => ({ code: l.code, port: l.port, state: l.state, ageSecs: Math.round((Date.now() - l.created) / 1000), events: l.events || [] })) });
  out(404, { error: "not found" });
});

// ------------------------------------------------------------------------------------------------ main
const main = async () => {
  if (!IMAGE || !SECRET || !PUBLIC_URL) { console.error("pool-agent: set IMAGE, LOBBY_SECRET and PUBLIC_URL"); process.exit(2); }
  await ensureNetwork();
  await adopt();
  server.listen(+LISTEN_PORT, LISTEN_HOST, () => log(`pool-agent ${VERSION} for ${HOST_ID}: ${lobbies.size} adopted, max ${MAX_LOBBIES}, image ${IMAGE}, on ${LISTEN_HOST}:${LISTEN_PORT}`));
  connect();
  setInterval(reap, 5000).unref();
  setInterval(async () => { await sampleCpu(); sendCap(); }, 30000).unref();
};
// Containers outlive the agent on purpose (players keep playing through an agent restart); a restarted agent adopts them.
process.on("SIGTERM", () => { log("SIGTERM: leaving lobby servers running"); process.exit(0); });
process.on("SIGINT", () => process.exit(0));
process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack || e}`));
process.on("unhandledRejection", (e) => log(`unhandled: ${e?.stack || e}`));
main().catch((e) => { console.error(e); process.exit(1); });
