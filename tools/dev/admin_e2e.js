// Browser E2E for the admin dashboard (#3991): two players on the lobby page, an admin on /admin. Signs in
// (wrong token, then right), watches the lobby go in_match, posts signed game events, checks funnel/minigame/winner
// panels, then broadcast, kick, drain, pause and close from the dashboard, with screenshots.
// Needs: web/relay.js + the lobby Worker under wrangler dev as in lobby/test/admin_test.mjs (fresh .wrangler,
// --ip 0.0.0.0), and a Chromium reachable over CDP (CDP=ws://browserless:3000).
//   L=http://<this host>:8787 LL=http://127.0.0.1:8787 OUT=/tmp/shots PW=playwright-core node tools/dev/admin_e2e.js
const { chromium } = require(process.env.PW || "playwright-core");
const crypto = require("node:crypto");
const L = process.env.L || "http://127.0.0.1:8787", LL = process.env.LL || "http://127.0.0.1:8787";
const TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token-change-me-0123456789", OUT = process.env.OUT || "/tmp/shots";
require("node:fs").mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const check = (ok, w) => { console.log((ok ? "PASS  " : "FAIL  ") + w); if (!ok) failed++; };
const signed = (body) => { const ts = Math.floor(Date.now() / 1000); return fetch(LL + "/api/events", { method: "POST", body,
  headers: { "X-CSP-Slot": "raid1", "X-CSP-Time": String(ts), "X-CSP-Sig": crypto.createHmac("sha256", "dev-secret-change-me").update("csp-ev|raid1|" + ts + "|" + body).digest("base64url") } }); };
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP || "ws://browserless:3000");
  const ctxA = await b.newContext({ viewport: { width: 1280, height: 900 } }), ctxB = await b.newContext({ viewport: { width: 390, height: 844 } });
  const ctxX = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const A = await ctxA.newPage(), B = await ctxB.newPage(), X = await ctxX.newPage();
  const errs = [];
  for (const [n, p] of [["A", A], ["B", B], ["admin", X]]) { p.on("pageerror", (e) => errs.push(n + ": " + e.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(n + " console: " + m.text()); }); p.on("dialog", (d) => d.accept(d.type() === "prompt" ? (d.defaultValue() || "24") : undefined)); }
  const go = (p, u) => p.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
  // players
  await go(A, L + "/"); await A.fill("#name", "Alice"); await A.click("#create");
  await A.waitForSelector("#lobby:not([hidden])", { timeout: 15000 });
  const code = (await A.textContent("#lobby-code")).trim();
  await go(B, L + "/"); await B.fill("#name", "Bob"); await B.fill("#code", code); await B.click("#join-form button");
  await B.waitForSelector("#lobby:not([hidden])", { timeout: 15000 });
  await A.waitForFunction(() => document.querySelectorAll("#seats .seat:not(.empty)").length === 2, null, { timeout: 10000 });
  check(true, "two browsers in lobby " + code);
  // admin sign-in: wrong then right
  await go(X, L + "/admin/");
  await X.fill("#token", "wrong-token-wrong-token-wrong"); await X.click("#login button");
  await X.waitForFunction(() => /Wrong admin token/.test(document.querySelector("#login-status").textContent), null, { timeout: 10000 });
  check(true, "wrong token refused on the sign-in form");
  await X.screenshot({ path: OUT + "/01-admin-signin-refused.png" });
  await X.fill("#token", TOKEN); await X.click("#login button");
  await X.waitForSelector("#app:not([hidden])", { timeout: 10000 });
  await X.waitForFunction((c) => [...document.querySelectorAll("#lobbies tbody td")].some((t) => t.textContent === c), code, { timeout: 10000 });
  check(true, "dashboard lists the lobby");
  // ready up -> match; game events; end
  await A.click("#ready"); await B.click("#ready");
  await X.waitForFunction((c) => [...document.querySelectorAll("#lobbies tbody tr")].some((r) => r.cells[0].textContent === c && r.cells[1].textContent === "in_match"), code, { timeout: 20000 });
  check(true, "dashboard shows the lobby in_match");
  await signed(JSON.stringify({ events: [{ e: "minigame_picked", b: ["hot_potato", "ffa"], d: [1] }, { e: "minigame_result", b: ["hot_potato", "2"], d: [45, 4] },
    { e: "minigame_picked", b: ["hns", "2v2"], d: [2] }, { e: "minigame_result", b: ["hns", "5"], d: [80, 4] }, { e: "match_finished", b: ["2", "1"], d: [900, 6, 2] }] }));
  await sleep(500);
  // open lobby detail
  await X.click("#lobbies tbody tr:first-child"); await X.waitForSelector("#detail:not([hidden])", { timeout: 10000 });
  await X.selectOption("#range", "24h"); await sleep(1500);
  await X.screenshot({ path: OUT + "/02-admin-live-detail.png", fullPage: true });
  // host ends match so stats have a closed match, refresh stats
  // the match start sent both players to the game server; come back through the lobby link like the game page does
  await sleep(2500);
  await go(A, L + "/?code=" + code); await go(B, L + "/?code=" + code);
  await A.waitForSelector("#end:not([hidden])", { timeout: 15000 });
  await A.screenshot({ path: OUT + "/02b-player-in-match.png" });
  await A.click("#end");
  await A.waitForSelector("#ready:not([hidden])", { timeout: 15000 });
  await X.selectOption("#range", "7d"); await X.selectOption("#range", "24h"); await sleep(1500);
  const funnelTxt = await X.textContent("#funnel");
  check(/Match finished/.test(funnelTxt) && /100%/.test(funnelTxt), "funnel panel renders with percentages");
  check(/hot_potato/.test(await X.textContent("#minigames")), "minigame table has game events");
  check(/Arctic Avengers/.test(await X.textContent("#winners")), "winner shown by character name");
  await X.locator("#h-funnel").scrollIntoViewIfNeeded();
  await X.screenshot({ path: OUT + "/03-admin-stats.png", fullPage: true });
  // broadcast via UI
  await X.fill("#bc-msg", "Server restart at 9pm"); await X.click("#f-broadcast button[type=submit]");
  await A.waitForSelector("#banner:not([hidden])", { timeout: 10000 });
  check((await A.textContent("#banner")) === "Server restart at 9pm", "broadcast banner on a player's lobby page");
  await A.screenshot({ path: OUT + "/04-player-broadcast.png" });
  // kick Bob via UI (Kick button in detail, second member)
  await X.click("#lobbies tbody tr:first-child"); await X.waitForSelector("#detail:not([hidden])");
  await X.locator("#detail tbody tr", { hasText: "Bob" }).getByRole("button", { name: "Kick", exact: true }).click();
  await B.waitForSelector("#home:not([hidden])", { timeout: 10000 });
  check(/removed you/.test(await B.textContent("#home-status")), "kicked player is sent home with the reason");
  await B.screenshot({ path: OUT + "/05-player-kicked.png" });
  // drain + pause via UI
  await X.click("#hosts tbody button");
  await X.waitForFunction(() => /DRAIN/.test(document.querySelector("#hosts tbody").textContent), null, { timeout: 10000 });
  check(true, "drain toggled from the server table");
  await X.fill("#pause-msg", "Maintenance until 9:15"); await X.click("#pause-btn");
  await X.waitForFunction(() => /PAUSED/.test(document.querySelector("#pause-state").textContent), null, { timeout: 10000 });
  await go(B, L + "/"); await B.waitForSelector("#banner:not([hidden])", { timeout: 10000 });
  check(/Maintenance until 9:15/.test(await B.textContent("#banner")), "paused: start page shows the maintenance banner");
  await B.fill("#name", "Bob"); await B.click("#create"); await sleep(1500);
  check(/Maintenance/.test(await B.textContent("#home-status")), "paused: create refused with the message");
  await B.screenshot({ path: OUT + "/06-player-paused.png" });
  await sleep(3500);
  await X.screenshot({ path: OUT + "/07-admin-actions-audit.png", fullPage: true });
  check(/kick/.test(await X.textContent("#audit")) && /pause/.test(await X.textContent("#audit")), "audit log lists the UI actions");
  // close lobby via UI
  await X.click("#lobbies tbody tr:first-child"); await X.waitForSelector("#detail:not([hidden])");
  await X.getByRole("button", { name: "Close lobby" }).click();
  await A.waitForSelector("#home:not([hidden])", { timeout: 10000 });
  check(/closed by an admin/.test(await A.textContent("#home-status")), "closed lobby sends members home with the message");
  // resume, undrain, clear broadcast
  await X.click("#pause-btn"); await X.click("#bc-clear"); await X.click("#hosts tbody button"); await sleep(1500);
  await X.setViewportSize({ width: 390, height: 844 }); await sleep(800);
  await X.screenshot({ path: OUT + "/08-admin-phone.png" });
  // expected: playwright's waitForFunction under the CSP, the deliberate wrong token (401) and the paused create (503)
  const real = errs.filter((e) => !/unsafe-eval|status of 401|status of 503/.test(e));
  check(!real.length, "no page errors or console errors (CSP included)" + (real.length ? ": " + real.join(" | ") : ""));
  await b.close();
  console.log(failed ? failed + " FAILED" : "all passed"); process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("CRASH", e.message); process.exit(2); });
