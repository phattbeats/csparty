// Live check for lobby servers (#4154): two GPU browsers on the live lobby Worker make a party, ready up, and
// land on a game server container the live pool-agent starts just for them (through the public relay). One
// drops and comes back to its seat; then the host ends the match and the container goes.
// Run on the game host (reads the agent's loopback /status), in the playwright container with host network:
//   LOBBY=https://<worker> AGENT=http://127.0.0.1:8097 OUT=/work/live node pool_live.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const LOBBY = process.env.LOBBY, AGENT = process.env.AGENT || "http://127.0.0.1:8097", OUT = process.env.OUT || "/work/live";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `+${Math.round((Date.now() - T0) / 1000)}s`, ...a);
let failed = 0;
const check = (ok, what) => { log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; return ok; };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 90000 }).catch((e) => log(`screenshot ${name}: ${e.message.split("\n")[0]}`));
const until = async (fn, ms, every = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return null; };
const lobbyOf = async (code) => (await (await fetch(`${AGENT}/status`)).json()).detail.find((l) => l.code === code);
const events = async (code, name) => ((await lobbyOf(code))?.events || []).filter((e) => e.name === name);

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const player = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
    await ctx.addInitScript((n) => { if (!localStorage.getItem("csp_name")) localStorage.setItem("csp_name", n); }, name);
    const page = await ctx.newPage();
    page.on("console", (m) => { const t = m.text(); if (/\[boot\] (Loading|Using|Writing)|Server issued|CSP_BACK/i.test(t)) log(`[${name}] ${t.slice(0, 120)}`); });
    return { ctx, page, name };
  };
  const A = await player("Ana"), B = await player("Ben");
  await A.page.goto(LOBBY, { waitUntil: "domcontentloaded" });
  const gpu = await A.page.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl"); const e = gl?.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; });
  log("WebGL renderer:", gpu);
  await A.page.click("#create");
  await A.page.waitForSelector("#lobby:not([hidden])");
  await A.page.locator('.char:has(input[value="2"])').click();
  const code = (await A.page.textContent("#lobby-code")).trim();
  check(/^[A-Z2-9]{5}$/.test(code), `live party ${code}`);
  await B.page.goto(`${LOBBY}/?code=${code}`, { waitUntil: "domcontentloaded" });
  await B.page.waitForSelector("#lobby:not([hidden])");
  await B.page.locator('.char:has(input[value="5"])').click();
  await sleep(1500);
  await A.page.waitForSelector("#ready:not([hidden])"); await B.page.waitForSelector("#ready:not([hidden])");
  await A.page.click("#ready"); await B.page.click("#ready");
  check(!!(await until(async () => /Starting your party's server/.test(await A.page.textContent("#lobby-status")), 30000, 300)), "lobby: starting the party's server");
  await shot(A.page, "live-1-starting");
  const lob = await until(() => lobbyOf(code), 30000, 500);
  check(!!lob, `live agent started a container for ${code} on :${lob?.port}`);
  const went = await until(async () => /[?&]key=/.test(A.page.url()) && /[?&]key=/.test(B.page.url()), 300000, 1000);
  check(!!went, `both sent to ${went ? new URL(A.page.url()).host : "?"} with the lobby key`);
  check(!!(await until(async () => (await events(code, "humans")).some((e) => e.data.n === 2), 600000, 3000)), "both in the game on the lobby's server (humans 2)");
  check(!!(await until(async () => (await events(code, "match_started")).length, 180000, 3000)), "match started");
  await sleep(10000);
  await shot(A.page, "live-2-ingame-A"); await shot(B.page, "live-3-ingame-B");
  // B drops and comes back
  await B.page.evaluate(() => { try { window.__csp?._CL_Disconnect?.(); } catch {} location.reload(); });
  check(!!(await until(async () => (await events(code, "humans")).at(-1)?.data.n === 1, 60000, 1000)), "Ben dropped (humans 1)");
  await B.page.waitForSelector("#go", { timeout: 60000 }); await sleep(3000); await B.page.click("#go");
  check(!!(await until(async () => (await events(code, "reconnect")).some((e) => e.data.outcome === "reattached"), 240000, 3000)), "Ben is back in his seat (reconnect reattached)");
  await sleep(6000);
  await shot(B.page, "live-4-ben-back");
  // the host ends it from the lobby page
  const H = await A.ctx.newPage();
  H.on("dialog", (d) => d.accept());
  await H.goto(`${LOBBY}/?code=${code}`, { waitUntil: "domcontentloaded" });
  await H.waitForSelector("#end:not([hidden])", { timeout: 30000 });
  await shot(H, "live-5-lobby-in-match");
  await H.click("#end");
  check(!!(await until(async () => !(await lobbyOf(code)), 60000, 2000)), "host ends the match -> the container is gone");
  check(!!(await until(async () => !(await H.isHidden("#ready")), 15000, 500)), "lobby open again");
  await shot(H, "live-6-lobby-open");
  await browser.close();
  log(failed ? `${failed} FAILED` : "all passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
