// Browser pass for #3992 against `wrangler dev` with the Turnstile test keys and no game servers (POOL:[]), so a
// started party queues. Screenshots to OUT. Needs playwright (the RAID's mcr.microsoft.com/playwright image).
//   LOBBY=http://127.0.0.1:8792 OUT=/out node harden_shots.cjs
const { chromium } = require("playwright");
const LOBBY = process.env.LOBBY || "http://127.0.0.1:8792";
const OUT = process.env.OUT || "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1100 } });
  const page = await ctx.newPage();
  const turnstileHits = [];
  page.on("request", (r) => { if (r.url().includes("challenges.cloudflare.com")) turnstileHits.push(r.url()); });
  page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 200)); });

  await page.goto(LOBBY + "/");
  await page.waitForLoadState("networkidle");
  const footer = await page.textContent("footer");
  check(/Turnstile/.test(footer) && /hash/.test(footer), "privacy note mentions Turnstile and hashed IPs");
  await page.screenshot({ path: `${OUT}/3992-1-home-privacy.png`, fullPage: true });

  // a refused name: the box is cleared and the page says why
  await page.fill("#name", "sh1thead");
  await page.fill("#title", "Friday night");
  await page.click("#create");
  await page.waitForSelector("#lobby:not([hidden])", { timeout: 30000 });
  check(turnstileHits.some((u) => u.includes("turnstile")), `Turnstile loaded on create (${turnstileHits.length} requests)`);
  await sleep(1500);
  const status = await page.textContent("#lobby-status");
  check(/isn't allowed/.test(status), `refused name explained (${status.trim().slice(0, 80)})`);
  check((await page.inputValue("#name")) === "", "name box cleared");
  const seat = await page.textContent("#seats");
  check(/Player/.test(seat) && !/sh1t/i.test(seat), "roster shows Player");
  await page.screenshot({ path: `${OUT}/3992-2-name-refused.png`, fullPage: true });

  // start with no servers: queued, place in line and a waiting timer
  await page.click("#start");
  await page.waitForFunction(() => /in line|Waiting for one/.test(document.querySelector("#lobby-status").textContent), null, { timeout: 15000 });
  await sleep(3200);
  const q = await page.textContent("#lobby-status");
  check(/number 1 in line/.test(q) && /Waiting 0:0[2-9]/.test(q), `queued: place in line and timer (${q.trim()})`);
  await page.screenshot({ path: `${OUT}/3992-3-queued.png`, fullPage: true });

  // someone else arriving sees the queue before making a party
  const p2 = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  await p2.goto(LOBBY + "/");
  await p2.waitForSelector("#busy:not([hidden])", { timeout: 10000 }).catch(() => {});
  const busy = await p2.textContent("#busy");
  check(/1 party is waiting/.test(busy), `home shows the queue (${busy.trim()})`);
  await p2.screenshot({ path: `${OUT}/3992-4-home-queue.png`, fullPage: true });

  // too many code lookups from one IP: the page shows the limit message
  await p2.evaluate(async () => { for (let i = 0; i < 35; i++) await fetch("/api/lobbies/ZZZZZ"); });
  await p2.fill("#code", "ABCDE");
  await p2.click("#join-form button");
  await sleep(800);
  const hs = await p2.textContent("#home-status");
  check(/Too many tries/.test(hs), `lookup limit message (${hs.trim()})`);
  await p2.screenshot({ path: `${OUT}/3992-5-lookup-limited.png`, fullPage: true });

  await browser.close();
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
