#!/usr/bin/env bash
# Builds the CS Party browser client from source into web/public:
#   Xash3D FWGS engine (WebAssembly main module) + its filesystem/renderer/menu side modules,
#   cs16-client (Velaron) client + menu side modules, two empty stub modules, the open-source extras paks,
#   and fflate for unzipping game data in the page.
# Game data (Valve's content) is NOT built here: run pack_gamedata.py against an install you own.
#
# usage: web/build_web.sh [workdir]        (default workdir: /opt/src/csp-web; needs git, python3, node, ~6 GB disk)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-/opt/src/csp-web}
OUT=$HERE/public
PATCHES=$HERE/patches

EMSDK_VERSION=4.0.11
XASH_REPO=https://github.com/FWGS/xash3d-fwgs;   XASH_REV=1414fc281b6dc986378ea7ae35086c62d782a865
CS16_REPO=https://github.com/Velaron/cs16-client; CS16_REV=e30e27c3bd890f731ad7921d9c876d171aea4b32
SDL_REPO=https://github.com/libsdl-org/SDL;      SDL_TAG=release-2.32.0
JOBS=$(nproc)

mkdir -p "$WORK" "$OUT"
cd "$WORK"
step() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- toolchain
step "emsdk $EMSDK_VERSION (+ CS Party patch: dynCalls under MAIN_MODULE + ASYNCIFY)"
[ -d emsdk ] || git clone -q https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1
(cd emsdk/upstream/emscripten && { patch -p1 -N -s --dry-run < "$PATCHES/emscripten-$EMSDK_VERSION.patch" >/dev/null 2>&1 \
  && patch -p1 -N -s < "$PATCHES/emscripten-$EMSDK_VERSION.patch" || echo "   (already patched)"; })
# Emscripten's own ports fetch from the network at build time; we hand it a local SDL2 instead.
[ -d SDL ] || git clone -q --depth 1 -b "$SDL_TAG" "$SDL_REPO" SDL
export EMCC_LOCAL_PORTS="sdl2=$WORK/SDL"

# ---------------------------------------------------------------- engine
step "Xash3D FWGS @ ${XASH_REV:0:8}"
if [ ! -d xash3d-fwgs ]; then
  git clone -q "$XASH_REPO" xash3d-fwgs
  (cd xash3d-fwgs && git checkout -q "$XASH_REV" && git submodule update -q --init --recursive && git apply "$PATCHES/xash3d-fwgs.patch")
fi
(cd xash3d-fwgs \
  && EMCC_CFLAGS="-s USE_SDL=2 -fPIC" CC=emcc CXX=em++ AR=emar ./waf configure --emscripten -T release >/dev/null \
  && EMCC_CFLAGS="-s USE_SDL=2 -fPIC" ./waf build -j"$JOBS" >/dev/null)
B=xash3d-fwgs/build
cp $B/engine/xash "$OUT/xash.js"
cp $B/engine/xash.wasm $B/filesystem/filesystem_stdio.so $B/ref/gl/libref_gles3compat.so $B/3rdparty/mainui/libmenu.so "$OUT/"
cp $B/3rdparty/extras/extras.pk3 "$OUT/extras_engine.pk3"

# ---------------------------------------------------------------- cs16-client
step "cs16-client @ ${CS16_REV:0:8}"
if [ ! -d cs16-client ]; then
  git clone -q "$CS16_REPO" cs16-client
  (cd cs16-client && git checkout -q "$CS16_REV" && git submodule update -q --init --recursive && git apply "$PATCHES/cs16-client.patch")
fi
(cd cs16-client \
  && EMCC_CFLAGS="-fPIC" emcmake cmake -B build-web -DCMAKE_BUILD_TYPE=Release -DBUILD_SERVER=OFF -DBUILD_CLIENT=ON \
       -DBUILD_MAINUI=ON -DMAINUI_USE_STB=ON >/dev/null \
  && EMCC_CFLAGS="-fPIC" cmake --build build-web -j"$JOBS" >/dev/null)
# the Emscripten toolchain only emits static archives here; link each into a side module ourselves
em++ -sSIDE_MODULE=1 -O2 -o "$OUT/client_emscripten_wasm32.so" \
  -Wl,--whole-archive cs16-client/build-web/cl_dll/client_emscripten_wasm32.a -Wl,--no-whole-archive
em++ -sSIDE_MODULE=1 -O2 -o "$OUT/menu_emscripten_wasm32.so" \
  -Wl,--whole-archive cs16-client/build-web/3rdparty/mainui_cpp/menu_emscripten_wasm32.a -Wl,--no-whole-archive
# its extras.pk3 is mostly bot chatter and training maps; the browser needs the menu art and touch layouts
python3 - "$(find cs16-client/build-web -name extras.pk3 | head -1)" "$OUT/extras_cs16.pk3" <<'EOF'
import sys, zipfile
src = zipfile.ZipFile(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as out:
    for i in src.infolist():
        if i.filename.startswith(("gfx/", "touch/", "touch_default/", "touch_presets/")) or i.filename == "touch.cfg":
            out.writestr(i, src.read(i))
EOF

# ---------------------------------------------------------------- stubs
step "stub modules"
# browsers never host a game, and there is no VGUI1 here; the engine still dlopen()s these paths
echo 'int csp_server_stub;' > stub.c
emcc -sSIDE_MODULE=1 -O2 stub.c -o "$OUT/cs_emscripten_wasm32.so"
emcc -sSIDE_MODULE=1 -O2 stub.c -o "$OUT/vgui_stub.so"

# ---------------------------------------------------------------- page deps + relay deps
step "npm deps"
(cd "$HERE" && npm install --silent --no-audit --no-fund)
cp "$HERE/node_modules/fflate/umd/index.js" "$OUT/fflate.js"

step "done"
ls -la "$OUT" | awk 'NR > 1 { printf "  %10s  %s\n", $5, $9 }'
echo
echo "Next: python3 $HERE/pack_gamedata.py <your CS 1.6 dir> $OUT/gamedata.zip"
echo "      node $HERE/relay.js --port 8080 --game 127.0.0.1:27015 --root $OUT"
