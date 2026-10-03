#!/usr/bin/env python3
"""Pack the game data a CS Party browser client needs into gamedata.zip, from a CS 1.6 install you own.

The zip is served by YOUR relay to YOUR players. Never publish it: it's Valve's content.

What goes in:
  - every file in gamedata.manifest (traced from a real client session; see tools/dev/trace_client.sh)
  - every small file (<= 16 KB) under valve/ and cstrike/: configs, scripts, small sprites. Cheap insurance.
  - the maps you list, with their .res/.txt and overview
  - WADs, sliced: only the textures each map actually resolves from each WAD in its "wad" key.
    de_dust2 pulls 8 textures from the 36 MB halflife.wad; the sliced copy is a few KB.
  - decals.wad / gfx.wad / fonts.wad / spraypaint.wad / cached.wad whole (the engine uses them outside of maps)

Anything the server precaches that's missing here still works: the client downloads it over the game
channel (sv_allowdownload 1). The manifest just keeps that from happening at every join.

usage: pack_gamedata.py <dir containing valve/ and cstrike/> <out.zip> [extra maps...]
"""
import os, re, struct, sys, zipfile

SRC, OUT = sys.argv[1], sys.argv[2]
MAPS = ["de_dust2", "de_inferno", "de_aztec", "csp_surf", "csp_bhop", "csp_climb", "csp_maze", "csp_towers"] + sys.argv[3:]
HERE = os.path.dirname(os.path.abspath(__file__))
WHOLE_WADS = {"decals.wad", "gfx.wad", "spraypaint.wad", "cached.wad", "fonts.wad"}
SKIP_DIRS = ("/maps", "/dlls", "/cl_dlls", "/addons", "/logs", "/media", "/overviews", "/SAVE")
SMALL = 16384

AUTOEXEC = b"""cl_ticket_generator revemu2013
cl_advertise_engine_in_name 0
_vgui_menus 0
fps_max 100
hud_draw 1
gl_check_errors 0
"""

# Touch layout for phones. Replaces cs16-client's deathmatch preset (bot menu, team change, buy, nine
# weapon slots over the turn menu). CS Party's screen: menus on the left, HUD in the top-centre column
# (the plugin moves it there for touch players), so buttons stay low on the right and in the top strip.
# Coordinates are fractions of the screen; textures from cs16-client's extras.pk3.
TOUCHCFG = b"""// CS Party touch layout
touch_config_file "touch.cfg"
touch_forwardzone "0.12"
touch_sidezone "0.07"
touch_pitch "60"
touch_yaw "60"
touch_move_indicator "3"
touch_set_stroke 1 242 163 58 180
touch_highlight_r "0.95"
touch_highlight_g "0.64"
touch_highlight_b "0.23"
touch_highlight_a "1.0"
touch_removeall
touch_addbutton "move" "" "_move" 0.00 0.30 0.45 1.00 255 255 255 150 0
touch_addbutton "look" "" "_look" 0.45 0.30 1.00 1.00 255 255 255 150 0
touch_addbutton "jump" "touch/gfx/jump" "+jump" 0.89 0.40 0.99 0.62 255 255 255 170 0 1
touch_addbutton "duck" "touch/gfx/duck" "+duck" 0.89 0.70 0.99 0.92 255 255 255 150 0 1
touch_addbutton "attack" "touch/gfx/attack" "+attack" 0.78 0.52 0.88 0.74 255 255 255 170 0 1
touch_addbutton "attack2" "touch/gfx/attack2" "+attack2" 0.78 0.28 0.88 0.50 255 255 255 140 0 1
touch_addbutton "use" "touch/gfx/use" "+use" 0.78 0.77 0.88 0.99 255 255 255 150 0 1
touch_addbutton "reload" "touch/gfx/reload" "+reload" 0.68 0.80 0.76 0.97 255 255 255 140 0 1
touch_addbutton "prev" "touch/gfx/left" "invprev" 0.17 0.00 0.23 0.13 255 255 255 140 0 1
touch_addbutton "next" "touch/gfx/right" "invnext" 0.23 0.00 0.29 0.13 255 255 255 140 0 1
touch_addbutton "chat" "touch/gfx/chat_all" "messagemode" 0.29 0.00 0.35 0.13 255 255 255 140 0 1
touch_addbutton "score" "touch/gfx/score" "+showscores" 0.62 0.00 0.68 0.13 255 255 255 140 0 1
touch_addbutton "menu" "touch/gfx/exit" "cancelselect" 0.68 0.00 0.74 0.13 255 255 255 140 0 1
"""

# Controller layout. It has to live in userconfig.cfg: the engine runs autoexec.cfg, then Valve's
# config.cfg, which starts with "unbindall" and wipes every pad bind; userconfig.cfg runs after it.
# (Gamepad API: USB or Bluetooth pads, phones included. Sticks: left moves, right looks.)
USERCONFIG = b"""// CS Party controller layout
bind A_BUTTON "+jump"            // jump; in CS Party menus: pick
bind B_BUTTON "+use"             // use; in CS Party menus: back
bind X_BUTTON "+reload"
bind Y_BUTTON "+showscores"
bind DPAD_UP "+forward"          // CS Party menus: cursor up
bind DPAD_DOWN "+back"           // CS Party menus: cursor down
bind DPAD_LEFT "invprev"
bind DPAD_RIGHT "invnext"
bind RTRIGGER "+attack"
bind LTRIGGER "+attack2"
bind R1_BUTTON "invnext"
bind L1_BUTTON "+duck"
bind STICK1 "+speed"
bind STICK2 "+duck"
bind BACK "+showscores"
bind START "cancelselect"
"""

def src(p): return os.path.join(SRC, p)

# ---------------------------------------------------------------- wads
def wad_read(path):
    d = open(path, "rb").read()
    magic, n, ofs = struct.unpack_from("<4sii", d, 0)
    lumps = {}
    for i in range(n):
        filepos, disksize, size, typ, comp, _p1, _p2 = struct.unpack_from("<iiibbbb", d, ofs + 32 * i)
        name = d[ofs + 32 * i + 16: ofs + 32 * i + 32].split(b"\0")[0]
        lumps[name.decode("latin1").lower()] = (name, typ, comp, size, d[filepos: filepos + disksize])
    return magic, lumps

def wad_write(magic, lumps, names):
    body = bytearray(b"\0" * 12); entries = []
    for nm in sorted(names):
        raw, typ, comp, size, data = lumps[nm]
        entries.append((len(body), len(data), size, typ, comp, raw)); body += data
        while len(body) % 4: body += b"\0"
    ofs = len(body)
    for filepos, disksize, size, typ, comp, raw in entries:
        body += struct.pack("<iiibbbb", filepos, disksize, size, typ, comp, 0, 0) + raw[:16].ljust(16, b"\0")
    struct.pack_into("<4sii", body, 0, magic, len(entries), ofs)
    return bytes(body)

def bsp_info(path):
    d = open(path, "rb").read()
    lumps = [struct.unpack_from("<ii", d, 4 + 8 * i) for i in range(15)]
    ofs, _ = lumps[2]
    n, = struct.unpack_from("<i", d, ofs)
    external = set()
    for i in range(n):
        o, = struct.unpack_from("<i", d, ofs + 4 + 4 * i)
        if o < 0: continue
        name = d[ofs + o: ofs + o + 16].split(b"\0")[0].decode("latin1").lower()
        mip, = struct.unpack_from("<I", d, ofs + o + 24)
        if mip == 0: external.add(name)
    ents = d[lumps[0][0]: lumps[0][0] + lumps[0][1]].decode("latin1", "replace")
    m = re.search(r'"wad"\s+"([^"]*)"', ents)
    keys = [os.path.basename(w.replace("\\", "/")).lower() for w in (m.group(1) if m else "").split(";") if w.strip()]
    sky = re.search(r'"skyname"\s+"([^"]*)"', ents)
    return external, keys, (sky.group(1) if sky else "desert")

def find_wad(name):
    for top in ("cstrike", "valve"):
        if os.path.isfile(src(f"{top}/{name}")): return f"{top}/{name}"
    return None

# ---------------------------------------------------------------- collect
files = {}   # zip path -> bytes or source path
def add(p):
    if os.path.isfile(src(p)): files[p] = src(p)

for line in open(os.path.join(HERE, "gamedata.manifest")):
    line = line.strip()
    if line and not line.startswith("#"): add(line)

for top in ("valve", "cstrike"):
    for dp, dn, fn in os.walk(src(top)):
        rel = os.path.relpath(dp, SRC)
        if any(s in "/" + rel for s in SKIP_DIRS): continue
        for f in fn:
            p = os.path.join(rel, f)
            if f.endswith((".wad", ".so", ".dll", ".dylib", ".bsp", ".nav")) or f in ("motd.txt", "listenserver.cfg", "server.cfg"): continue
            if os.path.getsize(src(p)) <= SMALL: files.setdefault(p, src(p))

need = {}    # wad path -> texture names
for m in MAPS:
    bsp = f"cstrike/maps/{m}.bsp"
    if not os.path.isfile(src(bsp)): sys.exit(f"missing map {bsp}")
    add(bsp)
    add(f"cstrike/maps/{m}.res")   # not maps/<map>.txt: cs16-client pops that briefing up, clipped, over the MOTD
    for ext in ("bmp", "tga", "txt"): add(f"cstrike/overviews/{m}.{ext}")
    external, keys, sky = bsp_info(src(bsp))
    for side in ("bk", "dn", "ft", "lf", "rt", "up"):
        for top in ("cstrike", "valve"): add(f"{top}/gfx/env/{sky}{side}.tga")
    wads = [(w, wad_read(src(w))[1]) for w in filter(None, map(find_wad, keys))]
    for tex in external:
        for w, lumps in wads:            # the engine takes the first keyed wad that has it
            if tex in lumps: need.setdefault(w, set()).add(tex); break
        else: print(f"  warning: {m}: texture {tex} is in none of {keys}")
add("cstrike/models/csp_dice.mdl")

for w in WHOLE_WADS:
    p = find_wad(w)
    if p: files[p] = src(p)
for w, names in need.items():
    if os.path.basename(w) in WHOLE_WADS: continue
    magic, lumps = wad_read(src(w))
    files[w] = wad_write(magic, lumps, names)
    print(f"  {w}: {len(names)} of {len(lumps)} textures")

# stock gamedll paths: a dedicated server's liblist.gam points at Metamod, which a browser can't load
lib = open(src("cstrike/liblist.gam"), encoding="latin1").read()
files["cstrike/liblist.gam"] = re.sub(r'(?m)^gamedll_linux .*$', 'gamedll_linux "dlls/cs.so"', lib).encode("latin1")
files["cstrike/autoexec.cfg"] = AUTOEXEC
files["cstrike/userconfig.cfg"] = USERCONFIG
files["cstrike/touch.cfg"] = TOUCHCFG

# ---------------------------------------------------------------- write
if os.path.exists(OUT): os.remove(OUT)
raw = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p in sorted(files):
        v = files[p]
        if isinstance(v, bytes): z.writestr(p, v); raw += len(v)
        else: z.write(v, p); raw += os.path.getsize(v)
print(f"{OUT}: {len(files)} files, {raw >> 20} MB unpacked, {os.path.getsize(OUT) >> 20} MB zipped")
