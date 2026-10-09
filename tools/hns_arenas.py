#!/usr/bin/env python3
"""Add Hide and Seek arenas to a board .ini: boxes (hns_arena) plus walkable spawn points from the nav mesh (hns_spawn).

usage: hns_arenas.py <cstrike dir> <boards dir> [map ...]
Re-run after board_compiler.py regenerates a board (it rewrites the whole .ini)."""
import math, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board_compiler as bc

# hand-picked boxes (x1 y1 x2 y2) per arena; maps not listed get tiles of the walkable area
MANUAL = {
    "de_dust2": {
        "B Site + Tunnels":  [(-2250, -200, -1450, 2000), (-2250, 1900, -1000, 3050)],
        "Mid + Catwalk":     [(-700, -700, -100, 1500), (-700, 1000, 500, 2000)],
        "A Long + A Site":   [(200, -100, 1600, 1500), (900, 1300, 1750, 2550)],
        "CT Spawn + B Door": [(-1000, 1950, 1100, 2600)],
        "T Spawn + Pit":     [(-1500, -1000, 500, -100)],
    },
}
TILE = 1500          # tile edge for generated arenas
MIN_WALK = 450000    # units^2 of nav area a tile needs
SPAWN_GAP = 112.0
SPAWN_MAX = 48
Z_BELOW, Z_ABOVE = 80.0, 260.0

def load_nodes(ini):
    out = []
    for l in open(ini):
        r = re.match(r'(\d+) (\S+) (\S+) (\S+) (\S+) \S+ "(.*)"', l)
        if r: out.append((float(r[3]), float(r[4]), r[6]))
    return out

def inside(b, x, y): return b[0] <= x <= b[2] and b[1] <= y <= b[3]

def tiles(areas, nodes):
    xs = [a.lo[0] for a in areas.values()] + [a.hi[0] for a in areas.values()]
    ys = [a.lo[1] for a in areas.values()] + [a.hi[1] for a in areas.values()]
    x0, y0 = min(xs), min(ys)
    cells = {}
    for a in areas.values():
        c = a.center(); k = (int((c[0] - x0) // TILE), int((c[1] - y0) // TILE))
        cells.setdefault(k, []).append(a)
    out = {}; used = {}
    for k, al in sorted(cells.items()):
        walk = sum((a.hi[0] - a.lo[0]) * (a.hi[1] - a.lo[1]) for a in al)
        if walk < MIN_WALK: continue
        # box = the tile, tightened to the nav areas in it
        bx = (min(a.lo[0] for a in al), min(a.lo[1] for a in al), max(a.hi[0] for a in al), max(a.hi[1] for a in al))
        labels = {}
        for nx, ny, lab in nodes:
            if inside(bx, nx, ny): labels[lab] = labels.get(lab, 0) + 1
        top = [l for l, _ in sorted(labels.items(), key=lambda t: -t[1])][:2]
        name = " + ".join(top) if top else "Open Ground"
        used[name] = used.get(name, 0) + 1
        if used[name] > 1: name += " " + "ABCDEFGH"[used[name] - 1]
        out[name] = [bx]
    return out

def build(cstrike, boards, m):
    nav = os.path.join(cstrike, "maps", m + ".nav"); ini = os.path.join(boards, m + ".ini")
    areas = bc.read_nav(nav); nodes = load_nodes(ini)
    arenas = MANUAL.get(m) or tiles(areas, nodes)
    lines = ["[hns]", "; Hide and Seek arenas (tools/hns_arenas.py): hns_arena \"name\" x1 y1 z1 x2 y2 z2 (several boxes = one arena), hns_spawn \"name\" x y z"]
    report = []
    for name, boxes in arenas.items():
        mine = [a for a in areas.values() if any(inside(b, *a.center()[:2]) for b in boxes)]
        if not mine: report.append(f"{name}: NO nav areas"); continue
        zs = [a.center()[2] for a in mine]
        zlo, zhi = min(zs) - Z_BELOW, max(zs) + Z_ABOVE
        for b in boxes:
            lines.append(f'hns_arena "{name}" {b[0]:.0f} {b[1]:.0f} {zlo:.0f} {b[2]:.0f} {b[3]:.0f} {zhi:.0f}')
        pts = []
        for a in mine:
            w, h = a.hi[0] - a.lo[0], a.hi[1] - a.lo[1]
            if w < 56 or h < 56: continue
            nx, ny = max(1, int(w // 128)), max(1, int(h // 128))
            for i in range(nx):
                for j in range(ny):
                    x = a.lo[0] + w * (i + 0.5) / nx; y = a.lo[1] + h * (j + 0.5) / ny
                    if any(inside(b, x, y) for b in boxes): pts.append((x, y, a.z_at(x, y)))
        # thin to a minimum spacing, then spread evenly down to SPAWN_MAX
        pts.sort(key=lambda p: (round(p[0] / 300), p[1]))
        keep = []
        for p in pts:
            if all(math.dist(p[:2], q[:2]) >= SPAWN_GAP or abs(p[2] - q[2]) > 80 for q in keep): keep.append(p)
        if len(keep) > SPAWN_MAX: keep = [keep[int(i * len(keep) / SPAWN_MAX)] for i in range(SPAWN_MAX)]
        for p in keep: lines.append(f'hns_spawn "{name}" {p[0]:.0f} {p[1]:.0f} {p[2]:.0f}')
        report.append(f"{name}: {len(boxes)} box(es), {len(mine)} nav areas, {len(keep)} spawns, z {zlo:.0f}..{zhi:.0f}")
    txt = open(ini).read()
    txt = txt.split("\n[hns]")[0].rstrip("\n") + "\n" + "\n".join(lines) + "\n"
    open(ini, "w").write(txt)
    print(m); [print("  " + r) for r in report]

if __name__ == "__main__":
    cs, boards = sys.argv[1], sys.argv[2]
    for m in (sys.argv[3:] or ["de_dust2", "de_inferno", "de_aztec", "de_cbble"]): build(cs, boards, m)
