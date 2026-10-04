#!/usr/bin/env bash
# Packs the CS Party server overlay: everything that goes on top of a stock SteamCMD HLDS (app 90, cstrike).
#   from SERVER_DIR (a working install you built): ReHLDS engine binaries, ReGameDLL_CS, Metamod-R,
#     AMX Mod X with ReAPI, zBot chatter data, the dust2 nav mesh
#   from this repo: the plugin, boards, minigame maps + zones, the dice model, MOTD, server.cfg
# No Valve files go in. Output feeds deploy/Dockerfile.server.
#
# usage: tools/package_server.sh <SERVER_DIR> [out.tar.gz]     (default out: deploy/cs-party-server-overlay.tar.gz)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC=$(cd "$1" && pwd); OUT=$(realpath -m "${2:-$REPO/deploy/cs-party-server-overlay.tar.gz}")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp_rel() { for f in "$@"; do mkdir -p "$T/$(dirname "$f")"; cp -a "$SRC/$f" "$T/$f"; done; }

# ReHLDS (engine + HLTV pieces) and the libsteam_api it ships with
cp_rel engine_i486.so filesystem_stdio.so core.so proxy.so director.so demoplayer.so libsteam_api.so
echo 10 > "$T/steam_appid.txt"   # SteamAPI_Init outside the Steam client needs it, or: "Unable to initialize Steam"
# ReGameDLL_CS
cp_rel cstrike/dlls/cs.so cstrike/game.cfg cstrike/game_init.cfg cstrike/BotChatter.db cstrike/BotProfile.db
cp_rel cstrike/sound/radio/bot
# Metamod-R + AMX Mod X (+ ReAPI module); no logs, stats or saved match state
cp_rel cstrike/liblist.gam cstrike/addons/metamod
rsync -a --exclude logs/ --exclude scripting/ --exclude 'data/cs_party_state.json' --exclude 'data/csstats.dat' \
  "$SRC/cstrike/addons/amxmodx/" "$T/cstrike/addons/amxmodx/"
grep -q '^cs_party.amxx' "$T/cstrike/addons/amxmodx/configs/plugins.ini" || echo 'cs_party.amxx' >> "$T/cstrike/addons/amxmodx/configs/plugins.ini"
[ -f "$SRC/cstrike/maps/de_dust2.nav" ] && cp_rel cstrike/maps/de_dust2.nav

# CS Party itself, from the repo
A=$T/cstrike/addons/amxmodx
mkdir -p "$A/plugins" "$A/configs/cs_party/boards" "$A/configs/cs_party/minigames" "$T/cstrike/maps" "$T/cstrike/models" "$T/cstrike/sprites"
cp "$REPO/build/cs_party.amxx" "$A/plugins/"
cp "$REPO"/boards/*.ini "$A/configs/cs_party/boards/"
cp "$REPO"/boards/*.nav "$T/cstrike/maps/"       # zBot nav for each board map (else the first load stalls minutes on nav analysis)
for m in csp_surf csp_bhop csp_climb csp_maze; do
  cp "$REPO/maps/$m.bsp" "$REPO/maps/$m.nav" "$T/cstrike/maps/"
  cp "$REPO/maps/$m.ini" "$A/configs/cs_party/minigames/"
done
cp "$REPO/assets/csp_dice.mdl" "$REPO/assets/csp_case.mdl" "$REPO/assets/csp_tile.mdl" "$T/cstrike/models/"
cp "$REPO/assets/csp_space.spr" "$REPO/assets/csp_face.spr" "$T/cstrike/sprites/"   # map overlay (tools/build_mapicons.py)
mkdir -p "$T/cstrike/sound/csp"; cp "$REPO"/assets/snd/cstrike/sound/csp/*.wav "$T/cstrike/sound/csp/"
cp "$REPO/server/motd.txt" "$REPO/server/server.cfg" "$T/cstrike/"

tar czf "$OUT" -C "$T" .
echo "$OUT: $(tar tzf "$OUT" | grep -vc '/$') files, $(du -h "$OUT" | cut -f1)"
