// Lobby end to end in real browsers (#3989): two players make and join a party on the lobby page, pick
// characters, ready up, get sent to the game server with the party's key, and land in the game; then they
// leave, and the lobby hands the server back and reopens.
//
// Needs: a game server + web/relay.js (LOBBY_SECRET, RELAY_ID=raid1), the lobby Worker under `wrangler dev`
// with POOL pointing at that relay and MATCH_GRACE_SECS small, and Node playwright@1.55.0.
//   LOBBY=http://127.0.0.1:8789 RCON=127.0.0.1:27089 RCON_PW=... OUT=/work/shots node lobby_e2e.js
const { chromium } = require("playwright");
const dgram = require("node:dgram");
const fs = require("node:fs");

const LOBBY = process.env.LOBBY || "http://127.0.0.1:8789";
const [RHOST, RPORT] = (process.env.RCON || "127.0.0.1:27089").split(":");
const RPW = process.env.RCON_PW || "";
const OUT = process.env.OUT || "/work/shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failed = 0;
const check = (ok, what) => { log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };
// evidence only: a slow frame on a loaded host must not end the run
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 90000 }).catch((e) => log(`screenshot ${name}: ${e.message.split("\n")[0]}`));

// GoldSrc rcon: get a challenge, then send the command
const rcon = (cmd) => new Promise((resolve) => {
  const s = dgram.createSocket("udp4"); let out = "", stage = 0;
  const done = => { try { s.close(); } catch {} resolve(out); };
  const t = setTimeout(done, 2500);
  s.on("message", (m) => {
    const txt = m.toString("latin1").slice(4);
    if (stage === 0) { const c = /challenge rcon (\d+)/.exec(txt); if (!c) return; stage = 1;
      s.send(Buffer.from(`\xff\xff\xff\xffrcon ${c[1]} "${RPW}" ${cmd}\n`, "latin1"), +RPORT, RHOST); }
    else { out += txt.replace(/^l/, ""); clearTimeout(t); setTimeout(done, 300); }
  });
  s.send(Buffer.from("\xff\xff\xff\xffchallenge rcon\n", "latin1"), +RPORT, RHOST);
});

(async => {
  const browser = await chromium.launch({ args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const player = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    await ctx.addInitScript((n) => { if (!localStorage.getItem("csp_name")) localStorage.setItem("csp_name", n); }, name);
    const page = await ctx.newPage();
    page.on("console", (m) => { const t = m.text(); if (/\[boot\]|connected|Server issued|error/i.test(t)) log(`[${name}] ${t.slice(0, 160)}`); });
    return { ctx, page, name };
  };
  const A = await player("Alice"), B = await player("Bob");

  // GPU check (Alex: headless browsers render on the Quadro)
  await A.page.goto(LOBBY);
  const gpu = await A.page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl"); const e = gl?.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; });
  log("WebGL renderer:", gpu);

  // A creates, then picks
  await A.page.click("#create");
  await A.page.waitForSelector("#lobby:not([hidden])");
  await A.page.locator('.char:has(input[value="2"])').click();
  await A.page.waitForFunction(() => [...document.querySelectorAll(".seat.me .muted")].some((e) => e.textContent === "Arctic Avengers"));
  const code = (await A.page.textContent("#lobby-code")).trim();
  check(/^[A-Z2-9]{5}$/.test(code), `Alice created party ${code}`);
  check(A.page.url().endsWith(`/?code=${code}`), "address bar is the invite link");

  // B joins by link and tries Alice's character first
  await B.page.goto(`${LOBBY}/?code=${code}`);
  await B.page.waitForSelector("#lobby:not([hidden])");
  await B.page.waitForFunction(() => document.querySelectorAll(".seat:not(.empty)").length === 2);
  check(await B.page.locator('.char:has(input[value="2"])').evaluate((e) => e.classList.contains("taken")), "Bob sees Alice's character taken");
  await B.page.locator('.char:has(input[value="5"])').click();
  await A.page.waitForFunction(() => [...document.querySelectorAll(".seat .muted")].some((e) => e.textContent === "GSG-9"));
  check(true, "Alice sees Bob as GSG-9");
  await shot(A.page, "1-lobby-host");
  await shot(B.page, "2-lobby-guest");
  check(await A.page.isVisible("#start") && !(await B.page.isVisible("#start")), "only the host has Start");

  // both ready -> countdown -> both sent to the game server
  await A.page.click("#ready");
  await B.page.click("#ready");
  await A.page.waitForFunction(() => /Starting in/.test(document.getElementById("lobby-status").textContent), null, { timeout: 5000 });
  await shot(A.page, "3-countdown");
  check(true, "countdown shown when everyone is ready");
  const gameUrl = (p) => p.waitForURL((u) => u.searchParams.has("lobby") && u.searchParams.has("key"), { timeout: 20000, waitUntil: "domcontentloaded" }).then(() => new URL(p.url()));
  const [ua, ub] = await Promise.all([gameUrl(A.page), gameUrl(B.page)]);
  check(ua.searchParams.get("char") === "2" && ub.searchParams.get("char") === "5", `redirected to the game with their picks (${ua.origin})`);
  check(ua.searchParams.get("key") === ub.searchParams.get("key") && /^[A-Z2-9]{5}\.\d+\./.test(ua.searchParams.get("key")), "same per-lobby party key for both");

  // the game page joins on its own; wait until both are on the server
  let st = "";
  for (let i = 0; i < 90; i++) {
    st = await rcon("status");
    if (/"Alice"/.test(st) && /"Bob"/.test(st)) break;
    await sleep(2000);
  }
  check(/"Alice"/.test(st) && /"Bob"/.test(st), "both players are on the game server");
  log(st.split("\n").filter((l) => /^#|players/.test(l)).join("\n"));
  await sleep(30000);   // plugin countdown (csp_autostart 20 s) into the match
  await shot(A.page, "4-ingame-alice");
  await shot(B.page, "5-ingame-bob");
  const state = await rcon("csp_state");
  log("csp_state:", state.slice(0, 400));
  // the first visit spent minutes downloading with no peer on the relay: the lobby must still hold the server
  const held = await (await fetch(`${LOBBY}/api/lobbies/${code}`)).json();
  check(held.state === "in_match", `lobby still holds the server while they play (${held.state})`);

  // leave: relay empties, the directory hands the server back, the lobby reopens
  await A.page.close(); await B.page.close();
  const t0 = Date.now();
  const back = await A.ctx.newPage();
  await back.goto(`${LOBBY}/?code=${code}`);
  await back.waitForSelector("#lobby:not([hidden])");
  const reopened = await back.waitForFunction(() => !document.getElementById("ready").hidden, null, { timeout: 330000 }).then(() => true, => false);
  check(reopened, `lobby reopened for a rematch ${Math.round((Date.now() - t0) / 1000)} s after everyone left the server`);
  await shot(back, "6-lobby-reopened");
  await browser.close();
  log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
