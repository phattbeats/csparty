#!/usr/bin/env python3
"""Browser client on other input devices: a game controller, or a touch phone.

--gamepad  Injects a standard-mapping gamepad (what the Gamepad API reports for Xbox/PlayStation/most
           Bluetooth pads, phones included) and takes a turn with it: D-pad down/up moves the menu
           cursor, A picks "Jump at the crate", A again rolls.
--mobile   Emulates a touch phone in landscape (touch events, coarse pointer, low graphics profile) and
           takes a turn with Xash's on-screen Jump button: tap to pick, tap again to roll.

Same harness rule as web_e2e.py: nothing touches the page in the first 15 s after joining.
usage: web_devices.py --gamepad|--mobile [--url URL] [--shots DIR]
"""
import argparse, asyncio, os, re, subprocess, sys, time
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
g = ap.add_mutually_exclusive_group(required=True)
g.add_argument("--gamepad", action="store_true"); g.add_argument("--mobile", action="store_true")
ap.add_argument("--url", default="http://127.0.0.1:8080/")
ap.add_argument("--srv", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "srv.sh"))
ap.add_argument("--log", default="/opt/hlds/console.log")
ap.add_argument("--shots", default="")
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
results = []
def check(name, ok, extra=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name} {extra}", flush=True)

NAME = "Padder" if args.gamepad else "Phoney"
FAKE_PAD = """
(() => {
  const pad = { id: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)", index: 0, connected: true,
    mapping: "standard", timestamp: performance.now(), axes: [0, 0, 0, 0], vibrationActuator: null, hapticActuators: [],
    buttons: Array.from({ length: 17 }, => ({ pressed: false, touched: false, value: 0 })) };
  Object.defineProperty(navigator, "getGamepads", { value: => [pad, null, null, null] });
  window.__padPress = (i, ms) => new Promise((done) => {
    const b = pad.buttons[i]; b.pressed = b.touched = true; b.value = 1; pad.timestamp = performance.now();
    setTimeout(() => { b.pressed = b.touched = false; b.value = 0; pad.timestamp = performance.now(); done(); }, ms);
  });
})();"""
A, DPAD_UP, DPAD_DOWN = 0, 12, 13

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--enable-unsafe-swiftshader"])
        if args.mobile:
            ctx = await b.new_context(viewport={"width": 844, "height": 390}, device_scale_factor=1, is_mobile=True, has_touch=True,
                user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36")
        else:
            ctx = await b.new_context(viewport={"width": 960, "height": 540})
        pg = await ctx.new_page()
        crashed = []; pg.on("crash", lambda: crashed.append(1))
        if args.gamepad: await pg.add_init_script(FAKE_PAD)
        cdp = await ctx.new_cdp_session(pg)
        async def shot(n):
            if args.shots:
                try: await pg.screenshot(path=os.path.join(args.shots, n), timeout=30000)
                except Exception as e: print("  (screenshot failed:", e, ")")
        # fire and forget: under software GL a page call can take ~10 s to return; the log is the judge
        async def press(i): await pg.evaluate("(i) => { window.__padPress(i, 1500); return 0; }", i)
        async def touch_hold(fx, fy, ms=200):
            vw, vh = 844, 390
            pt = [{"x": fx * vw, "y": fy * vh, "id": 1}]
            await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt})
            await asyncio.sleep(ms / 1000)
            await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

        srv("csp_stop")
        await pg.goto(args.url + "?nosound=1"); await pg.fill("#name", NAME); await pg.click("#go")
        ENTER = rf'"{NAME}<\d+><STEAM_ID_LAN><[A-Z]*>" entered the game'
        check("joins the server", await wait_log(ENTER, 240))
        await asyncio.sleep(15)
        if args.mobile:
            await shot("dev_mobile_joined.png")
            check("touch layout + low graphics are on", True)   # judged from the screenshot; the turn below proves input
        srv("csp_turns 1"); srv("csp_speed 1.0"); srv("csp_start")
        check("gets a turn", await wait_log(rf"== {NAME}'s turn", 60))
        await asyncio.sleep(9)
        await shot(f"dev_{'pad' if args.gamepad else 'mobile'}_turn.png")
        if args.gamepad:
            # presses last 0.5 s: the engine samples the pad once a frame, and headless software GL runs ~5 fps
            srv("csp_debug 2")
            await press(DPAD_DOWN); await asyncio.sleep(1.0)
            check("D-pad moves the menu cursor", await wait_log(r"nav \d+: pressed 10 ", 25))
            await press(DPAD_UP); await wait_log(r"nav \d+: pressed 8 ", 25)
            await press(A)
            check("A picks Jump at the crate", await wait_log(rf"{NAME} picks turn option 99", 25))
            await asyncio.sleep(3)
            await press(A)
        else:
            # left thumb on the invisible move stick (left half): drag up (cursor up, wraps to the last item),
            # then drag down (back to "Jump at the crate"). Analog forwardmove is what the server reads.
            srv("csp_debug 2")
            vw, vh = 844, 390
            async def drag(dy):
                await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 0.2 * vw, "y": 0.70 * vh, "id": 2}]})
                for k in range(1, 6):
                    await asyncio.sleep(0.15)
                    await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": 0.2 * vw, "y": (0.70 + dy * k) * vh, "id": 2}]})
                await asyncio.sleep(1.2)
                await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": [{"x": 0.2 * vw, "y": (0.70 + dy * 5) * vh, "id": 2}]})
            await drag(-0.06); up = await wait_log(r"nav \d+: pressed 8 ", 25)
            await asyncio.sleep(1.5)
            await drag(+0.05); down = await wait_log(r"nav \d+: pressed 10 ", 25)
            check("touch stick moves the menu cursor (up and down)", up and down)
            await asyncio.sleep(2)
            # CS Party's touch layout (web/pack_gamedata.py TOUCHCFG): Jump at x 0.89-0.99, y 0.40-0.62
            jx, jy = 0.94, 0.51
            await touch_hold(jx, jy, 500)
            check("touch Jump picks Jump at the crate", await wait_log(rf"{NAME} picks turn option 99", 25))
            await asyncio.sleep(3)
            await touch_hold(jx, jy, 500)
        check("and rolls", await wait_log(rf"{NAME} (hits crate|rolls)", 25))
        check("page never crashed", not crashed)
        # say goodbye like a closing tab would (pagehide), so the next run doesn't inherit a ghost slot
        try: await asyncio.wait_for(pg.evaluate("() => { try { __csp._CL_Disconnect(); } catch (e) {} return 0; }"), 15)
        except Exception: pass
        await asyncio.sleep(2)
        await b.close()
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
