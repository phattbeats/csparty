#!/usr/bin/env bash
# PHA-4004 spike: builds the CS Party game server for WebAssembly:
#   Xash3D FWGS dedicated server (main module, no ASYNCIFY, frames driven by JS via CSP_HostFrame)
#   + ReGameDLL_CS from cs16-client (Velaron's Xash-compatible fork, 5.30) as a side module.
# Same toolchain and engine revision as the browser client (web/build_web.sh), plus the patches in ./patches.
#
# usage: spike/p2p/build.sh [workdir]   (default /opt/src/csp-p2p; needs git, python3, node, cmake, ninja, ~5 GB)
# out:   <workdir>/out/{xash_server.js, xash.wasm, filesystem_stdio.so, cs_emscripten_wasm32.so}
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WEB=$(cd "$HERE/../../web" && pwd)
WORK=${1:-/opt/src/csp-p2p}
OUT=$WORK/out
EMSDK_VERSION=4.0.11
XASH_REV=1414fc281b6dc986378ea7ae35086c62d782a865
CS16_REV=e30e27c3bd890f731ad7921d9c876d171aea4b32
JOBS=$(nproc)
mkdir -p "$WORK" "$OUT"; cd "$WORK"
step() { printf '\n== %s\n' "$*"; }

step "emsdk $EMSDK_VERSION"
[ -d emsdk ] || git clone -q https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1
(cd emsdk/upstream/emscripten && git apply --check "$WEB/patches/emscripten-$EMSDK_VERSION.patch" 2>/dev/null \
  && git apply "$WEB/patches/emscripten-$EMSDK_VERSION.patch" || echo "   (already patched)")

step "Xash3D FWGS dedicated server @ ${XASH_REV:0:8}"
if [ ! -d xash3d-fwgs ]; then
  git clone -q https://github.com/FWGS/xash3d-fwgs xash3d-fwgs
  (cd xash3d-fwgs && git checkout -q "$XASH_REV" && git submodule update -q --init --recursive \
    && git apply "$WEB/patches/xash3d-fwgs.patch" && git apply "$HERE/patches/xash3d-fwgs-server.patch")
fi
(cd xash3d-fwgs \
  && EMCC_CFLAGS="-fPIC" CC=emcc CXX=em++ AR=emar ./waf configure --emscripten --dedicated -T release -o build-ded >/dev/null \
  && EMCC_CFLAGS="-fPIC" ./waf build -j"$JOBS" >/dev/null)
cp xash3d-fwgs/build-ded/engine/xash "$OUT/xash_server.js"
cp xash3d-fwgs/build-ded/engine/xash.wasm xash3d-fwgs/build-ded/filesystem/filesystem_stdio.so "$OUT/"

step "ReGameDLL_CS (cs16-client @ ${CS16_REV:0:8}, BUILD_SERVER)"
if [ ! -d cs16-client ]; then
  git clone -q https://github.com/Velaron/cs16-client cs16-client
  (cd cs16-client && git checkout -q "$CS16_REV" && git submodule update -q --init --recursive \
    && git apply "$HERE/patches/cs16-client-server.patch")
fi
(cd cs16-client \
  && EMCC_CFLAGS="-fPIC" emcmake cmake -B build-srv -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SERVER=ON -DBUILD_CLIENT=OFF -DBUILD_MAINUI=OFF >/dev/null \
  && EMCC_CFLAGS="-fPIC" cmake --build build-srv -j"$JOBS" >/dev/null)
# the toolchain only emits a static archive; link it into a side module ourselves (as web/build_web.sh does)
em++ -sSIDE_MODULE=1 -O2 -o "$OUT/cs_emscripten_wasm32.so" \
  -Wl,--whole-archive cs16-client/build-srv/3rdparty/ReGameDLL_CS/regamedll/cs_emscripten_wasm32.a -Wl,--no-whole-archive

step "done"
ls -la "$OUT" | awk 'NR > 1 { printf "  %10s  %s\n", $5, $9 }'
echo
echo "Game dir: valve/ + cstrike/ from web/pack_gamedata.py output, with cstrike/dlls/cs_emscripten_wasm32.so and"
echo "cstrike/liblist.gam gamedll_linux \"dlls/cs.so\". Run: node $HERE/node_host.mjs --out $OUT --game <dir>"
