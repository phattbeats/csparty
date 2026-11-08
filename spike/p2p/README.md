# P2P spike (PHA-4004)

The CS Party game server (Xash3D FWGS dedicated + ReGameDLL_CS) built to WebAssembly, running in a host's browser
tab, with the shipped browser client joining over WebRTC. Research only: nothing here is deployed or wired into the
lobby. Findings, numbers and the go/no-go are in `docs/p2p-feasibility.md`.

1. `build.sh [workdir]` builds `xash_server.js`, `xash.wasm`, `filesystem_stdio.so`, `cs_emscripten_wasm32.so`.
2. Server under node, bridged to UDP (the existing relay can point at it):
   `node node_host.mjs --out <workdir>/out --game <dir with valve/ cstrike/> --port 27400 -- +bot_enable 1 +map de_dust2`
   (stdin lines are server commands). The game dir needs the same files as the players' `gamedata.zip`, or clients
   fail file consistency.
3. Browser host: serve `web/` next to the client build, plus `fflate.js`, the build outputs (`cs_emscripten_wasm32.so`
   as `cs_server.so`), `gamedata.zip` and `srv_overlay.zip` (liblist.gam with `gamedll_linux "dlls/cs.so"`,
   server.cfg, every board's `.nav`). Run `WS=<ws package> node web/signal.mjs 8098`, open `host.html?code=X`,
   then players open `/?p2p=X&proto=xash` with `web/p2p_client.js` loaded before `boot.js`.
4. `p2p_probe.mjs` drives 3 end to end in two headless browsers; `join_probe.mjs` drives 2.

Evidence from the runs on 2026-11-07 is in `evidence/`.
