// What one lobby server costs on a host (#4154): CPU, memory and upload, read from the pool-agent's /status (docker
// stats per container, the relay's bytes per lobby) while lobbies play.
//   humans N: one lobby, N real browser players (GPU), a full match running         -> upload per player
//   bots K:   K lobbies at once, bots only (csp_start), no browsers                 -> CPU per lobby, host load
// Agent for this: MAX_LOBBIES >= K, NOSHOW_SECS large (bot lobbies have no peers), RCON_PASSWORD set, no EXTRA_CVARS.
//   LOBBY=http://127.0.0.1:8794 AGENT=http://127.0.0.1:8254 RCON_PW=... SECS=240 node pool_measure.js humans 4
const dgram = require("node:dgram");
const fs = require("node:fs");
const LOBBY = process.env.LOBBY || "http://127.0.0.1:8794";
const AGENT = process.env.AGENT || "http://127.0.0.1:8254";
const RPW = process.env.RCON_PW || "";
const SECS = +(process.env.SECS || 240);
const [mode, n] = [process.argv[2] || "bots", +(process.argv[3] || 4)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const until = async (fn, ms, every = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return null; };
const agent = async () => (await fetch(`${AGENT}/status`)).json();
const rcon = (port, cmd) => new Promise((resolve) => {
  const s = dgram.createSocket("udp4"); let stage = 0;
  const done = (v) => { try { s.close(); } catch {} resolve(v); };
  setTimeout(() => done(""), 2500);
  s.on("message", (m) => {
    const txt = m.toString("latin1").slice(4);
    if (stage === 0) { const c = /challenge rcon (\d+)/.exec(txt); if (!c) return; stage = 1; s.send(Buffer.from(`\xff\xff\xff\xffrcon ${c[1]} "${RPW}" ${cmd}\n`, "latin1"), port, "127.0.0.1"); }
    else done(txt);
  });
  s.send(Buffer.from("\xff\xff\xff\xffchallenge rcon\n", "latin1"), port, "127.0.0.1");
});
const create = async (i) => {
  const pid = `pid-measure-${i}-${Date.now()}`;
  const r = await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid, name: `M${i}` }) });
  const j = await r.json();
  if (!j.code) throw new Error(`create: ${j.error || r.status} (the Worker allows 10 creates per IP per 10 min: rm -rf lobby/.wrangler)`);
  return { code: j.code, pid };
};
const hostStart = ({ code, pid }) => new Promise((resolve) => {
  const ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${code}/ws?pid=${pid}&name=M`);
  ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ t: "start" })), 500);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.state === "in_match") resolve(ws); };
});

// samples: per lobby {cpu, memMb, upKbps, peers}; host load from the agent
const sample = async (codes, secs) => {
  const rows = [], end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    await sleep(15000);
    const st = await agent();
    const ls = st.lobbies.filter((l) => codes.includes(l.code));
    rows.push({ t: Math.round((Date.now() - (end - secs * 1000)) / 1000), load: st.load, upKbps: st.upKbps, lobbies: ls.map((l) => ({ code: l.code, cpu: l.cpu, memMb: l.memMb, upKbps: l.upKbps, peers: l.peers })) });
    log(`load ${st.load}  host up ${st.upKbps} kbps  ` + ls.map((l) => `${l.code}: cpu ${l.cpu}% mem ${l.memMb} MB up ${l.upKbps} kbps peers ${l.peers}`).join(" | "));
  }
  return rows;
};
const summary = (rows) => {
  const all = rows.slice(1).flatMap((r) => r.lobbies);   // the first sample can predate the CPU reading
  const avg = (k) => Math.round((all.reduce((a, l) => a + l[k], 0) / Math.max(1, all.length)) * 10) / 10;
  const max = (k) => Math.max(0, ...all.map((l) => l[k]));
  const loads = rows.map((r) => r.load);
  return { samples: rows.length, cpuAvg: avg("cpu"), cpuMax: max("cpu"), memAvg: avg("memMb"), memMax: max("memMb"), upAvgKbps: avg("upKbps"), upMaxKbps: max("upKbps"),
    loadMin: Math.min(...loads), loadMax: Math.max(...loads) };
};

(async () => {
  const before = await agent();
  log(`host load before: ${before.load}, lobbies running: ${before.running}`);
  if (mode === "bots") {
    const ls = []; for (let i = 0; i < n; i++) ls.push(await create(i));
    const socks = await Promise.all(ls.map(hostStart));
    log(`${n} lobbies in match: ${ls.map((l) => l.code).join(" ")}`);
    // bots join a few seconds after the map is up: ask until each match has started
    const ok = await until(async () => {
      const st = await agent();
      let all = true;
      for (const l of ls) {
        const d = st.detail.find((x) => x.code === l.code);
        if (d?.events.some((e) => e.name === "match_started")) continue;
        all = false;
        if (d) log(`${l.code} :${d.port} ${(await rcon(d.port, "csp_start")).trim().slice(0, 60)}`);
      }
      return all;
    }, 180000, 8000);
    log(ok ? "all matches started" : "not every match started");
    const rows = await sample(ls.map((l) => l.code), SECS);
    const sum = summary(rows);
    log("SUMMARY", JSON.stringify({ mode, lobbies: n, ...sum }));
    fs.writeFileSync(`/work/measure-bots${n}.json`, JSON.stringify({ mode, n, sum, rows }, null, 1));
    for (const ws of socks) ws.send(JSON.stringify({ t: "end" }));
    await sleep(2000);
    process.exit(0);
  }
  // humans: N browsers in one lobby
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ args: ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const pages = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
    await ctx.addInitScript((nm) => { localStorage.setItem("csp_name", nm); }, `P${i + 1}`);
    pages.push(await ctx.newPage());
  }
  await pages[0].goto(LOBBY); await pages[0].click("#create"); await pages[0].waitForSelector("#lobby:not([hidden])");
  const code = (await pages[0].textContent("#lobby-code")).trim();
  for (const p of pages.slice(1)) { await p.goto(`${LOBBY}/?code=${code}`); await p.waitForSelector("#lobby:not([hidden])"); }
  await sleep(1500);
  for (const p of pages) await p.click("#ready");
  const went = await until(async () => pages.every((p) => /[?&]key=/.test(p.url())), 300000, 1000);
  log(`party ${code}: ${went ? "all sent to the server" : "hand-off failed"}`);
  const inGame = await until(async () => (await agent()).detail.find((x) => x.code === code)?.events.some((e) => e.name === "humans" && e.data.n === n), 420000, 3000);
  const started = await until(async () => (await agent()).detail.find((x) => x.code === code)?.events.some((e) => e.name === "match_started"), 180000, 3000);
  log(`${inGame ? `all ${n} in game` : "not all in game"}, ${started ? "match started" : "match not started"}`);
  const rows = await sample([code], SECS);
  const sum = summary(rows);
  const evs = (await agent()).detail.find((x) => x.code === code)?.events || [];
  const mgs = evs.filter((e) => e.name === "minigame_picked").map((e) => e.data.mg);
  log("SUMMARY", JSON.stringify({ mode, humans: n, ...sum, upPerPlayerKbps: Math.round(sum.upAvgKbps / n), minigames: mgs }));
  fs.writeFileSync(`/work/measure-humans${n}.json`, JSON.stringify({ mode, n, sum, rows }, null, 1));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
