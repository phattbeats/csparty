// PHA-4004 spike: local stand-in for the lobby Durable Object's signaling role. One room per lobby code; the
// host registers, joiners get a peer id, and offers/answers/ICE candidates are forwarded between them. No game
// traffic touches it. In production this is three more message types on the lobby DO's existing WebSocket.
//
// usage: WS=<path to the ws package> node signal.mjs [port]
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.url)(process.env.WS || "ws");
const port = +(process.argv[2] || 8098);
const rooms = new Map();   // code -> { host, peers: Map<id, ws> }
let nextId = 1;

const wss = new WebSocketServer({ port });
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
wss.on("connection", (ws) => {
  let room = null, id = 0, isHost = false;
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "host") {
      room = { host: ws, peers: new Map() }; rooms.set(m.code, room); isHost = true;
      console.log(`[signal] host up for ${m.code}`);
    } else if (m.type === "join") {
      room = rooms.get(m.code);
      if (!room) return send(ws, { type: "error", reason: "no such lobby" });
      id = nextId++; room.peers.set(id, ws);
      send(ws, { type: "joined", id });
      send(room.host, { type: "peer", id });
      console.log(`[signal] peer ${id} joined ${m.code}`);
    } else if (m.type === "signal" && room) {
      // host -> peer (m.to) or peer -> host
      if (isHost) send(room.peers.get(m.to), { type: "signal", data: m.data });
      else send(room.host, { type: "signal", from: id, data: m.data });
    }
  });
  ws.on("close", () => {
    if (!room) return;
    if (isHost) { for (const p of room.peers.values()) send(p, { type: "host_left" }); rooms.forEach((r, c) => r === room && rooms.delete(c)); }
    else { room.peers.delete(id); send(room.host, { type: "peer_left", id }); }
  });
});
console.log(`[signal] ws://0.0.0.0:${port}`);
