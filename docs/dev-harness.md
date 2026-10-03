# Headless test harness (rootless container, no gcc, no docker daemon)

Scripts are in `tools/harness/`. They expect a working directory laid out like the old
`vision-quest/ISSUE` workdir: `hlds/` (game data + ReHLDS `hlds_linux`), `i386/` (Ubuntu 24.04
i386 debs extracted), `shim/` (built `stat32.so`, `nov6.so`), `amxx/` (AMX Mod X dist), `zigpkg/`
(pip `ziglang`) and `src/` (this repo). Those are third-party or rebuildable, so they are not
committed.

- `srv.sh start <map> | stop | rcon <cmd>`: local ReHLDS on UDP 27345, rcon password `csp`.
  Startup takes ~45 s; rcon times out until it is up. AMXX logs: `hlds/cstrike/addons/amxmodx/logs`.
  `srv.sh start` holds the calling shell, so run it as `setsid ... >/dev/null 2>&1 </dev/null &`
  and drive the server with `tools/rcon.py --port 27345 --password csp`, not `srv.sh cmd`.
- `gennav.sh <maps...>`: zBot `.nav` generation, 4-8 min per map.
- `mirror.py`: mirrors the Half-Life install from Nextcloud `cloud/csparty/Half-Life`
  (needs a curl User-Agent). SteamCMD self-update loops under a patched loader; take
  `hlds_linux` from the ReHLDS release zip instead.
- Compiler: zig from pip `ziglang`, with `cc`/`c++` wrappers. SDHLT (seedee/SDHLT @ df45198)
  builds with `sdhlt-df45198.patch`; `compress.cpp` must be built without optimization
  (sdHLRAD's self-test type-puns floats through misaligned pointers and fails at -O2).
- No system i386 libs: extract Ubuntu 24.04 i386 debs into `i386/` and `patchelf --set-interpreter`.

## Compiling the plugin

From `amxx/addons/amxmodx/scripting` (copy `plugin/cs_party.sma` in):

    i386/usr/lib/i386-linux-gnu/ld-linux.so.2 --library-path <i386 libs>:. --preload shim/stat32.so ./amxxpc cs_party.sma

amxxpc output is not byte-reproducible (it embeds the source path), so compare decompressed AMX
images, not md5s.

## Gotchas

- 32-bit stat/readdir fail with EOVERFLOW on the FUSE share. `shim/stat32.c` needs GLIBC_2.0/2.33
  symbol versions and fills `d_type` (FUSE leaves DT_UNKNOWN).
- Metamod deep-binds AMXX, so preloading the shim is not enough: the test copy of
  `amxmodx_mm_i386.so` has the shim added as NEEDED. Never ship that copy.
- Don't skip the `sound/` dirs: missing files make the engine crawl case-insensitive lookups.
- Never kill by grepping `gennav|hlds` over /proc cmdlines; it matches your own shell.
- Third-party BSPs: HLDS dies if any WAD in worldspawn's `wad` key is missing. Rewrite the key
  (append a new entity lump at EOF, update lump 0 in the header).

## Isolated end-to-end test on the RAID

Run a second server from the live image (`-e PORT=27030`) and a relay from the live relay image
(`GAME=127.0.0.1:27030 PORT=8096 PARTY_KEY=...`) with `gamedata.zip` mounted at
`/app/public/gamedata.zip:ro`. `csp_force_mg` resets on every map load; set it after each
changelevel.

Headless browser players run on the Quadro (not swiftshader):
`mcr.microsoft.com/playwright:v1.55.0-noble` with `--runtime nvidia`, an EGL vendor file for
`libEGL_nvidia.so.0`, and `--use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu`. For movement
tests, hide `#pause`, focus `#canvas`, then `keyboard.down('w')`; check position with `csp_probe`.
