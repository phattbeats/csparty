// PHA-4121 (tools/dev/touchmenu_e2e.js): the phone's menu buttons, end to end on the ISOLATED test stack.
// One landscape touch player (real CDP touch events, GPU browser) sits on its own turn menu and works the buttons.
// Runs in the Playwright image on the RAID: relay :8221, server :27121 (never the live ones).
// env: KEY, RPW, RELAY (http://127.0.0.1:8221), RPORT (27121), OUT (/work/out), DESKTOP=1 for the keyboard/mouse regression run
// Every check prints "PASS|FAIL name detail"; exit code 1 when anything failed.
const { chromium, devices } = require("playwright");
const dgram = require("dgram");
const fs = require("fs");

const RELAY = process.env.RELAY || "http://127.0.0.1:8221", RPORT = +(process.env.RPORT || 27121), OUT = process.env.OUT || "/work/out";
const DESKTOP = !!process.env.DESKTOP;
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const note = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

function rcon(cmd) {
  return new Promise((ok) => {
    const s = dgram.createSocket("udp4"); const H = Buffer.from([255, 255, 255, 255]);
    let out = "", timer;
    const done = () => { try { s.close(); } catch {} ok(out || "timeout"); };
    timer = setTimeout(done, 4000);
    s.on("message", (m) => {
      const t = m.slice(4).toString();
      const c = /challenge rcon (\d+)/.exec(t);
      if (c) s.send(Buffer.concat([H, Buffer.from(`rcon ${c[1]} "${process.env.RPW}" ${cmd}\n`)]), RPORT, "127.0.0.1");
      else { out += t.replace(/^l/, ""); clearTimeout(timer); timer = setTimeout(done, 600); }
    });
    s.send(Buffer.concat([H, Buffer.from("challenge rcon\n")]), RPORT, "127.0.0.1");
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = DESKTOP ? await browser.newContext({ viewport: { width: 1280, height: 720 } })
    : await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: devices["Pixel 7"].userAgent });
  const pg = await ctx.newPage();
  const cdp = await ctx.newCDPSession(pg);
  const cmds = [], navlog = [], cmdT = [];          // every console command the page sent
  pg.on("console", (m) => { const t = m.text(); if (t.startsWith("[nav]")) navlog.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + t); const c = /\[watch\] console: (.*)$/.exec(t); if (c) { cmds.push(c[1]); cmdT.push(((Date.now() - t0) / 1000).toFixed(1) + "s"); } });
  pg.on("pageerror", (e) => { check("no page errors", false, e.message); });
  await pg.addInitScript(() => { try { localStorage.setItem("csp_primer", "1"); } catch {} });
  await pg.goto(`${RELAY}/?key=${process.env.KEY}&nosound=1`, { waitUntil: "domcontentloaded" });
  await pg.fill("#name", DESKTOP ? "phaDK" : "phaTT"); await pg.click("#go");
  for (let i = 0; i < 400; i++) { if (await pg.evaluate(() => !!window.__csp && !document.getElementById("gate").offsetParent)) break; await sleep(500); }
  note("joined; waiting for the game state");
  await sleep(25000);
  const rc = async (...cmds) => { for (const c of cmds) await rcon(c); };   // one command per packet: rcon stops at the first ';'
  await rc("sv_timeout 900", "csp_turn_timeout 0", "csp_speed 0.5");   // 0: the turn waits for the player, so a menu can't expire mid-test
  if (!/state=1/.test(await rcon("csp_state"))) await rcon("csp_start");

  const pad = () => pg.evaluate(() => {
    const p = document.getElementById("navpad"), r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return {
      hidden: p.hidden,
      rows: [...document.querySelectorAll("#nav-rows button")].map((b) => ({ n: b.querySelector("b").textContent, label: b.querySelector("span").textContent, cur: b.classList.contains("cur"), ...r(b) })),
      ctl: [...document.querySelectorAll("#nav-ctl button")].filter((b) => !b.hidden).map((b) => ({ act: b.dataset.act, label: b.textContent, ...r(b) })),
      down: document.querySelectorAll("#navpad .down").length,
      box: r(document.getElementById("nav-box")),
    };
  });
  const waitPad = async (pred, ms = 20000, what = "pad") => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await pad(); if (pred(s)) return s; await sleep(250); } check(`wait ${what}`, false, JSON.stringify(s).slice(0, 300)); return s; };
  const shot = async (n) => { try { await pg.screenshot({ path: `${OUT}/${n}.png`, timeout: 20000 }); note(`shot ${n}`); } catch (e) { note(`shot ${n} FAILED`); } };
  const ctr = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  let held = 0;   // how many buttons the pad showed as pressed right after the last touchStart: proves a "sends nothing" test really pressed something
  const tStart = async (pts) => { await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) }); await sleep(40); held = await pg.evaluate(() => document.querySelectorAll("#navpad .down").length); };
  const tMove = (pts) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
  const tEnd = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const tCancel = () => cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  // rotate through the CDP metrics override, as a phone does (Playwright's setViewportSize rebuilds the emulation: touch events keep working but pointer events lose their coordinates)
  const rotate = async (w, h) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: w > h ? "landscapePrimary" : "portraitPrimary", angle: w > h ? 90 : 0 } }); await sleep(1500); };
  const tapFast = async (b) => { await tStart([ctr(b)]); await sleep(60); await tEnd(); };
  const tap = async (b) => { await sleep(500); await tapFast(b); };   // a person needs a moment to read the new menu; the pad ignores picks for 450 ms after one
  const sent = (since) => cmds.slice(since).filter((c) => c.startsWith("csp_nav"));
  const curIdx = (s) => s.rows.findIndex((r) => r.cur);
  const turnMenu = (s) => !s.hidden && s.rows.some((r) => /Open a case/i.test(r.label));
  const sig = (s) => s.rows.map((r) => r.label).join("|");

  if (DESKTOP) {
    // regression: a keyboard-and-mouse player never gets the pad, and the digit keys still pick
    await waitPad((s) => s.hidden, 5000, "desktop pad hidden");
    for (let i = 0; i < 120; i++) { if (/cur=0 /.test(await rcon("csp_state"))) break; await sleep(1000); }
    check("desktop: pad stays hidden", (await pad()).hidden);
    await pg.evaluate(() => { document.getElementById("pause").hidden = true; document.getElementById("canvas").focus(); });
    note("desktop: press 2 once it's this player's turn (server log shows the pick)");
    await rcon("csp_stuff phaDK say /menu"); await sleep(3000);
    await pg.keyboard.press("2"); await sleep(3000);
    await shot("desk-after-2");
    check("desktop: no csp_nav sent", sent(0).length === 0);
    await browser.close(); process.exit(failed ? 1 : 0);
  }

  // ---- S1: the pad mirrors the real menu
  let s = await waitPad(turnMenu, 120000, "turn menu on the pad");
  note("turn_timeout now: " + (await rcon("csp_turn_timeout")).trim().replace(/\s+/g, " ").slice(0, 120));
  await rc("csp_give 0 0", "csp_give 0 1", "csp_give 0 4", "csp_stuff phaTT say /menu");
  s = await waitPad((x) => turnMenu(x) && x.rows.length >= 6, 15000, "turn menu with items");
  note("turn menu rows: " + s.rows.map((r) => r.n + " " + r.label).join(" / "));
  check("S1 rows mirror the menu", s.rows[0].label.startsWith("Open a case") && s.rows[1].label.startsWith("Buy gear") && s.rows.some((r) => /Use Knife Out/.test(r.label)), sig(s));
  check("S1 numbering is the real item number", s.rows.every((r, i) => r.n === String(+r.n)) && s.rows[0].n === "1" && s.rows[1].n === "2");
  const small = [...s.rows, ...s.ctl].filter((b) => b.w < 44 || b.h < 44);
  check("S1 every hit area >= 44 CSS px", small.length === 0, small.map((b) => `${b.label}:${b.w.toFixed(0)}x${b.h.toFixed(0)}`).join(","));
  check("S1 pad stays in the left half (clear of Jump/Use/Fire)", s.box.x + s.box.w < 844 * 0.5, `right edge ${(s.box.x + s.box.w).toFixed(0)}px of 844`);
  check("S1 pad fits the screen", s.box.y + s.box.h <= 390, `bottom ${(s.box.y + s.box.h).toFixed(0)}px of 390`);
  check("S1 two columns past five options", s.rows.length > 5 ? new Set(s.rows.map((r) => Math.round(r.x))).size === 2 : true);
  await shot("s1-turn-menu");

  await pg.evaluate(() => { window.__ev = []; for (const t of ["pointerdown", "pointerup", "touchstart", "touchend"]) window.addEventListener(t, (e) => window.__ev.push(t + ":" + (e.target.id || e.target.className || e.target.tagName) + "@" + Math.round(e.clientX ?? e.touches?.[0]?.clientX ?? -1) + "," + Math.round(e.clientY ?? e.touches?.[0]?.clientY ?? -1)), true); });
  // ---- S2: cycling
  const ctl = (a) => s.ctl.find((c) => c.act === a);
  const start = curIdx(s), n = s.rows.length;
  let n0 = cmds.length;
  await tap(ctl("down")); await sleep(1200); s = await pad();
  note("diag after first tap: " + JSON.stringify(await pg.evaluate(() => ({ ev: window.__ev, vis: document.visibilityState, focus: document.hasFocus(), hidden: document.getElementById("navpad").hidden, w: innerWidth, h: innerHeight }))) + " tapped at " + JSON.stringify(ctr(ctl("down"))));
  check("S2 down moves the cursor one row", curIdx(s) === (start + 1) % n, `${start} -> ${curIdx(s)}`);
  await tap(ctl("up")); await tap(ctl("up")); await sleep(1500); s = await pad();
  check("S2 up twice wraps round", curIdx(s) === (start + n - 1) % n, `-> ${curIdx(s)}`);
  for (let i = 0; i < 4; i++) { await tap(ctl("down")); await sleep(120); }
  await sleep(1500); s = await pad();
  check("S2 four quick downs land four rows on", curIdx(s) === (start + n - 1 + 4) % n, `-> ${curIdx(s)} (n=${n})`);
  check("S2 exactly one command per tap", sent(n0).length === 7, `${sent(n0).length} commands`);
  check("S2 nothing left pressed", s.down === 0);

  // ---- S3: a tap on an option runs that option, and Back returns
  let seq0 = cmds.length;
  await tap(s.rows[1]);   // 2 Buy gear
  s = await waitPad((x) => x.rows.some((r) => /Handgun/.test(r.label)), 8000, "buy menu after tapping 2");
  check("S3 tapping 2 opens the buy menu", s.rows.some((r) => /Handgun/.test(r.label)), sig(s));
  check("S3 one pick sent", sent(seq0).filter((c) => /pick/.test(c)).length === 1, sent(seq0).join(";"));
  check("S3 buy menu has a Back", s.ctl.some((c) => c.act === "back"));
  const buyRows = s.rows.map((r) => r.label);
  await shot("s3-buy-menu");

  let c0;
  // ---- S4: every option of the buy menu does its own thing (opens a different menu), Back each time
  for (const label of buyRows) {
    s = await waitPad((x) => x.rows.some((r) => /Handgun/.test(r.label)), 8000, "buy menu");
    const row = s.rows.find((r) => r.label === label);
    if (/^Done$/i.test(label)) continue;
    const before = sig(s); c0 = cmds.length;
    await tap(row);
    const s2 = await waitPad((x) => sig(x) !== before && !x.hidden, 8000, `menu after ${label}`);
    check(`S4 option "${label}" opens its own menu`, sig(s2) !== before && sent(c0).length === 1, `${sig(s2).slice(0, 80)}`);
    await tap(s2.ctl.find((c) => c.act === "back"));
    await waitPad((x) => x.rows.some((r) => /Handgun/.test(r.label)), 8000, "back to buy menu");
  }

  // a pick inside a category runs that purchase and lands back on the buy menu
  s = await waitPad((x) => x.rows.some((r) => /Handgun/.test(r.label)), 8000, "buy menu");
  const buySig = sig(s); await tap(s.rows[0]);
  s = await waitPad((x) => sig(x) !== buySig && x.rows.some((r) => /Glock/.test(r.label)), 8000, "handgun menu");
  const glock = s.rows.find((r) => /Glock/.test(r.label)); c0 = cmds.length;
  await tap(glock);
  s = await waitPad((x) => sig(x) === buySig, 8000, "buy menu after buying");
  check("S4 buying from a category returns to the buy menu", sig(s) === buySig && sent(c0).length === 1, sent(c0).join(";"));

  // ---- S5: OK picks the cursor row; Back leaves the buy menu
  s = await pad();
  while (curIdx(s) !== 0) { await tap(s.ctl.find((c) => c.act === "up")); await sleep(500); s = await pad(); }
  await tap(s.ctl.find((c) => c.act === "down")); await sleep(1200); s = await pad();
  const want = s.rows[curIdx(s)].label; const before5 = sig(s);
  await tap(s.ctl.find((c) => c.act === "ok"));
  s = await waitPad((x) => sig(x) !== before5, 8000, "menu after OK");
  check("S5 OK picks the highlighted row", sig(s) !== before5, `highlight was "${want}"`);
  await tap(s.ctl.find((c) => c.act === "back"));
  s = await waitPad((x) => x.rows.some((r) => /Handgun/.test(r.label)), 8000, "buy menu again");
  await tap(s.ctl.find((c) => c.act === "back"));
  s = await waitPad(turnMenu, 8000, "back on the turn menu");
  check("S5 Back from the buy menu returns to the turn menu", turnMenu(s));

  // ---- S6: press / release behaviour
  const press = async (name, fn, expectCmds) => {
    s = await waitPad(turnMenu, 8000, "turn menu"); const c0 = cmds.length; await fn(s); await sleep(800);
    const after = await pad();
    check(`S6 ${name}`, sent(c0).length === expectCmds && after.down === 0 && held >= 1, `${sent(c0).length} commands, ${after.down} stuck, ${held} pressed while down`);
    return after;
  };
  await press("touchcancel sends nothing", async (x) => { await tStart([ctr(x.rows[0])]); await sleep(100); await tCancel(); }, 0);
  await press("drag off the button and release sends nothing", async (x) => { await tStart([ctr(x.rows[0])]); await sleep(100); await tMove([{ x: 700, y: 60 }]); await sleep(100); await tEnd(); }, 0);
  await press("focus loss mid-press sends nothing", async (x) => { await tStart([ctr(x.rows[0])]); await sleep(100); await pg.evaluate(() => window.dispatchEvent(new Event("blur"))); await sleep(100); await tEnd(); }, 0);
  await press("tab hidden mid-press sends nothing", async (x) => { await tStart([ctr(x.rows[0])]); await sleep(100); await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await tEnd(); }, 0);
  await press("a long hold sends one command (no auto-repeat)", async (x) => { await tStart([ctr(x.ctl.find((c) => c.act === "down"))]); await sleep(2500); await tEnd(); }, 1);
  await press("two fingers on up and down send one each, none stuck", async (x) => { await tStart([ctr(x.ctl.find((c) => c.act === "up")), ctr(x.ctl.find((c) => c.act === "down"))]); await sleep(150); await tEnd(); }, 2);
  // a double tap on an option answers the menu once
  s = await waitPad(turnMenu, 8000, "turn menu"); let c1 = cmds.length;
  await sleep(600); await tapFast(s.rows[2]); await sleep(60); await tapFast(s.rows[2]); await sleep(2000);
  check("S6 double tap on an option picks once", sent(c1).filter((c) => /pick/.test(c)).length === 1, sent(c1).join(";"));
  s = await pad();
  if (s.rows.some((r) => /Map overlay/.test(r.label)) === false) await sleep(1000);
  await waitPad(turnMenu, 8000, "turn menu after map overlay");
  s = await pad();
  if (/close/i.test(s.rows[2]?.label || "")) { await tap(s.rows[2]); await sleep(1500); }   // leave the overlay off

  // ---- S7: orientation, the Esc menu and other overlays
  s = await waitPad(turnMenu, 8000, "turn menu");
  const seqSig = sig(s); const pt = ctr(s.rows[0]); c1 = cmds.length;
  await rotate(390, 844);
  const covered = await pg.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.closest("#rotate") ? "rotate" : e.closest("#navpad") ? "pad" : e.tagName) : "none"; }, { x: 60, y: 120 });
  check("S7 portrait: the rotate card covers the pad", covered === "rotate", covered);
  await shot("s7-portrait");
  // (the CDP touch emulation maps touches through the pre-rotation layout, so a touch is only injected in landscape)
  await rotate(844, 390);
  await tStart([ctr(s.rows[0])]); await sleep(200); await rotate(390, 844); await rotate(844, 390); await tEnd(); await sleep(800);
  s = await pad();
  note("nav log: " + JSON.stringify((await pg.evaluate(() => window.__navlog)).slice(-4)) + " cmds " + sent(c1).join(";"));
  check("S7 rotating to portrait and back mid-press: the press is forgotten, nothing sent, nothing stuck", sent(c1).length === 0 && s.down === 0 && held === 1 && sig(s) === seqSig, `${sent(c1).length} commands, ${held} pressed while down`);
  check("S7 back in landscape the same pad is there", !s.hidden && s.rows.length > 0);
  await pg.evaluate(() => document.getElementById("pz-open").click()); await sleep(800);
  s = await pad();
  const over = await pg.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("#pause") ? "pause" : "other", pt);
  check("S7 Esc menu open: pad hidden and covered", s.hidden && over === "pause", `hidden=${s.hidden} over=${over}`);
  await shot("s7-esc-menu");
  await tap({ x: pt.x, y: pt.y, w: 0, h: 0 }); await sleep(500);
  check("S7 Esc menu open: a tap there sends nothing", sent(c1).length === 0, sent(c1).join(";"));
  await pg.evaluate(() => document.getElementById("pz-resume").click()); await sleep(1000);
  s = await pad();
  check("S7 closing the Esc menu brings the pad back", !s.hidden && sig(s) === seqSig);

  // ---- S8: the pad never leaks touches to the page behind it (the engine's stick/look zones listen up there)
  await pg.evaluate(() => { window.__leak = 0; window.__hit = 0; for (const t of ["touchstart", "pointerdown", "mousedown", "click"]) document.addEventListener(t, () => { window.__leak++; }); document.getElementById("nav-ctl").addEventListener("touchstart", () => { window.__hit++; }); });
  s = await pad(); c1 = cmds.length; await tStart([ctr(s.ctl.find((c) => c.act === "down"))]); await sleep(100); await tEnd(); await sleep(800);
  const leak = await pg.evaluate(() => window.__leak), hit = await pg.evaluate(() => window.__hit);
  note("S8 diag: " + JSON.stringify(await pg.evaluate(() => ({ ev: window.__ev.slice(-8), w: innerWidth, h: innerHeight, dpr: devicePixelRatio, vv: [visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop] }))) + " at " + JSON.stringify(ctr(s.ctl.find((c) => c.act === "down"))));
  check("S8 the touch really landed on the pad (and sent its command)", hit === 1 && sent(c1).length === 1, `hit=${hit} sent=${sent(c1).length}`);
  check("S8 a tap on the pad reaches no listener above it (touch/pointer/mouse/click)", leak === 0, `leak=${leak}`);

  // ---- S9: a menu that closes on its own takes the pad with it
  await rcon("csp_stuff phaTT say /menu"); await sleep(1500);
  await tap((await pad()).rows[0]);   // Open a case: the turn menu goes, the dice roll
  const gone = await waitPad((x) => x.hidden || !turnMenu(x), 15000, "pad leaves after the pick");
  check("S9 the pad leaves with the menu", gone.hidden || !turnMenu(gone), `hidden=${gone.hidden}`);
  await shot("s9-after-pick");
  const c9 = cmds.length; await tap(s.ctl.find((c) => c.act === "down")); await sleep(500);
  check("S9 a late tap on the gone pad sends nothing", sent(c9).length === 0, sent(c9).join(";"));

  note(`commands sent by the page (${sent(0).length}): ` + sent(0).slice(0, 60).join(" ; "));
  fs.writeFileSync(`${OUT}/commands.txt`, cmds.join("\n"));
  await browser.close();
  console.log(failed ? `FAILED ${failed}` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FAIL " + e.stack); process.exit(1); });
