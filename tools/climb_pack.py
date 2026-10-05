#!/usr/bin/env python3
"""The Climb race pack (ISSUE): ten beginner kreedz maps from kreedz.com, made ready for the race pool.

  climb_pack.py --game <dir with cstrike/ and valve/> [--dl build/climbdl] [--out build/racemaps]

For each map: download it (kreedz.com map API, the old xtreme-jumps archive), apply the fixes below, then
tools/race_map.py build (WADs, sky, models, the browser map pack under the phone budget) and a one-area zBot nav
stub (gen_minigame_maps.write_nav_stub over the .ini's spawn points: bots stand at the start and finish on a clock,
and the pool leaves out any map without a .nav). Zone .ini files are in maps/pool/<map>.ini, authors in
maps/CREDITS.md.
"""
import argparse, io, os, subprocess, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from race_map import entities, set_entities
from gen_minigame_maps import write_nav_stub

# map -> worldspawn skyname to use instead of the map's own (None: keep it)
MAPS = {
    "kz_xj_mountez": None,
    "cobkz_minecraft": None,
    "kz_ea_oldgraveyard": None,
    "kzbg_ytt_pyramid": "dusk",       # names a sky it doesn't ship ("thehell"): the client would draw black
    "skitz_bean_valley": None,
    "kz_darkmine": "DrkG",            # "drkg": the stock sky is DrkG, and the browser's file system is case-sensitive
    "kz_kzse_towerblock": None,
    "kz_j2s_summercliff_ez": None,
    "kz_cliffez": None,
    "kz_xj_ezbrickjump": None,
}
# the plugin's KZ_STOP list: a func_button aimed at one of these is the stop-timer button
STOP_TARGETS = {"counter_off", "clockstopbutton", "clockstop", "but_stop", "counter_stop_button", "multi_stop",
                "stop_counter", "m_counter_end_emi"}


def fetch(name, dl):
    z = os.path.join(dl, name + ".zip")
    if not os.path.exists(z):
        req = urllib.request.Request(f"https://kreedz.com/api/map/{name}", headers={"User-Agent": "Mozilla/5.0 (csparty)"})
        for attempt in range(4):
            try:
                open(z, "wb").write(urllib.request.urlopen(req, timeout=120).read()); break
            except Exception as e:   # the API rate-limits (429): back off
                print(f"  {name}: {e}; retrying"); time.sleep(30)
        else:
            sys.exit(f"{name}: download failed")
        time.sleep(5)
    root = os.path.join(dl, name)
    if not os.path.isdir(root): zipfile.ZipFile(z).extractall(root)
    for dp, _dn, fn in os.walk(root):
        if name + ".bsp" in fn: return os.path.join(dp, name + ".bsp"), os.path.dirname(dp)
    sys.exit(f"{name}: no maps/{name}.bsp in the download")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True); ap.add_argument("--dl", default="build/climbdl"); ap.add_argument("--out", default="build/racemaps")
    a = ap.parse_args()
    os.makedirs(a.dl, exist_ok=True)
    repo = os.path.dirname(HERE)
    for name, sky in MAPS.items():
        bsp, content = fetch(name, a.dl)
        d = open(bsp, "rb").read(); ents = entities(d); fixed = False
        if sky:
            ents[0][:] = [(k, v) for k, v in ents[0] if k != "skyname"] + [("skyname", sky)]; fixed = True
        for e in ents:
            # a stop button with a master only unlocks after the start button is pressed; the plugin times the race,
            # not the map's clock, so the stop button must work on its own
            kv = dict(e)
            if kv.get("classname") == "func_button" and kv.get("target", "").lower() in STOP_TARGETS and "master" in kv:
                e[:] = [(k, v) for k, v in e if k != "master"]; fixed = True
        if fixed:
            bsp = os.path.join(a.dl, name + ".fixed.bsp"); open(bsp, "wb").write(set_entities(d, ents))
        subprocess.run([sys.executable, os.path.join(HERE, "race_map.py"), "build", bsp, "--name", name, "--game", a.game,
                        "--content", content, "--out", a.out], check=True)
        ini = os.path.join(repo, "maps", "pool", name + ".ini")
        sp = [list(map(float, l.split()[1:4])) for l in open(ini) if l.startswith("spawn ")]
        lo = (min(p[0] for p in sp) - 64, min(p[1] for p in sp) - 64, min(p[2] for p in sp) - 36)
        hi = (max(p[0] for p in sp) + 64, max(p[1] for p in sp) + 64, 0)
        built = os.path.join(a.out, "server", "cstrike", "maps", name + ".bsp")
        write_nav_stub(built, (lo, hi), built[:-4] + ".nav")


if __name__ == "__main__":
    main()
