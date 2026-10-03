#!/usr/bin/env python3
"""Builds the CS Party board tile: models/csp_tile.mdl.

A flat hexagonal tile that sits on the floor of every board space. One skin per space type,
in the plugin's NT_* order: a solid color with a bold label, so a space reads at a glance from
the director camera. Textures are flagged fullbright (Xash3D STUDIO_NF_FULLBRIGHT) so map
lighting can't darken or wash them out; beams and glow sprites are additive and went pale on
dust2's sand.

The label's "up" is the model's +x: the plugin turns each tile to face along the path.
Compiled with Valve's studiomdl (tools/dev/README-studiomdl.md).

usage: build_tiles.py <studiomdl> <outdir> <bold.ttf>
"""
import math, os, struct, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

S = 256
R = 44.0            # hex radius: covers the four pawn spots (14 units off center) with room to spare
H = 2.0             # thickness
# (label, fill, label color) in NT_* order: BLUE, RED, EVENT, SITE, START, SHOP, CAMPER, ARMORY, VIP, DUEL, NEGOT
TYPES = [
    ("+$",    (40, 110, 235),  (255, 255, 255)),
    ("-$",    (215, 40, 40),   (255, 255, 255)),
    ("?",     (240, 200, 40),  (40, 30, 10)),
    ("C4",    (245, 140, 30),  (40, 20, 5)),
    ("GO",    (240, 240, 235), (30, 30, 30)),
    ("SHOP",  (60, 175, 75),   (255, 255, 255)),
    ("AWP",   (110, 10, 10),   (255, 220, 200)),
    ("ARMOR", (95, 110, 130),  (255, 255, 255)),   # slate: teal read as the green SHOP (2026-10-03 review)
    ("VIP",   (250, 245, 225), (150, 110, 20)),
    ("1v1",   (140, 80, 220),  (255, 255, 255)),
    ("DEAL",  (240, 90, 170),  (255, 255, 255)),
]
STUDIO_NF_FULLBRIGHT = 0x0004

def hex_pts(cx, cy, rad):
    return [(cx + rad * math.cos(math.radians(60 * k)), cy + rad * math.sin(math.radians(60 * k))) for k in range(6)]

def tile_texture(label, fill, ink, font_path, path):
    img = Image.new("RGB", (S, S), tuple(int(c * 0.45) for c in fill))      # dark: the rim and the sides use it
    d = ImageDraw.Draw(img)
    c = S / 2
    d.polygon(hex_pts(c, c, S / 2 - 2), fill=tuple(int(c * 0.45) for c in fill))
    d.polygon(hex_pts(c, c, S / 2 - 14), fill=fill)
    d.polygon(hex_pts(c, c, S / 2 - 22), outline=tuple(min(255, int(v * 1.25) + 20) for v in fill), width=3)
    size = 124                                   # largest that fits inside the inner hexagon
    while True:
        font = ImageFont.truetype(font_path, size)
        bb = d.textbbox((0, 0), label, font=font)
        if bb[2] - bb[0] <= S * 0.56 or size <= 30: break
        size -= 4
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    x, y = c - w / 2 - bb[0], c - h / 2 - bb[1]
    d.text((x + 3, y + 4), label, font=font, fill=tuple(int(v * 0.35) for v in fill))   # drop shadow
    d.text((x, y), label, font=font, fill=ink)
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(path)

def tile_smd(path, tex):
    # top-face UV: image up (v=1) is model +x, image right (u=1) is model -y
    def uv_top(x, y): return (0.5 - y / (2 * R) * (S / 2 - 2) / (S / 2), 0.5 + x / (2 * R) * (S / 2 - 2) / (S / 2))
    rim = (0.5, 0.02)                     # a point in the dark rim, for the side walls and the bottom
    pts = [(R * math.cos(math.radians(60 * k)), R * math.sin(math.radians(60 * k))) for k in range(6)]
    lines = ["version 1", "nodes", '  0 "tile" -1', "end", "skeleton", "time 0", "  0 0 0 0 0 0 0", "end", "triangles"]
    def vtx(p, n, uv): return f"0 {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} {n[0]:.4f} {n[1]:.4f} {n[2]:.4f} {uv[0]:.4f} {uv[1]:.4f}"
    def tri(a, b, c, n, uva, uvb, uvc):
        for order in ((a, uva, b, uvb, c, uvc), (a, uva, c, uvc, b, uvb)):   # double-sided
            lines.append(tex)
            for i in range(0, 6, 2): lines.append(vtx(order[i], n, order[i + 1]))
    top, bot = (0.0, 0.0, H), (0.0, 0.0, 0.0)
    for k in range(6):
        p0, p1 = pts[k], pts[(k + 1) % 6]
        a, b = (p0[0], p0[1], H), (p1[0], p1[1], H)
        tri(top, a, b, (0, 0, 1), uv_top(0, 0), uv_top(*p0), uv_top(*p1))
        a0, b0 = (p0[0], p0[1], 0.0), (p1[0], p1[1], 0.0)
        mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2; l = math.hypot(mx, my); n = (mx / l, my / l, 0.0)
        tri(a0, b0, b, n, rim, rim, rim); tri(a0, b, a, n, rim, rim, rim)
        tri(bot, b0, a0, (0, 0, -1), rim, rim, rim)
    lines.append("end")
    open(path, "w").write("\n".join(lines) + "\n")

def anim_smd(path):
    open(path, "w").write('version 1\nnodes\n  0 "tile" -1\nend\nskeleton\ntime 0\n  0 0 0 0 0 0 0\nend\n')

def flag_fullbright(mdl):
    data = bytearray(open(mdl, "rb").read())
    # studiohdr_t: ... numtextures @180, textureindex @184; mstudiotexture_t = name[64], flags, width, height, index
    numtex, texindex = struct.unpack_from("<ii", data, 180)
    if not 0 < numtex < 64: sys.exit(f"unexpected texture count {numtex}: header layout wrong?")
    for i in range(numtex):
        off = texindex + i * 80 + 64
        flags, = struct.unpack_from("<i", data, off)
        struct.pack_into("<i", data, off, flags | STUDIO_NF_FULLBRIGHT)
    open(mdl, "wb").write(data)
    return numtex

if __name__ == "__main__":
    studiomdl, outdir, font = sys.argv[1], sys.argv[2], sys.argv[3]
    work = os.path.join(outdir, "tile_src"); os.makedirs(work, exist_ok=True)
    names = []
    for i, (label, fill, ink) in enumerate(TYPES):
        nm = f"tile{i:02d}.bmp"; tile_texture(label, fill, ink, font, os.path.join(work, nm)); names.append(nm)
    tile_smd(os.path.join(work, "tile_ref.smd"), names[0])
    anim_smd(os.path.join(work, "idle.smd"))
    qc = '$modelname "csp_tile.mdl"\n$cd "."\n$cdtexture "."\n$scale 1.0\n$body "studio" "tile_ref"\n' \
         '$texturegroup skins\n{\n' + "\n".join('{ "%s" }' % n for n in names) + '\n}\n$sequence idle "idle" fps 1 loop\n'
    open(os.path.join(work, "tile.qc"), "w").write(qc)
    r = subprocess.run([os.path.abspath(studiomdl), "tile.qc"], cwd=work, capture_output=True, text=True)
    print(r.stdout[-600:], r.stderr[-400:])
    mdl = os.path.join(work, "csp_tile.mdl")
    if not os.path.exists(mdl): sys.exit("studiomdl failed")
    print("fullbright textures:", flag_fullbright(mdl))
    os.replace(mdl, os.path.join(outdir, "csp_tile.mdl"))
    sheet = Image.new("RGB", (S * 6 // 2, S * 2 // 2), (18, 20, 17))
    for i, nm in enumerate(names):
        sheet.paste(Image.open(os.path.join(work, nm)).convert("RGB").resize((S // 2, S // 2)), ((i % 6) * S // 2, (i // 6) * S // 2))
    sheet.save(os.path.join(outdir, "tile_skins.png"))
    print("skin order = NT_* order")
