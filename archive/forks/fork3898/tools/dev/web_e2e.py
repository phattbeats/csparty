#!/usr/bin/env python3
"""End-to-end test of the browser client against a running CS Party server.

Joins from headless Chromium while a bot is wearing the player's name, takes a full board turn with the
keyboard (menu "2", Space at the crate), then rides a map-change minigame (de_dust2 -> csp_surf -> de_dust2)
and checks the player gets their own seat back, by owner, not just by name.

--stall drops all server->browser traffic for a few seconds as the server leaves csp_surf, so the client
misses the map change (the real-world stall). The page's watchdog has to notice and reconnect. Needs the
relay started with RELAY_DEV=1.

Needs: the relay serving web/public on :8080, ReHLDS + the plugin on de_dust2 (tools/dev/srv.sh),
Playwright with Chromium. Keys are dispatched as DOM KeyboardEvents: Playwright's real input
pipeline waits for an input ack that a software-GL page under load is slow to give.

Harness rule: never touch the page (evaluate, screenshot, key events) in the first ~10 s after the client
enters a map. Any DevTools-protocol call in that window sends headless Chromium's renderer into runaway
memory growth (+35-67 MB/s until the OOM killer). Measured: no call -> flat ~400 MB through both map
changes; a bare evaluate("1") at join -> 1.8 GB in 40 s. Players have no DevTools attached.

usage: web_e2e.py [--url http://127.0.0.1:8080/] [--shots DIR] [--no-minigame] [--stall] [--sound] [--key K]
"""
import argparse, asyncio, os, re, subprocess, sys, time, urllib.request
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8080/")
ap.add_argument("--srv", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "srv.sh"))
ap.add_argument("--log", default="/opt/hlds/console.log")
ap.add_argument("--shots", default="")
ap.add_argument("--no-minigame", action="store_true")
ap.add_argument("--skip-turn", action="store_true", help="skip the board turn (fewer page calls; see the harness rule)")
ap.add_argument("--stall", action="store_true", help="simulate a missed map change (relay must run with RELAY_DEV=1)")
ap.add_argument("--dev", default="", help="also run the engine with -dev and save its log to this file")
ap.add_argument("--key", default="", help="party key, if the relay runs with --key")
ap.add_argument("--sound", action="store_true", help="run with audio (default -nosound: headless has no device)")
args = ap.parse_args()

def srv(cmd): subprocess.run([args.srv, "cmd", cmd])
START = sum(1 for _ in open(args.log, errors="replace"))
def lines(): return open(args.log, errors="replace").read().splitlines()[START:]
def count(pat): return sum(1 for l in lines() if re.search(pat, l))
async def wait_log(pat, secs, n=1):
    t = time.time()
    while time.time() - t < secs:
        if count(pat) >= n: return True
        await asyncio.sleep(0.5)
    return False

# entered under any name the engine might have given the human (the name fix happens after entering)
SETTLE = 15   # seconds after entering a map before the test may touch the page (see the harness rule above)
ENTER = r'"(\(\d+\))?Alex<\d+><STEAM_ID_LAN><[A-Z]*>" entered the game'
# fire and forget: under software GL a page call can take ~10 s to return; the server log is the judge
KEY = """([k, code, kc, hold]) => {
  const ev = (t) => window.dispatchEvent(new KeyboardEvent(t, { key: k, code, keyCode: kc, which: kc, bubbles: true }));
  ev('keydown'); setTimeout(() => ev('keyup'), hold); return 0; }"""
results = []
def check(name, ok, extra=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name} {extra}", flush=True)

async def seat_is_mine(secs=20):
    """csp_state prints owner and actual player per seat; Alex's seat must be owned and played by Alex."""
    t = time.time()
    while time.time() - t < secs:
        mark = len(lines()); srv("csp_state"); await asyncio.sleep(1.5)
        new = lines()[mark:]
        if any(re.search(r"seat\d Alex \(.*\) owner=Alex player=Alex pos=", l) for l in new): return True
        await asyncio.sleep(2)
    return False

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": 960, "height": 540})
        pg.set_default_timeout(30000)
        crashed, errors, watch = [], [], []
        pg.on("crash", lambda: crashed.append(1))
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: watch.append(m.text) if m.text.startswith("[watch]") else None)
        async def shot(name):
            if args.shots:
                try: await pg.screenshot(path=os.path.join(args.shots, name), timeout=30000)
                except Exception as e: print("  (screenshot failed:", e, ")")
        async def overlay_hidden(secs):
            try: await pg.wait_for_function("document.getElementById('overlay').hidden", timeout=secs * 1000); return True
            except Exception: return False

        srv("csp_stop")
        srv("csp_botname Alex")                   # zBot names include real names; the human must still win
        q = [f"key={args.key}"] if args.key else []
        if not args.sound: q.append("nosound=1")
        if args.dev: q.append("dev=1")
        await pg.goto(args.url + ("?" + "&".join(q) if q else "")); await pg.fill("#name", "Alex"); await pg.click("#go")
        t0 = time.time()
        check("joins the server", await wait_log(ENTER, 240), f"({time.time() - t0:.0f}s from Join)")
        await asyncio.sleep(SETTLE)
        if count(r'"\(\d+\)Alex<\d+><STEAM_ID_LAN>'):
            check("gets their name back from a bot", await wait_log(r"Alex had their name taken by a bot; renamed back", 15))
        else:
            print("SKIP  name collision: no bot was wearing \"Alex\" when the player joined (bot quota reshuffled bots)")
        check("auto-joined a team", await wait_log(r'Alex auto-joins (TERRORIST|CT)', 20))
        check("join overlay clears", await overlay_hidden(60))
        await asyncio.sleep(3)
        await shot("e2e_joined.png")

        if not args.skip_turn:
            srv("csp_turns 1"); srv("csp_speed 1.0"); srv("csp_debug 2"); srv("csp_start")
            check("gets a turn", await wait_log(r"== Alex's turn", 60))
            await asyncio.sleep(9)                       # intro cut, then the turn menu
            await shot("e2e_turn.png")
            # cursor menus: S moves down, W back up, Space picks the highlighted "Jump at the crate", Space rolls
            await pg.evaluate(KEY, ["s", "KeyS", 83, 500]); down = await wait_log(r"nav \d+: pressed 10 ", 25)
            await pg.evaluate(KEY, ["w", "KeyW", 87, 500]); up = await wait_log(r"nav \d+: pressed 8 ", 25)
            check("W/S move the menu cursor", down and up)
            await pg.evaluate(KEY, [" ", "Space", 32, 500])
            check("Space picks Jump at the crate", await wait_log(r"Alex picks turn option 99", 25))
            await asyncio.sleep(3)
            await pg.evaluate(KEY, [" ", "Space", 32, 500])
            check("Space jumps into the crate", await wait_log(r"Alex (hits crate|rolls)", 25))
        if not args.skip_turn: check("seat is Alex's on the board", await seat_is_mine())

        if not args.no_minigame:
            srv("csp_stop"); await asyncio.sleep(2)
            srv("csp_test_remote 8")
            check("server changes to csp_surf", await wait_log(r'Started map "csp_surf"', 40))
            check("client follows to csp_surf", await wait_log(ENTER, 120, 2))
            await asyncio.sleep(SETTLE); await shot("e2e_surf.png")
            check("race finishes", await wait_log(r"wins the Surf Race|got the furthest", 160))
            if args.stall:
                # the server changes map ~5 s after the win; the client won't hear about it
                urllib.request.urlopen(args.url.rstrip("/") + "/dev/blackhole?secs=25").read()
            check("server returns to de_dust2", await wait_log(r'Started map "de_dust2"', 40))
            check("client follows back", await wait_log(ENTER, 150 if args.stall else 120, 3))
            await asyncio.sleep(SETTLE)
            check("overlay clear after the map change", await overlay_hidden(60))
            await asyncio.sleep(6)
            check("seat is Alex's after the round trip", await seat_is_mine(60))
            retries = [w for w in watch if "console: retry" in w]
            if args.stall: check("watchdog reconnected the stalled client", len(retries) >= 1, f"({len(retries)} retries)")
            else: check("watchdog stayed quiet", not retries, f"({len(retries)} retries)")

        if args.dev:
            try: open(args.dev, "w").write(await pg.evaluate("__csp.FS.readFile('/xash/engine.log', {encoding: 'utf8'})"))
            except Exception as e: print("  (engine log not saved:", e, ")")
        check("page never crashed", not crashed)
        check("no page errors", not errors, "; ".join(errors[:3]))
        print(f"overflow warnings for Alex: {count(r'overflow(ed)? (on|for) Alex')}")
        print("watch log:", " | ".join(watch[-12:]))
        # say goodbye like a closing tab would (pagehide), so the next run doesn't inherit a ghost slot
        try: await asyncio.wait_for(pg.evaluate("() => { try { __csp._CL_Disconnect(); } catch (e) {} return 0; }"), 15)
        except Exception: pass
        await asyncio.sleep(2)
        await b.close()
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
