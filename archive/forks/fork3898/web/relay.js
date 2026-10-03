// CS Party web relay.
// Serves the browser client and bridges each browser's WebSocket to its own UDP socket on the game
// server, so browser players join the real ReHLDS server like anyone else.
//
// The browser engine is Xash3D FWGS built with Emscripten; Emscripten turns the engine's UDP sockets
// into WebSockets: one connection per destination, an optional 10-byte "port" hello, then one binary
// message per datagram. This relay is the other end of that.
//
//   node relay.js [--port 8080] [--game 127.0.0.1:27015] [--root ./public] [--key PARTYKEY]
//
// --key (or PARTY_KEY): gamedata.zip and the game socket then need ?key=PARTYKEY. The page itself stays
// open, so an invite link is just https://your.host/?key=PARTYKEY. Use it on anything internet-facing:
// gamedata.zip is Valve's content, packed from your install for your friends, not for the world.
//
// Env knobs: MAX_PEERS (32), MAX_PER_IP (6), IDLE_SECS (120: no game traffic either way -> close).
import crypto from "node:crypto";
import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg("--port", process.env.PORT || 8080);
const [GAME_HOST, GAME_PORT] = arg("--game", process.env.GAME || "127.0.0.1:27015").split(":");
const ROOT = path.resolve(arg("--root", process.env.ROOT || "./public"));
const MAX_PEERS = +(process.env.MAX_PEERS || 32);
const MAX_PER_IP = +(process.env.MAX_PER_IP || 6);
const IDLE_MS = +(process.env.IDLE_SECS || 120) * 1000;
const BACKLOG_MAX = 512 * 1024;   // bytes queued to a slow browser before we start dropping server packets
const KEY = arg("--key", process.env.PARTY_KEY || "");
const PROTECTED = new Set(["/gamedata.zip"]);
const keyOk = (reqUrl) => {
  if (!KEY) return true;
  let q; try { q = new URL(reqUrl || "/", "http://x").searchParams.get("key") || ""; } catch { return false; }
  const got = Buffer.from(q);
  const want = Buffer.from(KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
// Test hook, only with RELAY_DEV=1: GET /dev/blackhole?secs=N drops server->browser packets for N seconds,
// which is what a client that misses a map change sees. tools/dev/web_e2e.py --stall uses it.
const DEV = process.env.RELAY_DEV === "1";
let blackholeUntil = 0;
// X-Forwarded-For only means something behind your own reverse proxy (SWAG etc.). TRUST_PROXY=1 there;
// exposed directly, a client could forge it to dodge MAX_PER_IP.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const clientIp = (req) => (TRUST_PROXY && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm",
  ".so": "application/wasm", ".zip": "application/zip", ".pk3": "application/zip", ".css": "text/css",
  ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const stats = { started: Date.now(), peers: 0, totalPeers: 0, up: 0, down: 0, dropped: 0, rejected: 0 };

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400).end(); return; }
  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...stats, uptime: Math.round((Date.now() - stats.started) / 1000) }) + "\n");
    return;
  }
  if (DEV && url === "/dev/blackhole") {
    let secs = 20; try { secs = +(new URL(req.url, "http://x").searchParams.get("secs") || 20); } catch {}
    blackholeUntil = Date.now() + secs * 1000; log(`dev: dropping server->browser traffic for ${secs} s`);
    res.writeHead(200).end("ok\n"); return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
  const file = path.join(ROOT, url === "/" ? "index.html" : url);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end(); return; }
  if (PROTECTED.has(url) && !keyOk(req.url)) { res.writeHead(403).end("party key required\n"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const ext = path.extname(file);
    // ETag lets the page keep game data in its own cache and check it with one HEAD request
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size, ETag: etag,
      // engine files are immutable per deploy; pages and scripts revalidate
      "Cache-Control": [".zip", ".wasm", ".so", ".pk3"].includes(ext) ? "public, max-age=604800" : "no-cache" };
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }).end(); return; }
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on("error", => res.destroy());
    stream.pipe(res);
  });
});

const perIp = new Map();
const wss = new WebSocketServer({ server, path: "/relay", maxPayload: 64 * 1024,
  handleProtocols: (p) => (p.has("binary") ? "binary" : false),
  verifyClient: ({ req }, cb) => {
    const ip = clientIp(req);
    if (!keyOk(req.url)) { stats.rejected++; return cb(false, 401, "party key required"); }
    if (stats.peers >= MAX_PEERS) { stats.rejected++; return cb(false, 503, "relay full"); }
    if ((perIp.get(ip) || 0) >= MAX_PER_IP) { stats.rejected++; return cb(false, 429, "too many connections"); }
    cb(true);
  } });

let seq = 0;
wss.on("connection", (ws, req) => {
  const id = ++seq, who = clientIp(req);
  perIp.set(who, (perIp.get(who) || 0) + 1);
  stats.peers++; stats.totalPeers++;
  const udp = dgram.createSocket("udp4");
  let first = true, up = 0, down = 0, dropped = 0, alive = true, lastTraffic = Date.now(), closed = false;

  const close = (why) => {
    if (closed) return; closed = true;
    clearInterval(beat);
    try { udp.close(); } catch {}
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    stats.peers--; perIp.set(who, perIp.get(who) - 1); if (!perIp.get(who)) perIp.delete(who);
    log(`[${id}] closed: ${why} (${up} up / ${down} down${dropped ? ` / ${dropped} dropped` : ""})`);
  };

  udp.on("message", (msg) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (blackholeUntil && Date.now() < blackholeUntil) { dropped++; return; }
    // UDP semantics end to end: a browser that can't keep up loses packets instead of growing a queue
    if (ws.bufferedAmount > BACKLOG_MAX) { dropped++; stats.dropped++; return; }
    ws.send(msg, { binary: true }); down++; stats.down++; lastTraffic = Date.now();
  });
  udp.on("error", (e) => close(`udp error ${e.message}`));
  udp.bind(0, => log(`[${id}] ${who} -> udp :${udp.address().port} -> ${GAME_HOST}:${GAME_PORT}`));

  ws.on("message", (data) => {
    if (closed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Emscripten's first message on a bound datagram socket announces its local port; not game traffic
    if (first && buf.length === 10 && buf.readUInt32BE(0) === 0xffffffff && buf.toString("latin1", 4, 8) === "port") { first = false; return; }
    first = false;
    try { udp.send(buf, +GAME_PORT, GAME_HOST); } catch (e) { return close(`udp send ${e.code || e.message}`); }
    up++; stats.up++; lastTraffic = Date.now();
  });
  ws.on("pong", => { alive = true; });
  ws.on("close", (code) => close(`browser closed (${code})`));
  ws.on("error", (e) => close(`ws error ${e.message}`));

  // A tab that vanished without a close frame (sleep, network change) would otherwise hold its UDP socket
  // forever. Ping every 15 s; no pong by the next ping, or no game traffic for IDLE_SECS, and it's gone.
  const beat = setInterval(() => {
    if (!alive) return close("no pong");
    if (Date.now() - lastTraffic > IDLE_MS) return close("idle");
    alive = false;
    try { ws.ping(); } catch { close("ping failed"); }
  }, 15000);
});

const shutdown = (sig) => {
  log(`${sig}: closing ${stats.peers} peers`);
  for (const ws of wss.clients) ws.close(1001, "relay restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", => shutdown("SIGTERM"));
process.on("SIGINT", => shutdown("SIGINT"));

server.listen(PORT, => log(`CS Party relay: http://0.0.0.0:${PORT}  ->  ${GAME_HOST}:${GAME_PORT}  (root ${ROOT})${KEY ? "  [party key on]" : ""}`));
