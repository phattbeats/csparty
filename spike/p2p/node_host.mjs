// PHA-4004 spike: run the wasm dedicated server (Xash3D FWGS + ReGameDLL_CS) under node, with its datagrams
// bridged to a real UDP port. This is the same engine build a browser host would run in a Worker; only the
// Module.cspNet backend differs (here: node dgram, in a tab: WebRTC DataChannels).
//
// usage: node node_host.mjs --out <dir with xash_server.js> --game <dir with valve/ cstrike/> [--port 27400]
//                           [-- <extra engine args, e.g. +map de_dust2 +maxplayers 8>]
import { createRequire } from "node:module";
import dgram from "node:dgram";
import path from "node:path";
import { parseArgs } from "node:util";

const dash = process.argv.indexOf("--");
const { values: opt } = parseArgs({
  args: process.argv.slice(2, dash < 0 ? undefined : dash),
  options: { out: { type: "string" }, game: { type: "string" }, port: { type: "string", default: "27400" }, stats: { type: "string", default: "10" } },
});
const extra = dash < 0 ? ["+map", "de_dust2", "+maxplayers", "8"] : process.argv.slice(dash + 1);
const XashServer = createRequire(import.meta.url)(path.resolve(opt.out, "xash_server.js"));

// one fake 10.99.x.y address per real peer; the engine only ever sees these
const peers = new Map(), byFake = new Map(), inbox = [];
let nextPeer = 1;
const fakeIp = (n) => (10 | (99 << 8) | ((n >> 8 & 255) << 16) | ((n & 255) << 24)) >>> 0;   // s_addr bytes 10.99.hi.lo
const stats = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, frames: 0 };
const udp = dgram.createSocket("udp4");
udp.on("message", (data, from) => {
  const key = `${from.address}:${from.port}`;
  let p = peers.get(key);
  if (!p) { p = { ip: fakeIp(nextPeer++), port: from.port, address: from.address, rport: from.port }; peers.set(key, p); byFake.set(`${p.ip}:${p.port}`, p); console.log(`[net] peer ${key}`); }
  inbox.push({ ip: p.ip, port: p.port, data: new Uint8Array(data) });
  if (process.env.TRACE && stats.rx < 12) console.log(`[trace] rx ${data.length} ${JSON.stringify(data.subarray(0, 480).toString("latin1"))}`);
  stats.rx++; stats.rxBytes += data.length;
});

const cspNet = {
  listen(port) { console.log(`[net] engine listens on ${port}; bridged to udp :${opt.port}`); },
  recv() { return inbox.shift(); },
  send(ip, port, data) {
    const p = byFake.get(`${ip}:${port}`);
    if (!p) return;
    udp.send(data, p.rport, p.address);
    if (process.env.TRACE && stats.tx < 12) console.log(`[trace] tx ${data.length} ${JSON.stringify(Buffer.from(data.subarray(0, 160)).toString("latin1"))}`);
    stats.tx++; stats.txBytes += data.length;
  },
};

const t0 = performance.now();
const Module = {
  cspNet,
  locateFile: (f) => path.resolve(opt.out, f),
  print: (t) => console.log(t),
  printErr: (t) => console.warn(t),
};
const em = await XashServer(Module);
console.log(`[host] runtime ready in ${(performance.now() - t0).toFixed(0)} ms`);
em.FS.mkdir("/game");
em.FS.mount(em.NODEFS, { root: path.resolve(opt.game) }, "/game");
em.FS.chdir("/game");
udp.bind(+opt.port, "0.0.0.0");

// CPU and memory the server costs, the numbers that decide whether a host tab can carry it
let lastCpu = process.cpuUsage(), lastT = performance.now();
setInterval(() => {
  const cpu = process.cpuUsage(lastCpu), now = performance.now();
  const pct = ((cpu.user + cpu.system) / 1000 / (now - lastT)) * 100;
  lastCpu = process.cpuUsage(); lastT = now;
  const heap = em.HEAP8 ? em.HEAP8.length : 0;
  console.log(`[stats] cpu ${pct.toFixed(1)}% wasm-heap ${(heap / 1048576).toFixed(0)} MB rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB peers ${peers.size} rx ${stats.rx} (${stats.rxBytes} B) tx ${stats.tx} (${stats.txBytes} B)`);
}, +opt.stats * 1000).unref();

// Host_Main only initialises; we own the clock (a tab would tick from a Worker, same as this)
em.callMain(["-dedicated", "-game", "cstrike", "-port", "27015", "-noip6", "-dev", "1", "-log", ...extra]);
const frame = em._CSP_HostFrame;
let frameMs = 0, worstMs = 0;
const tick = () => {
  const a = performance.now();
  if (frame() < 0) { console.log("[host] engine stopped"); process.exit(1); }
  const d = performance.now() - a;
  frameMs += d; worstMs = Math.max(worstMs, d); stats.frames++;
  setTimeout(tick, 1);   // ~1 ms like a browser timer; the engine skips frames it doesn't need yet (sys_ticrate)
};
tick();
// console: each stdin line is a server command (status, bot_add, changelevel ...)
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { for (const line of chunk.split("\n")) if (line.trim()) em.ccall("Cbuf_AddText", null, ["string"], [line + "\n"]); });
setInterval(() => {
  console.log(`[frames] ${stats.frames} calls, avg ${(frameMs / Math.max(1, stats.frames)).toFixed(3)} ms, worst ${worstMs.toFixed(1)} ms`);
  stats.frames = 0; frameMs = 0; worstMs = 0;
}, +opt.stats * 1000).unref();
