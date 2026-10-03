#!/usr/bin/env python3
"""Generates CS Party's own minigame maps as Valve 220 .map files and compiles them with SDHLT.

  csp_surf  V-shaped surf ramps in two stages, fall = back to stage start, finish platform
  csp_bhop  caution-striped blocks over lava, gaps grow, checkpoints, finish platform

Textures come only from cstrike.wad (every CS client has it); tool textures (sky, trigger)
are embedded from sdhlt.wad. Also writes <map>.ini with start/finish/checkpoint boxes for the plugin.

usage: gen_minigame_maps.py <sdhlt_tools_dir> <cstrike_dir> <outdir>
"""
import math, os, subprocess, sys

def sub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def dot(a, b): return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]

def tex_axes(n):
    ax, ay, az = abs(n[0]), abs(n[1]), abs(n[2])
    if az >= ax and az >= ay: return (1, 0, 0), (0, -1, 0)
    if ax >= ay: return (0, 1, 0), (0, 0, -1)
    return (1, 0, 0), (0, 0, -1)

class Brush:
    """Convex brush from vertices + faces (lists of vertex indices, any winding)."""
    def __init__(self, verts, faces, tex, face_tex=None):
        self.v, self.f, self.tex, self.face_tex = verts, faces, tex, face_tex or {}
    def text(self):
        c = tuple(sum(p[k] for p in self.v) / len(self.v) for k in range(3))
        out = ["{"]
        for fi, face in enumerate(self.f):
            p0, p1, p2 = (self.v[i] for i in face[:3])
            # qbsp: normal = (p0 - p1) x (p2 - p1); make it point away from the brush center
            n = cross(sub(p0, p1), sub(p2, p1))
            if dot(n, sub(p1, c)) < 0: p0, p2 = p2, p0; n = (-n[0], -n[1], -n[2])
            u, v = tex_axes(n)
            t = self.face_tex.get(fi, self.tex)
            out.append(f"( {p0[0]:g} {p0[1]:g} {p0[2]:g} ) ( {p1[0]:g} {p1[1]:g} {p1[2]:g} ) ( {p2[0]:g} {p2[1]:g} {p2[2]:g} ) "
                       f"{t} [ {u[0]} {u[1]} {u[2]} 0 ] [ {v[0]} {v[1]} {v[2]} 0 ] 0 1 1")
        out.append("}")
        return "\n".join(out)

def box(lo, hi, tex, top=None):
    x0, y0, z0 = lo; x1, y1, z1 = hi
    v = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    f = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]]
    return Brush(v, f, tex, {1: top} if top else None)

def ramp(x0, x1, inner_y, outer_y, z_bot0, z_top0, drop, tex):
    """Surf ramp: triangle cross-section (low inner edge, high outer edge) swept along x, descending by `drop`."""
    v = []
    for x, dz in ((x0, 0), (x1, -drop)):
        v += [(x, inner_y, z_bot0 + dz), (x, outer_y, z_bot0 + dz), (x, outer_y, z_top0 + dz)]
    f = [[0,1,2],[3,4,5],[0,1,4,3],[1,2,5,4],[2,0,3,5]]
    return Brush(v, f, tex)

class Map:
    def __init__(self, name): self.name, self.world, self.ents = name, [], []
    def solid(self, b): self.world.append(b)
    def ent(self, cls, brushes=None, **kv): self.ents.append((cls, kv, brushes or []))
    def text(self, wads):
        out = ['{', '"classname" "worldspawn"', '"mapversion" "220"', f'"wad" "{";".join(wads)}"', '"skyname" "desert"',
               '"message" "CS Party minigame (original map, generated)"']
        out += [b.text() for b in self.world] + ['}']
        for cls, kv, brushes in self.ents:
            out.append('{'); out.append(f'"classname" "{cls}"')
            out += [f'"{k}" "{v}"' for k, v in kv.items()]
            out += [b.text() for b in brushes]; out.append('}')
        return "\n".join(out) + "\n"

def shell(m, lo, hi, t=16):
    """Hollow sky box around everything (keeps the map sealed and lit by the sun)."""
    x0, y0, z0 = lo; x1, y1, z1 = hi
    for b in [((x0-t,y0-t,z0-t),(x1+t,y1+t,z0)), ((x0-t,y0-t,z1),(x1+t,y1+t,z1+t)),
              ((x0-t,y0-t,z0),(x0,y1+t,z1)), ((x1,y0-t,z0),(x1+t,y1+t,z1)),
              ((x0,y0-t,z0),(x1,y0,z1)), ((x0,y1,z0),(x1,y1+t,z1))]:
        m.solid(box(b[0], b[1], "sky"))

def spawns(m, x, y, z, yaw=0):
    for i in range(4):
        dx, dy = (i % 2) * 48 - 24, (i // 2) * 48 - 24
        m.ent("info_player_start", origin=f"{x+dx} {y+dy} {z}", angles=f"0 {yaw} 0")
        m.ent("info_player_deathmatch", origin=f"{x+dx} {y+dy+100} {z}", angles=f"0 {yaw} 0")

def teleport_zone(m, lo, hi, dest_name):
    m.ent("trigger_teleport", [box(lo, hi, "AAATRIGGER")], target=dest_name)

def build_surf():
    m = Map("csp_surf")
    shell(m, (-2600, -1100, -1400), (2600, 1100, 1200))
    MET, WALL, CAUT = "CSTRIKE_ME4METL", "CSTRIKE_WR7PLN", "CSTRIKE_ME7CAUT"
    # start ledge
    m.solid(box((-2500, -260, 640), (-2150, 260, 672), WALL, CAUT))
    spawns(m, -2380, -40, 710)
    m.ent("info_teleport_destination", targetname="stage1", origin="-2380 0 710", angles="0 0 0")
    # stage 1: V ramps, inner edges 48u apart, 300u rise over 260u (49 deg), descending 300 over the run
    for side in (-1, 1):
        m.solid(ramp(-2150, -350, side * 48, side * 308, 220, 520, 300, MET))
    teleport_zone(m, (-2150, -48, -200), (-350, 48, 140), "stage1")
    # mid platform
    m.solid(box((-340, -260, -120), (-80, 260, -96), WALL, CAUT))
    m.ent("info_teleport_destination", targetname="stage2", origin="-220 0 -50", angles="0 0 0")
    # stage 2: longer, steeper drop
    for side in (-1, 1):
        m.solid(ramp(-60, 1900, side * 48, side * 308, -400, -100, 500, MET))
    teleport_zone(m, (-60, -48, -1350), (1900, 48, -480), "stage2")
    # catch floor under everything that isn't a ramp: fall = back to last stage start
    teleport_zone(m, (-2580, -1080, -1390), (-80, 1080, -1300), "stage1")
    teleport_zone(m, (-80, -1080, -1390), (2580, 1080, -1300), "stage2")
    # finish
    m.solid(box((1950, -300, -1000), (2500, 300, -968), WALL, CAUT))
    m.ent("light_environment", origin="0 0 1000", pitch="-55", angles="0 135 0", _light="255 236 210 260", _diffuse_light="160 170 200 60")
    for x in (-2300, -200, 2200):
        m.ent("light", origin=f"{x} 0 {-900 if x > 0 else 760 if x < -1000 else 40}", _light="255 230 190 220")
    zones = {"start": ((-2500, -260, 672), (-2150, 260, 900)), "finish": ((1950, -300, -968), (2500, 300, -700)),
             "checkpoints": [((-340, -260, -96), (-80, 260, 100))]}
    return m, zones

def build_bhop():
    m = Map("csp_bhop")
    shell(m, (-3000, -500, -600), (3000, 500, 800))
    WALL, CAUT, FLOOR = "CSTRIKE_WR7PLN", "CSTRIKE_ME7CAUT", "CSTRIKE_FP2DARK"
    m.solid(box((-2950, -200, -32), (-2600, 200, 0), FLOOR))
    spawns(m, -2800, -40, 40)
    m.ent("info_teleport_destination", targetname="cp0", origin="-2800 0 40", angles="0 0 0")
    # blocks: gaps grow from easy (96) to speed-only (176). y wanders so you have to steer.
    x, cps, i = -2600, [], 0
    gaps = [96, 96, 112, 112, 128, 128, 112, 144, 144, 128, 160, 160, 144, 176, 176, 160]
    for g in gaps:
        x += g
        y = int(90 * math.sin(i * 0.9))
        m.solid(box((x, y - 40, -32), (x + 80, y + 40, 0), CAUT))
        x += 80; i += 1
        if i in (6, 12):   # checkpoint pads
            x += 96
            m.solid(box((x, -160, -32), (x + 256, 160, 0), FLOOR))
            name = f"cp{len(cps) + 1}"
            m.ent("info_teleport_destination", targetname=name, origin=f"{x + 128} 0 40", angles="0 0 0")
            cps.append((name, x, x + 256))
            x += 256
    finish_x = x + 140
    m.solid(box((finish_x, -220, -32), (finish_x + 360, 220, 0), WALL, CAUT))
    # lava: teleport back to the last checkpoint passed
    edges = [-2600] + [c[1] for c in cps] + [finish_x]
    dests = ["cp0"] + [c[0] for c in cps]
    for k in range(len(dests)):
        teleport_zone(m, (edges[k], -480, -560), (edges[k + 1], 480, -300), dests[k])
    m.solid(box((-2600, -480, -600), (finish_x, 480, -560), "CSTRIKE_FT2MUD"))
    # side walls so the corridor reads as a course
    m.solid(box((-2950, -500, -600), (finish_x + 400, -480, 300), WALL))
    m.solid(box((-2950, 480, -600), (finish_x + 400, 500, 300), WALL))
    m.ent("light_environment", origin="0 0 700", pitch="-60", angles="0 45 0", _light="255 236 210 240", _diffuse_light="160 170 200 60")
    zones = {"start": ((-2950, -200, 0), (-2600, 200, 200)), "finish": ((finish_x, -220, 0), (finish_x + 360, 220, 200)),
             "checkpoints": [((c[1], -160, 0), (c[2], 160, 200)) for c in cps]}
    return m, zones

def write_zones(path, zones):
    def fmt(b): return " ".join(f"{v:g}" for p in b for v in p)
    with open(path, "w") as f:
        f.write("; CS Party minigame zones (generated)\n")
        f.write(f"start {fmt(zones['start'])}\nfinish {fmt(zones['finish'])}\n")
        for c in zones["checkpoints"]: f.write(f"checkpoint {fmt(c)}\n")

def compile_map(tools, cstrike, outdir, name):
    mp = os.path.abspath(os.path.join(outdir, name + ".map"))
    cs_wad = os.path.join(cstrike, "cstrike.wad"); tool_wad = os.path.join(tools, "sdhlt.wad")
    # embed only the tool textures (sky, trigger); cstrike.wad art stays on the player's machine
    steps = [["sdHLCSG", "-wadinclude", "sdhlt.wad"], ["sdHLBSP"], ["sdHLVIS", "-fast"], ["sdHLRAD", "-fast", "-bounce", "2"]]
    for s in steps:
        r = subprocess.run([os.path.join(tools, s[0])] + s[1:] + [mp], cwd=outdir, capture_output=True, text=True)
        log = r.stdout + r.stderr
        if r.returncode != 0 or "Error" in log and "Warning" not in log:
            print(f"--- {s[0]} rc={r.returncode}\n" + log[-2500:]); return False
    return os.path.exists(os.path.join(outdir, name + ".bsp"))

if __name__ == "__main__":
    tools, cstrike, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    wads = [os.path.join(cstrike, "cstrike.wad"), os.path.join(tools, "sdhlt.wad")]
    for build in (build_surf, build_bhop):
        m, zones = build()
        open(os.path.join(outdir, m.name + ".map"), "w").write(m.text(wads))
        write_zones(os.path.join(outdir, m.name + ".ini"), zones)
        ok = compile_map(tools, cstrike, outdir, m.name)
        print(m.name, "compiled" if ok else "FAILED")
