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
progress dist                       ; who got furthest at the 120 s buzzer: x|-x|y|-y|z|-z|dist (default x on csp_, else dist)
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
