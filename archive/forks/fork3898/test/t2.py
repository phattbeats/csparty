import subprocess, time, sys
from playwright.sync_api import sync_playwright
srv=None
time.sleep(1)
ok = True
def check(c, m):
    global ok; print(("PASS " if c else "FAIL ") + m); ok &= bool(c)
try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 800})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8771/")
    check(pg.locator("#char-grid input").count() == 9, "9 tiles (8 characters + Random)")
    check(pg.locator("#char-grid input:checked").get_attribute("value") == "-1", "default is Random")
    pg.screenshot(path="desk-random.png")
    pg.click("text=SEAL Team 6")
    check("3 3 3 4 4 4" in " ".join(pg.locator("#char-info .die i").all_inner_texts()), "info panel shows SEAL die")
    pg.keyboard.press("ArrowUp"); check(pg.locator("#char-grid input:checked").get_attribute("value") == "0", "up from SEAL -> Phoenix")
    pg.keyboard.press("ArrowLeft"); check(pg.locator("#char-grid input:checked").get_attribute("value") == "7", "left wraps -> GIGN")
    pg.keyboard.press("ArrowDown"); check(pg.locator("#char-grid input:checked").get_attribute("value") == "-1", "down from CT row -> Random")
    pg.keyboard.press("ArrowDown"); check(pg.locator("#char-grid input:checked").get_attribute("value") == "0", "down from Random -> first")
    pg.keyboard.press("ArrowRight"); pg.keyboard.press("ArrowRight")
    check(pg.locator("#char-grid input:checked").get_attribute("value") == "2", "right x2 -> Arctic")
    pg.screenshot(path="desk-arctic.png")
    pg.fill("#name", "Tester")
    pg.click("#go")
    pg.wait_for_function("window.__args", timeout=15000)
    a = pg.evaluate("window.__args")
    i = a.index("+setinfo", a.index("+name"))
    check(a[i:i+3] == ["+setinfo", "_csp_char", "2"], "engine gets +setinfo _csp_char 2: " + str(a[i:i+3]))
    pg.goto("http://127.0.0.1:8771/")
    check(pg.locator("#char-grid input:checked").get_attribute("value") == "2", "pick remembered on reload")
    pg.click("text=Random"); pg.fill("#name", "Tester"); pg.click("#go"); pg.wait_for_function("window.__args", timeout=15000)
    check("_csp_char" not in pg.evaluate("window.__args"), "Random sends no _csp_char")
    check(not errs, "no page errors " + str(errs))
    ph = b.new_page(viewport={"width": 844, "height": 390}, is_mobile=True, has_touch=True)
    ph.goto("http://127.0.0.1:8771/?char=6"); ph.screenshot(path="phone-landscape.png", full_page=True)
    check(ph.locator("#char-grid input:checked").get_attribute("value") == "6", "?char=6 preselects SAS")
    ph.tap("text=Guerilla Warfare"); check(ph.locator("#char-grid input:checked").get_attribute("value") == "3", "tap picks on phone")
    pp = b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    pp.goto("http://127.0.0.1:8771/"); pp.screenshot(path="phone-portrait.png", full_page=True)
    w = pp.evaluate("document.querySelector('#gate .card').scrollWidth <= innerWidth")
    check(w, "no horizontal overflow on portrait phone")
    b.close()
finally:
  pass
print("ALL PASS" if ok else "SOME FAILED")
