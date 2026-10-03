---
title: CS Party (CS 1.6 x Mario Party): scope, builds, browser play
date: 2026-09-30
updated: 2026-10-01
tags: [gamedev, cs16, goldsrc, amxx, rehlds, party-game, webassembly, xash3d, docker, cs2, cs_script]
status: v0.3-browser-playable
---

# CS Party

Pitch: Mario Party structure, CS 1.6 everything. 4 seats, pick a player model as your character, board is a CS map, minigames are real CS rounds, star costs $5k. Server-side mod: join with stock CS 1.6 or from a browser tab.

## Status (2026-10-01): v0.3, playable from a browser
- Repo `cs-party`, commit 42317e3. Delivered as `cs-party-v0.3.tar.gz` (source) + `cs-party-v0.3-builds.tar.gz` (built browser client + server overlay).
- **Browser play works end to end.** Xash3D FWGS + cs16-client compiled to WebAssembly. A Node relay bridges each tab's WebSocket to UDP on ReHLDS. `tools/dev/web_e2e.py` passes 13/13: join, auto-seat, keyboard turn (menu "2", Space into the crate), de_dust2 → csp_surf → de_dust2 round trip with the seat kept. Passes on the dev server and on the Docker Compose stack.
- **Deployable on game-host:** `deploy/docker-compose.yml` (game server image = SteamCMD HLDS + open-source overlay; relay image), host networking. Expose only the relay's 8080 behind the reverse proxy (WebSocket upgrade on `/relay`). `PARTY_KEY` is required: invite link `https://host/?key=...`. `RCON_PASSWORD` + `tools/rcon.py csp_start` to run matches remotely.

## Decisions this round
- **Bonus awards:** hidden end-of-game awards flipped ~50% of winners. Now 2 of 6 are drawn at match start, announced, with live HUD leaders (Top Fragger, Max Money, Eco Round, Big Spender, Rusher, Bomb Squad). `csp_awards`: 0 off, 1 announced stars (default), 2 classic hidden three, 3 announced cash.
- **Map-change minigames:** Surf Race (`csp_surf`), Bhop Course (`csp_bhop`), generated as Valve 220 .map and compiled with SDHLT. Match state persists in JSON across changelevel. Human seats held 60 s. Hide and Seek runs on the board map.
- **"Browser" meant real CS Party in a tab** (not a separate web game). Valve content (gamedata.zip) is packed from the operator's own install and served only behind the party key.

## Browser build: what it took
- Emscripten 4.0.11 MAIN_MODULE + side modules, ASYNCIFY, WebGL2 (gles3compat renderer). Pinned upstream commits + 3 patches (`web/patches/`), one script (`web/build_web.sh`, ~5 min).
- Bugs that only showed up by running it:
  - ASYNCIFY forces legacy dynCalls on, but MAIN_MODULE never generates them. Every JS→wasm callback (keyboard, mouse, focus, audio) was a throwing stub, and the first keypress killed the tab. Patched Emscripten's makeDynCall/dynCallLegacy to use the function table.
  - cs16-client draws CS team/class panels as menu-DLL dialogs that keep the keyboard after the server has placed you. The plugin now supersedes those panels when auto-join is on.
  - Missing Xash `extras.pk3` → console/menu text drawn as atlas shards.
  - Memory: 354 MB of untraced game data, copied twice into MEMFS → 3+ GB tab. Fixed with a traced manifest (strace of a native client across all three maps), WADs sliced per map (dust2 uses 8 of 3,116 halflife.wad textures), and canOwn writes. Now 44 MB download / 75 MB in memory. Precached-but-unseen models (hostages, gibs) were added after the first join downloaded 417 KB over the game channel. Join went from 37–63 s to 11 s.
  - `-O2` link: wasm 12 → 6.6 MB.
- Plugin bugs found via the browser: ReGameDLL's game.cfg sets `mp_timelimit 20` after server.cfg (the server rotated maps mid-party; the plugin owns it now). Ring redraws "0.03 s apart" were really ~45 beams per frame (AMXX timer floor 0.1 s) and overflowed slow clients' 4 KB datagrams.

## Known limits
- Under headless software GL (~5 fps) a map-change reconnect occasionally stalls ~1 min (1 in ~15 runs). If it happens, the race starts with a bot in the seat. Real GPUs (60+ fps) shouldn't hit it. Watch for it on game night.
- ReAPI warns "ReHLDS API minor version mismatch (expected 15, real 10)". Pre-existing and harmless here: the plugin only uses ReGameDLL hooks.
- Mobile: cs16-client touch layouts ship but aren't wired up.
- Leader handicap (skill 9 vs three 5s wins ~60%) still not addressed.

## Earlier design notes (still true)
- Turn: buy gear (real 1.6 buy menu, board money) → use board items (Knife Out, Bhop Script, Rigged Crate, Fake Call, Smoke, C4, Rotate, Hostage Intel) → jump into the crate over your head.
- Board generated from the zBot nav mesh (A* legs + shortcut). 42 spaces on dust2 with Black Markets, Campers, Armories, Duels, VIP Escort, Negotiator.
- Broadcast director camera; spectators locked to the active player.
- Dice crate: original olive supply crate (the first draft read as Nintendo's ? Block).

## Engine question: CS2 cs_script
cs_script has a scripted camera, clickable Panorama HUD, OnPlayerJump, money/items. It's experimental, Windows-only tooling, and can't be tested in the sandbox. Decision stands: 1.6 to a real game night first, then rebuild on cs_script as the public version. Rules, economy, items, camera shots and crate design carry over.

## Next
1. **Game night on game-host:** `docker compose up`, 4 humans (browser and/or native), no bots. The real test is pacing (turn length, minigame frequency) plus the reconnect stall on real hardware.
2. Leader handicap.
3. More boards (any map with a .nav) and more map-change minigames (kz, OpenHNS-style hns).
4. Mobile touch controls (the layouts already ship).
5. CS2 cs_script rebuild.

