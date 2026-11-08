// PHA-4004 spike: lets the shipped CS Party browser client play on a browser-hosted server without touching the
// engine. Emscripten turns every UDP destination into `new WebSocket(<relay url>)`; with ?p2p=<code> the relay
// socket becomes a WebRTC DataChannel to the host tab instead. Everything else (voice, lobby sockets) stays a
// real WebSocket. Must run before boot.js captures window.WebSocket (a <script> ahead of it, or an init script).
(() => {
  const params = new URLSearchParams(location.search);
  const code = params.get("p2p");
  if (!code) return;
  const signalUrl = params.get("signal") || `ws://${location.hostname}:8098`;
  const ICE = JSON.parse(params.get("ice") || "[]");
  const NativeWS = window.WebSocket;

  class DataChannelSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    constructor(url) {
      super();
      this.url = url; this.readyState = 0; this.binaryType = "arraybuffer"; this.bufferedAmount = 0; this.protocol = "binary";
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      const sig = this.sig = new NativeWS(signalUrl);
      const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });
      const dc = this.dc = pc.createDataChannel("game", { ordered: false, maxRetransmits: 0 });
      dc.binaryType = "arraybuffer";
      const sigSend = (o) => sig.send(JSON.stringify(o));
      pc.onicecandidate = (ev) => ev.candidate && sigSend({ type: "signal", data: { candidate: ev.candidate } });
      sig.onopen = () => sigSend({ type: "join", code });
      sig.onmessage = async (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "joined") {
          await pc.setLocalDescription(await pc.createOffer());
          sigSend({ type: "signal", data: { sdp: pc.localDescription } });
        } else if (m.type === "signal") {
          if (m.data.sdp) await pc.setRemoteDescription(m.data.sdp);
          else if (m.data.candidate) await pc.addIceCandidate(m.data.candidate).catch(() => {});
        } else if (m.type === "host_left") this._close(4004, "host left");
        else if (m.type === "error") this._close(4004, m.reason);
      };
      dc.onopen = () => {
        this.readyState = 1;
        const pair = pc.getStats().then((s) => { for (const r of s.values()) if (r.type === "candidate-pair" && r.nominated) return r; });
        pair.then((r) => console.log(`[p2p] channel open to host (${r ? r.state : "?"})`));
        this._emit("open", new Event("open"));
      };
      dc.onmessage = (e) => this._emit("message", new MessageEvent("message", { data: e.data }));
      dc.onclose = () => this._close(1006, "channel closed");
      pc.onconnectionstatechange = () => { console.log(`[p2p] ${pc.connectionState}`); if (pc.connectionState === "failed") this._close(1006, "ICE failed"); };
    }
    _emit(type, ev) { this.dispatchEvent(ev); const h = this["on" + type]; if (h) h.call(this, ev); }
    _close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      try { this.dc.close(); this.pc.close(); this.sig.close(); } catch {}
      this._emit("close", new CloseEvent("close", { code, reason }));
    }
    send(data) { if (this.readyState === 1) this.dc.send(data); }
    close() { this._close(1000, ""); }
  }

  window.WebSocket = new Proxy(NativeWS, {
    // boot.js subclasses window.WebSocket (WatchedWS); returning our object from super() keeps its listeners working
    construct(target, args, newTarget) { return /\/relay/.test(String(args[0])) ? new DataChannelSocket(args[0]) : Reflect.construct(target, args, newTarget); },
  });
  console.log(`[p2p] game traffic goes peer to peer to lobby ${code}`);
})();
