// PHA-4004 spike: the host tab. Runs the game server in a Worker and gives each joining player a WebRTC
// DataChannel to it. Signaling goes through the lobby's socket (here: signal.mjs standing in for the lobby DO).
// Game datagrams ride one unordered, no-retransmit channel per player: UDP semantics, which GoldSrc netcode wants.
const params = new URLSearchParams(location.search);
const code = params.get("code") || "SPIKE";
const signalUrl = params.get("signal") || `ws://${location.hostname}:8098`;
const ICE = JSON.parse(params.get("ice") || "[]");   // production: TURN credentials minted by the lobby Worker
const log = (t) => { console.log(t); const el = document.getElementById("log"); if (el) el.textContent += t + "\n"; };

const worker = new Worker("server_worker.js");
const peers = new Map();   // id -> { pc, dc }
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "pkt") { const p = peers.get(m.peer); if (p && p.dc && p.dc.readyState === "open") p.dc.send(m.data); }
  else if (m.type === "log") log(m.text);
  else if (m.type === "stats") {
    const s = m.stats;
    log(`[host] frames ${s.frames} avg ${(s.frameMs / Math.max(1, s.frames)).toFixed(3)} ms worst ${s.worstMs.toFixed(1)} ms rx ${s.rx} tx ${s.tx} (${s.txBytes} B) heap ${s.heapMB.toFixed(0)} MB peers ${peers.size}`);
    window.__hostStats = s;
  } else if (m.type === "ready") { log("[host] server ready"); window.__hostReady = true; }
};
worker.postMessage({
  type: "start",
  zips: [params.get("gamedata") || "gamedata.zip", "srv_overlay.zip"],
  libs: { "filesystem_stdio.so": "filesystem_stdio.so", "cstrike/dlls/cs_emscripten_wasm32.so": "cs_server.so" },
  args: (params.get("args") || "+bot_enable 1 +maxplayers 8 +map de_dust2").split(" "),
});
window.serverCmd = (text) => worker.postMessage({ type: "cmd", text });

const sig = new WebSocket(signalUrl);
const sigSend = (o) => sig.send(JSON.stringify(o));
sig.onopen = () => { sigSend({ type: "host", code }); log(`[host] lobby ${code} open for players`); };
sig.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "peer") {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const p = { pc, dc: null }; peers.set(m.id, p);
    pc.onicecandidate = (ev) => ev.candidate && sigSend({ type: "signal", to: m.id, data: { candidate: ev.candidate } });
    pc.ondatachannel = (ev) => {
      p.dc = ev.channel; p.dc.binaryType = "arraybuffer";
      p.dc.onopen = () => log(`[host] player ${m.id} channel open`);
      p.dc.onmessage = (msg) => {
        const d = msg.data;
        // Emscripten's first datagram on a bound socket announces its port; not game traffic (as in relay.js)
        if (d.byteLength === 10 && new Uint8Array(d, 4, 4).every((c, i) => c === "port".charCodeAt(i))) return;
        worker.postMessage({ type: "pkt", peer: m.id, data: d }, [d]);
      };
      p.dc.onclose = () => log(`[host] player ${m.id} channel closed`);
    };
    pc.onconnectionstatechange = () => log(`[host] player ${m.id} ${pc.connectionState}`);
  } else if (m.type === "signal") {
    const p = peers.get(m.from); if (!p) return;
    if (m.data.sdp) {
      await p.pc.setRemoteDescription(m.data.sdp);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      sigSend({ type: "signal", to: m.from, data: { sdp: p.pc.localDescription } });
    } else if (m.data.candidate) await p.pc.addIceCandidate(m.data.candidate).catch(() => {});
  } else if (m.type === "peer_left") {
    const p = peers.get(m.id); if (p) { p.pc.close(); peers.delete(m.id); }
  }
};
