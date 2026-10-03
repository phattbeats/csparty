import asyncio, os
from playwright.async_api import async_playwright
KEY = os.environ["KEY"]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": 1024, "height": 640})
        pg.on("pageerror", lambda e: print("PAGEERROR", e, flush=True))
        await pg.goto(f"http://127.0.0.1:8095/?key={KEY}&char=1&nosound")
        await pg.fill("#name", "TowerTest")
        await pg.click("#go")
        for i in range(30):                      # 30 x 15 s; the host script drives rcon and reads the log
            await asyncio.sleep(15)
            await pg.screenshot(path=f"/out/t{i:02d}.png")
            if os.path.exists("/out/STOP"): break
        await b.close()
asyncio.run(main())
