#!/usr/bin/env python3
"""Adds an ambient light floor to the indoor surfaces of a compiled GoldSrc map (BSP v30), in place of a
hlrad -ambient recompile for maps we have no .map source for (csp_towers = Murray's "The Two Towers").

Only the lighting lump's bytes change: geometry, entities and every lump offset stay identical, so the
.nav and the plugin's spots still fit. (Clients still compare the whole file: ship the same BSP in the
server image and in gamedata.zip.)

"Indoor" = can't see the sky. Each lit face is sampled on a coarse texel grid; from every sample a set of
rays goes out over the face's hemisphere through the BSP leaves, and the share that reaches a sky leaf is
its sky view. Texels with no sky view get the full floor, texels that see more than --sky-max of the sky
get none (outdoors and the window sills keep their original light), and the weight is interpolated over
the face between samples so no seams appear. The floor is added in quadrature per channel
(new = sqrt(old^2 + floor^2)): black becomes the floor, sunlit texels barely move. The floor's colour is
--tint mixed (--hue) with the texel's own light colour, so rooms lit by coloured lamps keep their cast.

The sky-view pass takes a minute or two; --cache keeps it for re-runs with other --floor/--tint values.

usage: relight_bsp.py in.bsp out.bsp [--floor 24] [--tint 1.0,0.8,0.66] [--hue 0.5] [--sky-max 0.06]
                      [--step 3] [--rays 48] [--cache file.json]
"""
import argparse, json, math, os, struct, sys

CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER, CONTENTS_SKY = -1, -2, -3, -6

class BSP:
    def __init__(self, path):
        self.d = d = bytearray(open(path, "rb").read())
        if struct.unpack_from("<i", d, 0)[0] != 30: sys.exit("not a BSP v30 file")
        self.lumps = [struct.unpack_from("<ii", d, 4 + 8 * i) for i in range(15)]
        def rows(i, fmt):
            o, l = self.lumps[i]; n = struct.calcsize(fmt)
            return [struct.unpack_from(fmt, d, o + k * n) for k in range(l // n)]
        self.planes = rows(1, "<4fi")
        self.verts = rows(3, "<3f")
        self.nodes = rows(5, "<i2h6h2H")
        self.texinfo = rows(6, "<8f2i")
        self.faces = rows(7, "<HhiHH4Bi")
        self.leafs = rows(10, "<2i6h2H4B")
        self.edges = rows(12, "<2H")
        o, l = self.lumps[13]; self.surfedges = struct.unpack_from("<%di" % (l // 4), d, o)
        self.models = rows(14, "<9f7i")
        self.miptex = self.texture_names()
        self.head = self.models[0][9]

    def texture_names(self):
        o, l = self.lumps[2]
        n = struct.unpack_from("<i", self.d, o)[0]
        offs = struct.unpack_from("<%di" % n, self.d, o + 4)
        return [bytes(self.d[o + x:o + x + 16]).split(b"\0")[0].decode("latin1").lower() if x >= 0 else "" for x in offs]

    def face_verts(self, f):
        fe, ne = self.faces[f][2], self.faces[f][3]
        out = []
        for k in range(fe, fe + ne):
            e = self.surfedges[k]
            out.append(self.verts[self.edges[e][0]] if e >= 0 else self.verts[self.edges[-e][1]])
        return out

    def face_lightmap(self, f):
        """(texmins, lightmap w, h) the way the engine computes them"""
        ti = self.texinfo[self.faces[f][4]]
        mins, maxs = [1e30, 1e30], [-1e30, -1e30]
        for v in self.face_verts(f):
            for j in range(2):
                val = v[0] * ti[4 * j] + v[1] * ti[4 * j + 1] + v[2] * ti[4 * j + 2] + ti[4 * j + 3]
                mins[j] = min(mins[j], val); maxs[j] = max(maxs[j], val)
        bmin = [math.floor(mins[j] / 16) for j in range(2)]; bmax = [math.ceil(maxs[j] / 16) for j in range(2)]
        return [bmin[j] * 16 for j in range(2)], bmax[0] - bmin[0] + 1, bmax[1] - bmin[1] + 1

    def first_hit(self, node, a, b):
        """contents of the first non-empty leaf on the segment a->b (CONTENTS_EMPTY if it gets through)"""
        while node >= 0:
            pn, c0, c1 = self.nodes[node][0], self.nodes[node][1], self.nodes[node][2]
            nx, ny, nz, dist, _ = self.planes[pn]
            fa = a[0] * nx + a[1] * ny + a[2] * nz - dist
            fb = b[0] * nx + b[1] * ny + b[2] * nz - dist
            if fa >= 0 and fb >= 0: node = c0; continue
            if fa < 0 and fb < 0: node = c1; continue
            frac = fa / (fa - fb)
            mid = (a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac)
            near, far = (c0, c1) if fa >= 0 else (c1, c0)
            r = self.first_hit(near, a, mid)
            if r not in (CONTENTS_EMPTY, CONTENTS_WATER): return r
            return self.first_hit(far, mid, b)
        return self.leafs[-node - 1][0]

def hemisphere(n):
    """n directions spread evenly over the +z hemisphere (Fibonacci spiral), cosine-ish weighted"""
    out, g = [], math.pi * (3 - math.sqrt(5))
    for i in range(n):
        z = 1 - (i + 0.5) / n                 # uniform in z = uniform solid angle
        r = math.sqrt(max(0.0, 1 - z * z))
        out.append((math.cos(g * i) * r, math.sin(g * i) * r, z))
    return out

def basis(nrm):
    a = (0, 0, 1) if abs(nrm[2]) < 0.9 else (1, 0, 0)
    u = (a[1] * nrm[2] - a[2] * nrm[1], a[2] * nrm[0] - a[0] * nrm[2], a[0] * nrm[1] - a[1] * nrm[0])
    l = math.sqrt(sum(x * x for x in u)); u = tuple(x / l for x in u)
    v = (nrm[1] * u[2] - nrm[2] * u[1], nrm[2] * u[0] - nrm[0] * u[2], nrm[0] * u[1] - nrm[1] * u[0])
    return u, v

def solve3(m, r):
    """3x3 linear solve (Cramer)"""
    def det(a): return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                        + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    D = det(m)
    if abs(D) < 1e-9: return None
    out = []
    for c in range(3):
        mc = [list(row) for row in m]
        for k in range(3): mc[k][c] = r[k]
        out.append(det(mc) / D)
    return out

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("inp"); ap.add_argument("out")
    ap.add_argument("--floor", type=float, default=24.0, help="light floor (0-255) for surfaces with no sky view")
    ap.add_argument("--tint", default="1.0,0.8,0.66", help="floor colour multipliers r,g,b (warm, like the dusk)")
    ap.add_argument("--hue", type=float, default=0.5, help="0 = floor in --tint, 1 = in the texel's own light colour")
    ap.add_argument("--cache", help="json file for the sky-view weights (written if missing, read if present)")
    ap.add_argument("--sky-max", type=float, default=0.06, help="sky view share at which the floor fades out")
    ap.add_argument("--step", type=int, default=3, help="sample every Nth texel (interpolated between)")
    ap.add_argument("--rays", type=int, default=48)
    ap.add_argument("--reach", type=float, default=6000.0, help="ray length")
    a = ap.parse_args()
    tint = [float(x) for x in a.tint.split(",")]
    b = BSP(a.inp)
    dirs = hemisphere(a.rays)
    cache = json.load(open(a.cache)) if a.cache and os.path.exists(a.cache) else None
    newcache = {}
    lo, ll = b.lumps[8]
    changed = faces_lit = 0
    stats = {"indoor": 0, "partial": 0, "outdoor": 0}
    for f in range(len(b.faces)):   # brush entities too: they sit where they were compiled (no moving ones here)
        pn, side, fe, ne, tix, s0, s1, s2, s3, lofs = b.faces[f]
        if lofs < 0 or s0 == 255: continue
        ti = b.texinfo[tix]
        name = b.miptex[ti[8]] if 0 <= ti[8] < len(b.miptex) else ""
        if name.startswith("sky") or (ti[9] & 1): continue
        nx, ny, nz, dist, _ = b.planes[pn]
        if side: nx, ny, nz, dist = -nx, -ny, -nz, -dist
        nrm = (nx, ny, nz)
        (m0, m1), w, h = b.face_lightmap(f)
        faces_lit += 1
        if cache is not None:
            ws = cache.get(str(f), [0.0] * (w * h))
        else:
            ws = sky_weights(b, a, f, nrm, dist, ti, m0, m1, w, h, dirs)
            newcache[str(f)] = [round(x, 3) for x in ws]
        kind = "indoor" if min(ws) > 0.99 else ("outdoor" if max(ws) < 0.01 else "partial")
        stats[kind] += 1
        if max(ws) <= 0: continue
        base = lo + lofs
        for i, wt in enumerate(ws):
            if wt <= 0: continue
            px = [b.d[base + i * 3 + c] for c in range(3)]
            top = max(px)
            own = [x / top for x in px] if top >= 6 else tint
            for c in range(3):
                fl = a.floor * wt * (tint[c] * (1 - a.hue) + own[c] * a.hue)
                new = min(255, int(round(math.sqrt(px[c] * px[c] + fl * fl))))
                if new != px[c]: b.d[base + i * 3 + c] = new; changed += 1
    if a.cache and cache is None: json.dump(newcache, open(a.cache, "w"))
    open(a.out, "wb").write(b.d)
    print(f"{a.out}: {faces_lit} lit faces ({stats['indoor']} indoor, {stats['partial']} partly, {stats['outdoor']} outdoor); "
          f"{changed} lightmap bytes raised of {ll}")

def sky_weights(b, a, f, nrm, dist, ti, m0, m1, w, h, dirs):
    """per-texel floor weight for face f: 1 = sees no sky, 0 = sees at least --sky-max of it"""
    u, v = basis(nrm)
    world_dirs = [tuple(d[0] * u[k] + d[1] * v[k] + d[2] * nrm[k] for k in range(3)) for d in dirs]
    M = [ti[0:3], ti[4:7], nrm]
    # sky view on a coarse grid (always including the last row/column)
    gs = sorted(set(list(range(0, w, a.step)) + [w - 1])); gt = sorted(set(list(range(0, h, a.step)) + [h - 1]))
    poly = b.face_verts(f)
    cx = [sum(p[k] for p in poly) / len(poly) for k in range(3)]
    grid = {}
    for t in gt:
        for s in gs:
            p = solve3(M, (m0 + s * 16 - ti[3], m1 + t * 16 - ti[7], dist))
            if p is None: p = cx
            # pull samples that fall off the face (lightmap corners) toward the face centre, and lift
            # them off the surface so the rays don't start inside the wall
            start = None
            for pull in (0.0, 0.25, 0.5, 0.75, 1.0):
                q = tuple(p[k] + (cx[k] - p[k]) * pull + nrm[k] * 2.0 for k in range(3))
                if b.first_hit(b.head, q, q) in (CONTENTS_EMPTY, CONTENTS_WATER): start = q; break
            if start is None: grid[(s, t)] = 1.0; continue
            sky = 0
            for d in world_dirs:
                end = (start[0] + d[0] * a.reach, start[1] + d[1] * a.reach, start[2] + d[2] * a.reach)
                if b.first_hit(b.head, start, end) == CONTENTS_SKY: sky += 1
            grid[(s, t)] = sky / len(world_dirs)
    def weight(s, t):
        # bilinear over the coarse grid
        i = max(k for k in range(len(gs)) if gs[k] <= s); j = max(k for k in range(len(gt)) if gt[k] <= t)
        s0_, s1_ = gs[i], gs[min(i + 1, len(gs) - 1)]; t0_, t1_ = gt[j], gt[min(j + 1, len(gt) - 1)]
        fs = (s - s0_) / (s1_ - s0_) if s1_ > s0_ else 0.0; ft = (t - t0_) / (t1_ - t0_) if t1_ > t0_ else 0.0
        sky = (grid[(s0_, t0_)] * (1 - fs) * (1 - ft) + grid[(s1_, t0_)] * fs * (1 - ft)
               + grid[(s0_, t1_)] * (1 - fs) * ft + grid[(s1_, t1_)] * fs * ft)
        return max(0.0, 1.0 - sky / a.sky_max)
    return [weight(s, t) for t in range(h) for s in range(w)]

if __name__ == "__main__":
    main()
