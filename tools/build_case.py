#!/usr/bin/env python3
"""Builds the CS Party case-opening block: models/csp_case.mdl.

Same 36-unit cube as the dice, 6 skins: 0 = "?" (unopened), 1..5 = rarity cards
(blue, purple, pink, red, gold knife). The plugin slides rows of these past the camera.

usage: build_case.py <studiomdl> <outdir>   (studiomdl needs i386 libs; see docs/dev-harness.md)
"""
import os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_dice import cube_smd, anim_smd, S, FONT
from PIL import Image, ImageDraw, ImageFont

RAR = [  # name, base, bright
    ("blue",   (38, 70, 150),  (84, 140, 255)),
    ("purple", (70, 38, 130),  (160, 96, 255)),
    ("pink",   (120, 34, 110), (240, 80, 220)),
    ("red",    (130, 28, 32),  (255, 70, 66)),
    ("gold",   (120, 90, 18),  (255, 214, 64)),
]

def glyph(d, kind, col):
    # side-on weapon silhouettes in a 128 box, drawn into the card's middle band
    if kind == 0:   # pistol
        d.polygon([(30, 52), (96, 52), (96, 66), (70, 66), (70, 74), (80, 96), (66, 96), (54, 74), (54, 66), (30, 66)], fill=col)
    elif kind == 1: # smg
        d.polygon([(20, 54), (104, 54), (104, 66), (62, 66), (62, 74), (66, 98), (54, 98), (50, 74), (50, 66), (20, 66)], fill=col)
        d.rectangle([84, 66, 90, 82], fill=col)
    elif kind == 2: # rifle
        d.polygon([(14, 56), (30, 52), (88, 52), (98, 58), (114, 58), (114, 66), (60, 66), (58, 70), (62, 94), (50, 94), (46, 70), (30, 68), (14, 72)], fill=col)
    elif kind == 3: # sniper
        d.polygon([(10, 58), (24, 54), (96, 58), (118, 58), (118, 64), (56, 66), (50, 70), (52, 92), (42, 92), (36, 70), (24, 70), (10, 74)], fill=col)
        d.rectangle([46, 46, 70, 52], fill=col)
    else:           # knife: blade sweeping up from a short handle
        d.polygon([(34, 90), (40, 96), (54, 76), (50, 70)], fill=col)
        d.polygon([(48, 72), (58, 80), (96, 40), (110, 30), (98, 56), (66, 86)], fill=col)

def card(idx, path):
    name, base, bright = RAR[idx]
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):
        t = y / (S - 1)
        k = 0.25 + 0.75 * (1 - abs(t - 0.55) * 1.6)
        d.line([(0, y), (S, y)], fill=tuple(int(c * max(k, 0.2) + 12) for c in base))
    glyph(d, idx, tuple(min(255, c + 70) for c in bright))
    d.rectangle([0, S - 22, S, S], fill=bright)
    d.rectangle([0, S - 22, S, S - 20], fill=(255, 255, 255))
    d.rectangle([0, 0, S - 1, S - 1], outline=bright, width=4)
    d.rectangle([5, 5, S - 6, S - 6], outline=tuple(c // 2 for c in bright), width=1)
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(path)

def unknown(path):
    img = Image.new("RGB", (S, S), (24, 28, 36))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, S - 1, S - 1], outline=(120, 130, 150), width=4)
    f = ImageFont.truetype(FONT if os.path.exists(FONT) else "/tmp/vlibs/root/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 90)
    b = d.textbbox((0, 0), "?", font=f)
    d.text(((S - (b[2] - b[0])) / 2 - b[0], (S - (b[3] - b[1])) / 2 - b[1]), "?", font=f, fill=(210, 220, 235))
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(path)

if __name__ == "__main__":
    studiomdl, outdir = sys.argv[1], sys.argv[2]
    work = os.path.join(outdir, "src_case"); os.makedirs(work, exist_ok=True)
    names = ["case00.bmp"] + [f"case{i+1:02d}.bmp" for i in range(5)]
    unknown(os.path.join(work, names[0]))
    for i in range(5): card(i, os.path.join(work, names[i + 1]))
    cube_smd(os.path.join(work, "case_ref.smd"), names[0]); anim_smd(os.path.join(work, "idle.smd"))
    qc = '$modelname "csp_case.mdl"\n$cd "."\n$cdtexture "."\n$scale 1.0\n$body "studio" "case_ref"\n$texturegroup skins\n{\n' \
         + "".join('{ "%s" }\n' % n for n in names) + '}\n$sequence idle "idle" fps 1 loop\n'
    open(os.path.join(work, "case.qc"), "w").write(qc)
    r = subprocess.run(studiomdl.split() + ["case.qc"], cwd=work, capture_output=True, text=True)
    print(r.stdout[-800:], r.stderr[-500:])
    mdl = os.path.join(work, "csp_case.mdl")
    if not os.path.exists(mdl): sys.exit("studiomdl failed")
    os.replace(mdl, os.path.join(outdir, "csp_case.mdl"))
    sheet = Image.new("RGB", (S * 6, S), (18, 20, 17))
    for i, nm in enumerate(names): sheet.paste(Image.open(os.path.join(work, nm)).convert("RGB"), (i * S, 0))
    sheet.save(os.path.join(outdir, "case_skins.png"))
