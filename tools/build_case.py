#!/usr/bin/env python3
"""Builds the CS Party case-opening model: models/csp_case.mdl.

Body "card" (body 0) is a flat 35x27 card facing +X. Its skins:
  0       unopened ("?")
  1..16   rarity * 4 + skin: Mil-Spec, Restricted, Classified, Covert, 4 named skins each (RAR_SKIN in the plugin)
  17      the gold "Rare Special Item" star card that stands in for a knife while the reel spins
  18..21  the four knives, swapped in when a gold card lands
Bodies 1..7 are the case window around the reel: 1 = smoked backing strip, 2 = gold centre marker,
3..7 = additive rarity glow behind the winner (blue, purple, pink, red, gold).
Every texture is flagged fullbright, so the reel reads the same in a dark tunnel as in the sun.

usage: build_case.py <studiomdl> <outdir>   (studiomdl needs i386 libs; see tools/dev/README-studiomdl.md)
"""
import math, os, struct, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, K = 160, 120, 4            # card texture, supersampled K times while drawing
CW, CH = 35.0, 27.0              # card size in world units (the plugin spaces cards 38 apart)
FONTS = ["/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
         "/tmp/vlibs/root/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
         "/paperclip/.npm/_npx/6583fba12287d067/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf"]
FONT = next((f for f in FONTS if os.path.exists(f)), None)
RAR = [(75, 105, 255), (136, 71, 255), (211, 44, 230), (235, 75, 75), (255, 196, 0)]   # CS:GO rarity colours
GOLD = (255, 205, 60)
rng = np.random.default_rng(3985)

# ---------------------------------------------------------------- patterns --
# each returns an RGB float array (H*K, W*K, 3) in 0..1 that fills the painted parts of the weapon
YY, XX = np.mgrid[0:H * K, 0:W * K].astype(np.float32) / K     # texture pixel coords

def rgb(*c): return np.array(c, np.float32) / 255.0
def solid(c): return np.broadcast_to(rgb(*c), (H * K, W * K, 3)).copy()
def smooth_noise(cells, seed=None):
    g = (np.random.default_rng(seed) if seed is not None else rng).random((max(2, H // cells), max(2, W // cells)))
    return np.asarray(Image.fromarray((g * 255).astype(np.uint8)).resize((W * K, H * K), Image.BICUBIC), np.float32) / 255.0
def mix(a, b, t):
    t = np.clip(np.asarray(t, np.float32), 0, 1)
    return a * (1 - t[..., None]) + b * t[..., None] if t.ndim else a * (1 - t) + b * t
def lerp_cols(stops, t):
    t = np.clip(t, 0, 1); out = np.zeros(t.shape + (3), np.float32)
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        m = (t >= t0) & (t <= t1); u = ((t - t0) / max(t1 - t0, 1e-6))[..., None]
        out[m] = (rgb(*c0) * (1 - u) + rgb(*c1) * u)[m]
    return out

def p_sand():       return mix(solid((196, 172, 128)), solid((160, 132, 92)), smooth_noise(3) * 0.8 + rng.random((H * K, W * K)) * 0.25)
def p_army():
    a = solid((92, 98, 62)); a = mix(a, solid((58, 62, 40)), smooth_noise(14) > 0.55); return mix(a, solid((120, 102, 70)), smooth_noise(10) > 0.62)
def p_mesh():
    g = ((np.abs(((XX + YY) % 7) - 3.5) < 0.6) | (np.abs(((XX - YY) % 7) - 3.5) < 0.6))
    return mix(solid((220, 226, 232)), solid((120, 130, 142)), g * 0.85)
def p_groundwater():
    w = np.sin(YY * 0.45 + np.sin(XX * 0.12) * 2.0 + smooth_noise(12) * 3)
    return mix(solid((54, 84, 80)), solid((130, 150, 120)), (w > 0.35) * 0.9)
def p_basilisk():
    sc = np.abs(np.sin(XX * 0.9 + (np.floor(YY / 3) % 2) * 1.6) * np.sin(YY * 1.05))
    return mix(solid((90, 104, 96)), solid((150, 190, 120)), (sc > 0.55) * 0.8)
def p_guardian():
    st = (((XX * 0.6 - YY) % 18) < 3)
    return mix(mix(solid((36, 64, 130)), solid((70, 110, 190)), YY / H), solid((225, 232, 245)), st * 0.9)
def p_cobalt():
    return mix(solid((22, 52, 160)), solid((120, 170, 255)), np.clip(np.sin(XX * 0.08 - YY * 0.15) * 0.5 + 0.3, 0, 1))
def p_heat():
    f = smooth_noise(5) + (1 - YY / H) * 0.6 + np.sin(XX * 0.35) * 0.12
    return lerp_cols([(0.0, (110, 10, 10)), (0.55, (220, 40, 20)), (0.85, (255, 150, 30)), (1.2, (255, 230, 120))], f * 0.8)
def p_redline():
    carbon = ((np.floor(XX / 1.5) + np.floor(YY / 1.5)) % 2) * 0.05
    base = solid((26, 26, 30)) + carbon[..., None]
    lines = (np.abs(YY - 58) < 1.1) | (np.abs(YY - 54) < 0.6) | ((np.abs(YY - 47 - XX * 0.1) < 0.8) & (XX > 60))
    return mix(base, solid((225, 30, 36)), lines)
def p_hyperbeast():
    n1, n2, n3 = smooth_noise(9, 1), smooth_noise(9, 2), smooth_noise(7, 4)
    c = solid((28, 30, 40)); c = mix(c, solid((40, 210, 200)), n1 > 0.58); c = mix(c, solid((240, 50, 170)), n2 > 0.6)
    return mix(c, solid((250, 220, 40)), n3 > 0.72)
def p_desolate():
    c = lerp_cols([(0, (30, 16, 70)), (0.5, (90, 40, 140)), (1, (250, 120, 60))], smooth_noise(12, 7) * 1.2 - 0.1)
    return mix(c, solid((255, 255, 255)), rng.random((H * K, W * K)) > 0.995)
def p_water():
    s = np.sin(XX * 0.3 + np.sin(YY * 0.4) * 3 + smooth_noise(8) * 4)
    return lerp_cols([(0, (200, 20, 30)), (0.5, (235, 235, 240)), (1, (40, 90, 220))], s * 0.5 + 0.5)
def p_dragonlore():
    c = mix(solid((206, 184, 140)), solid((176, 150, 104)), smooth_noise(4) * 0.7)
    sc = (np.sin(XX * 1.1) * np.sin(YY * 1.1 + np.floor(XX / 3)) > 0.5) & (smooth_noise(16, 9) > 0.45)
    c = mix(c, solid((70, 110, 60)), sc * 0.9)
    return mix(c, solid((200, 150, 40)), (np.abs(YY - 55 - np.sin(XX * 0.15) * 4) < 0.8))
def p_fireserpent():
    c = mix(solid((40, 70, 50)), solid((70, 110, 70)), smooth_noise(6) * 0.8)
    d = np.abs(YY - 55 - np.sin(XX * 0.09) * 9)
    return mix(mix(c, solid((214, 170, 60)), d < 3.0), solid((150, 30, 20)), d < 1.0)
def p_howl():
    f = smooth_noise(6, 11) + (YY / H) * 0.5
    c = lerp_cols([(0, (255, 210, 60)), (0.5, (255, 110, 20)), (1, (190, 30, 10))], f * 0.85)
    return mix(c, solid((24, 16, 14)), (smooth_noise(10, 12) > 0.66) * 0.9)
def p_blaze():
    f = (XX / W) * 1.2 + np.sin(YY * 0.6 + XX * 0.08) * 0.12 + smooth_noise(6) * 0.3
    return lerp_cols([(0, (18, 16, 18)), (0.55, (30, 22, 20)), (0.75, (240, 80, 20)), (1.2, (255, 220, 80))], 1.25 - f)
def p_fade():
    return lerp_cols([(0, (255, 80, 200)), (0.45, (150, 70, 230)), (0.75, (240, 200, 90)), (1, (255, 240, 140))], (XX - YY * 0.6) / W + 0.2)
def p_doppler():
    c = lerp_cols([(0, (20, 8, 24)), (0.5, (170, 30, 120)), (1, (255, 120, 210))], smooth_noise(7, 21) * 1.3 - 0.15)
    return mix(c, solid((255, 255, 255)), rng.random((H * K, W * K)) > 0.993)
def p_crimson():
    cx, cy = 70.0, 30.0; a = np.arctan2(YY - cy, XX - cx); r = np.hypot(XX - cx, YY - cy)
    web = (np.abs(((a * 7 / math.pi) % 1) - 0.5) < 0.05) | (np.abs(((r + np.sin(a * 14) * 1.5) % 9) - 4.5) < 0.45)
    return mix(solid((150, 14, 20)), solid((14, 8, 10)), web)
def p_tiger():
    st = np.sin(XX * 0.55 + np.sin(YY * 0.3) * 2.5 + smooth_noise(8) * 2) > 0.5
    return mix(mix(solid((250, 190, 60)), solid((230, 150, 40)), YY / H), solid((110, 50, 14)), st * 0.9)

# ---------------------------------------------------------------- weapons --
# side views, muzzle right, in 160x120 texture space. Each part is (layer, shape): layer "p" takes the paint,
# "m" is bare gunmetal, "k" is near-black (grips, rails). Shapes are polygons or ("e", box) ellipses.
def rect(x0, y0, x1, y1): return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
def ell(x0, y0, x1, y1): return ("e", [(x0, y0), (x1, y1)])
def offs(parts, dx, dy, s=1.0, cx=80, cy=60):
    def tf(pts): return [(cx + (x - cx) * s + dx, cy + (y - cy) * s + dy) for x, y in pts]
    return [(l, ("e", tf(sh[1])) if sh[0] == "e" else tf(sh)) for l, sh in parts]

AK = [("p", [(10, 54), (44, 47), (47, 58), (40, 62), (14, 75), (9, 71)]),
      ("m", [(44, 46), (58, 42), (100, 42), (102, 46), (102, 58), (44, 58)]),
      ("p", [(100, 46), (124, 46), (124, 57), (100, 58)]),
      ("m", [(100, 41), (126, 41), (126, 46), (100, 46)]),
      ("m", rect(124, 48.5, 148, 52.5)), ("m", rect(138, 43, 141, 49)), ("m", rect(147, 47.5, 152, 53.5)),
      ("p", [(76, 58), (89, 58), (93, 71), (100, 85), (87, 90), (80, 75)]),
      ("k", [(56, 58), (67, 58), (64, 77), (53, 77)]), ("m", [(66, 58), (77, 58), (75, 65), (67, 65)])]
M4 = [("k", [(8, 50), (40, 48), (42, 60), (30, 61), (12, 70), (8, 68)]),
      ("p", [(40, 45), (98, 45), (98, 59), (40, 59)]), ("k", rect(50, 40, 92, 45)), ("m", [(62, 34), (70, 34), (70, 40), (62, 40)]),
      ("p", [(98, 46), (126, 46), (126, 58), (98, 58)]), ("m", rect(126, 49.5, 148, 53.5)), ("m", rect(132, 42, 135, 49.5)),
      ("m", rect(147, 48, 153, 55)),
      ("p", [(70, 59), (82, 59), (84, 84), (72, 84)]), ("k", [(52, 59), (62, 59), (58, 78), (48, 78)]), ("m", [(62, 59), (70, 59), (69, 65), (63, 65)])]
M4S = M4[:5] + [("k", rect(126, 48, 154, 55))] + M4[8:]           # M4A1-S: long suppressor instead of the flash hider
AWP = [("p", [(8, 52), (48, 50), (52, 60), (44, 64), (34, 64), (28, 76), (10, 76), (6, 68)]),
       ("p", [(48, 48), (104, 48), (104, 60), (52, 60)]), ("m", rect(104, 51, 154, 55)), ("m", rect(150, 49.5, 156, 56.5)),
       ("k", [(58, 36), (100, 36), (100, 44), (58, 44)]), ("k", [(52, 37), (60, 34), (60, 46), (52, 44)]), ("k", [(98, 34), (106, 32), (106, 48), (98, 46)]),
       ("m", rect(74, 44, 82, 48)), ("p", [(68, 60), (80, 60), (80, 70), (68, 70)]), ("m", [(56, 60), (66, 60), (64, 66), (58, 66)])]
DEAGLE = [("p", [(36, 46), (118, 46), (120, 50), (118, 60), (36, 60)]), ("k", rect(38, 43, 52, 46)), ("k", rect(110, 42, 114, 46)),
          ("m", [(40, 60), (74, 60), (70, 66), (44, 66)]), ("k", [(42, 60), (62, 60), (56, 96), (34, 96)]), ("m", [(62, 66), (74, 66), (70, 74), (62, 72)])]
GLOCK = [("p", [(40, 48), (116, 48), (116, 60), (40, 60)]), ("k", [(42, 60), (82, 60), (80, 66), (44, 66)]),
         ("k", [(44, 60), (64, 60), (60, 94), (40, 94)]), ("m", [(64, 66), (78, 66), (74, 74), (64, 72)]), ("m", rect(110, 45, 113, 48))]
GLOCKP = [("p", sh) if i in (0, 2) else (l, sh) for i, (l, sh) in enumerate(GLOCK)]   # painted frame too: Water Elemental is all over
P250 = [("p", [(40, 47), (114, 47), (116, 51), (114, 60), (40, 60)]), ("p", [(42, 60), (80, 60), (78, 66), (46, 66)]),
        ("k", [(44, 60), (64, 60), (59, 94), (38, 94)]), ("m", [(64, 66), (76, 66), (72, 74), (64, 72)])]
USPS = [("p", [(26, 48), (90, 48), (90, 60), (26, 60)]), ("k", rect(90, 49, 144, 59)), ("m", rect(140, 49, 144, 59)),
        ("p", [(28, 60), (64, 60), (62, 66), (30, 66)]), ("k", [(30, 60), (50, 60), (46, 94), (26, 94)]), ("m", [(50, 66), (62, 66), (58, 74), (50, 72)])]
MP7 = [("p", [(36, 44), (110, 44), (112, 48), (112, 60), (36, 60)]), ("k", rect(46, 39, 100, 44)), ("m", rect(112, 49, 134, 54)),
       ("k", [(14, 50), (36, 48), (36, 54), (18, 56)]), ("k", [(8, 46), (14, 46), (16, 60), (8, 60)]),
       ("p", [(52, 60), (66, 60), (62, 96), (48, 96)]), ("k", [(88, 60), (98, 60), (96, 78), (88, 78)]), ("m", [(66, 60), (80, 60), (78, 68), (66, 68)])]
MAC10 = [("p", [(40, 44), (110, 44), (110, 62), (40, 62)]), ("k", rect(110, 50, 132, 55)), ("m", rect(48, 40, 56, 44)), ("m", rect(100, 40, 106, 44)),
         ("k", [(56, 62), (72, 62), (70, 104), (54, 104)]), ("m", [(72, 62), (86, 62), (82, 70), (72, 70)]), ("k", [(20, 46), (40, 46), (40, 50), (20, 50)])]
NOVA = [("p", [(6, 54), (42, 48), (44, 60), (36, 64), (10, 74), (5, 68)]), ("p", [(42, 47), (84, 47), (84, 60), (42, 60)]),
        ("m", rect(84, 49, 152, 54)), ("m", rect(84, 55, 140, 59)), ("p", [(92, 54), (124, 54), (124, 63), (92, 63)]),
        ("m", rect(146, 46, 149, 49)), ("m", [(56, 60), (68, 60), (66, 67), (58, 67)])]
# knives: blade "p", handle "k"
KARAMBIT = [("p", [(56, 72), (64, 58), (82, 48), (106, 46), (128, 54), (142, 72), (126, 64), (106, 59), (86, 62), (70, 76)]),
            ("p", [(30, 66), (58, 64), (62, 76), (36, 82), (24, 78)]), ("k", ell(12, 64, 34, 86)), ("m", [(52, 62), (58, 62), (62, 78), (56, 78)])]
BUTTERFLY = [("p", [(70, 50), (128, 48), (148, 54), (130, 62), (70, 63)]), ("k", rect(14, 49, 68, 56)), ("p", rect(14, 57, 68, 64)),
             ("m", ell(64, 52, 72, 61)), ("m", ell(10, 52, 18, 62))]
M9 = [("p", [(70, 47), (130, 47), (150, 56), (132, 65), (70, 65)]), ("m", rect(66, 46, 72, 66)),
      ("k", [(18, 51), (66, 50), (66, 62), (18, 61), (14, 56)]), ("m", rect(104, 43, 130, 47))] \
     + [("k", rect(106 + i * 4, 43, 108 + i * 4, 47)) for i in range(6)]
BAYONET = [("p", [(70, 48), (128, 48), (150, 57), (130, 65), (70, 65)]), ("m", rect(66, 47, 72, 66)),
           ("k", [(18, 51), (66, 50), (66, 62), (18, 61), (14, 56)]), ("m", [(110, 49), (130, 49), (138, 54), (110, 54)])]

# the four named skins per rarity (same order as RAR_SKIN in plugin/cs_party.sma), then the knives
SKINS = [
    (P250, p_sand), (MP7, p_army), (NOVA, p_mesh), (GLOCK, p_groundwater),
    (M4S, p_basilisk), (USPS, p_guardian), (DEAGLE, p_cobalt), (MAC10, p_heat),
    (AK, p_redline), (AWP, p_hyperbeast), (M4, p_desolate), (GLOCKP, p_water),
    (AWP, p_dragonlore), (AK, p_fireserpent), (M4, p_howl), (DEAGLE, p_blaze),
]
KNIVES = [(KARAMBIT, p_fade), (BUTTERFLY, p_doppler), (M9, p_crimson), (BAYONET, p_tiger)]

def draw_mask(shapes):
    m = Image.new("L", (W * K, H * K), 0); d = ImageDraw.Draw(m)
    for sh in shapes:
        if sh[0] == "e": d.ellipse([c * K for p in sh[1] for c in p], fill=255)
        else: d.polygon([(x * K, y * K) for x, y in sh], fill=255)
    return np.asarray(m, np.float32) / 255.0

def fimg(a): return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
def farr(im): return np.asarray(im, np.float32) / 255.0

def weapon(img, parts, paint):
    """composites a shaded, outlined, painted weapon onto img (float array, modified in place)"""
    layers = {l: draw_mask([sh for ll, sh in parts if ll == l]) for l in "pmk"}
    allm = np.clip(layers["p"] + layers["m"] + layers["k"], 0, 1); mi = fimg(allm)
    shadow = np.roll(farr(mi.filter(ImageFilter.GaussianBlur(5 * K))), 4 * K, axis=0)
    img *= (1 - shadow[..., None] * 0.65)
    img[:] = mix(img, solid((8, 9, 12)), farr(mi.filter(ImageFilter.MaxFilter(2 * K - 1))))     # outline
    grad = np.clip((YY - 40) / 30, 0, 1)
    col = mix(mix(mix(solid((46, 48, 52)), solid((18, 19, 22)), grad), mix(solid((92, 96, 104)), solid((40, 43, 48)), grad), layers["m"]), paint, layers["p"])
    # light from above: a bright rim on top edges, a soft roll-off toward the belly
    top = np.clip(allm - np.roll(allm, 2 * K, axis=0), 0, 1)
    up = farr(mi.filter(ImageFilter.GaussianBlur(4 * K)))
    shade = 0.78 + 0.32 * np.clip(np.roll(up, 3 * K, axis=0) - np.roll(up, -3 * K, axis=0) + 0.5, 0, 1)
    col = np.clip(col * shade[..., None] + top[..., None] * 0.35, 0, 1)
    img[:] = mix(img, col, farr(mi.filter(ImageFilter.MinFilter(K + 1))))

def card_bg(color, gold=False):
    img = mix(solid((52, 44, 30)), solid((22, 18, 12)), YY / H) if gold else mix(solid((44, 48, 56)), solid((20, 22, 27)), YY / H)
    c = rgb(*color)
    g = np.exp(-(((XX - W / 2) / (W * 0.62)) ** 2 + ((YY - H) / (H * 0.62)) ** 2) * 1.6)   # rarity glow rising from the bottom
    img = np.clip(img + c * g[..., None] * (0.38 if gold else 0.55), 0, 1) * 0.93 + c * (0.04 if gold else 0.07)
    return np.clip(img + (np.exp(-((XX - YY * 0.9 - 40) / 14) ** 2) * 0.05)[..., None], 0, 1)   # faint diagonal sheen

def card_frame(img, color, gold=False):
    c = rgb(*color); bar = (H - 11) * K; b = (2 if gold else 1) * K
    img[bar:, :] = c; img[bar:bar + K, :] = np.clip(c * 0.6 + 0.4, 0, 1); img[(H - 4) * K:, :] *= 0.8   # rarity bar
    img[bar - b:bar, :] *= 0.5
    edge = rgb(*GOLD) if gold else rgb(74, 80, 92)
    img[:b, :] = edge; img[:, :b] = edge; img[:, -b:] = edge
    img[H * K - b:, :] = edge if gold else c * 0.7

def finish(img, path):
    im = fimg(img).resize((W, H), Image.LANCZOS)
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path)
    return im

def weapon_card(rar, parts, pat, path):
    img = card_bg(RAR[rar], rar == 4)
    weapon(img, offs(parts, 0, -6, 1.0) if rar < 4 else offs(parts, 6, -4, 1.04), pat())
    card_frame(img, RAR[rar], rar == 4)
    return finish(img, path)

def star_card(path):
    """CS shows every knife as this gold card until it lands"""
    img = card_bg(GOLD, True)
    rays = (np.cos(np.arctan2(YY - 48, XX - 80) * 12) * 0.5 + 0.5) * np.exp(-np.hypot(XX - 80, YY - 48) / 40)
    img = np.clip(img + rgb(*GOLD) * rays[..., None] * 0.45, 0, 1)
    m = Image.new("L", (W * K, H * K)); d = ImageDraw.Draw(m)
    pts = [(80 + (34 if i % 2 == 0 else 14) * math.sin(i * math.pi / 5), 50 - (34 if i % 2 == 0 else 14) * math.cos(i * math.pi / 5)) for i in range(10)]
    d.polygon([(x * K, y * K) for x, y in pts], fill=255)
    star = farr(m)
    img = np.clip(img + rgb(255, 210, 90) * farr(m.filter(ImageFilter.GaussianBlur(6 * K)))[..., None] * 0.8, 0, 1)
    img = mix(img, solid((40, 24, 4)), farr(m.filter(ImageFilter.MaxFilter(2 * K + 1))))
    img = mix(img, mix(solid((255, 248, 190)), solid((240, 160, 10)), (YY - 18) / 64), star)
    if FONT:
        t = Image.new("L", (W * K, H * K)); d = ImageDraw.Draw(t)
        f = ImageFont.truetype(FONT, 9 * K); s = "RARE SPECIAL ITEM"; bb = d.textbbox((0, 0), s, font=f)
        d.text(((W * K - (bb[2] - bb[0])) / 2 - bb[0], 92 * K - bb[1]), s, font=f, fill=255)
        img = mix(img, solid((20, 12, 2)), farr(t.filter(ImageFilter.MaxFilter(K + 1))))
        img = mix(img, solid((255, 236, 160)), farr(t))
    card_frame(img, GOLD, True)
    return finish(img, path)

def unknown_card(path):
    img = card_bg((120, 130, 150))
    m = Image.new("L", (W * K, H * K)); d = ImageDraw.Draw(m)
    if FONT:
        f = ImageFont.truetype(FONT, 64 * K); bb = d.textbbox((0, 0), "?", font=f)
        d.text(((W * K - (bb[2] - bb[0])) / 2 - bb[0], (100 * K - (bb[3] - bb[1])) / 2 - bb[1]), "?", font=f, fill=255)
    img = mix(img, solid((210, 220, 235)), farr(m))
    card_frame(img, (120, 130, 150))
    return finish(img, path)

# ---------------------------------------------------------------- reel window --
def save8(a, path): fimg(a).quantize(colors=256, dither=Image.Dither.NONE).save(path)

def panel_tex(path):
    """smoked strip behind the cards: dark, with a faint rim top and bottom (the plugin draws it translucent)"""
    w, h = 256, 32
    y = np.arange(h, dtype=np.float32)[:, None] / (h - 1)
    v = 0.05 + 0.04 * np.exp(-((y - 0.5) / 0.35) ** 2)
    img = np.repeat((v * np.ones((h, w)))[..., None], 3, axis=2) * np.array([0.9, 0.95, 1.1])
    img[0] = img[-1] = (0.40, 0.42, 0.46); img[1] = img[-2] = (0.14, 0.15, 0.17)
    save8(img, path)

def marker_tex(path):
    y = np.arange(64, dtype=np.float32)[:, None] / 63
    c = np.array(GOLD, np.float32) / 255 * (0.85 + 0.15 * np.cos((y - 0.5) * 6))
    save8(np.repeat(c[:, None, :], 16, axis=1), path)

def glow_tex(color, path):
    w, h = 128, 64
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    g = np.clip(1 - np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2)), 0, 1) ** 1.4
    save8(np.array(color, np.float32)[None, None, :] / 255 * g[..., None] * 1.1 + g[..., None] ** 3 * 0.35, path)

# ---------------------------------------------------------------- geometry --
# studiomdl turns the model 90 degrees about Z, so the source is drawn facing -Y with screen-right along +X:
# compiled, the card faces +X (the entity's yaw) with screen-right along +Y
def quad(tex, x, y0, y1, z0, z1):
    """one front-facing quad at depth x; y is screen-right, z up"""
    def vtx(y, z, u, v): return f"0 {y:.4f} {-x:.4f} {z:.4f} 0 -1 0 {u:.4f} {v:.4f}"
    a, b, c, d = (y0, z0, 0, 0), (y1, z0, 1, 0), (y1, z1, 1, 1), (y0, z1, 0, 1)
    return [tex, vtx(*a), vtx(*b), vtx(*c), tex, vtx(*a), vtx(*c), vtx(*d)]

def tri(tex, x, pts):
    return [tex] + [f"0 {y:.4f} {-x:.4f} {z:.4f} 0 -1 0 0.5000 0.5000" for y, z in pts]

def smd(path, tris):
    open(path, "w").write("\n".join(["version 1", "nodes", '  0 "card" -1', "end", "skeleton", "time 0", "  0 0 0 0 0 0 0", "end", "triangles"] + tris + ["end"]) + "\n")

def set_flags(mdl):
    """studiomdl has no switch for it: set STUDIO_NF_FULLBRIGHT (4) on every texture, plus STUDIO_NF_ADDITIVE (0x20) on the glows"""
    b = bytearray(open(mdl, "rb").read())
    n, idx = struct.unpack_from("<ii", b, 180)
    for i in range(n):
        o = idx + i * 80
        fl = struct.unpack_from("<i", b, o + 64)[0] | 4 | (0x20 if b[o:o + 4] == b"glow" else 0)
        struct.pack_into("<i", b, o + 64, fl)
    open(mdl, "wb").write(bytes(b))

if __name__ == "__main__":
    studiomdl, outdir = sys.argv[1], sys.argv[2]
    work = os.path.join(outdir, "src_case")
    os.makedirs(work, exist_ok=True)
    for f in os.listdir(work): os.remove(os.path.join(work, f))
    names = ["card00.bmp"]; sheet = [unknown_card(os.path.join(work, names[0]))]
    for i, (parts, pat) in enumerate(SKINS):
        names.append(f"card{i + 1:02d}.bmp"); sheet.append(weapon_card(i // 4, parts, pat, os.path.join(work, names[-1])))
    names.append("card17.bmp"); sheet.append(star_card(os.path.join(work, names[-1])))
    for i, (parts, pat) in enumerate(KNIVES):
        names.append(f"card{i + 18:02d}.bmp"); sheet.append(weapon_card(4, parts, pat, os.path.join(work, names[-1])))
    panel_tex(os.path.join(work, "panel.bmp")); marker_tex(os.path.join(work, "marker.bmp"))
    for r in range(5): glow_tex(RAR[r], os.path.join(work, f"glow{r}.bmp"))

    smd(os.path.join(work, "card.smd"), quad(names[0], 0, -CW / 2, CW / 2, -CH / 2, CH / 2))
    PW, PH = 276.0, 35.0
    smd(os.path.join(work, "panel.smd"), quad("panel.bmp", 0, -PW / 2, PW / 2, -PH / 2, PH / 2))
    mk = quad("marker.bmp", 0, -0.55, 0.55, -PH / 2 - 1.5, PH / 2 + 1.5)
    mk += tri("marker.bmp", 0, [(-3.2, PH / 2 + 1.5), (0, PH / 2 - 3.0), (3.2, PH / 2 + 1.5)])     # pointers top and bottom
    mk += tri("marker.bmp", 0, [(-3.2, -PH / 2 - 1.5), (3.2, -PH / 2 - 1.5), (0, -PH / 2 + 3.0)])
    smd(os.path.join(work, "marker.smd"), mk)
    for r in range(5): smd(os.path.join(work, f"glow{r}.smd"), quad(f"glow{r}.bmp", 0, -80, 80, -42, 42))
    open(os.path.join(work, "idle.smd"), "w").write('version 1\nnodes\n  0 "card" -1\nend\nskeleton\ntime 0\n  0 0 0 0 0 0 0\nend\n')
    qc = ['$modelname "csp_case.mdl"', '$cd "."', '$cdtexture "."', '$scale 1.0',
          '$bodygroup "part"', "{", ' studio "card"', ' studio "panel"', ' studio "marker"'] + [f' studio "glow{r}"' for r in range(5)] + ["}",
          "$texturegroup skins", "{"] + ['{ "%s" }' % n for n in names] + ["}", '$sequence idle "idle" fps 1 loop']
    open(os.path.join(work, "case.qc"), "w").write("\n".join(qc) + "\n")
    cols = 6; rows = (len(sheet) + cols - 1) // cols
    out = Image.new("RGB", (cols * (W + 6) + 6, rows * (H + 6) + 6), (12, 13, 16))
    for i, im in enumerate(sheet): out.paste(im.convert("RGB"), (6 + (i % cols) * (W + 6), 6 + (i // cols) * (H + 6)))
    out.save(os.path.join(outdir, "case_skins.png"))
    if studiomdl == "-": sys.exit(0)        # art only
    r = subprocess.run(studiomdl.split() + ["case.qc"], cwd=work, capture_output=True, text=True)
    print(r.stdout[-600:], r.stderr[-400:])
    mdl = os.path.join(work, "csp_case.mdl")
    if not os.path.exists(mdl): sys.exit("studiomdl failed")
    set_flags(mdl)
    os.replace(mdl, os.path.join(outdir, "csp_case.mdl"))
