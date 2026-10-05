# Race map pools

Surf Race, Bhop Course, Climb and Maze Run each draw their map from a pool (ISSUE). The draw happens at the
minigame's intro. A match never plays the same race map twice until that race's pool is used up.

## What puts a map in a pool

The plugin scans `configs/cs_party/minigames/*.ini` on every map load (`scan_pools`). A map joins a pool when all of
these hold:

- **Pool.** The .ini has a `pool surf|bhop|climb|maze` line, or the map's name decides it: `surf_`/`csp_surf*`,
  `bhop_`/`csp_bhop*`, `kz_`/`bkz_`/`climb_`/`csp_climb*`, `maze_`/`csp_maze*`. `pool none` keeps a map out.
- **A way to finish.** A `finish` box, or `buttons 1` (the kreedz stop-timer button).
- **The server can load it.** `maps/<map>.bsp` is BSP version 30, and every WAD in its worldspawn `wad` key exists.
  A missing WAD makes HLDS quit on the spot, so the map is left out, never loaded.
- **`maps/<map>.nav` exists.** zBots won't join a map without a nav mesh. The race would then wait for seats that
  never fill, and bots would never finish.

Anything left out is logged: `Race pools: <map> left out (<why>)`. A race whose pool is empty falls back to its
`csp_` map.

Check a server with `csp_test_remote pools`. Play one map on its own with `csp_test_remote <mg> [1v3|ffa] <map>`
(mg: 8 surf, 9 bhop, 10 climb, 11 maze).

## Zone .ini

```
pool climb                          ; optional, see above
spawn x y z yaw                     ; start spots, one per racer is best (up to 8); else the start box row
start x1 y1 z1 x2 y2 z2             ; csp_ maps: racers line up across it facing +x
finish x1 y1 z1 x2 y2 z2            ; reach it to finish
buttons 1                           ; kreedz: pressing the stop-timer button (counter_off, clockstopbutton...) finishes
progress dist                       ; who got furthest at the time-limit buzzer: x|-x|y|-y|z|-z|dist (default x on csp_, else dist)
time 240                            ; optional race time limit in seconds (default 120, 30-1800)
bottime 150 210                     ; optional window bots finish in, seconds (default: the race's own, 30-75 s)
checkpoint ...                      ; for reference only; the map's own triggers do the respawning
```

With no `spawn` and no `start`, racers start on the map's own spawn points. Kreedz maps put those at the start.

## Adding a community map

```
python3 tools/race_map.py build kz_foo.bsp --game <hlds dir> --content <the map's unpacked release> --nav kz_foo.nav
```

This writes `build/racemaps/server/cstrike/...` (the server's files), `build/racemaps/web/kz_foo.zip` (the browser's
map pack) and `build/racemaps/kz_foo.ini.draft`.

- **Textures.** Every texture the map takes from a WAD is copied into one `kz_foo.wad`, and the `wad` key names only
  that file. Server and browser get the same complete set, so mapper paths such as `\sierra\half-life\valve\xeno.wad`
  stop mattering. Lighting and geometry are untouched, and the map CRC skips the entity lump.
- **Refused maps.** Non-GoldSrc BSPs (Quake 29, Source `VBSP`) are refused. So is any map whose model or sprite isn't
  in its release or the game (HLDS quits on the precache). A missing sound is only a warning.
- **Size budget.** The browser pack must fit `--budget-mb` (6 MB zipped by default), because phones download it during
  the minigame intro. Over budget means nothing is written.
- **Nav mesh.** Make it on the built .bsp with `tools/harness/gennav.sh` (4-8 min per map). A .nav records the size of
  the .bsp it was made on.
- **Zone .ini.** The draft lists the map's spawns and its kreedz stop button, or a "Thanks for playing" trigger as the
  finish. Check every line in game, then commit it as `maps/pool/kz_foo.ini`.

The repo keeps only the .ini files. Third-party maps and the WAD slices (Valve textures) stay out of git:
`build/racemaps/` and `web/public/mappacks/` are ignored.

## The surf pack (ISSUE)

Six original surf courses live in `maps/pool/`: `csp_surf_dust`, `csp_surf_aztec`, `csp_surf_snow`, `csp_surf_night`,
`csp_surf_storm`, `csp_surf_space` (.bsp, .map, .nav and zone .ini each). `tools/gen_minigame_maps.py` builds them from
`SURF_PACK`: one stage list per course (a stage is a V run or a one-sided ramp, then a landing platform), a theme
(sky, stock WAD, ramp/floor/trim textures, light colour). Falling anywhere teleports you back to the start of that
stage. The finish is a gate over the last pad, so flying past it counts. Regenerate with

```
python3 tools/gen_minigame_maps.py <sdhlt tools> <cstrike dir> <outdir> csp_surf_dust csp_surf_aztec ...
```

then `tools/race_map.py build <outdir>/csp_surf_<theme>.bsp --game <hlds>` for the WAD slice and browser pack
(0.15-0.96 MB zipped). The .nav is the same 79-byte stub the other `csp_` maps use: zBots join and stand at the
start, they don't surf, and the race ends when a human finishes or the 120 s buzzer picks the furthest racer
(`progress x`). Test one course on an isolated server with `csp_test_remote 8 ffa csp_surf_night`; the scripted
desktop/phone race rig is `tools/dev/surf_e2e.js`.

## The climb pack (ISSUE)

Ten beginner kreedz maps (all **Easy** on kreedz.com), credited in `maps/CREDITS.md`: `kz_xj_mountez`,
`cobkz_minecraft`, `kz_ea_oldgraveyard`, `kzbg_ytt_pyramid`, `skitz_bean_valley`, `kz_darkmine`, `kz_kzse_towerblock`,
`kz_j2s_summercliff_ez`, `kz_cliffez`, `kz_xj_ezbrickjump`. The repo keeps their zone .ini files in `maps/pool/`.
Build the server files and browser packs (1.2-3.5 MB zipped) with

```
python3 tools/climb_pack.py --game <hlds dir> --dl build/climbdl --out build/racemaps
```

It downloads each map from the kreedz.com archive, fixes what the browser or the race can't take (a sky the map
doesn't ship, a sky name in the wrong case, a stop button with a `master` that stays locked until the start button
is pressed), runs `race_map.py build`, and writes a one-area nav stub at the start. zBots join and stand at the
start. They can't climb, so a race no human finishes ends at the buzzer on `progress z` (highest racer wins). The
.ini files also carry `time 180` / `bottime` for the longer kreedz runs. Plugins without those keys ignore them.

Test rig: `tools/dev/climb_e2e.js` with the test-only `tools/dev/csp_kztest.sma` (`csp_kz_goto <name> [n]` puts a
racer in front of the stop button). A desktop client and a phone client (touch Use button) press the real button,
and the race must record both finishes.

## How browsers get the map

Pool maps are not in `gamedata.zip`, so a new map doesn't make every player re-download 55 MB. The plugin echoes
`CSP_MAP_<map>` at the intro and again at the hand-off. boot.js then fetches `mappacks/<map>.zip?key=...` and writes it
into the engine's file system. The map change comes about 10 s later. A map already in the file system (the `csp_`
maps in gamedata.zip) isn't fetched. If the fetch fails, the engine's own download over the game connection is the
fallback (`sv_allowdownload`). The relay serves `mappacks/` with the party key, like gamedata.zip, because the WAD
slices are Valve's.

## Deploying pool maps

1. Copy `build/racemaps/web/*.zip` to `appdata/cs-party/mappacks/`. The relay mounts that directory read-only
   (`csparty-up.sh`), so new packs need no relay rebuild.
2. Add the server files and .ini files to a server patch:
   `COPY racemaps/ /hlds/` and `COPY *.ini /hlds/cstrike/addons/amxmodx/configs/cs_party/minigames/`.
   `tools/package_server.sh` also does this from `maps/pool/` + `build/racemaps/server/`.
3. Check the pools on the new server (`csp_test_remote pools`), and look for `left out` lines in the AMXX log.

## Maze Run variants (ISSUE)

`csp_maze` plus seven generated variants fill the maze pool. `tools/gen_minigame_maps.py` has `MAZE_VARIANTS`
(grid size, cell size, seed, theme, dark, extra loops); `tools/build_maze_pack.py <sdhlt_tools> <game_dir>` compiles
them, runs `race_map.py build`, writes the nav stub and copies the .ini and .map into `maps/pool/`. Textures are all
cstrike.wad. Routes are at 250 u/s: "shortest" is the BFS route (a player who reads the maze), "follower" is the
left-hand wall follower (a player who never reads it). The seeds were searched so the follower lands near 85-90 s and
the shortest route is 30-45 s, which keeps a lost player in the 60-120 s band.

| map | grid x cell | theme | shortest | follower | browser pack |
|---|---|---|---|---|---|
| csp_maze_brick8 | 8 x 256 | brick | 43 s | 88 s | 0.9 MB |
| csp_maze_conc10 | 10 x 192 | concrete | 45 s | 87 s | 1.0 MB |
| csp_maze_hedge | 12 x 160 | hedge | 41 s | 87 s | 0.9 MB |
| csp_maze_metal14 | 14 x 144 | metal | 42 s | 88 s | 0.4 MB |
| csp_maze_rust16 | 16 x 128 | rust | 34 s | 88 s | 0.9 MB |
| csp_maze_dark10 | 10 x 192 | night, dark | 32 s | 87 s | 0.7 MB |
| csp_maze_dark14 | 14 x 144 | night, dark | 36 s | 88 s | 0.7 MB |

Dark variants have the lights off, so players need the flashlight (F). Every .ini has `pool maze`, `progress x`
(the progress bar follows the way out) and 8 spawns.

**Bots.** zBots can't read a maze. Each variant ships a one-area nav stub over the start zone (`g.write_nav_stub`),
so the pool accepts the map and bots join; they "finish" on the clock in `MG_BOT_TIME` (30-60 s for maze), as on
every race map. Each variant's .ini also has `bottime 50 100` (ISSUE key; older plugins ignore it): bots then
finish after a player who reads the maze (~40 s) and around a lost one (~88 s), instead of 30-60 s, which beat most
humans. The stub records the .bsp size, so it has to be written after `race_map.py build` (which rewrites the
worldspawn wad key): `build_maze_pack.py` does that.

**Testing.** `tools/dev/csp_mazewalk.sma` (dev only, never ships) walks the first human along the solution
(`<out>/walk/<map>.walk`, written by the build) and logs `[WALK] reached the last waypoint after X s`. The race ends 5 s after the first finisher, so without
`bottime` a bot on the 30-60 s clock can end it before the 250 u/s walker gets there; `csp_mazewalk_speed 400`
(`SPEED=400` for the E2E) proves the route reaches the finish regardless.
`tools/dev/maze_e2e.js` drives a browser client (`VIEW=desktop|phone`) through `csp_test_remote 11 ffa <map>`, starts
the walker and screenshots the start, the run and the finish.
