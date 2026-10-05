#!/usr/bin/env python3
"""Builds the Maze Run variants (ISSUE) for the race map pool.

  build_maze_pack.py <sdhlt_tools_dir> <game_dir with cstrike/ and valve/> [--out build/racemaps] [map ...]

For each variant in gen_minigame_maps.MAZE_VARIANTS (except the original csp_maze): generate + compile the .bsp,
run race_map.py build (server files + browser pack, phone budget), then write the bot nav stub against the .bsp that
build produced (it rewrites the worldspawn wad key, and a .nav records the .bsp's size). Zone .inis go to maps/pool/.
"""
import os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import gen_minigame_maps as g

args = sys.argv[1:]
out = os.path.join(REPO, "build", "racemaps")
if "--out" in args: i = args.index("--out"); out = os.path.abspath(args[i + 1]); del args[i:i + 2]
tools, game, names = os.path.abspath(args[0]), os.path.abspath(args[1]), args[2:] or [n for n in g.MAZE_VARIANTS if n != "csp_maze"]
wads = [os.path.join(game, "cstrike", "cstrike.wad"), os.path.join(tools, "sdhlt.wad")]
tmp = tempfile.mkdtemp(prefix="mazepack")
for name in names:
    m, zones = g.build_maze(name, **g.MAZE_VARIANTS[name])
    open(os.path.join(tmp, name + ".map"), "w").write(m.text(wads))
    g.write_zones(os.path.join(tmp, name + ".ini"), zones)
    if not g.compile_map(tools, game + "/cstrike", tmp, name, m.rad): sys.exit(f"{name}: compile failed")
    bsp = os.path.join(tmp, name + ".bsp"); g.write_nav_stub(bsp, zones["start"], os.path.join(tmp, name + ".nav"))
    subprocess.run([sys.executable, os.path.join(HERE, "race_map.py"), "build", bsp, "--game", game, "--nav", os.path.join(tmp, name + ".nav"),
                    "--out", out, "--force"], check=True)
    built = os.path.join(out, "server", "cstrike", "maps", name)
    g.write_nav_stub(built + ".bsp", zones["start"], built + ".nav")
    os.makedirs(os.path.join(REPO, "maps", "pool"), exist_ok=True)
    shutil.copy(os.path.join(tmp, name + ".ini"), os.path.join(REPO, "maps", "pool", name + ".ini"))
    shutil.copy(os.path.join(tmp, name + ".map"), os.path.join(REPO, "maps", "pool", name + ".map"))
    sp, fol, path = zones["metrics"]; c = zones["cell"]; n = max(x for x, _ in path) + 1; W = n * c
    # the solution as waypoints for tools/dev/csp_mazewalk.sma (a test helper that walks the first human to the finish)
    wp = [(-150, 80), (-30, c // 2)] + [(x * c + c // 2, y * c + c // 2) for x, y in path] + [(W + 40, W - c // 2), (W + 256, W - c // 2)]
    os.makedirs(os.path.join(out, "walk"), exist_ok=True)
    open(os.path.join(out, "walk", name + ".walk"), "w").write("".join(f"{x} {y}\n" for x, y in wp))
    print(f"{name}: shortest {sp * c / 250 + 4:.0f} s, wall-follower {fol * c / 250 + 4:.0f} s at 250 u/s")
shutil.rmtree(tmp)
