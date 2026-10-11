# Voice chat (PHA-4058)

Push-to-talk between browser players, peer to peer over WebRTC (audio-only mesh, so it suits the
party's 10 seats). Native clients are not bridged.

- **Relay** (`web/relay.js`): a second WebSocket, `/voice` (same party key as `/relay`), only introduces
  peers. Messages: `welcome {id, peers}`, `hello {name}`, `join`, `leave`, `sig {to, data}` (offer, answer,
  ICE, forwarded by id) and `talk {on}`. Audio never touches the relay. Cap `MAX_VOICE` (16); 60 messages/s per socket.
- **Page** (`web/public/boot.js`): connects when the player joins. The newcomer calls everyone already
  there. The mic is requested on the first press, then the track is swapped in with `replaceTrack` (no
  renegotiation). Hold **V** or the on-screen mic button to talk; a pill shows who is talking; the Esc/Menu
  card lists players with a Mute button (remembered per name in localStorage).
- **ICE**: Google STUN only (`stun:stun.l.google.com:19302`), no TURN. Players behind symmetric NAT or strict
  firewalls may not connect; add a TURN server to `STUN` in boot.js if that shows up. WebRTC shows each
  player's IP address to the others in the party.
- **Test**: `tools/dev/rig/shoot.js` launches Chromium with a fake microphone; join two rigs, hold `V` in one
  (`down KeyV`) and check `#voice-talk` and the remote `<audio>` track in the other.
