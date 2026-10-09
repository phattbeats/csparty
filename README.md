# CS Party

Mario Party rules, Counter-Strike 1.6 everything. A server-side mod: players join with a stock CS 1.6 client and nothing to install, or from a browser tab.

Status: v0.5, playable start to finish with bots and humans, from CS 1.6, a desktop browser, a phone, or a controller. Tested on a headless ReHLDS server with zBots, a native Xash3D FWGS + cs16-client client, and the same client compiled to WebAssembly in headless Chromium, all driven by simulated input. `tools/dev/web_e2e.py` (19 checks, optional simulated map-change stall) and `tools/dev/web_devices.py` (controller, touch phone) run the browser paths end to end, against a dev server or the Docker stack.

## How a match plays

- Up to 4 seats. Humans on T or CT get seats first, bots fill the rest. Spectators watch.
- **Your turn:** buy gear (the real 1.6 buy menu, real prices, board money), use board items, then **open a case** (a CS:GO-style reel of rarity cards; your character's top roll is the gold knife).
- Everyone watches one broadcast camera that follows whoever's turn it is: fade, intro shot, dice shot, follow shot, landing shot, hostage cutaway.
- **Board:** generated from the map's bot nav mesh. Blue +$, red -$, ? events, bombsites (plant a C4 trap down the road), Black Markets at T and CT spawn (board items), Camper, Armory, Duel, VIP Escort, Negotiator.
- **Stars:** reach the hostages, pay $5,000. They move after every rescue.
- **Minigames** after everyone moves: space colors decide CT vs T (4-0 FFA, 2-2, 3-1). Real CS rounds on the board map: Plant the Bomb, Pistol Round, Full Buy, Deagle Only, Knife Fight, Scoutzknivez, Nades Only, Hide and Seek. Survive a gear round and keep your gear. Die and lose it. Loot counts.
- **Characters:** eight, one per CS 1.6 model, each with its own die (Mario Party style). Browser players pick from a grid on the join screen (mouse, touch, arrows or a controller; the pick is remembered). The pick travels as `setinfo _csp_char 0-7`, so CS 1.6 players can set it in the console too. At match start picks are honoured first come, first served in seat order; bots and anyone whose pick was taken get a random one of the rest.
- **Boards:** de_dust2, de_inferno, de_aztec, de_cbble. The board is the map the server is on; between matches anyone can switch with `say /board`.
- **Map-change minigames:** Surf Race (`csp_surf`), Bhop Course (`csp_bhop`), Climb (`csp_climb`: step jumps, a ladder wall, narrow beams, checkpoints over a pit) and Maze Run (`csp_maze` plus seven generated variants from 8x8 to 16x16, brick/hedge/metal/rust and two dark ones; walls too tall to jump). Two Towers (`csp_towers`, Murray's community sniper map) is a deathmatch minigame. The server changes map, everyone races start to finish, and the match resumes on the board where it left off (state in `data/cs_party_state.json`). Human seats are held 60 s across the change.
- **Bonus stars** (`csp_awards 1`): two are drawn from six at match start and announced, with live leaders on the HUD: Top Fragger, Max Money, Eco Round, Big Spender, Rusher, Bomb Squad. Hidden end-of-game awards flipped about half of all winners in simulation; announcing two makes them goals to play for instead of a coin flip at the end.
- CS money HUD shows board money; TAB score shows stars.

## Controls

Every CS Party menu works with digits, or with a cursor: move up/down to highlight, **Jump** to pick, **Use** to go back. "Open a case" is always first, so a whole turn is Jump, Jump.

| | Menus | Turn | Minigames |
|---|---|---|---|
| Keyboard | digits, or W/S + Space, E back | Space, Space | as CS 1.6 |
| Controller (USB or Bluetooth, phones too) | D-pad or left stick, A pick, B back | A, A | sticks move/look, RT fire, LT alt-fire, A jump, LB duck, X reload, RB / D-pad left-right weapons, Y scores |
| Phone (touch) | left thumb up/down, Jump | Jump, Jump | left half moves, right half looks, Jump / Fire / Duck / Use / Reload buttons |

The cursor is read server-side from each player's movement (buttons and analog forward/back), so it needs nothing in the client.

## Server requirements

ReHLDS, ReGameDLL_CS (with `bot_enable 1` in `game_init.cfg` for zBots), Metamod-R, AMX Mod X 1.10, ReAPI. All built from source in testing:

| Project | Version tested |
|---|---|
| ReHLDS | 3.10.0.761 |
| ReGameDLL_CS | 5.30.0.814 |
| Metamod-R | 1.3.0.149 |
| ReAPI | 5.29.0.358 |
| AMX Mod X | 1.10.0.5486 |

## Install

```
cstrike/addons/amxmodx/plugins/cs_party.amxx          <- build/cs_party.amxx
cstrike/addons/amxmodx/configs/plugins.ini            <- add a line: cs_party.amxx
cstrike/addons/amxmodx/configs/cs_party/boards/       <- boards/*.ini
cstrike/maps/                                         <- boards/*.nav  (zBot nav for each board map)
cstrike/addons/amxmodx/configs/cs_party/minigames/    <- maps/csp_*.ini  (race zones)
cstrike/maps/                                         <- maps/csp_*.{bsp,nav}  (surf, bhop, climb, maze)
cstrike/models/csp_dice.mdl                           <- assets/csp_dice.mdl  (clients download it)
cstrike/motd.txt, cstrike/server.cfg                  <- server/
```

Or skip all of this and use the Docker image (see Deploy), or `tools/package_server.sh` for an overlay tarball.

Recommended in `amxx.cfg` (the plugin sets most of these itself at match start):

```
mp_autokick 0
mp_autoteambalance 0
mp_limitteams 0
bot_join_after_player 0
bot_quota 4
```

Optional: comment out `imessage.amxx`, `scrollmsg.amxx` and `multilingual.amxx` in `plugins.ini` to drop the AMXX chat ads.

## Commands

| Command | Who | What |
|---|---|---|
| `say /party` | players | start a match |
| `say /help` | players | show the how-to-play MOTD |
| `csp_start` / `csp_stop` | server | start / abort |
| `csp_state` | server | dump seats, money, stars |
| `csp_spec` | server | move every human to spectator |
| `say /menu` | players | reopen your turn menu |
| `say /board` / `csp_board <map>` | players / server | switch to another board between matches |
| `csp_probe`, `csp_nocam` | server | dev: movement state of the active player / drop the director camera |
| `csp_force_mg <i>` / `csp_test_remote <i>` | server | dev: force the next minigame / jump straight into a map-change minigame (8 surf, 9 bhop, 10 climb, 11 maze) |
| `csp_botname <name>`, `csp_stuff <player> <cmd>` | server | dev: rename a bot (name-collision tests) / run a command on a client |

Remote: `RCON_PASSWORD=... tools/rcon.py csp_start` (set `rcon_password` on the server; the Docker image takes `RCON_PASSWORD`).

## Cvars

| Cvar | Default | |
|---|---|---|
| `csp_turns` | 15 | |
| `csp_startmoney` | 800 | pistol-round money |
| `csp_hostage_cost` | 5000 | price of a star |
| `csp_blue` / `csp_red` | 500 / 750 | space payouts |
| `csp_mg_win` | 1500 | minigame win |
| `csp_loss_base` / `_step` / `_cap` | 200 / 200 / 800 | CS-style loss bonus |
| `csp_trap` | 1500 | C4 trap payout |
| `csp_overtime` | 3 | last N turns pay double |
| `csp_awards` | 1 | 0 off, 1 two announced bonus stars, 2 classic hidden three, 3 two announced cash prizes |
| `csp_autojoin` | 1 | put arriving humans on a team, no team/class panels |
| `csp_rings` | 1 | draw the board's space markers |
| `csp_turn_timeout` | 45 | seconds a human can sit on a board decision before the bot logic makes that one (8 s if they disconnected; 0 = wait forever) |
| `csp_buy_anywhere` | 0 | 1 = Black Market in the turn menu too |
| `csp_speed` | 1.0 | delay multiplier (0.25 for fast bot tests) |
| `csp_debug` | 1 | 2 = crate and jump tracing |

## Play in a browser

Friends open a link and join the real server from a browser tab: no CS install, no Steam. The client is Xash3D FWGS (the open-source GoldSrc engine) and cs16-client, compiled to WebAssembly, rendering with WebGL2. The browser can't send UDP, so a small Node relay turns each tab's WebSocket into its own UDP socket on the game server. To ReHLDS a browser player is just another LAN client.

```
browser tab ──https──> relay (static files + /relay WebSocket) ──udp 127.0.0.1──> ReHLDS + CS Party
```

1. **Build the client** (Emscripten 4.0.11, Xash3D FWGS and cs16-client at pinned commits, with the patches in `web/patches/`):
   `web/build_web.sh` → `web/public/` (engine 6.6 MB wasm, side modules, extras paks). About 5 minutes.
2. **Pack game data** from a CS 1.6 install you own: `python3 web/pack_gamedata.py <dir with valve/ and cstrike/> web/public/gamedata.zip`.
   44 MB zipped, 75 MB in memory. The file list (`web/gamedata.manifest`) was traced from a real client session across the board and both minigame maps, and WADs are sliced to the textures each map uses (dust2 needs 8 of the 3,116 textures in `halflife.wad`). Anything missing still arrives over the game channel. It just costs time at every join. After adding maps or models, re-trace with `tools/dev/trace_client.sh`.
3. **Run the relay**: `cd web && npm install && node relay.js --port 8080 --game 127.0.0.1:27015 --root public --key <party key>`
4. **Invite**: `https://your.host/?key=<party key>`. Name, Join, about 45 MB on the first visit, then it's cached.

**Party key.** `gamedata.zip` is Valve's content, packed from your install for your friends. With `--key` (or `PARTY_KEY`) the zip and the game socket answer only to the invite link. The page itself stays public. Use a key on anything internet-facing.

**Phones.** Same link. Touch devices get Xash3D's on-screen controls with a CS Party layout (shipped as `cstrike/touch.cfg` in the game data; replaces cs16-client's deathmatch preset), the CS Party HUD moved to the top-centre column, a low graphics profile (3D at 60 % resolution, softer textures, no detail textures or MSAA, 60 fps cap; `?gfx=high` to override, `?gfx=low` on a weak PC), and a "turn your phone" prompt in portrait. Android: the Fullscreen button locks landscape. iPhone Safari has no fullscreen API: add the page to the home screen (there's a web manifest and icon).

**Controllers.** The browser's Gamepad API, so USB and Bluetooth pads both work, phones included. The layout lives in `cstrike/userconfig.cfg` in the game data (see Controls).

**The page looks after the connection.** It shows a joining overlay with stages, reasons when you get disconnected or kicked (with a Rejoin button), and keeps the game data in the browser's Cache Storage, checked by ETag, so a second visit skips the 44 MB download. A watchdog notices when server traffic stops in the middle of a map change (a client that missed the change) and sends `retry`; the server holds the seat 60 s and gives it back by name.

## Deploy (Docker, e.g. Unraid)

```
tools/package_server.sh <your working server dir>     # -> deploy/cs-party-server-overlay.tar.gz
web/build_web.sh                                      # -> web/public
python3 web/pack_gamedata.py <CS 1.6 dir> deploy/gamedata.zip
cp .env.example deploy/.env  # then edit the values
cd deploy && docker compose up -d --build
```

- `deploy/Dockerfile.server`: Ubuntu 24.04 (the overlay binaries need glibc 2.38+), stock HLDS from SteamCMD, then the overlay: ReHLDS, ReGameDLL_CS, Metamod-R, AMX Mod X + ReAPI, the plugin, boards, minigame maps. No Valve files in the overlay.
- `web/Dockerfile`: the relay and the built client. Mount `gamedata.zip`, which the compose file does.
- Both services use host networking. The relay reaches the server on `127.0.0.1:27015`, so the only port to expose is the relay's 8080, behind your reverse proxy with WebSocket upgrade allowed on `/relay`. No UDP forwarding is needed unless native CS clients join from outside (then `SV_LAN=0` and forward UDP 27015).
- Both base images take `--build-arg BASE=...` if you need a mirror.
- Healthchecks: the relay's `/healthz` (peers, packets, drops as JSON) and an A2S query against the game server. `TRUST_PROXY=1` (set in the compose file) makes the relay's per-IP limit use `X-Forwarded-For` from SWAG; leave it off if the relay is exposed directly.
- **SWAG:** `deploy/swag/csparty.subdomain.conf.sample`. Use a subdomain, not a path, because the page opens its socket at `/relay`. Point it at the host IP, since the relay uses host networking.

**Known limits.**
- A client that misses a map change used to sit for a minute. The page's watchdog now reconnects it after 15 s of silence, and the seat comes back. Verified with a simulated stall (`web_e2e.py --stall`); never reproduced on the native client.
- Slow clients (software GL, ~5 fps) get few server packets, so bursts of unreliable messages can overflow their datagram and drop an effect.
- Test harness only: calling into a headless-Chromium page over DevTools while the engine loads (join, map change, turn start) sends the renderer's memory up by GBs. Players have no DevTools attached. The tests wait 15 s after every join and keep page calls light.
- A native CS client that joins in the same seconds a match starts can be left with the team panel open. Close it with Escape; you're seated.

## New boards

```
python3 tools/board_compiler.py <cstrike_dir> <map> --out boards/<map>.ini --png preview.png
```

Needs the map's `.nav` (zBots generate it on first load: start the server on the map with bots and wait for `Navigation file ... saved`, 4-8 minutes). Routes T spawn → B → CT spawn → A → T spawn through different corridors, adds one shortcut, places special spaces. Commit the `.nav` next to the board as `boards/<map>.nav`: without it the server stalls for minutes on the first load.

Check the PNG before shipping a board. Maps where the bombsites stack vertically (de_nuke) or the shortcut has to double back over the loop (de_dust) give overlapping spaces; de_train has no route the compiler accepts. de_inferno, de_aztec and de_cbble come out clean.

## Dice crate model

```
python3 tools/build_dice.py <studiomdl> assets
```

Builds `csp_dice.mdl` (11 skins: "?" and 0-9) with Valve's HL SDK studiomdl. Compiling studiomdl on Linux: see `tools/dev/README-studiomdl.md`.

## Things learned the hard way

- Pawns stand 28 units apart but player hulls are 32 wide. Overlapping players are "stuck" and the movement code refuses to run, so nobody can jump. Pawns are non-solid on the board.
- zBots under `bot_stop` don't run player physics; their crate jumps are animated by the plugin.
- Spectators' clients render their own chase cam, so they can't see the director camera. Their observer target is pointed at the active player instead.
- Watching the board looks "idle" to CS. `mp_autokick` would kick players waiting for their turn.
- zBot's team balancing kicks seated bots unless `mp_autoteambalance 0`. Empty seats refill from unseated players anyway.
- Non-objective team rounds need arena spawns and survivor-based timeouts, or bots camp until "Target Saved".
- The open-source cs16-client prints HTML MOTDs as raw text; Steam 1.6 renders them. The MOTD is plain text so both work. Connect MOTD limit is 1,536 bytes.
- A "?" block with corner rivets reads as Nintendo's. The crate is an original olive supply crate with hazard bands and stenciled numbers.
- AMXX timers can't fire faster than about 0.1 s. Ring redraws scheduled "0.03 s apart" landed about 45 beams in one frame, which overflowed slow clients' 4 KB datagram. Now one space per 0.1 s.
- ReGameDLL's `game.cfg` runs after `server.cfg` and sets `mp_timelimit 20`: mid-party, the server rotated to cs_siege. The plugin now owns `mp_timelimit`/`mp_maxrounds`/`mp_winlimit`.

- ReHLDS zeroes every button from an `FL_FROZEN` player, and board pawns are frozen. Cursor menus "thaw" the pawn (maxspeed 1: no walking, no jumping) while a menu is open.
- Nothing server-side can press an AMXX newmenu key: `amxclient_cmd` and `engclient_cmd` run plugin hooks and the game DLL, not AMXX's own menu handling, and a stuffed `menuselect` round trip proved flaky on slow clients. The cursor cancels the menu and calls its handler directly.
- AMXX menu handles start at 0. Re-showing a menu cancels the open one (its handler gets an exit). Pawn's `?:` between arrays of different sizes is unsafe.
- zBot's name list has real names in it. A bot already named Alex made the human "(1)Alex", who then never got his seat back by name. Humans win name collisions now, and stand-in bots are "Name (bot)".
- A player who walked away mid-decision stalled the whole party. The turn timer hands that one decision to the bot logic.

Browser client:
- Emscripten forces legacy `dynCall_*` exports on with `ASYNCIFY=1`, but a `MAIN_MODULE` build never generates them. Every JS→wasm callback (keyboard, mouse, focus, audio) compiled to a stub that throws, so the first keypress killed the tab. `web/patches/emscripten-4.0.11.patch` falls back to the function table.
- cs16-client draws the CS team and class panels as menu-DLL dialogs. They take the keyboard (`key_menu`) even after the server has placed the player, so turn-menu digits went nowhere. With auto-join on, the plugin now supersedes those panels.
- Unzipping into Emscripten's MEMFS copies by default: two copies of the game data. `FS.writeFile(..., {canOwn: true})`. With 354 MB of untraced data the tab crossed 3 GB. The traced pack is 75 MB.
- Xash's console font and the menu's TrueType font live in its own `extras.pk3`. Without it, text renders as shards of the font atlas.
- `127.0.0.1` makes Xash treat the game as local and skip the network. The page connects to a dummy LAN address, and the relay decides where packets really go.
- The engine runs `autoexec.cfg`, then Valve's `config.cfg` (which starts with `unbindall`), then `userconfig.cfg`. Controller binds only survive in the last.
- SDL drops pad input while no window has keyboard focus. The browser build sets `SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS`.
- Sticks and touch sticks set an analog forward value, not `IN_FORWARD`. The server reads both.

Map tools:
- SDHLT's sdHLRAD self-test (`compress_compatability_test`) type-puns floats through misaligned pointers. Built with clang at -O2 it fails; compiling `compress.cpp` without optimization fixes it.
- Race maps are new geometry, so check them before compiling: every gap on csp_climb clears with at least 1.5x margin on a plain jump (no crouch, no strafe), and a BFS over the maze with a 32-unit hull reaches the finish.

## Repo layout

```
plugin/cs_party.sma       AMXX plugin (Pawn)
build/cs_party.amxx       compiled plugin
boards/                   generated boards (.ini) and their zBot nav meshes (.nav)
assets/csp_dice.mdl       dice crate model (+ dice_skins.png, src/)
server/motd.txt           connect MOTD
tools/board_compiler.py   nav mesh -> board
tools/build_dice.py       crate textures + model
tools/gen_minigame_maps.py  generates + compiles csp_surf / csp_bhop / csp_climb / csp_maze (+ variants, tools/build_maze_pack.py) (Valve 220 .map, SDHLT)
tools/package_server.sh   server overlay for deploy/Dockerfile.server
tools/rcon.py             GoldSrc RCON client
tools/dev/                headless test harness: srv.sh, cam.sh, trace_client.sh, web_e2e.py
maps/                     csp_surf / csp_bhop / csp_climb / csp_maze: .map source, .bsp, .nav, race zones (.ini)
server/                   motd.txt, server.cfg
web/                      browser client: relay.js, public/ (page + built engine), build_web.sh,
                          pack_gamedata.py + gamedata.manifest, patches/ (Emscripten, Xash3D, cs16-client)
deploy/                   Dockerfile.server, docker-compose.yml
index.html                browser prototype + economy simulator (pre-gear item model)
```
