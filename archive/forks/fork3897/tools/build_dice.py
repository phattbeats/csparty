#!/usr/bin/env python3
"""Builds the CS Party dice block: models/csp_dice.mdl.

An olive-steel supply crate with 11 skins (0-9 and "?"). The plugin cycles skins through
the rolling character's die faces while the block spins, and freezes it on the
rolled face when a player jumps into it.

Geometry is emitted double-sided so it renders regardless of winding convention.
Compiled with Valve's own HL SDK studiomdl (built for Linux from the halflife repo).

usage: build_dice.py <studiomdl> <outdir>
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 128
HALF = 18.0          # cube is 36 units: player hull is 32 wide, 72 tall
FONT = "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"
FACES = [str(d) for d in range(10)] + ["?"]

def face_texture(label, path):
    """Olive-steel supply crate face: hazard bands top and bottom, stenciled amber number."""
    import random
    rnd = random.Random(7)                      # same grime on every skin, so only the number changes
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):                          # olive drab, a touch lighter up top
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=(int(92 - 20 * t), int(99 - 22 * t), int(64 - 16 * t)))
    for _ in range(900):                        # paint grain
        x, y = rnd.randrange(S), rnd.randrange(S); v = rnd.randint(-10, 10)
        r, g, b = img.getpixel((x, y)); img.putpixel((x, y), (max(0, r + v), max(0, g + v), max(0, b + v)))
    band = 16                                   # hazard stripe bands
    stripes = Image.new("RGB", (S, band), (30, 28, 22)); sd = ImageDraw.Draw(stripes)
    for k in range(-band, S + band, 16):
        sd.polygon([(k, 0), (k + 8, 0), (k + 8 - band, band), (k - band, band)], fill=(242, 163, 58))
    img.paste(stripes, (0, 0)); img.paste(stripes, (0, S - band))
    d = ImageDraw.Draw(img)
    d.line([(0, band), (S, band)], fill=(24, 24, 18), width=2)
    d.line([(0, S - band - 1), (S, S - band - 1)], fill=(24, 24, 18), width=2)
    d.rectangle([0, 0, S - 1, S - 1], outline=(36, 38, 26), width=3)      # frame
    d.line([(3, 3), (S - 4, 3)], fill=(130, 138, 98)); d.line([(3, 3), (3, S - 4)], fill=(120, 128, 90))
    for x0 in (8, S - 12):                                                  # side bolts, mid-height
        d.rectangle([x0, S // 2 - 3, x0 + 4, S // 2 + 3], fill=(40, 42, 30))
    font = ImageFont.truetype(FONT, 82)
    bbox = d.textbbox((0, 0), label, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (S - w) / 2 - bbox[0]; y = (S - h) / 2 - bbox[1] + 1
    d.text((x + 2, y + 3), label, font=font, fill=(34, 36, 24))             # paint shadow
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).text((x, y), label, font=font, fill=255)
    cy = S // 2 + 1                                                         # stencil bridge: a gap through the paint
    ImageDraw.Draw(mask).rectangle([0, cy - 2, S, cy + 1], fill=0)
    img.paste(Image.new("RGB", (S, S), (242, 163, 58)), (0, 0), mask)
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(path)

def cube_smd(path, tex):
    h = HALF
    # each face: outward normal n, up vector; right = cross(-n, up)
    faces = [((1, 0, 0), (0, 0, 1)), ((-1, 0, 0), (0, 0, 1)), ((0, 1, 0), (0, 0, 1)),
             ((0, -1, 0), (0, 0, 1)), ((0, 0, 1), (1, 0, 0)), ((0, 0, -1), (1, 0, 0))]
    def cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
    lines = ["version 1", "nodes", '  0 "dice" -1', "end", "skeleton", "time 0", "  0 0 0 0 0 0 0", "end", "triangles"]
    def vtx(p, n, uv): return f"0 {p[0]:.4f} {p[1]:.4f} {p[2]:.4f} {n[0]} {n[1]} {n[2]} {uv[0]:.4f} {uv[1]:.4f}"
    for n, up in faces:
        right = cross(tuple(-c for c in n), up)
        c = tuple(n[k] * h for k in range(3))
        def P(su, sv): return tuple(c[k] + right[k] * h * su + up[k] * h * sv for k in range(3))
        q = [(P(-1, -1), (0, 0)), (P(1, -1), (1, 0)), (P(1, 1), (1, 1)), (P(-1, 1), (0, 1))]
        for tri in ((0, 1, 2), (0, 2, 3)):
            for order in (tri, tri[::-1]):          # double-sided
                lines.append(tex)
                for i in order: lines.append(vtx(q[i][0], n, q[i][1]))
    lines.append("end")
    open(path, "w").write("\n".join(lines) + "\n")

def anim_smd(path):
    open(path, "w").write("version 1\nnodes\n  0 \"dice\" -1\nend\nskeleton\ntime 0\n  0 0 0 0 0 0 0\nend\n")

if __name__ == "__main__":
    studiomdl, outdir = sys.argv[1], sys.argv[2]
    work = os.path.join(outdir, "src"); os.makedirs(work, exist_ok=True)
    names = []
    for i, f in enumerate(FACES):
        nm = f"face{i:02d}.bmp"; face_texture(f, os.path.join(work, nm)); names.append(nm)
    cube_smd(os.path.join(work, "dice_ref.smd"), names[10])
    anim_smd(os.path.join(work, "idle.smd"))
    groups = " ".join("{ \"%s\" }" % n for n in [names[10]] + names[:10])
    qc = f"""$modelname "csp_dice.mdl"
$cd "."
$cdtexture "."
$scale 1.0
$body "studio" "dice_ref"
$texturegroup skins
{{
{chr(10).join('{ "%s" }' % n for n in [names[10]] + names[:10])}
}}
$sequence idle "idle" fps 1 loop
"""
    open(os.path.join(work, "dice.qc"), "w").write(qc)
    r = subprocess.run([os.path.abspath(studiomdl), "dice.qc"], cwd=work, capture_output=True, text=True)
    print(r.stdout[-1500:], r.stderr[-800:])
    mdl = os.path.join(work, "csp_dice.mdl")
    if not os.path.exists(mdl): sys.exit("studiomdl failed")
    os.replace(mdl, os.path.join(outdir, "csp_dice.mdl"))
    # contact sheet for humans
    sheet = Image.new("RGB", (S * 6, S * 2), (18, 20, 17))
    for i, nm in enumerate([names[10]] + names[:10]):
        sheet.paste(Image.open(os.path.join(work, nm)).convert("RGB"), ((i % 6) * S, (i // 6) * S))
    sheet.save(os.path.join(outdir, "dice_skins.png"))
    print("skin order: 0='?', 1..10 = digits 0..9")
