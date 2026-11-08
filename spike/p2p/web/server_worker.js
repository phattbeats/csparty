// PHA-4004 spike: the CS Party game server (Xash3D FWGS dedicated + ReGameDLL_CS, both wasm) in a Web Worker.
// The host page owns the WebRTC peers and posts datagrams in and out; the worker owns the engine and its clock,
// so rendering in the host's own game tab never stalls the server, and the server never stalls the host's game.
/* global XashServer, fflate */
importScripts("fflate.js", "xash_server.js");

const inbox = [];
const fakeIp = (n) => (10 | (99 << 8) | ((n >> 8 & 255) << 16) | ((n & 255) << 24)) >>> 0;   // s_addr bytes 10.99.hi.lo
const peerOfIp = new Map();
const stats = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, frames: 0, frameMs: 0, worstMs: 0 };
let em = null;

const cspNet = {
  listen(port) { postMessage({ type: "log", text: `[worker] engine listens on ${port}` }); },
  recv() { return inbox.shift(); },
  send(ip, port, data) {
    const peer = peerOfIp.get(ip);
    if (peer === undefined) return;
    stats.tx++; stats.txBytes += data.length;   // before the transfer empties it
    postMessage({ type: "pkt", peer, data: data.buffer }, [data.buffer]);
  },
};

async function fetchZip(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return fflate.unzipSync(new Uint8Array(await r.arrayBuffer()));
}
function mkdirp(FS, p) {
  let cur = "";
  for (const part of p.split("/").filter(Boolean)) { cur += "/" + part; try { FS.mkdir(cur); } catch {} }
}

async function start({ zips, libs, args }) {
  const t0 = performance.now();
  em = await XashServer({ cspNet, print: (t) => postMessage({ type: "log", text: t }), printErr: (t) => postMessage({ type: "log", text: t }) });
  const ROOT = "/game";
  mkdirp(em.FS, ROOT);
  let bytes = 0;
  for (const url of zips) {   // later zips override earlier ones (server overlay after the shared game data)
    const files = await fetchZip(url);
    for (const [p, data] of Object.entries(files)) {
      if (p.endsWith("/")) continue;
      mkdirp(em.FS, ROOT + "/" + p.split("/").slice(0, -1).join("/"));
      em.FS.writeFile(ROOT + "/" + p, data, { canOwn: true }); bytes += data.length;
    }
  }
  for (const [dest, url] of Object.entries(libs)) {
    const r = await fetch(url); const data = new Uint8Array(await r.arrayBuffer());
    mkdirp(em.FS, ROOT + "/" + dest.split("/").slice(0, -1).join("/"));
    em.FS.writeFile(ROOT + "/" + dest, data); bytes += data.length;
  }
  em.FS.chdir(ROOT);
  postMessage({ type: "log", text: `[worker] ${(bytes / 1048576).toFixed(0)} MB of files in ${(performance.now() - t0).toFixed(0)} ms` });
  em.callMain(["-dedicated", "-game", "cstrike", "-port", "27015", "-noip6", ...args]);
  postMessage({ type: "ready" });
  const tick = () => {
    const a = performance.now();
    if (em._CSP_HostFrame() < 0) { postMessage({ type: "log", text: "[worker] engine stopped" }); return; }
    const d = performance.now() - a;
    stats.frames++; stats.frameMs += d; stats.worstMs = Math.max(stats.worstMs, d);
    setTimeout(tick, 1);
  };
  tick();
  setInterval(() => {
    postMessage({ type: "stats", stats: { ...stats, heapMB: em.HEAP8.length / 1048576 } });
    stats.frames = 0; stats.frameMs = 0; stats.worstMs = 0;
  }, 10000);
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === "start") start(m).catch((err) => postMessage({ type: "log", text: `[worker] start failed: ${err.stack || err}` }));
  else if (m.type === "pkt") {
    const ip = fakeIp(m.peer);
    peerOfIp.set(ip, m.peer);
    inbox.push({ ip, port: 27005, data: new Uint8Array(m.data) });
    stats.rx++; stats.rxBytes += m.data.byteLength;
  } else if (m.type === "cmd" && em) em.ccall("Cbuf_AddText", null, ["string"], [m.text + "\n"]);
};
