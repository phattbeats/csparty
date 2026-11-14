#!/usr/bin/env python3
"""Builds the PHATT ID hat sprites (PHA-5163): sprites/csp/hat_<name>.spr, one per trinket the arcade maps to CS Party's
`hat` slot (arcade items/<key>.json `render.csparty.hat`). The plugin floats the sprite over the pawn's head with
TE_PLAYERATTACHMENT, the way CS shows its radio icon.

Source art: art/hats/<name>.png, the trinket's 256 px icon from the arcade (static/unlock/<key>-256.png, PHA-4929).
A temp entity draws a sprite 1 px = 1 unit and can't scale it, so the size here is the size in the world: S units,
about a head and a half wide. GoldSrc sprite v2, "parallel", alpha-tested (palette 255 is see-through), via
build_mapicons.write_spr. The plugin's HATS[] must list the same files, in any order.

usage: build_hats.py <outdir>      (writes <outdir>/hat_<name>.spr and hats_preview.png)
"""
import os, sys
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_mapicons import write_spr

S = 48
HATS = ["benny", "snowglobe", "cabinet", "owl"]
SRC = os.path.join(HERE, "..", "art", "hats")

def hat_frame(name):
    """The icon on a 2 px dark rim, so it reads over sand, sky and dust alike once alpha is cut at 50%."""
    icon = Image.open(os.path.join(SRC, name + ".png")).convert("RGBA")
    icon = icon.crop(icon.getbbox() or (0, 0, *icon.size))
    k = (S - 4) / max(icon.size)
    icon = icon.resize((max(1, round(icon.width * k)), max(1, round(icon.height * k))), Image.LANCZOS)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(icon, ((S - icon.width) // 2, (S - icon.height) // 2), icon)
    rim = img.getchannel("A").point(lambda a: 255 if a >= 128 else 0).filter(ImageFilter.MaxFilter(5))
    out = Image.new("RGBA", (S, S), (16, 12, 20, 0)); out.putalpha(rim)
    out.alpha_composite(img)
    return out

def main():
    outdir = sys.argv[1]
    os.makedirs(outdir, exist_ok=True)
    frames = {n: hat_frame(n) for n in HATS}
    for n, f in frames.items(): write_spr(os.path.join(outdir, f"hat_{n}.spr"), [f])
    sheet = Image.new("RGBA", (S * len(HATS) * 4, S * 4), (200, 170, 120, 255))
    for k, f in enumerate(frames.values()): sheet.alpha_composite(f.resize((S * 4, S * 4), Image.NEAREST), (S * 4 * k, 0))
    sheet.save(os.path.join(outdir, "hats_preview.png"))

if __name__ == "__main__":
    main()
