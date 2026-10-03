# headless browser client for map-overlay screenshots. Control: touch ctl/shot_<name> -> shots/<name>.png; ctl/quit ends.
import asyncio, os, sys, time
from playwright.async_api import async_playwright
D = os.path.dirname(os.path.abspath(__file__))
os.environ["LD_LIBRARY_PATH"] = D + "/chromelibs/root/usr/lib/x86_64-linux-gnu:" + D + "/chromelibs/root/lib/x86_64-linux-gnu"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/paperclip/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": int(sys.argv[1]) if len(sys.argv) > 1 else 960, "height": int(sys.argv[2]) if len(sys.argv) > 2 else 540})
        log = open(os.path.join(D, "client.log"), "w")
        pg.on("console", lambda m: (log.write(m.text + "\n"), log.flush()))
        await pg.goto("http://127.0.0.1:8124/?nosound&server=10.27.0.1:27015")
        await pg.fill("#name", "VQTest")
        await pg.click("#go")
        while True:
            for f in sorted(os.listdir(os.path.join(D, "ctl"))):
                os.remove(os.path.join(D, "ctl", f))
                if f == "quit": await b.close(); return
                if f.startswith("shot_"):
                    await pg.screenshot(path=os.path.join(D, "shots", f[5:] + ".png"))
                    open(os.path.join(D, "shots", f[5:] + ".done"), "w").close()
            await asyncio.sleep(0.3)
asyncio.run(main())
