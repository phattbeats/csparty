#!/usr/bin/env python3
"""Turn a race map (ours or a community one) into something CS Party can put in a race pool.

  race_map.py build <map.bsp> --game <dir with cstrike/ and valve/> [--content <dir>]... [--out build/racemaps]
                    [--nav <map.nav>] [--name <map>] [--budget-mb 6] [--force]
  race_map.py info  <map.bsp>                       entities that matter for a zone .ini

build writes, for map NAME:
  <out>/server/cstrike/...   the files the game server needs: maps/NAME.bsp, NAME.wad, maps/NAME.nav, and the
                             models, sprites, sounds and sky the map uses that a stock CS 1.6 install doesn't have.
                             The .nav (zBot nav mesh) is required: bots don't join a map without one, and the
                             plugin leaves such a map out of its pool. Make it with tools/harness/gennav.sh on the
                             built .bsp: a .nav records the size of the .bsp it was made on.
  <out>/web/NAME.zip         the browser client's map pack (relay public/mappacks/; boot.js fetches it when the
                             plugin announces the map, CSP_MAP_NAME). Must fit --budget-mb, zipped: phones.
  <out>/NAME.ini.draft       a zone .ini to start from (spawns, kreedz buttons), unless one exists

Third-party BSPs that crash HLDS or break the browser, and what build does about each:
  - The worldspawn "wad" key names WADs from the mapper's disk ("\\sierra\\half-life\\valve\\xeno.wad"). HLDS
    quits if any is missing. build copies every texture the map takes from a WAD into one NAME.wad and points
    the key at it alone, so server and browser load the same, complete set. (The map CRC skips the entity lump.)
  - BSP version other than 30 (Quake 29, Source "VBSP"): refused.
  - A model or sprite an entity uses that isn't anywhere: HLDS quits on its precache. Refused; a missing sound
    is only a warning.
--content: the map's own files as it came (the folder with models/, sound/, gfx/...), searched first.
"""
import argparse, io, os, re, struct, sys, zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"))
from bsp_util import wad_read, wad_write, bsp_info

HERE = os.path.dirname(os.path.abspath(__file__))
KZ_START = {"counter_start", "clockstartbutton", "firsttimerelay", "but_start", "counter_start_button", "multi_start", "timer_startbutton", "start_timer_emi", "gogogo"}
KZ_STOP = {"counter_off", "clockstopbutton", "clockstop", "but_stop", "counter_stop_button", "multi_stop", "stop_counter", "m_counter_end_emi"}
RES_RE = re.compile(r"^[!*#]*([\w/\\.\-]+\.(mdl|spr|wav))$", re.I)


def entities(d):
    ofs, ln = struct.unpack_from("<ii", d, 4)
    text = d[ofs: ofs + ln].split(b"\0")[0].decode("latin1")
    return [re.findall(r'"([^"]*)"\s+"([^"]*)"', blk) for blk in re.findall(r"\{([^}]*)\}", text)]


def ent_text(ents):
    return "".join("{\n" + "".join(f'"{k}" "{v}"\n' for k, v in e) + "}\n" for e in ents)


def set_entities(d, ents):
    """New entity lump appended at the end of the file; the header points at it. Other lumps keep their offsets."""
    d = bytearray(d)
    while len(d) % 4: d += b"\0"
    raw = ent_text(ents).encode("latin1") + b"\0"
    struct.pack_into("<ii", d, 4, len(d), len(raw))
    return bytes(d + raw)


def model_bounds(d, idx):
    ofs, _ = struct.unpack_from("<ii", d, 4 + 8 * 14)
    v = struct.unpack_from("<6f", d, ofs + 64 * idx)
    return v[:3], v[3:]


def g(e, k, default=""):
    for a, b in e:
        if a == k: return b
    return default


class Finder:
    def __init__(self, content, game):
        self.content = content; self.game = game
        self.index = {}
        for root in content:   # case-insensitive, like the engine on Windows where these maps were made
            for dp, _dn, fn in os.walk(root):
                for f in fn:
                    rel = os.path.relpath(os.path.join(dp, f), root).replace("\\", "/").lower()
                    self.index.setdefault(rel, os.path.join(dp, f))
                    self.index.setdefault("#" + f.lower(), os.path.join(dp, f))   # by bare name: wads, loose files

    def custom(self, rel):
        rel = rel.replace("\\", "/").lower()
        return self.index.get(rel) or self.index.get("cstrike/" + rel)

    def stock(self, rel):
        for top in ("cstrike", "valve"):
            p = os.path.join(self.game, top, rel)
            if os.path.isfile(p): return p
        return None

    def wad(self, name):
        name = os.path.basename(name.replace("\\", "/")).lower()
        return self.index.get("#" + name) or self.stock(name)


def manifest():
    out = set()
    for line in open(os.path.join(HERE, "..", "web", "gamedata.manifest")):
        line = line.strip()
        if line and not line.startswith("#"): out.add(line.lower())
    return out


def info(d, ents, say=print):
    spawns = [e for e in ents if g(e, "classname") in ("info_player_start", "info_player_deathmatch")]
    btn = {"start": [], "stop": []}
    for e in ents:
        if g(e, "classname") not in ("func_button", "func_rot_button"): continue
        t = g(e, "target").lower()
        kind = "start" if t in KZ_START else "stop" if t in KZ_STOP else None
        m = g(e, "model")
        if kind and m.startswith("*"):
            lo, hi = model_bounds(d, int(m[1:]))
            btn[kind].append([(a + b) / 2 for a, b in zip(lo, hi)])
    # no buttons: the end is often a trigger_multiple that fires a "Thanks for playing" / "Congratulations" text
    msgs = {g(e, "targetname"): g(e, "message") for e in ents if g(e, "classname") == "game_text"}
    ends = []
    for e in ents:
        m = g(e, "model")
        if g(e, "classname") == "trigger_multiple" and m.startswith("*") and re.search(r"thank|congrat|finish|you win|the end|well done", msgs.get(g(e, "target"), ""), re.I):
            ends.append(model_bounds(d, int(m[1:])))
    btn["end"] = ends
    for lo, hi in ends: say(f"    finish trigger {' '.join(f'{v:.0f}' for v in lo)}  {' '.join(f'{v:.0f}' for v in hi)}")
    tele = sum(1 for e in ents if g(e, "classname") == "trigger_teleport")
    say(f"  spawns: {len(spawns)}  kreedz buttons: {len(btn['start'])} start, {len(btn['stop'])} stop  trigger_teleport: {tele}")
    for k in ("start", "stop"):
        for c in btn[k]: say(f"    {k} button at {c[0]:.0f} {c[1]:.0f} {c[2]:.0f}")
    return spawns, btn


def draft_ini(name, spawns, btn, mode):
    lines = [f"; {name}: zone .ini draft from tools/race_map.py. Check every line in game (csp_test_remote, csp_probe).",
             f"pool {mode}" if mode else "; pool surf|bhop|climb|maze  (else by the map's name)"]
    for e in spawns[:4]:
        x, y, z = (float(v) for v in g(e, "origin", "0 0 0").split())
        yaw = float((g(e, "angles", "0 0 0").split() + ["0"] * 3)[1]) if g(e, "angles") else float(g(e, "angle", "0") or 0)
        lines.append(f"spawn {x:.0f} {y:.0f} {z + 1:.0f} {yaw:.0f}")
    if btn["stop"]: lines.append("buttons 1")
    elif btn["end"]: lo, hi = btn["end"][0]; lines.append("finish " + " ".join(f"{v:.0f}" for v in (*lo, *hi)))
    else: lines.append("; finish x1 y1 z1 x2 y2 z2   <- the end of the course (no kreedz stop button found)")
    lines.append("progress dist")
    return "\n".join(lines) + "\n"


def build(a):
    src = a.bsp; name = a.name or os.path.splitext(os.path.basename(src))[0]
    d = open(src, "rb").read()
    ver = struct.unpack_from("<i", d)[0]
    if ver != 30: sys.exit(f"{name}: BSP version {ver} ({d[:4]!r}), not 30 (Half-Life). Not a GoldSrc map.")
    ents = entities(d)
    world = ents[0]
    content = list(a.content) + [os.path.dirname(os.path.abspath(src))]
    f = Finder(content, a.game)
    fatal, warn = [], []
    files = {}   # path under cstrike/ -> bytes or source path   (server and web)

    # textures: every one the map takes from a WAD goes into NAME.wad
    external, keys, sky = bsp_info(src)
    wads = []
    for k in keys:
        p = f.wad(k)
        if p: wads.append((k, wad_read(p)))
        else: warn.append(f"WAD {k} is nowhere (dropped from the key)")
    take = {}
    for tex in sorted(external):
        for k, (magic, lumps) in wads:
            if tex in lumps: take[tex] = lumps[tex]; break
        else: warn.append(f"texture {tex} is in none of its WADs (it will show as missing)")
    world = [(k, v) for k, v in world if k != "wad"]
    if take:
        magic = wads[0][1][0] if wads else b"WAD3"
        files[f"{name}.wad"] = wad_write(magic, take, take.keys())
        world.insert(0, ("wad", f"{name}.wad"))
    ents[0] = world
    files[f"maps/{name}.bsp"] = set_entities(d, ents)

    # sky
    for side in ("bk", "dn", "ft", "lf", "rt", "up"):
        rel = f"gfx/env/{sky}{side}.tga"
        p = f.custom(rel) or f.stock(rel)
        if p: files[rel] = p
        else: warn.append(f"sky {rel} is nowhere (the client draws black)")

    # models, sprites, sounds named by entities
    known = manifest()
    for e in ents:
        for k, v in e:
            m = RES_RE.match(v.strip())
            if not m: continue
            rel = m.group(1).replace("\\", "/")
            if rel.lower().endswith(".wav") and not rel.lower().startswith("sound/"): rel = "sound/" + rel
            own = f.custom(rel)
            if own: files[rel] = own; continue
            st = f.stock(rel)
            if not st:
                (fatal if not rel.lower().endswith(".wav") else warn).append(f"{g(e, 'classname')} {k}: {rel} is nowhere")
            elif "cstrike/" + rel.lower() not in known and "valve/" + rel.lower() not in known and os.path.getsize(st) > 16384:
                files.setdefault("web-only:" + rel, st)   # stock, but not in gamedata.zip: the browser needs it in the pack

    nav = a.nav or f.custom(f"maps/{name}.nav")
    if nav: files[f"server-only:maps/{name}.nav"] = nav   # bots run on the server; the browser never reads it
    else: warn.append(f"no maps/{name}.nav yet: make one (tools/harness/gennav.sh) or the plugin leaves the map out")
    print(f"{name}: {len(take)} textures from {len(wads)} WADs, sky {sky}, {len(files)} files")
    for w in warn: print("  warning:", w)
    for w in fatal: print("  FATAL:", w)
    spawns, btn = info(d, ents)
    if fatal and not a.force: sys.exit(f"{name}: refused, HLDS would quit loading it")

    # the browser pack first: a map over the phone budget writes nothing at all
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, v in sorted(files.items()):
            if rel.startswith("server-only:"): continue
            z.writestr("cstrike/" + rel.replace("web-only:", ""), v if isinstance(v, bytes) else open(v, "rb").read())
    size = buf.tell()
    print(f"  browser pack: {size / 1048576:.1f} MB zipped (budget {a.budget_mb} MB)")
    if size > a.budget_mb * 1048576 and not a.force:
        sys.exit(f"{name}: browser pack is over the {a.budget_mb} MB budget; left out (--force to keep it)")
    out = a.out
    srv = os.path.join(out, "server", "cstrike")
    for rel, v in files.items():
        if rel.startswith("web-only:"): continue
        rel = rel.replace("server-only:", "")
        p = os.path.join(srv, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "wb").write(v if isinstance(v, bytes) else open(v, "rb").read())
    os.makedirs(os.path.join(out, "web"), exist_ok=True)
    open(os.path.join(out, "web", f"{name}.zip"), "wb").write(buf.getvalue())
    ini = os.path.join(out, f"{name}.ini.draft")
    if not os.path.exists(ini):
        open(ini, "w").write(draft_ini(name, spawns, btn, "climb" if btn["stop"] else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("bsp"); b.add_argument("--game", required=True)
    b.add_argument("--content", action="append", default=[]); b.add_argument("--out", default="build/racemaps")
    b.add_argument("--name"); b.add_argument("--nav"); b.add_argument("--budget-mb", type=float, default=6.0); b.add_argument("--force", action="store_true")
    i = sub.add_parser("info"); i.add_argument("bsp")
    a = ap.parse_args()
    if a.cmd == "build": build(a)
    else:
        d = open(a.bsp, "rb").read(); ents = entities(d)
        print(f"{a.bsp}: BSP version {struct.unpack_from('<i', d)[0]}, worldspawn wad = {g(ents[0], 'wad')!r}")
        info(d, ents)


if __name__ == "__main__":
    main()
