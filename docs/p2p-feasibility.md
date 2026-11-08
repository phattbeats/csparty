# CS Party P5: true P2P feasibility (PHA-4004)

Status: research spike, done 2026-11-07. Nothing here is deployed and nothing live was changed. The proof of concept
is in `spike/p2p/` on branch `pha-4004-p2p-spike`. Design context: `docs/lobby-design.md` section 4A and decision 3.

## 1. Answer

**It's feasible, and less risky than section 4A of the lobby design assumed.** The engine, the game DLL and the
transport all work. The one large job left is the party logic: about 6,000 lines of Pawn that have to become C++.

| Question | Answer |
|---|---|
| Can the Xash3D server build to wasm and run in a tab? | **Yes, built and run.** The dedicated server (3 MB wasm) runs in a Web Worker and under node. The engine needed about 150 lines of patches. |
| Can the existing browser client join it? | **Yes, proven.** The shipped client (the live build, unchanged) joined the wasm server and entered the game on de_dust2. It needs one change: connect with Xash protocol 49 instead of forcing GoldSrc (`gs`). |
| Over WebRTC with lobby signaling? | **Yes, proven browser to browser.** A host tab ran the server in a Worker; a player in a separate browser joined over a DataChannel and entered the game with 3 zBots. The client's game socket is swapped for a DataChannel by a shim that runs before `boot.js`; the engine itself is untouched. Signaling is 3 message types, run here by a local stand-in for the lobby DO. |
| ReGameDLL_CS to wasm | **Yes, 3 one-line changes.** cs16-client already vendors a Xash-ready ReGameDLL 5.30 fork (same version as live). 2.4 MB side module. zBots join and play. |
| Party logic | **Port it to C++ in the game DLL.** AMXX in wasm has no prior art and four x86-only pieces. Port estimate: 5 to 8 weeks. |
| TURN | About **$0** at our scale. Cloudflare gives 1,000 GB/month free, which covers about 67,000 relayed player-hours. |
| Host closes the tab | The match ends, as in the Halo reference. Checkpoint-and-resume onto a new host is possible later using the state file we already write. |
| Effort | **About 9 to 14 weeks** in total. |
| Recommendation | **Technically go, but don't start the build yet**, because the trigger hasn't fired (section 9). |

## 2. What the spike built

```
host tab                                                   player tab (shipped CS Party client, unchanged engine)
  host.js ── RTCPeerConnection per player ── DataChannel "game" {ordered:false, maxRetransmits:0} ── p2p_client.js
     │  postMessage(datagram)                                                                       (window.WebSocket
  server_worker.js: xash_server.js + xash.wasm (dedicated) + cs_emscripten_wasm32.so (ReGameDLL)        shim for /relay)
     Module.cspNet  ⇄  net_ws.c hook (server socket only)
signaling: signal.mjs (stand-in for the lobby DO): host / join / signal / peer_left / host_left
```

| File | What it does |
|---|---|
| `spike/p2p/build.sh` | Reproducible build. Uses the same emsdk 4.0.11 and Xash revision as `web/build_web.sh`, plus `patches/`. |
| `patches/xash3d-fwgs-server.patch` | Applies on top of `web/patches/xash3d-fwgs.patch`. Adds the datagram hook, JS-driven frames, the posix timer for the wasm dedicated server, and link flags. |
| `patches/cs16-client-server.patch` | ReGameDLL platform guards (2 lines); `--no-undefined` is skipped for Emscripten. |
| `node_host.mjs` | The wasm server under node, bridged to a real UDP port. Used to measure the server and to point the existing relay at it. |
| `web/server_worker.js`, `web/host.js`, `web/host.html` | The host tab: the server in a Worker, plus one WebRTC peer per player. |
| `web/p2p_client.js` | `?p2p=<code>`: turns the client's relay WebSocket into a DataChannel to the host. |
| `web/signal.mjs` | Local signaling server shaped like the lobby DO messages. |
| `join_probe.mjs`, `p2p_probe.mjs` | Headless test drivers. |

### Engine changes (Xash3D FWGS)

1. **Datagram hook** (`net_ws.c`). Emscripten sockets can only dial out over a WebSocket; they can't accept peers.
   When the page sets `Module.cspNet`, the server socket's `sendto`/`recvfrom` go to JS instead. Each peer gets a
   fake address (10.99.x.y), so the engine is unchanged above the socket. Only the server socket is hooked.
2. **No ASYNCIFY; JS drives frames** (`host.c`). The client's `emscripten_sleep` main loop crashed the server.
   ASYNCIFY can't unwind through the JS `invoke_*` frames that Emscripten's setjmp emulation puts around
   `Host_Main`. `Host_Main` now returns after init, and the page calls `CSP_HostFrame()` on its own timer. That
   also drops ASYNCIFY's size and speed cost.
3. **Timer** (`defaults.h`). The dedicated build has no SDL, so it uses the posix timer.

### ReGameDLL changes

cs16-client's `BUILD_SERVER` builds Velaron's `ReGameDLL_CS` fork, which already has the 64-bit, ARM and Xash fixes
(`pfnNameForFunction` pointers, `force_align_arg_pointer` only on i386, and others). For Emscripten it only needed:
`platform.h` (accept `__EMSCRIPTEN__`), `counter.h` (`<limits.h>` instead of `<linux/limits.h>`), and dropping
`-Wl,--no-undefined`. SSE intrinsics stay behind `HAVE_SSE`. It reports `ReGameDLL version: 5.30.0.859-dev+m`.

## 3. Evidence

### 3.1 Server under node (same wasm build a tab runs)

- Boot to map: `Dll loaded for game "Counter-Strike"`, `8 player server started`, `level loaded at 1.43 sec`, de_dust2.
- zBots: `bot_add_t/ct` produced bots that `joined team`, `entered the game` and played rounds. Our `server.cfg`
  quota settings kicked them right away ("kicked to maintain quota"); that's config, not wasm.
- Cost, measured with the frame loop paced like a browser timer (`setTimeout(1)`):

| Load | CPU (one core) | Memory |
|---|---|---|
| Map loaded, no players | 7 to 9 % | 128 MB wasm heap, 220-240 MB process RSS |
| 1 browser player in game + round play | 4 to 5 % | same |
| Map load | spikes of 1.4 to 2.4 s on one frame | |

The node numbers include V8 and the bridge. The board loop with 4 players and bots will cost more, but the live
ReHLDS measures 7.5 % for a full lobby (lobby-design §13). Expect roughly 10 to 20 % of one desktop core.

### 3.2 Shipped browser client → wasm server

The live client was served by the existing `relay.js` and pointed at the wasm server under node. Packet trace:

```
rx "getchallenge steam"        tx "challenge -1090964779 1"
rx "connect 49 ... \o\emscripten\a\wasm32 ..."     tx "client_connect \ext\3\cheats\1 ..."
server: "Probe<1><0><>" connected, address "10.99.0.1:57723"
server: "Probe<1><ID_LAN><>" entered the game          client: state 3 -> 4 (active)
```

Screenshot: the client on de_dust2 at the team panel, build string `v49/0.21 (emscripten-wasm32)`.

What it took:
1. **Protocol.** `boot.js` always connects with `gs` (GoldSrc protocol 48) because the live server is ReHLDS.
   Xash3D's server only speaks protocol 49 and rejected it (`unsupported protocol`). The fix is to drop `gs` for P2P
   lobbies, one argument in the page.
2. **Same game data on both ends.** With a server data set that lacked sprites, the client hit `Server is enforcing
   file consistency for sprites/fast_wallpuff1.spr` and dropped. A browser host would load the same `gamedata.zip`
   its players use (plus a 0.9 MB server overlay: navs, `liblist.gam`, `server.cfg`), so this solves itself.
3. **Test-only.** Software GL on a host at load 60-90 took about 2 minutes in "Setting up renderer", past Xash's
   60 s `sv_connect_timeout`. Real players with a GPU don't hit this.

### 3.3 Browser host → browser player over WebRTC

**Works.** Two separate headless Chromium processes, so WebRTC was the only path between them (`p2p_probe.mjs`,
log `spike/p2p/evidence/p2p-run.log`, screenshot `evidence/p2p-browser-host-join.png`):

```
  5.5 host   [worker] 103 MB of files in 4676 ms          (gamedata.zip + 1 MB server overlay, unzipped in the Worker)
  5.8 host   Dll loaded for game "Counter-Strike" ... server ready
 76.9 player [p2p] channel open to host (succeeded)       (ICE: direct host candidates)
 78.4 host   "Peer<2><1><>" connected, address "10.99.0.1:27005"
183.2 host   "Peer<2><ID_LAN><>" entered the game          player: state 3 -> 4 (active)
372.1 host   status:  Josh (bot)  Peer 10.99.0.1 (emscripten-wasm32)  Will (bot)  Nick (bot)
382.6 host   "Will<3><ID_BOT><CT>" killed "Josh<1><ID_BOT><TERRORIST>" with "mp5navy"
```

- **Host boot:** 5.8 s from opening the page to a running server, including fetching and unpacking 103 MB.
- **Server cost in the tab:** about 1,800 frames per 10 s, averaging 0.2 to 0.4 ms each (worst 15 to 70 ms),
  with 1 player and 3 bots. That's about 5 to 7 % of one core in the Worker.
- **zBot navs:** the test overlay had no `de_dust2.nav`, so the wasm server generated one in the tab (95 s, frames
  around 560 ms during it), then played normally. Production ships every board's `.nav` in the overlay.
- The player's 76 s and 183 s timings are software GL loading the engine and map on a heavily loaded test host.

## 4. Things that are different from the RAID pool

- **Native Steam CS 1.6 players can't join a P2P lobby.** A browser tab can't take UDP from the internet, and
  GoldSrc clients only speak protocol 48. P2P lobbies are browser-only (desktop, phone, controller). Keep the RAID
  pool for mixed lobbies and for anyone who wants to join from Steam.
- **The engine is Xash3D, not ReHLDS.** The plugin relies on some ReHLDS behaviour (frozen pawns lose buttons, the
  team/class panels, map-change seat holds). Each of those has to be re-checked on Xash. Budgeted in section 8.
- **The host is a player.** Their tab runs the server Worker and their own client. That's fine on a desktop
  (about 10-20 % of a core for the server). Phones should join, not host.
- **Background tab.** The server ticks in a Worker, and packets move by events, not main-thread timers, so Chrome's
  hidden-tab timer clamping doesn't touch the critical path. Chromium has discussed throttling background workers.
  Not tested in this spike (headless pages are always "visible"); it's a day-one check in the build, and a silent
  AudioContext is the known fallback. Usually the host is playing, so the tab is visible.

## 5. ReGameDLL_CS in wasm: blockers, size, performance

- **Blockers:** none left. The 3 changes in section 2. webxash3d (yohimik, MIT, repo since removed, mirrors exist)
  had independently built the same cs16-client server DLL to wasm for a listen server, so this isn't a one-off.
- **Size:** `cs_emscripten_wasm32.so` 2.4 MB (2.9 MB with function names). Engine `xash.wasm` 3.0-3.5 MB plus
  0.55 MB JS. About 2 MB more for a host to download, compressed. Players download nothing new.
- **Performance:** see section 3.1. wasm runs at roughly 1.5 to 2x native, and the server is light (the live one
  uses 7.5 % of a core per full lobby).

## 6. Party logic: AMXX in wasm vs C++ in the game DLL

`plugin/cs_party.sma` is 6,154 lines and about 590 functions. It uses about 550 distinct natives/functions,
including 84 `set_task` calls, 17 menus, 14 `message_begin` calls, JSON state, `fakemeta` forwards (`StartFrame`,
`CmdStart`, `CheckVisibility`), one `Ham_Use`, and 9 ReAPI hook chains. **All of the ReAPI hooks are ReGameDLL
(`RG_*`); none are ReHLDS.** The members it reads and writes (`m_iTeam`, `m_iJoiningState`, `m_iMenu`,
`m_iHideHUD`, `var_*`) are plain `CBasePlayer`/`entvars` fields.

| | AMXX (+ Metamod + ReAPI) in wasm | C++ inside the game DLL |
|---|---|---|
| Prior art | None found (no Pawn VM in wasm anywhere). AMXX on ARM Android exists but is weeks old. | ReGameDLL already builds to wasm. |
| Work | metamod-fwgs through Emscripten `dlopen` chains (unverified); AMXX with the C interpreter (the build hard-defines JIT/ASM32); replace `natives-x86.asm` and CDetour; Hamsandwich vtable patching on wasm vtables; ReAPI ported to Xash (it assumes ReHLDS). | Rewrite 6k lines: hooks become direct calls or ReGameDLL hook chains, `set_task` becomes a small scheduler, AMXX menus become `ShowMenu`, JSON stays (a small library). |
| Risk | High. Four x86-specific subsystems, each unknown in wasm. | Medium. Big but mechanical, with the Pawn as the spec. |
| Speed | Pawn interpreted inside wasm: about 10x slower than JIT. Fine for menus, worrying for the per-frame camera. | Native wasm speed. |
| One codebase | Same `.sma` on RAID and P2P. | Two implementations, **unless RAID moves to the C++ build too**: the same code built natively as a ReGameDLL-API module on ReHLDS. Recommended. |

**Recommendation: C++.** Write it against ReGameDLL's hook-chain API and engine functions, linked into the wasm game
DLL and built natively for the RAID servers. Then retire the `.sma` so there is one implementation.

## 7. TURN fallback cost

Cloudflare Realtime TURN (pricing page dated 2026-09-22): **$0.05/GB egress after 1,000 GB/month free** (shared
with SFU). Ingress and STUN are free. A Worker or DO can mint short-lived credentials with
`POST rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers`; that's how the Halo reference does it.

- A relayed player costs about 15 MB/hour. That uses the 25 kbps per player measured on the live server
  (lobby-design §13), plus about 8 kbps up.
- 1,000 GB covers **about 67,000 relayed player-hours a month**. Past that, 1,000 relayed player-hours cost about $0.75.
- Commonly cited TURN need is 15-22 % of peers (higher on mobile and corporate networks). If the host itself is behind
  symmetric NAT, the whole lobby relays: 4 players is about 60 MB/hour, still inside the free tier.
- Host uplink: one lobby is 93-185 kbps total (§13 measurement). That's fine for home connections.
- The real bandwidth cost is the **55 MB game-data download** per new player. It should come from Cloudflare
  (decision 4 allows it), not TURN and not RAID.

## 8. Host migration and host tab closing

The server's state lives in the host tab's memory, so there's no live migration in GoldSrc.

- **v1 (ship this):** the host leaving ends the match. The lobby DO sees the host socket drop
  (`host_left` in the spike) and puts everyone back in the lobby with "the host left", as the Halo reference does.
  It costs nothing extra.
- **v2 (optional, about 1 week):** checkpoint-resume. The party state is already serialised to JSON for map-change
  minigames (`cs_party_state.json`). The host Worker sends it to the lobby DO every turn (a few KB). When the host
  drops, the DO picks a new host, that tab boots the server with the saved state (about 6 s here), and everyone
  rejoins. Seats are already kept by `_csp_pid` with a 90 s grace. A minigame in progress restarts at the turn
  boundary. Expect a 20 to 40 s interruption.

## 9. Effort and recommendation

| Work | Estimate |
|---|---|
| Productionise the wasm server build and patches; server overlay pack | 3 to 5 days |
| Host page (Worker, WebRTC, reconnect), lobby DO signaling (3 message types), TURN minting, host/join UX, `?p2p` in `boot.js`, data from Cloudflare | 1.5 to 2 weeks |
| Port the party logic to C++ (scheduler, menus, HUD, JSON state, camera, 20+ minigames, map-change minigames) | 5 to 8 weeks |
| Xash-vs-ReHLDS parity fixes, found by running the bot and browser e2e suites against the wasm host | 1 to 2 weeks |
| Optional: checkpoint-resume host migration | about 1 week |
| **Total** | **about 9 to 14 weeks** |

**Go/no-go: technically go; start the build only when the trigger fires.** The spike retires most of section 4A's
"months, high risk": the engine, the game DLL, bots, the client protocol and the transport all work. What's left is
mostly the party-logic port, which is big but mechanical. Today RAID carries 12 lobbies and real use is 0, so the
PHA-3986 trigger ("lobbies regularly exceed what RAID carries") hasn't fired. Lobby-design §13 also lists cheaper
steps that come first and roughly triple capacity: serve `gamedata.zip` from Cloudflare, and run the relay as
several processes (about 40 lobbies).

Options for Brandon:
1. **Park (recommended).** Keep this spike on its branch. When lobbies approach about 10 concurrent, do the two
   cheap RAID steps; start the P2P build only if demand still grows past about 40.
2. **Start only the C++ port now.** It's the long pole, and it also helps RAID (no AMXX, one codebase). Then P2P is
   about 4 weeks of work whenever it's needed.
3. **Full build now** (9 to 14 weeks).
