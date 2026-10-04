# CS Party deploy runbook (game-host, SWAG, Cloudflare)

Live at **https://csparty.example.com/?key=<PARTY_KEY>**. The key is in `/srv/cs-party/.env` on game-host (mode 600).

## Layout
- Source and builds (v0.4, commit f462f09): `/srv/cs-party/src/cs-party`, from the tarballs in Nextcloud `cloud/csparty/`.
- Secrets: `appdata/cs-party/.env` holds `PARTY_KEY` and `RCON_PASSWORD`.
- Build logs: `appdata/cs-party/logs/`.
- Game data: `appdata/cs-party/gamedata.zip`, packed from Nextcloud `cloud/csparty/Half-Life`.

## Ports
| Service | Port | Note |
|---|---|---|
| cs-party-server (HLDS, ReHLDS + AMXX + CS Party) | UDP 27016, host network | 27015 is taken by nvmp-coop |
| cs-party-relay (page, game data, /relay WebSocket) | TCP 8095, host network | 8080 is taken by sabnzbd and others |

## Steps taken
1. Extracted `cs-party-v0.4.tar.gz` and `cs-party-v0.4-builds.tar.gz` into `appdata/cs-party/src`.
2. Built the images. Unraid has no `docker compose`, so these are plain builds:
   - `docker build -t cs-party-server:0.4 -f deploy/Dockerfile.server deploy`
   - `docker build -t cs-party-relay:0.4 web`
3. Generated `.env` with random `PARTY_KEY` and `RCON_PASSWORD`.
4. Started the game server. Both containers are now (re)created by `appdata/cs-party/csparty-up.sh [all|server|relay]`, the compose replacement with our ports and healthchecks:
   `docker run -d --name cs-party-server --network host --restart unless-stopped -e MAP=de_dust2 -e PORT=27016 -e SV_LAN=1 -e RCON_PASSWORD=... cs-party-server:0.4`
   The healthcheck is the A2S_INFO probe from compose, on 27016.
5. Started the relay:
   `docker run -d --name cs-party-relay --network host --restart unless-stopped -e PORT=8095 -e GAME=127.0.0.1:27016 -e TRUST_PROXY=1 -e PARTY_KEY=... -v appdata/cs-party/gamedata.zip:/app/public/gamedata.zip:ro cs-party-relay:0.4`
6. Cloudflare: created a proxied CNAME `csparty` -> `example.com` in zone example.com (record id RECORD_ID), using the token in `swag/dns-conf/cloudflare.ini`.
7. SWAG proxy conf: added `swag/nginx/proxy-confs/csparty.subdomain.conf`, which proxies to `HOST_IP:8095` (host IP, because the relay is on host networking).
   - There is no `proxy_read_timeout`: proxy.conf already sets 240 s, and a duplicate stops SWAG from starting.
   - The relay heartbeats its sockets, which keeps them under Cloudflare's 100 s idle limit.
8. SWAG template:
   - Backed up `/boot/config/plugins/dockerMan/templates-user/my-swag.xml` to `my-swag.xml.pre-csparty-20261002`.
   - Appended `csparty` to SUBDOMAINS.
   - Ran `nginx -t` (ok), then `/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container swag`.
   - The cert was re-issued with `csparty.example.com` in its SAN; it expires 2026-12-31.
9. Game data:
   - Alex copied his Half-Life install to Nextcloud `cloud/csparty/Half-Life`.
   - The packer needs the CS Party maps under `cstrike/`, so I staged the Half-Life files plus the server overlay's `cstrike` files (no `addons`/`dlls`).
   - Ran `web/pack_gamedata.py` in a `python:3.12-slim` container (Unraid has no python3). Result: 3,070 files, 44 MB zipped.
   - Moved the zip to `appdata/cs-party/gamedata.zip` and deleted the staging copy.
   - Mounted the zip into the relay.
10. Verified:
   - `/healthz` returns 200 through Cloudflare.
   - The page loads (200).
   - `gamedata.zip` without the key returns 403.
   - Nextcloud and Zelda were still 200 after the SWAG restart.
   - `gamedata.zip` with the key: 200, 46.6 MB, through Cloudflare.
   - `wss://csparty.example.com/relay?key=...` carried an A2S query to HLDS, which answered "CS Party / de_dust2". A wrong key gets 401.
   - Both containers report healthy.
   - Not tested by me: a full WASM client join in a real browser. That's the game-night check (ISSUE).
11. Invite link and RCON password: Nextcloud `cloud/csparty/INVITE-LINK.txt` (`.env` remains the source of truth).

## Operating it
- Start a match:
  - In game, `say /party`.
  - Or remotely: `RCON_PASSWORD=... python3 tools/rcon.py csp_start`, aimed at port 27016.
- Logs: `docker logs cs-party-server` and `docker logs cs-party-relay`.
- Update to a new build:
  1. Extract the new tarballs into `src`.
  2. Rebuild both images.
  3. Run `appdata/cs-party/csparty-up.sh`.
- New maps or models: re-pack `gamedata.zip` as in step 9, then run `csparty-up.sh relay`.
- Gotcha: inline `docker run --health-cmd` quoting broke the relay healthcheck (literal `\x27` reached node). The script quotes it correctly.
- Roll back SWAG: copy `my-swag.xml.pre-csparty-20261002` over `my-swag.xml`, delete `csparty.subdomain.conf`, and run `rebuild_container swag`. Then delete the Cloudflare record.

## Native CS 1.6 clients
`SV_LAN=1`, so only browser players (through the relay) and LAN clients can join. For internet native clients:
1. Set `SV_LAN=0`.
2. Forward UDP 27016 on the router.
3. Connect to `example.com:27016`. This has to be a DNS-only record, because Cloudflare's proxy doesn't carry UDP.


## v0.4.1 patch (2026-10-02): auto-start lobby and bigger spaces
Problem: the server booted into plain de_dust2 with bots. The party only began on `say /party`, which nobody was told about, so joiners landed in normal CS.
1. Fetched AMX Mod X 1.10 base (`amxxpc`) and the ReAPI includes into `appdata/cs-party/build-tools/`. Compile inside the server image because amxxpc is 32-bit: `docker run --rm -v $PWD:/s -w /s cs-party-server:0.4 ./amxxpc cs_party.sma -ocs_party.amxx`. The unmodified v0.4 source compiled first as a baseline.
2. Plugin changes in `plugin/cs_party.sma`; originals kept as `*.v0.4`:
   - New cvar `csp_autostart` (default 20). The first human to join opens a lobby: everyone is frozen, `bot_stop 1`, damage is off, and a "The board starts in N" countdown runs. After the countdown the match starts. `/party` and `csp_start` skip the countdown. Set it to 0 for the old behavior.
   - Space markers: ring radius 22/30 -> 46/60, beam width 6 -> 18, brightness 200 -> 255, a 96-unit light pillar on every space, and thicker path dots.
3. Image: `appdata/cs-party/patch/Dockerfile` (FROM cs-party-server:0.4, copies the new amxx) -> `cs-party-server:0.4.1`. `csparty-up.sh` now uses 0.4.1. Recreated with `csparty-up.sh server`.
4. Verified over RCON: `csp_start` ran the board (bots rolling, hitting crates), and `csp_stop` returned to idle. Not yet tested: the lobby countdown, which needs a human join.
5. Rollback: change `csparty-up.sh` back to `cs-party-server:0.4`, then run `csparty-up.sh server`.
6. RCON tool: `docker run --rm --network host -e RCON_PASSWORD -v <src>/tools:/t python:3.12-slim python3 /t/rcon.py --port 27016 <cmd>`. Replies show up in `docker logs cs-party-server`.


## Relay v0.4.1 (2026-10-02): CS Party Esc menu replaces the engine's
Problem: Esc opened Half-Life's own menu (Resume / Training / Save Load / HL Readme...). In the browser build the mouse can't use it: hover and clicks do nothing, and only real arrow keys move the highlight. Reproduced headlessly with Playwright (`mcr.microsoft.com/playwright:v1.55.0-noble`, already on the RAID) against the live server.
1. Fix, page only, with no engine rebuild (`web/public/boot.js` and `index.html`; originals kept as `*.v0.4`):
   - A capture-phase `keydown` listener on window takes Esc before the engine sees it and toggles a CS Party menu. The menu has: Back to the party, mouse sensitivity, volume, fullscreen, controls, and Leave.
   - Losing the mouse capture without the engine asking (Esc while captured, alt-tab) also opens the menu. Releases the engine makes itself (map changes, its console) go through a wrapped `Document.prototype.exitPointerLock` and are ignored.
   - While the menu is open, `mousedown`/`mouseup` are stopped at window capture. Reason: SDL queues a "capture the mouse" request on map changes and fires it on the next mouseup anywhere, which grabbed the mouse mid-menu during testing. Re-capture is also refused while the menu is open.
   - Keyboard: Up/Down, Tab, Enter. Controller: D-pad/stick, left/right on sliders, A to pick, B/Start to go back.
   - Settings are saved in localStorage (`csp_settings`) and applied as console cvars on join, but only the ones the player changed.
   - The help window that opens on join closes on click (attack), not Esc, so taking Esc away loses nothing.
2. Image: `appdata/cs-party/patch-relay/` (FROM cs-party-relay:0.4, copies the two files) -> `cs-party-relay:0.4.1`. `csparty-up.sh` now uses relay 0.4.1. Recreated with `csparty-up.sh relay`.
3. Verified headlessly on a test relay (port 8096, removed afterwards):
   - Esc opens the menu with focus on Back to the party, and the arrows move focus.
   - The sliders work and are saved (the engine gets `sensitivity 4` and `volume 0.25`).
   - Clicking Back to the party returns to the game, and the engine menu never appears.
   - Esc toggles the menu open and closed.
4. Also confirmed in the same test run: the auto-start lobby. The test player joined at 16:24:35, and the match started by itself at 16:24:55.
5. Rollback: change `csparty-up.sh` back to `cs-party-relay:0.4`, then run `csparty-up.sh relay`.


## Server v0.4.2 to v0.4.4 (2026-10-02): minigame weapons, board tiles, smooth camera, late joins
Source: `src/cs-party/plugin/cs_party.sma`. Earlier builds are kept as `*.v0.4.1`.

**Builds**
- Build `appdata/cs-party/patch/` (Dockerfile FROM cs-party-server:0.4, which copies the amxx and `models/csp_tile.mdl`). It's tagged `cs-party-server:0.4.4` and wired into `csparty-up.sh`.
- Rollback: change the tag in `csparty-up.sh` back to an earlier one (0.4.1, 0.4.2, 0.4.3), then run `csparty-up.sh server`.

**Changes**
1. **Minigame weapons.** Counter-Strike only gives the round's default weapons to players who died the previous round. Pawns standing on the board survive with an empty inventory, so they started minigames with nothing. The log proved it: `Loadout ... nothing`. Fix: `apply_loadout` now strips everyone and gives knife + the minigame's primary/secondary/grenade with full reserve ammo (`give_full`), then board gear on top. Each minigame logs `Loadout <name>: ...` 2 s in.
   - Verified with bots: Scoutzknivez gave all four scout + knife; Pistol Round gave T glock + C4, CT usp, plus board gear.
2. **Board hidden in minigames.** `board_show(false)` runs at minigame start. Tiles, props, traps and the hostage get EF_NODRAW. Path beams stop redrawing and fade within about 6 s (beam life is now tied to the redraw period). `enter_board` shows everything again.
3. **Board tiles.** A new model, `models/csp_tile.mdl`: a hex tile with one skin per space type (+$, -$, ?, C4, GO, SHOP, AWP, ARMOR, VIP, 1v1, DEAL).
   - Textures are flagged fullbright, so lighting can't wash them out the way additive beams did on the sand.
   - It replaces the hex rings, pillars and glow orbs; the dotted path beams remain.
   - Built with `tools/build_tiles.py` and Valve's studiomdl. Sources are in `assets/src_tile`, the contact sheet is `assets/tile_skins.png`, and the file was added to `gamedata.zip` (backup: `gamedata.zip.pre-tiles`) and `web/gamedata.manifest`.
   - studiomdl itself: `build-tools/studiomdl/build/sm/studiomdl`, built per `tools/dev/README-studiomdl.md` in image `csp-gcc32`; `csp-mdltools` adds python3-pil. The rebuilt dice came out the same size as the shipped `csp_dice.mdl` (191,064 bytes), so the compiler matches.
4. **Smooth camera and hops.** AMXX timers fire about every 0.1 s, so the 0.04 s camera and 0.03 s hop tasks really ran at about 10 Hz. Both now run from `FM_StartFrame` (about 60 Hz) with time-based smoothing (`ease()`); hops take 0.3 s. The server also sets `sv_maxupdaterate 60` so clients interpolate the camera entity.
5. **Late joiners take a bot's seat.** Someone joining mid-match used to spectate until the match ended. Now, at the next safe moment, they take a seat a bot is playing for itself, never one a bot is keeping for a human who dropped.
6. **Host contention.** The RAID ran at load average about 37 on 12 cores (browserless about 420% CPU, whisper about 220%), which starved the game server and the headless tests.
   - `cs-party-server` now runs with `--cpu-shares 4096` (set live, and saved in `csparty-up.sh`).
   - Under that load, headless test joins sometimes stall during connect. Two stalls happened right after server restarts.

**Still open**
- Black player models ("shadow people"): not reproduced.
- Ruled out: missing models (all 8 player .mdl files are 2.3 MB with embedded textures), plugin render settings (none touch players), and engine planar shadows (`r_shadows` defaults to 0).
- Two Towers DM minigame: ISSUE (which map is still to be picked).


## Relay v0.4.3 (2026-10-02): art drop, new join screen
Source: Nextcloud `cloud/csparty/cs-party-design-v1.zip`, a GoldSrc party-menu design pack with a character portrait atlas, logos and HTML/CSS/JS. It's kept in `src/cs-party/web/design/csparty-design-v1/`.

1. **Join screen** (`web/public/index.html`, `boot.js`; previous versions are `*.pre-artdrop`):
   - The design's markup sits inside `#gate`, and the design CSS is scoped under `#gate`, so the in-game overlays, pause menu and toast keep their own styles.
   - The ISSUE pick logic stays as it was: `_csp_char` setinfo, the saved pick, arrow and controller grid moves.
   - The page keeps the IDs boot.js depends on: `form`, `name`, `go`, `status`, `bar`, `touch`, and `char` radios with values 0-7 or -1.
   - The download status and progress bar sit under the Join button.
2. **Assets** in `web/public/art/`:
   - `logo.webp`: primary logo resized to 720x360.
   - `character-atlas.webp`: 4x2 portraits, 295 KB (the PNG was 1.8 MB).
   - `favicon.svg`.
   - Portrait order matches the plugin's SKIN order: Phoenix, Elite, Arctic, Guerilla, SEAL, GSG-9, SAS, GIGN.
3. **relay.js:** added the `.webp` and `.svg` MIME types (previously served as octet-stream).
4. **Landscape phones** (max-height 500px) get a compact masthead, so the roster is in the first screen.
5. **Image:** `appdata/cs-party/patch-relay2/` (FROM cs-party-relay:0.4.2) -> `cs-party-relay:0.4.3`, wired into `csparty-up.sh` (backup: `csparty-up.sh.pre-artdrop`).
6. **Verified headless** at 1440, 900, 390x844 and 844x390:
   - No horizontal overflow and all 8 tiles render.
   - Click GSG-9 shows die 0 2 2 5 5 7; the arrow keys move between characters and onto Random.
   - Join starts the download and saves `csp_char`.
   - No page errors.
   - Through Cloudflare, all assets return 200 with correct content types.
7. **Rollback:** set `cs-party-relay:0.4.2` in `csparty-up.sh`, then run `csparty-up.sh relay`.


## v0.5.0 (2026-10-02 evening): forks merged, Cloudflare cache fix, game-night requests
**Two forks.** ISSUE built v0.5 (new boards, Climb and Maze minigames) and later the GN-1 spawn fix in its own workspace, `/paperclip/workspace/vision-quest/ISSUE`, branched from v0.4. It was never deployed. The live server (0.4.5) carried every fix since the morning but none of v0.5. GN-1 was marked "fixed" on ISSUE, but it was not live.

1. **Plugin merge:** `git merge-file` three-way merge, ours = live 0.4.5, base = v0.4, theirs = ISSUE `src/plugin/cs_party.sma` (the workspace copy, newer than the v0.5 tarball).
   - One conflict, `cmd_start` vs the board picker: kept both.
   - From v0.5: `safe_spot`/`spot_clear` (GN-1, used by `pawn_spot` and the arena spawns), `/board` + `csp_board`, and MG_CLIMB / MG_MAZE.
   - Previous build kept as `plugin/cs_party.sma.v0.4.5`.
2. **Game-night requests:**
   - The crosshair is hidden during board phases and the lobby (`crosshair_sync`, `m_iHideHUD` bit 64) and comes back in minigames.
   - Bigger text: the page starts the engine with `+hud_scale 900` (desktop) or `640` (touch). That's a virtual HUD width, so about 1.6x at 1440 px. `?hud=0` turns it off.
3. **Server 0.5.0** (`patch050/`, FROM cs-party-server:0.4): the v0.5 overlay's new files plus the merged amxx and `csp_tile.mdl`.
   - Boards: de_dust2, de_aztec, de_cbble, de_inferno. Minigame configs for climb and maze.
   - Maps csp_climb and csp_maze, plus .nav files for the new boards and maps, and the v0.5 motd.
4. **Game data:**
   - Repacked with the v0.5 `pack_gamedata.py` (map list + `de_cbble`) from a staging copy, `appdata/cs-party/stage`, made of the Nextcloud Half-Life folder + the v0.5 overlay + `csp_tile.mdl`.
   - Result: 3,095 files, 55.5 MB. Includes the new maps, sliced WADs, the dice and tile models, and the touch layout.
   - Previous files: `gamedata.zip.v04-tiles` and `gamedata.zip.pre-tiles`.
5. **Cloudflare was serving stale game data.**
   - The relay sent `.zip` as `public, max-age=604800`, so Cloudflare kept handing out the original 46.6 MB pack (ETag 2c723e8) after the tile update. Browsers never got `csp_tile.mdl`.
   - Fix (relay 0.4.5):
     - `gamedata.zip` is now `private, no-cache`; Cloudflare shows `cf-cache-status: BYPASS`.
     - The page requests `gamedata.zip?key=...&v=<GAMEDATA_V>` (`0.5.0`), which sidesteps the poisoned cache entry.
   - **Bump `GAMEDATA_V` in boot.js whenever gamedata.zip changes.**
6. **Images:** server `0.5.0`, relay `0.4.5`. The previous script is `csparty-up.sh.pre-v05`.
7. **Rollback:**
   - Set `cs-party-server:0.4.5` / `cs-party-relay:0.4.3` in `csparty-up.sh`.
   - Restore `gamedata.zip.v04-tiles` over `gamedata.zip`.
   - Run `csparty-up.sh all`.


## v0.5.1 (2026-10-02 night): Two Towers minigame (ISSUE)
1. **Map:** `twotowers` ("The Two Towers - Sniping Heaven" by Murray), downloaded from ds-servers.com. The readme has no license or redistribution terms (old freeware community map).
   - Shipped as `csp_towers.bsp`. The `csp_` prefix is what makes the plugin treat a map as an own-map minigame.
   - Edited the worldspawn of the BSP (new entity lump appended; no other lump moved):
     - `wad` cut from 22 WADs to `halflife.wad;cs_bdog.wad;cs_dust.wad`. HLDS failed with `TEX_InitFromWad: couldn't open as_tundra.wad`, and only 12 textures are used.
     - Sky `cl_dusk` (not stock) became Half-Life's `dusk`.
   - The original is kept next to it as `csp_towers.bsp.orig` in the work dir.
   - Its lighting is a dark orange dusk (sun `255 132 72 200`). That's the author's lighting, not missing textures.
2. **Plugin** (`plugin/cs_party.sma`; previous version kept as `cs_party.sma.v0.5.0`):
   - New minigame `MG_TOWERS` (index 12), "Two Towers": AWP + Deagle, every format, `mp_roundtime 2.0`, last side (or last player in FFA) standing. `MG_MAP` = `csp_towers`.
   - `mg_fight()` marks own-map minigames that are fights, not races. On the fight map, the wait phase holds players at the map's own spawns (no race line). It then runs the same `mg_rules()` + `mg_fight_start()` the board minigames use, which `flow_minigame_go` was split into.
   - Round end on an own map saves the result, and `task_race_over` changes back to the board. The board pays out through the existing resume path.
   - The arena placement on board nodes is skipped when there's no board (`g_nodeCount` 0).
   - Fix found in testing: `set_member_game(m_bGameStarted, true)` before the restart. On a freshly loaded map, the first kill fired `Game_Commencing`, which ended the round as a draw.
3. **Images:**
   - Server: `patch051/` (FROM cs-party-server:0.5.0, `ov/` = amxx + csp_towers bsp/txt/nav) -> `cs-party-server:0.5.1`.
   - Relay: `patch-relay4/` (FROM cs-party-relay:0.4.5; its boot.js has `GAMEDATA_V` "0.5.1") -> `cs-party-relay:0.4.6`.
   - `csparty-up.sh` backup: `csparty-up.sh.pre-towers`.
4. **Game data:**
   - `csp_towers.bsp/.txt` added to `stage/cstrike/maps`, and `csp_towers` added to `MAPS` in `web/pack_gamedata.py`. Repacked: 3,103 files, 54 MB.
   - The previous zip is `gamedata.zip.v050`.
   - Served through Cloudflare: 200, 56.8 MB, BYPASS.
5. **Verified:**
   - Headless harness, bots at `csp_speed 0.3` with `csp_force_mg 12`: 2v2 hand-off, all four players got awp/deagle/knife, elimination ended the round, back on de_dust2, +$2500 to the winners, and the board continued.
   - The live server, same check: 1v3 played to elimination, return, and payout.
   - Live with one headless browser player (`csp_test_remote 12`):
     - The player reconnected across the changelevel ("TowerTest is back."), got AWP + Deagle, fought, died to an AWP, and was back on the board rolling dice.
     - Screenshots: `/paperclip/workspace/vision-quest/ISSUE/test/shots/`.
6. **Dev commands:**
   - `csp_force_mg 12` forces Two Towers.
   - `csp_test_remote 12` jumps straight to it.
   - Note: `csp_force_mg` with no argument sets 0 (Plant the Bomb), so always pass `-1` to clear it.
7. **Rollback:**
   - Set `cs-party-server:0.5.0` / `cs-party-relay:0.4.5` in `csparty-up.sh`.
   - Restore `gamedata.zip.v050` over `gamedata.zip`.
   - Run `csparty-up.sh all`.


## v0.5.2 (2026-10-03): theme song (ISSUE)
1. **Audio:** Alex's `C-S-Party.wav` (Nextcloud cloud/csparty, 1:49) encoded to `public/audio/cs-party-theme.mp3` (160 kbps, 2.1 MB, 2.5 s fade at the end).
2. **Page** (`index.html`, `boot.js`):
   - The join screen plays the theme on loop at **10% by default**. A mute button and a volume slider sit in the title bar (where "PLAYER SETUP" was). The Esc menu has a matching **Music** slider. Both are saved in localStorage `csp_music`.
   - Browsers block sound before any interaction, so if the first `play()` is refused, the first click, key, touch or controller starts it.
   - Pressing Join fades the music out over 2.5 s. If the join fails, the music comes back on.
   - At game end, the page plays the song once from the start, at the saved volume, unless muted.
3. **Plugin:** `flow_finish` sends `echo CSP_THEME_PLAY` to every client right after the winner banner. `match_start` sends `echo CSP_THEME_STOP`, which fades out a theme still playing. The page watches the engine console (`Module.print`) for these lines. Native CS 1.6 clients only see the echo in their console and hear nothing.
4. **Relay:** `relay.js` serves `.mp3` as `audio/mpeg`.
5. **Images:**
   - Server: `patch052/` (FROM cs-party-server:0.5.1, `ov/` = the new amxx) -> `cs-party-server:0.5.2`.
   - Relay: `patch-relay5/` (FROM cs-party-relay:0.4.6; relay.js, index.html, boot.js, audio/) -> `cs-party-relay:0.4.7`.
   - Backup: `csparty-up.sh.pre-theme`. The game data is unchanged (`GAMEDATA_V` is still 0.5.1).
   - Source: `/paperclip/workspace/vision-quest/ISSUE/` (`live/` = web, `plugin/` = sma + amxx). The plugin source is the live 0.5.1 `ISSUE/plugin/cs_party.sma` plus 2 lines.
6. **Verified on live** (headless Chromium on the RAID):
   - Default autoplay policy: the page loads paused at 10% (slider 0.1, label 10%). A click starts playback. Mute pauses it, and unmute resumes it.
   - Autoplay allowed: playback starts on load. Join fades it out.
   - 1-turn bot match (`csp_turns 1`, `csp_speed 0.3`): CSP_THEME_STOP arrived at match start. At game end (00:40:27) the theme started, no loop, volume 0.1, and stopped by itself when the song ended about 1:50 later.
   - Screenshots at 390, 640 and 1280 px wide: the control fits in the title bar. After the test, the server was recreated to restore its cvars.
7. **Rollback:**
   - Set `cs-party-server:0.5.1` / `cs-party-relay:0.4.6` in `csparty-up.sh`, or restore `csparty-up.sh.pre-theme`.
   - Run `csparty-up.sh all`.


## Server v0.5.3 (2026-10-03): movement tutorials, auto-bhop, source back in sync
1. **The source tree had drifted from production.**
   - Server 0.5.2 (ISSUE, the theme song) was built from a scratch copy, so `src/cs-party/plugin/cs_party.sma` was still 0.5.1.
   - I diffed the decompressed strings of the 0.5.1 and 0.5.2 amxx. The only change was `client_cmd(0, "echo CSP_THEME_PLAY")` at the winner banner and `CSP_THEME_STOP` at match start, and I rebuilt that into the source.
   - Web: copied the live relay files (patch-relay5: boot.js, index.html, audio/, relay.js) into `src/cs-party/web`; the old copies are `*.pre-sync`.
   - **Rule: every deploy writes its sources back to `src/cs-party` first.**
2. **Tutorials.** `MG_TUT[]` holds a short how-to card for Surf, Bhop and Climb.
   - It's drawn on its own HUD channel (`g_hudTut`, left side) while players load, through the countdown, and for the first 12 s of the race.
3. **Auto-bhop.** `csp_autobhop 1` (default) sets `sv_autobunnyhopping 1` for the Bhop Course only. It resets to 0 wherever `sv_airaccelerate` goes back to 10.
4. **Image:** `patch053/` (FROM cs-party-server:0.5.2) -> `cs-party-server:0.5.3`. The previous script is `csparty-up.sh.pre-tutorials`; the previous source is `plugin/cs_party.sma.v0.5.1-src`.
5. **Verified with bots** (`csp_test_remote 9`):
   - `sv_autobunnyhopping` was 1 on csp_bhop and 0 after resuming on de_dust2.
   - The race finished and the match resumed.
   - Not verified: how the card looks in a browser (headless joins time out under the current host load).


## relay 0.4.9 (2026-10-03): theme waits 20 s on the join screen (ISSUE)
- `boot.js` only, built on the live 0.4.8 copy (`patch-relay6/`, FROM cs-party-relay:0.4.8). The music no longer starts on page load. After 20 s on the join screen (`MENU_DELAY`), the theme fades in over 3 s.
  - Moving the volume slider or pressing unmute starts it straight away.
  - Joining before the 20 s are up cancels it.
  - If the browser still blocks sound because nobody has interacted yet, the first interaction after the 20 s starts it.
- Verified on live (headless Chromium): the page stays paused at 3, 10 and 19 s, and starts playing at 21 s (volume 0.017, reaching 0.1 by 25 s). Mute then unmute at 2 s plays immediately. Join at 2 s keeps it silent at 23 s.
- Rollback: restore `csparty-up.sh.pre-menudelay` (relay 0.4.8), then run `csparty-up.sh relay`.


## relay 0.4.11 (2026-10-03): 1.5x text by default
- Alex tested `&font=1.5` and answered "bigger and clean, make it the default".
- `boot.js`: `FONT_SCALE = params.get("font") || "1.5"`, always passed as `+hud_fontscale`. Use `&font=1` for normal-size text. `hud_scale` (`&hud=`) stays opt-in because it renders white boxes.
- `index.html` now loads `boot.js?v=0.4.11`. boot.js is served with `max-age=14400`, so browsers would otherwise keep the old copy for up to 4 h. **Bump this `v=` on every boot.js change.**
- Written to `src/cs-party/web/public` first (backups `boot.js.pre-font15`, `index.html.pre-font15`), then `patch-relay11/` (FROM cs-party-relay:0.4.10) -> `cs-party-relay:0.4.11`.
- Deployed with the peers check as a hard condition in the same command (`peers=0`, both restarts).
- Verified through Cloudflare: the page references `boot.js?v=0.4.11`, which returns 200 with the new default. `/healthz` returns 200.
- Rollback: restore `csparty-up.sh.pre-font15` (relay 0.4.10), then run `csparty-up.sh relay` once peers is 0.


## server 0.5.9-vq (2026-10-03 13:44 UTC): returning players could not move (ISSUE)
- Bug: after a map change (Two Towers, races, back to the board), the returning human is seated from inside the team-panel VGUI hook. ReGameDLL's JoiningThink then sets `m_iJoiningState = PICKINGTEAM` / `m_iMenu = Menu_ChooseTeam` after the hook returns. The player stood alive and armed with maxspeed 1, which was Alex's "unable to move" on Two Towers. On the board, round respawns skipped them, so they sat dead in spectator. Races hid it because `race_unstick` resets maxspeed every 0.1 s.
- Fix: `seat_settle(id)` sets JOINED / Menu_OFF and resets maxspeed for any seated human on T/CT. It runs 0.2 s after `seat_join`/`reclaim_seat`, in `mg_fight_start`, and on every `task_seat_watch` tick (minigames included). It logs "X was still joining (state 4, menu 1): settled."
- Also: target menus (duel pick, fake call, swap, negotiator) now start the turn watchdog (`W_TARGET`). Before this, a human who ignored the duel pick stalled the party for good. The fallback is a duel against the richest opponent, a roll for item picks, and walking on for the negotiator. It compiles, but no test has hit the timeout yet.
- `csp_probe` now also prints team, joining state, menu, observer mode, deadflag and spawn count.
- Verified on an isolated RAID copy (server :27030 + relay :8096, same 0.5.8-vq image) with a GPU headless player (Quadro K2200, ANGLE gl-egl). Before the fix: `join=4 menu=1 maxspd=1`, position frozen. After: settled, then moving at velocity 208, position 595 -> 868 -> 971/-338, until a bot's AWP killed it.
- Source: `ISSUE/src/plugin/cs_party.sma` (backup `.pre-ISSUE-join`). Image `cs-party-server:0.5.9-vq` = FROM 0.5.8-vq + COPY cs_party.amxx. Deployed with the peers=0 and live-tag gate in the same command.
- Rollback: `docker rm -f cs-party-server && docker rename cs-party-server-058old cs-party-server && docker start cs-party-server` (0.5.8-vq, healthcheck intact).



## server 0.5.11-vq + relay 0.4.13 (2026-10-03 15:21 UTC): Two Towers "crash" and drops ending fights (ISSUE)
- **Alex's crash was the page unloading.** At 12:36:01 the client sent 'drop' and the relay saw `browser closed (1001)` in the same second. Only boot.js's `pagehide` handler sends 'drop', and 1001 means the page went away. A renderer crash closes with 1006 and sends no 'drop', and an engine Host_Error shows an alert and leaves the socket open. The most likely trigger is Ctrl+W: Ctrl is duck, W is forward, and Chrome closes the tab without asking the page.
- relay 0.4.13 (`patch-relay13/`, FROM 0.4.12, `boot.js?v=0.4.13`):
  - A `beforeunload` prompt while in a match, so Ctrl+W, Ctrl+R and mouse-back ask "Leave site?" first. The Leave and Rejoin buttons skip it.
  - `navigator.keyboard.lock()` in fullscreen, so Chrome/Edge hand Ctrl+W to the game.
- **Repro, isolated** (server :27030 + relay :8096 from the live images, GPU Playwright, `tools/dev/towers_e2e.js`): csp_towers 1 v 3 with the AWP, about 60 s of scope in and out, turning, firing and duck-walking. No page errors and no engine errors; a bot's AWP ended it. A reload with the guard showed the beforeunload dialog, and dismissing it kept the game in state 4. Playwright's `page.close` never shows the dialog, even on a bare page.
- **Fights ended when a human dropped.** On this sv_lan server, ReHLDS turns the Steam "deny" for a leaving human into dropping every bot ("Client dropped by server", `sv_steam3.cpp` OnGSClientDenyHelper). Both sides emptied, the round ended as a draw, and the plugin said "Nobody wins Two Towers!" and changed map. Our ReHLDS exposes API 3.10, too old for a `RH_SV_DropClient` hook (a plugin that registers it fails in plugin_init).
- server 0.5.11-vq (`patch0511/`, FROM 0.5.10-vq + amxx):
  - Anyone who drops out of a fight while alive gets a stand-in: a spare bot (bot_quota refills within a second) at the same spot, with the same health. The round end waits until the stand-in is in, and a "Game Commencing" draw is never a result.
  - `task_slay` no longer kills a bot that was seated as a stand-in after it spawned.
  - `refill_seats` keeps a bot seat's name ("Xavier takes over Rick's seat" no longer renames Rick).
  - `bot_join_after_player 0` is re-applied after game.cfg (which sets it to 1).
  - `rebind_seats` gives a seat to a bot already wearing that name first. That fixes "(1)Dan".
  - `Sides:` debug line; `csp_test_remote <mg> 1v3`.
- Teams in Alex's game were right: 3 CT vs Dean on T is a legal 1 v 3. The "suicide with world" lines are the plugin slaying spare bots.
- Verified on the isolated copy: phaTT dropped mid-fight and all 4 bots went with him. All 4 seats were back in the fight within 2 s, phaTT's stand-in killed a CT, the CTs won 90 s later, and the server returned to the board and paid the result.
- Deployed with the gate in one command: rcon status had 0 humans, peers was 0, and the live tags were 0.5.10-vq / 0.4.12. `csparty-up.sh` now carries the current tags, MAXPLAYERS=10 and the log limits (backup `csparty-up.sh.pre-ISSUE`). E2E logs are in `appdata/cs-party/logs/ISSUE-e2e/`.
- Rollback: `docker rm -f cs-party-server cs-party-relay && docker rename cs-party-server-0510old cs-party-server && docker rename cs-party-relay-0412old cs-party-relay && docker start cs-party-server cs-party-relay`.


## server 0.5.16-vq (2026-10-04 16:52 UTC): score table and tutorial no longer blink out (ISSUE, ISSUE)
- The client never restarts a HUD message that's already up (one buffer per channel, so cs16-client's de-dup always matches a re-send). With a 4 s hold, the table timed out 4 s after it first went up and stayed gone until the next 2.5 s refresh.
- Fix: the table and the minigame tutorial are held for 240 s (`HUD_HOLD`). The table is re-sent on text change, just after the hold runs out, and after each spawn (`ResetHUD`). Idle blanks the table. The tutorial is blanked when its window ends.
- `patch0516/` (FROM cs-party-server:0.5.15-vq + amxx) -> `cs-party-server:0.5.16-vq`. `csparty-up.sh` backup: `csparty-up.sh.pre-ISSUE`. Deployed with the gate in one command: 0 humans in rcon status, peers 0, live tag 0.5.15-vq.
- Live spot-check (GPU headless desktop player, 960x600): the table was in 120/120 board frames over 75 s and gone from all 11 frames after `csp_stop`. In the bhop race the table showed in every in-race frame, and the tutorial was up until 12.0 s race time and gone from 12.6 s on.
- Known: a ~0.5 s blink once every 4 minutes at the hold handoff (no free HUD channel to overlap it).
- Rollback: `docker rm -f cs-party-server && docker rename cs-party-server-0515old cs-party-server && docker start cs-party-server`, then restore `csparty-up.sh.pre-ISSUE`.

## server 0.5.16-vq-ISSUE + relay MAX_PER_IP=12 (2026-10-04 18:40 UTC): 7+ browser players kept across map changes (ISSUE)
- 8-client soak (`tools/dev/stability_e2e.js`: 4 seated + 4 spectators, 35 min, 4 map changes) on an isolated copy. Every browser player reaches HLDS from 127.0.0.1 (the relay). A map change reconnects them all at once, and ReHLDS refused the 6th+ still-connecting client from one IP (`Too many connect packets from 127.0.0.1 (6>5)`), dropping them to "Lost the party".
- Fix: `sv_rehlds_maxclients_from_single_ip 32` in server.cfg. Relay `MAX_PER_IP` 6 -> 12 (a party in one house shares one public IP).
- `patch0516-cfg/` (FROM cs-party-server:0.5.16-vq + server.cfg) -> `cs-party-server:0.5.16-vq-ISSUE`. `csparty-up.sh` backup: `csparty-up.sh.pre-ISSUE`. Gate: 0 humans, peers 0, live tags 0.5.16-vq / 0.4.18.
- Soak with the fix: 0 server crashes or restarts, 0 AMXX errors, ~120 MB, ~7% CPU; all 8 clients back after every map change.
- Rollback: containers `cs-party-server-0.5.16-vqold` and `cs-party-relay-0.4.18old`.

## server 0.5.17-vq (2026-10-04 20:43 UTC): pawn light is steady, no more "flashlights" (ISSUE)
- Reported live: flickering lighting, "everyone has flashlights on". The 0.5.15 pawn light was `EF_DIMLIGHT`. Xash3D gives your own player a real flashlight beam for it (`CL_UpdateFlashlight`) and everyone else a world light with radius `200 + rand(0..31)` re-rolled every frame.
- Stopgap 20:18 UTC: `csp_pawnlight 0` over rcon (no restart).
- Fix: `TE_ELIGHT` per seated pawn, 90 units toward the director camera, radius 200, grey 110, 0.6 s life, re-sent every 0.25 s, key `4095 - id`. It lights models only. Studio models are lit only on faces turned toward a light, and a key equal to an entity index makes the client snap the light onto that entity's origin, so a light keyed to the pawn did almost nothing (+2 vs +6).
- A/B on an isolated copy (own turn, still camera, light on/off/on): old +7 pawn brightness with added frame-to-frame change (1.9 -> 2.35); new +6, nothing added on the floor.
- `patch0517/` (FROM cs-party-server:0.5.16-vq-ISSUE + amxx) -> `cs-party-server:0.5.17-vq`. `csparty-up.sh` backup: `csparty-up.sh.pre-0517`. Gate: 0 humans, peers 0, live tag 0.5.16-vq-ISSUE. Verified: plugin running, `csp_pawnlight` 1, `sv_rehlds_maxclients_from_single_ip` 32, healthy.
- Rollback: `docker rm -f cs-party-server && docker rename cs-party-server-0.5.16-vq-ISSUEold cs-party-server && docker start cs-party-server`, then restore `csparty-up.sh.pre-0517` (or keep 0.5.17 and set `csp_pawnlight 0`).
