# Archive

Working copies from before CS Party had a repo (#3926, 2026-10-03). Each heartbeat worked in
its own copy, so fixes forked. The repo root holds the merged, live tree; this directory keeps
the pieces it was built from.

## forks/ (from `/paperclip/workspace/vision-quest`)

| dir | issue | what |
| --- | --- | --- |
| ISSUEm, ISSUEn | #3865 | 3-way merge inputs/outputs for the game-night plugin merges |
| ISSUE | #3867 | older plugin sources and builds (`.pre-*`, `.0.5.5-vq`), board previews |
| ISSUE | #3897 | Two Towers: plugin versions, join-state fix, map (+ original bsp), tests, shots |
| ISSUE | #3898 | character picker: plugin/web before and after, `p.diff`, e2e tests, shots |
| ISSUE | #3912 | theme song + board music: merge bases, live/new web snapshots, board audio candidates, tests |

Left out: ReHLDS/Valve game data, AMX Mod X dist, i386 libs, zig, pip libs, chromium libs,
SteamCMD, `gamedata.zip`, wasm/pk3 build outputs, and `theme.wav` (master is on Nextcloud
`cloud/csparty`). #3924 (map overlay) was still in flight and is on the
`ISSUE-map-overlay` branch instead.

## host/ (from game-host `/srv/cs-party`)

- `patch*/`: one-layer Docker builds used for each live deploy. `patch05x` are server images
  (`ov/` is the overlay copied into `/hlds/`), `patch-relayN` are relay images.
- `csparty-up.sh.pre-*`: earlier copies of the deploy script (current one: `deploy/csparty-up.sh`).
- `src-versions/`: versioned backups (`.v0.4`, `.pre-ISSUE`, ...) from the host's `src/cs-party`.

Not copied: `.env` (secrets), `gamedata*.zip`, `stage/` (Valve game data), `build-tools/`.
