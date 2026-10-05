#!/usr/bin/env python3
"""Generates CS Party's own minigame maps as Valve 220 .map files and compiles them with SDHLT.

  csp_surf  V-shaped surf ramps in two stages, fall = back to stage start, finish platform
  csp_bhop  caution-striped blocks over lava, gaps grow, checkpoints, finish platform
  csp_climb ascending course over a pit: step jumps, a ladder wall, narrow beams, big steps, checkpoints
  csp_maze  a seeded 12x12 maze between a start lobby and a finish room, walls too tall to jump
  csp_surf_<theme>  surf pack: dust, aztec, snow, night, storm, space (see SURF_PACK)

Textures come only from stock CS WADs (every CS client has them); tool textures (sky, trigger)
are embedded from sdhlt.wad. Also writes <map>.ini with start/finish/checkpoint boxes for the plugin.

usage: gen_minigame_maps.py <sdhlt_tools_dir> <cstrike_dir> <outdir> [map ...]   (default: all)
"""
import math, os, random, subprocess, sys

# Fill light for the race maps: playtesters found faces turned away from the sun (and climb's platform
# undersides) nearly black. A brighter sky dome plus a small hlrad ambient floor lifts them to ~80/255
# while sunlit faces stay ~2.5x brighter, so the sun direction still reads.
FILL_RAD = ["-ambient", "0.08", "0.08", "0.09"]

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
    def __init__(self, name, sky="desert", wads=()):   # rad: extra sdHLRAD args; wads: stock WADs beyond cstrike.wad
        self.name, self.world, self.ents, self.rad, self.sky, self.wads = name, [], [], [], sky, list(wads)
    def solid(self, b): self.world.append(b)
    def ent(self, cls, brushes=None, **kv): self.ents.append((cls, kv, brushes or []))
    def text(self, wads):
        out = ['{', '"classname" "worldspawn"', '"mapversion" "220"', f'"wad" "{";".join(wads)}"', f'"skyname" "{self.sky}"',
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

# ---- surf pack (ISSUE): themed variants built from one stage list -----------------------------------
# Every course runs along +x (race_place lines racers up facing +x; "furthest at the time limit" is the
# largest x). A stage is one ramp run: "v" = two ramps with a gap between (csp_surf's shape), "l" / "r" = one
# ramp on the left (+y) / right (-y) side. After each stage a landing platform, which is also the ledge you
# drop off into the next stage. Fall anywhere = back to the start of the stage you fell from.
SURF_THEMES = {
    #  name     sky        extra wads         ramp               floor              trim (edges, finish)  light colour
    "dust":   ("desert",   ["cs_dust.wad"],   "csSandWall2",     "SandRoad",        "SandTrim",        "255 226 180"),
    "aztec":  ("grnplsnt", ["de_aztec.wad"],  "-0AzMoss",        "AzGrnd",          "AzTrim",          "230 255 220"),
    "snow":   ("snow",     ["cs_office.wad"], "snow",            "snow_rockcliff4", "CSTRIKE_ME7CAUT", "220 235 255"),
    "night":  ("night",    [],                "CSTRIKE_WR4CCPN", "CSTRIKE_FT4APHT", "CSTRIKE_ME7CAUT", "190 200 255"),
    "storm":  ("de_storm", ["de_storm.wad"],  "WDPLANKS256D",    "DRKCRETE",        "MATT_STNWALL",    "210 220 230"),
    "space":  ("space",    [],                "CSTRIKE_ME4RADR", "CSTRIKE_ME1GRAT", "CSTRIKE_ME7CAUT", "200 220 255"),
}

def build_surf_course(name, theme, stages, title, sun=(-55, 135, 240)):
    """stages: list of (kind, length, drop, centre_y[, rise, width]). rise/width default 300/260 (49 deg, like
    csp_surf); a face is only surfable (not walkable) above ~45.6 deg, so keep rise/width > 1.03."""
    sky, wads, RAMP, FLOOR, TRIM, lcol = SURF_THEMES[theme]
    m = Map(name, sky=sky, wads=wads)
    GAP, PLAT, START, FIN = 48, 288, 400, 1000          # the finish pad is long: you leave the last ramp fast
    total = START + sum(st[1] + 16 + PLAT for st in stages[:-1]) + stages[-1][1] + 16 + FIN
    x = -total // 2                                     # centre the course on x = 0
    def span(st):                                       # y extent of a stage's ramps
        kind, c, w = st[0], st[3], (st[5] if len(st) > 5 else 260)
        return {"v": (c - GAP - w, c + GAP + w), "l": (c, c + w), "r": (c - w, c)}[kind]
    def ramps(kind, x0, x1, c, zt, rise, w, drop):
        if kind in ("v", "l"):
            o = GAP if kind == "v" else 0
            m.solid(ramp(x0, x1, c + o, c + o + w, zt - rise, zt, drop, RAMP))
        if kind in ("v", "r"):
            o = GAP if kind == "v" else 0
            m.solid(ramp(x0, x1, c - o, c - o - w, zt - rise, zt, drop, RAMP))
    zone_cp, lights, lo_y, hi_y, route = [], [], 1e9, -1e9, []   # route: per stage, for scripted test runs
    # start ledge
    y0, y1 = span(stages[0]); y0, y1 = min(y0, -260), max(y1, 260)
    z = 3200; zt = z - 64
    m.solid(box((x, y0, z - 32), (x + START, y1, z), FLOOR, TRIM))
    c0 = stages[0][3]
    spawns(m, x + 120, c0 - 50, z + 40)
    zone_start = ((x, y0, z), (x + START, y1, z + 228))
    m.ent("info_teleport_destination", targetname="stage1", origin=f"{x + 120} {c0} {z + 40}", angles="0 0 0")
    lights.append((x + START // 2, c0, z + 200)); lo_y, hi_y = min(lo_y, y0), max(hi_y, y1)
    x += START; zmin = z
    for i, st in enumerate(stages):
        kind, L, drop, c = st[:4]; rise = st[4] if len(st) > 4 else 300; w = st[5] if len(st) > 5 else 260
        x0, x1 = x, x + L
        ramps(kind, x0, x1, c, zt, rise, w, drop)
        side = "r" if kind == "r" else "l"
        route.append({"x0": x0, "x1": x1, "side": side, "y": c + (GAP if kind == "v" else 0) * (1 if side == "l" else -1) + (w * 0.5 if side == "l" else -w * 0.5)})
        inner_end = zt - rise - drop
        last = i == len(stages) - 1
        pz = inner_end - (96 if last else 48)           # landing top: below the lowest ramp edge, so you fly onto it
        px0, px1 = x1 + 16, x1 + 16 + (FIN if last else PLAT)
        a, b = span(st)
        if not last: a2, b2 = span(stages[i + 1]); a, b = min(a, a2), max(b, b2)
        if last: a, b = min(a, c - 300), max(b, c + 300)
        m.solid(box((px0, a, pz - 32), (px1, b, pz), FLOOR, TRIM if last else None))
        lo_y, hi_y = min(lo_y, a), max(hi_y, b)
        # fall catcher under the stage and its landing platform: back to this stage's start
        ya, yb = span(st)
        teleport_zone(m, (x0 - (START if i == 0 else PLAT), min(ya, a) - 400, -3900), (px1, max(yb, b) + 400, pz - 64), f"stage{i + 1}")
        lights.append((px0 + 140, (a + b) // 2, pz + 180))
        zmin = min(zmin, pz)
        route[-1].update(px0=px0, px1=px1, pz=pz)
        if last:
            # a gate, not a floor: flying over the pad counts. A back wall catches anyone who'd fly past it.
            top = zt - drop + 300
            zone_finish = ((px0, a, pz), (px1, b, top))
            m.solid(box((px1, a - 32, pz - 32), (px1 + 32, b + 32, top + 200), TRIM))
            for yy in (a + 24, b - 24):                 # finish posts at the gate
                m.solid(box((px0, yy - 24, pz), (px0 + 48, yy + 24, top), TRIM))
        else:
            nc = stages[i + 1][3]
            m.ent("info_teleport_destination", targetname=f"stage{i + 2}", origin=f"{px0 + 80} {nc} {pz + 40}", angles="0 0 0")
            zone_cp.append(((px0, a, pz), (px1, b, pz + 228)))
            zt = pz - 64; x = px1
    xa, xb = -total // 2, -total // 2 + total + 32
    assert -3950 < xa and xb < 3950 and -3950 < zmin - 900, (name, xa, xb, zmin)
    shell(m, (xa - 64, lo_y - 600, -3968), (xb + 64, hi_y + 600, 3700))
    sp, sy, sl = sun
    m.ent("light_environment", origin="0 0 3500", pitch=str(sp), angles=f"0 {sy} 0", _light=f"{lcol} {sl}", _diffuse_light="160 170 200 70")
    for lx, ly, lz in lights: m.ent("light", origin=f"{lx} {ly} {lz}", _light=f"{lcol} 230")
    m.rad = FILL_RAD
    zones = {"start": zone_start, "finish": zone_finish, "checkpoints": zone_cp, "pool": "surf", "name": title, "route": route}
    return m, zones

SURF_PACK = {
    # gentle start: three V runs, one dogleg
    "csp_surf_dust":  ("dust",  [("v", 1500, 300, 0), ("v", 1700, 400, 320), ("v", 1800, 500, 0)], "Surf: Dust"),
    # one-sided ramps: left, right, then a V to finish
    "csp_surf_aztec": ("aztec", [("l", 1600, 350, -130), ("r", 1700, 400, 130), ("v", 1800, 500, 0)], "Surf: Aztec"),
    # four short runs that step sideways
    "csp_surf_snow":  ("snow",  [("v", 1250, 300, 0), ("v", 1300, 350, 280), ("v", 1350, 400, -280), ("v", 1400, 450, 0)], "Surf: Snow"),
    # long middle run on the left wall, wider ramps
    "csp_surf_night": ("night", [("v", 1500, 350, 0, 300, 300), ("l", 2000, 550, -150, 300, 300), ("v", 1800, 550, 0, 300, 300)], "Surf: Night"),
    # zig-zag: every run starts on the other side
    "csp_surf_storm": ("storm", [("v", 1300, 300, -300), ("v", 1300, 350, 300), ("v", 1350, 400, -300), ("v", 1400, 450, 300)], "Surf: Storm"),
    # steep and fast (56 deg), big drops
    "csp_surf_space": ("space", [("v", 1700, 550, 0, 360, 240), ("v", 1900, 650, 220, 360, 240), ("v", 2000, 750, 0, 360, 240)], "Surf: Space"),
}
for _n, (_t, _st, _title) in SURF_PACK.items():
    globals()["build_" + _n] = (lambda n=_n, t=_t, st=_st, ti=_title: build_surf_course(n, t, st, ti))

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
    m.ent("light_environment", origin="0 0 700", pitch="-60", angles="0 45 0", _light="255 236 210 240", _diffuse_light="160 170 200 150")
    m.rad = FILL_RAD
    zones = {"start": ((-2950, -200, 0), (-2600, 200, 200)), "finish": ((finish_x, -220, 0), (finish_x + 360, 220, 200)),
             "checkpoints": [((c[1], -160, 0), (c[2], 160, 200)) for c in cps]}
    return m, zones

def build_climb():
    m = Map("csp_climb")
    shell(m, (-3200, -700, -700), (3200, 700, 1500))
    WALL, CAUT, FLOOR, BEAM = "CSTRIKE_WR7PLN", "CSTRIKE_ME7CAUT", "CSTRIKE_FP2DARK", "CSTRIKE_CJ2BEAM"
    m.solid(box((-3150, -200, -32), (-2800, 200, 0), FLOOR))
    spawns(m, -3000, -40, 40)
    m.ent("info_teleport_destination", targetname="cp0", origin="-3000 0 40", angles="0 0 0")
    cps = []
    def checkpoint(x, z):
        m.solid(box((x, -192, z - 32), (x + 256, 192, z), FLOOR))
        name = f"cp{len(cps) + 1}"
        m.ent("info_teleport_destination", targetname=name, origin=f"{x + 128} 0 {z + 40}", angles="0 0 0")
        cps.append((name, x, x + 256, z)); return x + 256
    # 1: step jumps, each block higher than the last (rise 24 -> 36), y wanders
    x, z = -2800, 0
    for i, (gap, rise) in enumerate([(64, 24), (72, 24), (80, 28), (80, 28), (88, 32), (88, 32), (96, 32), (96, 36)]):
        x += gap; z += rise; y = int(110 * math.sin(i * 1.1))
        m.solid(box((x, y - 56, z - 32), (x + 112, y + 56, z), CAUT)); x += 112
    x = checkpoint(x + 80, z + 24); z += 24
    # 2: ladder wall up 320 units onto a ledge
    m.solid(box((x, -96, z - 32), (x + 64, 96, z), FLOOR))                    # foot of the ladder
    wall_x = x + 64
    m.solid(box((wall_x, -256, z), (wall_x + 64, 256, z + 320), WALL))
    m.ent("func_ladder", [box((wall_x - 12, -40, z), (wall_x, 40, z + 336), "AAATRIGGER")])
    m.ent("func_illusionary", [box((wall_x - 4, -40, z), (wall_x - 2, 40, z + 320), "{CSTRIKE_LE6LAD")],
          rendermode="4", renderamt="255")
    x, z = wall_x + 64, z + 320
    m.solid(box((wall_x, -256, z - 32), (x + 128, 256, z), FLOOR)); x += 128   # ledge on top of the wall
    # 3: narrow beams, zig-zag, each a little higher, small pads between
    y = 0
    for i in range(4):
        y2 = 160 if i % 2 == 0 else -160
        z += 16
        m.solid(box((x, y - 12, z - 16), (x + 288, y + 12, z), BEAM))
        x += 288
        m.solid(box((x, min(y, y2) - 48, z - 32), (x + 96, max(y, y2) + 48, z), CAUT))
        y = y2; x += 96
    x = checkpoint(x + 64, z + 16); z += 16
    # 4: big steps, rise 40, longer gaps, wide y swings
    for i, gap in enumerate([80, 88, 96, 96, 104, 104]):
        x += gap; z += 40; y = int(110 * math.sin(i * 1.4 + 0.5))
        m.solid(box((x, y - 52, z - 32), (x + 104, y + 52, z), CAUT)); x += 104
    finish_x = x + 96
    m.solid(box((finish_x, -220, z - 8), (finish_x + 320, 220, z + 24), WALL, CAUT)); fz = z + 24
    # pit: fall = back to the last checkpoint passed
    edges = [-3150] + [c[1] for c in cps] + [finish_x + 400]
    dests = ["cp0"] + [c[0] for c in cps]
    for k in range(len(dests)):
        teleport_zone(m, (edges[k], -680, -680), (edges[k + 1], 680, -400), dests[k])
    m.solid(box((-3150, -680, -700), (finish_x + 400, 680, -680), "CSTRIKE_FT2MUD"))
    m.solid(box((-3150, -700, -700), (finish_x + 400, -680, 1400), WALL))
    m.solid(box((-3150, 680, -700), (finish_x + 400, 700, 1400), WALL))
    m.ent("light_environment", origin="0 0 1300", pitch="-60", angles="0 45 0", _light="255 236 210 240", _diffuse_light="160 170 200 150")
    # cool fill from the pit so the undersides of the platforms aren't black
    for px in range(-2800, finish_x + 1, 800): m.ent("light", origin=f"{px} 0 -380", _light="200 210 255 250")
    m.rad = FILL_RAD
    zones = {"start": ((-3150, -200, 0), (-2800, 200, 200)), "finish": ((finish_x, -220, fz), (finish_x + 320, 220, fz + 200)),
             "checkpoints": [((c[1], -192, c[3]), (c[2], 192, c[3] + 200)) for c in cps]}
    return m, zones

# Maze Run variants (ISSUE). name -> build_maze kwargs. csp_maze is the original and stays byte-identical.
MAZE_THEMES = {
    "brick":    dict(wall="CSTRIKE_WR4CCPN", floor="CSTRIKE_FT4APHT", sky="desert"),
    "concrete": dict(wall="CSTRIKE_WR7PLN",  floor="CSTRIKE_FP2MED",  sky="cliff"),
    "metal":    dict(wall="CSTRIKE_ME4METL", floor="CSTRIKE_FP2LGHT", sky="city"),
    "hedge":    dict(wall="CSTRIKE_MJ3SHRU", floor="CSTRIKE_FT3GRAS", sky="morning"),
    "rust":     dict(wall="CSTRIKE_ME2RSTW", floor="CSTRIKE_FT2DIRT", sky="dusk"),
    "night":    dict(wall="CSTRIKE_WR4CCVT", floor="CSTRIKE_FP2DARK", sky="night"),
}
# seeds picked by a search: shortest route >= 28 s and a left-hand wall follower ~85 s at 250 u/s
MAZE_VARIANTS = {
    "csp_maze":         dict(),
    "csp_maze_brick8":  dict(n=8,  cell=256, seed=35,   theme="brick", loops=0),
    "csp_maze_conc10":  dict(n=10, cell=192, seed=36,   theme="concrete", loops=2),
    "csp_maze_hedge":   dict(n=12, cell=160, seed=147,  theme="hedge", loops=3),
    "csp_maze_metal14": dict(n=14, cell=144, seed=12,   theme="metal", loops=3),
    "csp_maze_rust16":  dict(n=16, cell=128, seed=67,   theme="rust", loops=4),
    "csp_maze_dark10":  dict(n=10, cell=192, seed=1075, theme="night", dark=True, loops=2),
    "csp_maze_dark14":  dict(n=14, cell=144, seed=2006, theme="night", dark=True, loops=3),
}

def maze_carve(n, rng, loops):
    """Depth-first carve. east[cx][cy] / north[cx][cy]: wall present on that side of the cell."""
    east = [[True] * n for _ in range(n)]; north = [[True] * n for _ in range(n)]
    seen = [[False] * n for _ in range(n)]; stack = [(0, 0)]; seen[0][0] = True
    while stack:
        cx, cy = stack[-1]
        opts = [(dx, dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                if 0 <= cx + dx < n and 0 <= cy + dy < n and not seen[cx + dx][cy + dy]]
        if not opts: stack.pop(); continue
        dx, dy = rng.choice(opts); nx, ny = cx + dx, cy + dy
        if dx == 1: east[cx][cy] = False
        elif dx == -1: east[nx][ny] = False
        elif dy == 1: north[cx][cy] = False
        else: north[nx][ny] = False
        seen[nx][ny] = True; stack.append((nx, ny))
    for _ in range(loops):   # a few extra openings so there's more than one way through
        cx, cy = rng.randrange(n - 1), rng.randrange(n - 1)
        if rng.random() < 0.5: east[cx][cy] = False
        else: north[cx][cy] = False
    return east, north

def maze_open(n, east, north, cx, cy, dx, dy):
    if dx == 1: return cx < n - 1 and not east[cx][cy]
    if dx == -1: return cx > 0 and not east[cx - 1][cy]
    if dy == 1: return cy < n - 1 and not north[cx][cy]
    return cy > 0 and not north[cx][cy - 1]

def maze_metrics(n, east, north):
    """Cells walked entrance (0,0) to exit (n-1,n-1): shortest route, a left-hand wall follower, and the route itself.
    Someone exploring without a map lands between the two."""
    from collections import deque
    D = ((1, 0), (0, 1), (-1, 0), (0, -1))
    dist = {(0, 0): 0}; q = deque([(0, 0)]); prev = {}
    while q:
        c = q.popleft()
        for dx, dy in D:
            if maze_open(n, east, north, c[0], c[1], dx, dy):
                nb = (c[0] + dx, c[1] + dy)
                if nb not in dist: dist[nb] = dist[c] + 1; prev[nb] = c; q.append(nb)
    path = [(n - 1, n - 1)]
    while path[-1] != (0, 0): path.append(prev[path[-1]])
    path.reverse()
    x, y, h, steps = 0, 0, 0, 0     # entered heading east
    while (x, y) != (n - 1, n - 1) and steps < 40 * n * n:
        for t in (1, 0, -1, 2):     # left, straight, right, back
            nh = (h + t) % 4; dx, dy = D[nh]
            if maze_open(n, east, north, x, y, dx, dy): h = nh; x += dx; y += dy; steps += 1; break
    return dist[(n - 1, n - 1)], steps, path

def build_maze(name="csp_maze", n=12, cell=160, seed=3867, theme="brick", dark=False, loops=None):
    m = Map(name)
    th = MAZE_THEMES[theme]
    W, H, T = n * cell, 192, 16          # walls 192 high: no jumping over them, not even crouch-jumping
    lobby, room = 448, 448
    shell(m, (-lobby - 64, -64, -64), (W + room + 64, W + 64, 400))
    WALL, FLOOR, CAUT = th["wall"], th["floor"], "CSTRIKE_ME7CAUT"
    m.sky = th["sky"]
    m.solid(box((-lobby, 0, -32), (W + room, W, 0), FLOOR))
    rng = random.Random(seed)
    east, north = maze_carve(n, rng, n if loops is None else loops)
    def wall(x0, y0, x1, y1): m.solid(box((x0, y0, 0), (x1, y1, H), WALL))
    # outer walls, with the entrance (west of cell 0,0) and exit (east of cell n-1,n-1) left open
    wall(-T, cell, 0, W + T)                                   # west, gap at row 0
    wall(W, -T, W + T, W - cell)                               # east, gap at row n-1
    wall(-lobby - 16, -T, W + room + 16, 0); wall(-lobby - 16, W, W + room + 16, W + T)   # south, north (lobby and finish room too)
    for cx in range(n):
        for cy in range(n):
            x, y = cx * cell, cy * cell
            if cx < n - 1 and east[cx][cy]: wall(x + cell - T // 2, y - T // 2, x + cell + T // 2, y + cell + T // 2)
            if cy < n - 1 and north[cx][cy]: wall(x - T // 2, y + cell - T // 2, x + cell + T // 2, y + cell + T // 2)
    # lobby and finish room walls (rooms span the full maze height, closed except where they meet the maze)
    m.solid(box((-lobby - 16, 0, 0), (-lobby, W, H), WALL))
    m.solid(box((W + room, 0, 0), (W + room + 16, W, H), WALL))
    m.solid(box((W + 64, W - cell - 192, -2), (W + room - 64, W - 64, 0), CAUT))   # finish pad marking
    spawns(m, -lobby // 2, cell // 2, 40)
    if not dark:
        m.ent("light_environment", origin="0 0 300", pitch="-70", angles="0 30 0", _light="255 236 210 230", _diffuse_light="160 170 200 160")
        m.rad = FILL_RAD
    else:
        # night: a dim moon, no ambient floor; a warm lamp every third cell and bright lobby and finish rooms.
        # Players carry a flashlight (F) for the dark stretches.
        m.ent("light_environment", origin="0 0 300", pitch="-60", angles="0 30 0", _light="90 110 170 40", _diffuse_light="60 70 120 30")
        for lx in (-lobby // 2, W + room // 2): m.ent("light", origin=f"{lx} {W // 2} 160", _light="255 220 170 300")
        for cx in range(1, n, 3):
            for cy in range(1, n, 3):
                m.ent("light", origin=f"{cx * cell + cell // 2} {cy * cell + cell // 2} 150", _light="255 200 130 110")
        m.rad = ["-ambient", "0.01", "0.01", "0.02"]
    zones = {"start": ((-lobby, 0, 0), (0, W, 200)), "finish": ((W + 64, W - cell - 192, 0), (W + room - 64, W - 64, 200)),
             "checkpoints": []}
    if name != "csp_maze":   # the original keeps its .ini; variants carry their pool and start spots (the plugin's pool format)
        # bottime (ISSUE): bots finish between the shortest route (~40 s) and the wall follower (~88 s)
        zones.update(pool="maze", progress="x", bottime=(50, 100), spawns=[(-70 - (k // 2) * 60, 50 + (k % 2) * 60, 40, 0) for k in range(8)])
    zones["metrics"] = maze_metrics(n, east, north)
    zones["cell"] = cell
    return m, zones

def write_zones(path, zones):
    def fmt(b): return " ".join(f"{v:g}" for p in b for v in p)
    with open(path, "w") as f:
        f.write(f"; CS Party minigame zones (generated){': ' + zones['name'] if zones.get('name') else ''}\n")
        f.write(f"start {fmt(zones['start'])}\nfinish {fmt(zones['finish'])}\n")
        for c in zones["checkpoints"]: f.write(f"checkpoint {fmt(c)}\n")
        if zones.get("pool"): f.write(f"pool {zones['pool']}\nprogress {zones.get('progress', 'x')}\n")
        if zones.get("bottime"): f.write("bottime %g %g\n" % zones["bottime"])
        for sp in zones.get("spawns", []): f.write("spawn " + " ".join(f"{v:g}" for v in sp) + "\n")

def write_nav_stub(bsp, start, path):
    """One-area zBot nav over the start zone. Bots on race maps only stand at the start (they finish on a clock),
    and a nav file stops ReGameDLL from running a full nav analysis every time the map loads."""
    import struct
    (x0, y0, z0), (x1, y1, _) = start
    b = struct.pack("<IIIHI", 0xFEEDFACE, 5, os.path.getsize(bsp), 0, 1)
    b += struct.pack("<IB6f2f", 1, 0, x0, y0, z0, x1, y1, z0, z0, z0)
    b += struct.pack("<4IBBIH", 0, 0, 0, 0, 0, 0, 0, 0)
    open(path, "wb").write(b)

def compile_map(tools, cstrike, outdir, name, rad=()):
    mp = os.path.abspath(os.path.join(outdir, name + ".map"))
    cs_wad = os.path.join(cstrike, "cstrike.wad"); tool_wad = os.path.join(tools, "sdhlt.wad")
    # embed only the tool textures (sky, trigger); cstrike.wad art stays on the player's machine
    steps = [["sdHLCSG", "-wadinclude", "sdhlt.wad"], ["sdHLBSP"], ["sdHLVIS", "-fast"], ["sdHLRAD", "-fast", "-bounce", "2", *rad]]
    for s in steps:
        r = subprocess.run([os.path.join(tools, s[0])] + s[1:] + [mp], cwd=outdir, capture_output=True, text=True)
        log = r.stdout + r.stderr
        if r.returncode != 0 or "Error" in log and "Warning" not in log:
            print(f"--- {s[0]} rc={r.returncode}\n" + log[-2500:]); return False
    return os.path.exists(os.path.join(outdir, name + ".bsp"))

if __name__ == "__main__":
    tools, cstrike, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    builders = {"csp_surf": build_surf, "csp_bhop": build_bhop, "csp_climb": build_climb}
    builders.update({n: globals()["build_" + n] for n in SURF_PACK})
    for _n, _kw in MAZE_VARIANTS.items(): builders[_n] = (lambda n=_n, kw=_kw: build_maze(n, **kw))
    for name in sys.argv[4:] or list(builders):
        m, zones = builders[name]()
        wads = [os.path.join(cstrike, w) for w in ["cstrike.wad"] + m.wads] + [os.path.join(tools, "sdhlt.wad")]
        open(os.path.join(outdir, m.name + ".map"), "w").write(m.text(wads))
        write_zones(os.path.join(outdir, m.name + ".ini"), zones)
        ok = compile_map(tools, cstrike, outdir, m.name, m.rad)
        if ok: write_nav_stub(os.path.join(outdir, m.name + ".bsp"), zones["start"], os.path.join(outdir, m.name + ".nav"))
        print(m.name, "compiled" if ok else "FAILED")
        if "metrics" in zones:
            sp, fol, _ = zones["metrics"]; c = zones["cell"]
            print(f"  {m.name}: shortest {sp} cells ({sp * c / 250:.0f}s), wall-follower {fol} cells ({fol * c / 250:.0f}s) at 250 u/s")
