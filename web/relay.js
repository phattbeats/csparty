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
// Env knobs: MAX_PEERS (32), MAX_PER_IP (6), IDLE_SECS (120: no game traffic either way -> close),
// LOBBY_SECRET + RELAY_ID (also accept the lobby Worker's per-lobby keys; see lobbyKeyOk).
import crypto from "node:crypto";
import http from "node:http";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { WebSocketServer } from "ws";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg("--port", process.env.PORT || 8080);
const [GAME_HOST, GAME_PORT] = arg("--game", process.env.GAME || "127.0.0.1:27015").split(":");
const GAME_IS_IP = net.isIP(GAME_HOST) !== 0;
const ROOT = path.resolve(arg("--root", process.env.ROOT || "./public"));
const MAX_PEERS = +(process.env.MAX_PEERS || 32);
const MAX_PER_IP = +(process.env.MAX_PER_IP || 6);
const IDLE_MS = +(process.env.IDLE_SECS || 120) * 1000;
const BACKLOG_MAX = 512 * 1024;   // bytes queued to a slow browser before we start dropping server packets
const KEY = arg("--key", process.env.PARTY_KEY || "");
const PROTECTED_FILES = new Set([path.join(ROOT, "gamedata.zip")]);
// Lobby party keys (ISSUE, lobby/): the lobby Worker gives each lobby it sends here CODE.EXPIRY.SIG, an
// HMAC-SHA256 over this relay's RELAY_ID with the LOBBY_SECRET both sides share. Accepted next to --key.
const LOBBY_SECRET = process.env.LOBBY_SECRET || "", RELAY_ID = process.env.RELAY_ID || "";
const lobbyKeyOk = (k) => {
  const m = LOBBY_SECRET && RELAY_ID && /^([A-Z2-9]{5})\.(\d{9,11})\.([\w-]{24})$/.exec(k);
  if (!m || +m[2] < Date.now() / 1000) return false;
  const want = Buffer.from(crypto.createHmac("sha256", LOBBY_SECRET).update(`csp-lobby|${RELAY_ID}|${m[1]}|${m[2]}`).digest().subarray(0, 18).toString("base64url"));
  const got = Buffer.from(m[3]);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const keyOk = (reqUrl) => {
  if (!KEY) return true;
  let q; try { q = new URL(reqUrl || "/", "http://x").searchParams.get("key") || ""; } catch { return false; }
  if (lobbyKeyOk(q)) return true;
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
// Behind Cloudflare the first X-Forwarded-For entry is whatever the client sent; CF-Connecting-IP isn't.
const clientIp = (req) => (TRUST_PROXY && (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0].trim())) || req.socket.remoteAddress;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...a);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm",
  ".so": "application/wasm", ".zip": "application/zip", ".pk3": "application/zip", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json" };

const stats = { started: Date.now(), peers: 0, totalPeers: 0, up: 0, down: 0, dropped: 0, rejected: 0 };

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400).end(); return; }
  if (url.includes("\0")) { res.writeHead(400).end(); return; }   // fs.stat throws synchronously on a NUL: one request took the relay down
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
  // check the file actually served: "//gamedata.zip" or "/x/..%2Fgamedata.zip" resolve to it too
  // race map packs hold slices of Valve's WADs too
  const isProtected = PROTECTED_FILES.has(file) || file.startsWith(path.join(ROOT, "mappacks") + path.sep);
  if (isProtected && !keyOk(req.url)) { res.writeHead(403).end("party key required\n"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const ext = path.extname(file);
    // ETag lets the page keep game data in its own cache and check it with one HEAD request
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size, ETag: etag,
      // everything revalidates by ETag (a 304 is cheap): fixed-name engine files cached for a week could pair
      // a new xash.js with an old xash.wasm after an engine rebuild
      // the key-protected game data is Valve's content: never on a shared cache (Cloudflare kept serving a
      // week-old copy after updates). Browsers keep it in their own Cache Storage, checked by ETag.
      "Cache-Control": isProtected ? "private, no-cache" : "no-cache" };
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
  // A refused handshake reaches the page only as close code 1006, whatever the reason. So the socket is
  // accepted and closed at once with a code the page can explain (4001 key, 4003 full, 4029 per-IP cap).
  verifyClient: ({ req }, cb) => {
    const ip = clientIp(req);
    req.refuse = !keyOk(req.url) ? [4001, "party key required"] : stats.peers >= MAX_PEERS ? [4003, "relay full"]
      : (perIp.get(ip) || 0) >= MAX_PER_IP ? [4029, "too many connections"] : null;
    if (req.refuse) stats.rejected++;
    cb(true);
  } });

let seq = 0;
wss.on("connection", (ws, req) => {
  // a refused socket still gets an error listener: one malformed frame on it was an unhandled error that killed the relay
  if (req.refuse) { ws.on("error", => {}); log(`refused ${clientIp(req)}: ${req.refuse[1]}`); ws.close(...req.refuse); return; }
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

  udp.on("message", (msg, from) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (GAME_IS_IP && (from.address !== GAME_HOST || from.port !== +GAME_PORT)) return;   // only the game server talks to browsers
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
// Last resort: one bad request must not drop every player in the party. Log it and keep relaying.
process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack || e}`));
server.on("clientError", (e, sock) => { try { sock.destroy(); } catch {} });
process.on("SIGINT", => shutdown("SIGINT"));

server.listen(PORT, => log(`CS Party relay: http://0.0.0.0:${PORT}  ->  ${GAME_HOST}:${GAME_PORT}  (root ${ROOT})${KEY ? "  [party key on]" : ""}`));
