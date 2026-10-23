#!/usr/bin/env python3
"""Builds the map overlay's sprites: sprites/csp_space.spr and sprites/csp_face.spr.

csp_space.spr: one frame per space type, in the plugin's NT_* order, in the board tile's colours and labels
(build_tiles.TYPES, with shorter map labels), so the map view shows what every space is. Then two markers:
frame 11 the hostages (a gold star), frame 12 the whose-turn ring (tinted by the plugin).
csp_face.spr: one frame per character, in the plugin's SK_* order: the character-select portrait
(web/public/art/character-atlas.webp, 4 columns x 2 rows) in a circle, ringed in the character's colour.

GoldSrc sprites, version 2, "parallel" (faces the camera), alpha-tested: palette index 255 is see-through.
Every frame of a sprite shares one 255-colour palette.

usage: build_mapicons.py <outdir> <bold.ttf>
"""
import math, os, struct, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_tiles import TYPES, hex_pts

S = 128
ATLAS = os.path.join(HERE, "..", "web", "public", "art", "character-atlas.webp")
# boot.js CHARS[].c, SK_* order
CHAR_COL = ["#e6603f", "#e3b52b", "#a7d5e4", "#9bad54", "#6b9fd4", "#b5b9c1", "#b98ad9", "#e2e2d4"]

# the overlay draws a space ~24 px tall: four-letter labels shrank to unreadable, so the map uses short ones
MAP_LABEL = {"SHOP": "BUY", "ARMOR": "KEV"}
SS = 4   # drawn at 4x and scaled down (anti-aliased edges; alpha is still cut at 50% in write_spr)

def space_frame(label, fill, ink, font_path):
    label = MAP_LABEL.get(label, label)
    B = S * SS
    img = Image.new("RGBA", (B, B), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = B / 2
    d.polygon(hex_pts(c, c, B / 2 - 1 * SS), fill=(20, 20, 20, 255))                       # dark edge: reads on sand
    d.polygon(hex_pts(c, c, B / 2 - 6 * SS), fill=tuple(int(v * 0.55) for v in fill) + (255,))
    d.polygon(hex_pts(c, c, B / 2 - 12 * SS), fill=fill + (255,))
    size = 64 * SS
    while True:
        font = ImageFont.truetype(font_path, size)
        bb = d.textbbox((0, 0), label, font=font)
        if bb[2] - bb[0] <= B * 0.74 or size <= 16 * SS: break
        size -= 2 * SS
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    x, y = c - w / 2 - bb[0], c - h / 2 - bb[1]
    dark = tuple(int(v * 0.35) for v in fill) + (255,)
    d.text((x + 2 * SS, y + 2 * SS), label, font=font, fill=dark)
    d.text((x, y), label, font=font, fill=ink + (255,), stroke_width=2 * SS, stroke_fill=dark)
    return img.resize((S, S), Image.LANCZOS)

def star_points(cx, cy, ro, ri):
    return [(cx + (ro if k % 2 == 0 else ri) * math.sin(math.radians(36 * k)), cy - (ro if k % 2 == 0 else ri) * math.cos(math.radians(36 * k))) for k in range(10)]

def hostage_frame():
    """Where the hostages (the star) are: a gold star on a dark disc, in the board's star colour."""
    B = S * SS; c = B / 2
    img = Image.new("RGBA", (B, B), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    d.ellipse((SS, SS, B - SS, B - SS), fill=(20, 16, 8, 255))
    d.ellipse((5 * SS, 5 * SS, B - 5 * SS, B - 5 * SS), fill=(255, 200, 40, 255))
    d.ellipse((11 * SS, 11 * SS, B - 11 * SS, B - 11 * SS), fill=(60, 40, 10, 255))
    d.polygon(star_points(c, c + 2 * SS, B * 0.36, B * 0.15), fill=(255, 214, 60, 255), outline=(255, 245, 190, 255), width=2 * SS)
    return img.resize((S, S), Image.LANCZOS)

def turn_ring_frame():
    """Whose turn: a plain thick ring, light grey so the plugin's rendercolor tints it the character's colour."""
    B = S * SS
    img = Image.new("RGBA", (B, B), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    d.ellipse((SS, SS, B - SS, B - SS), fill=(20, 20, 20, 255))
    d.ellipse((5 * SS, 5 * SS, B - 5 * SS, B - 5 * SS), fill=(250, 250, 250, 255))
    d.ellipse((17 * SS, 17 * SS, B - 17 * SS, B - 17 * SS), fill=(20, 20, 20, 255))
    d.ellipse((21 * SS, 21 * SS, B - 21 * SS, B - 21 * SS), fill=(0, 0, 0, 0))
    return img.resize((S, S), Image.LANCZOS)

def face_frame(atlas, i):
    cw, ch = atlas.width / 4, atlas.height / 2
    x0, y0 = (i % 4) * cw, (i // 4) * ch
    side = ch * 0.78                                      # head and shoulders, from just under the top of the cell
    crop = atlas.crop((int(x0 + (cw - side) / 2), int(y0 + ch * 0.02), int(x0 + (cw + side) / 2), int(y0 + ch * 0.02 + side)))
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    col = tuple(int(CHAR_COL[i][k:k + 2], 16) for k in (1, 3, 5))
    d.ellipse((0, 0, S - 1, S - 1), fill=(15, 15, 15, 255))
    d.ellipse((3, 3, S - 4, S - 4), fill=col + (255,))
    inner = S - 2 * 12
    face = Image.new("RGBA", (inner, inner), (40, 40, 40, 255))
    face.alpha_composite(crop.convert("RGBA").resize((inner, inner), Image.LANCZOS))
    mask = Image.new("L", (inner, inner), 0); ImageDraw.Draw(mask).ellipse((0, 0, inner - 1, inner - 1), fill=255)
    img.paste(face, (12, 12), mask)
    return img

def write_spr(path, frames):
    """frames: RGBA images of one size. Alpha < 128 becomes palette index 255 (transparent)."""
    w, h = frames[0].size
    strip = Image.new("RGB", (w, h * len(frames)))
    for k, f in enumerate(frames):
        bg = Image.new("RGB", (w, h), (0, 0, 0)); bg.paste(f, (0, 0), f)
        strip.paste(bg, (0, h * k))
    q = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = (q.getpalette() or [])[:255 * 3]
    pal += [0] * (255 * 3 - len(pal)) + [0, 0, 255]
    px = bytearray(q.tobytes())
    for k, f in enumerate(frames):
        a = f.getchannel("A").tobytes()
        for j in range(w * h):
            if a[j] < 128: px[k * w * h + j] = 255
    out = struct.pack("<4siiifiiifi", b"IDSP", 2, 2, 3, math.hypot(w / 2, h / 2), w, h, len(frames), 0.0, 0)
    out += struct.pack("<h", 256) + bytes(pal)
    for k in range(len(frames)):
        out += struct.pack("<iiiii", 0, -w // 2, h // 2, w, h) + bytes(px[k * w * h:(k + 1) * w * h])
    open(path, "wb").write(out)

def main():
    outdir, font = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    spaces = [space_frame(lbl, fill, ink, font) for lbl, fill, ink in TYPES] + [hostage_frame(), turn_ring_frame()]
    write_spr(os.path.join(outdir, "csp_space.spr"), spaces)
    atlas = Image.open(ATLAS)
    faces = [face_frame(atlas, i) for i in range(8)]
    write_spr(os.path.join(outdir, "csp_face.spr"), faces)
    # contact sheet, to eyeball the frames
    sheet = Image.new("RGBA", (S * 13, S * 2), (200, 170, 120, 255))
    for k, f in enumerate(spaces): sheet.alpha_composite(f, (S * k, 0))
    for k, f in enumerate(faces): sheet.alpha_composite(f, (S * k, S))
    sheet.save(os.path.join(outdir, "mapicons_preview.png"))

if __name__ == "__main__":
    main()
