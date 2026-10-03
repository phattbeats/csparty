import asyncio, os, subprocess, re, time
from playwright.async_api import async_playwright
KEY = os.environ["KEY"]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
        pg = await b.new_page(viewport={"width": 1024, "height": 640})
        await pg.goto(f"http://127.0.0.1:8095/?key={KEY}&char=1&nosound")
        await pg.fill("#name", "CharTest")
        await pg.screenshot(path="/out/live-gate.png")
        await pg.click("#go")
        await asyncio.sleep(170)   # join + settle; the host script drives rcon and reads the log
        await pg.screenshot(path="/out/live-ingame.png")
        await b.close()
asyncio.run(main())
