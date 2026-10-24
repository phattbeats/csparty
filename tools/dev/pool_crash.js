// Crash isolation for the one-container build (#4475): N full bot lobbies at once, then kill -9 one lobby's ReHLDS.
// The others must keep running (same pids, matches going), the crashed lobby must be reaped (slot dir gone, Worker told),
// the relay must stay up, and the freed slot must take a new lobby.
//   LOBBY=http://127.0.0.1:8794 AGENT=http://127.0.0.1:18097 RCON_PW=... CONTAINER=csp4475-app node pool_crash.js 5
// CONTAINER: docker container the lobby servers run in (kill -9 goes through `docker exec`); empty = kill from here.
const dgram = require("node:dgram");
const { execFileSync } = require("node:child_process");
const LOBBY = process.env.LOBBY || "http://127.0.0.1:8794", AGENT = process.env.AGENT || "http://127.0.0.1:18097";
const RPW = process.env.RCON_PW || "", CONTAINER = process.env.CONTAINER || "", N = +(process.argv[2] || 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(), log = (...a) => console.log(`+${Math.round((Date.now() - T0) / 1000)}s`, ...a);
let failed = 0;
const check = (ok, what) => { log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; return ok; };
const until = async (fn, ms, every = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every); } return null; };
const agent = async () => (await fetch(`${AGENT}/status`)).json();
const sh = (cmd) => CONTAINER ? execFileSync("docker", ["exec", CONTAINER, "sh", "-c", cmd]).toString() : execFileSync("sh", ["-c", cmd]).toString();
const rcon = (port, cmd) => new Promise((resolve) => {
  const s = dgram.createSocket("udp4"); let stage = 0;
  const done = (v) => { try { s.close(); } catch {} resolve(v); };
  setTimeout(() => done(""), 2500);
  s.on("message", (m) => { const txt = m.toString("latin1").slice(4);
    if (stage === 0) { const c = /challenge rcon (\d+)/.exec(txt); if (!c) return; stage = 1; s.send(Buffer.from(`\xff\xff\xff\xffrcon ${c[1]} "${RPW}" ${cmd}\n`, "latin1"), port, "127.0.0.1"); } else done(txt); });
  s.send(Buffer.from("\xff\xff\xff\xffchallenge rcon\n", "latin1"), port, "127.0.0.1");
});
const create = async (i) => {
  const pid = `pid-crash-${i}-${Date.now()}`;
  const j = await (await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid, name: `C${i}` }) })).json();
  if (!j.code) throw new Error(`create: ${j.error}`);
  return { code: j.code, pid, states: [] };
};
const host = (l) => new Promise((resolve) => {
  const ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${l.code}/ws?pid=${l.pid}&name=C`);
  ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ t: "start" })), 500);
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.state) { if (l.states.at(-1) !== m.state) l.states.push(m.state); l.state = m.state; } if (m.state === "in_match") resolve(ws); };
  l.ws = ws;
});
const snap = async (codes) => { const st = await agent(); return Object.fromEntries(st.detail.filter((d) => codes.includes(d.code)).map((d) => [d.code, d])); };
const table = (st, codes) => codes.map((c) => { const d = st[c]; return d ? `${c}:${d.port} pid ${d.pid} cpu ${d.cpu}% ${d.memMb}MB` : `${c}: gone`; }).join(" | ");

(async () => {
  const ls = []; for (let i = 0; i < N; i++) ls.push(await create(i));
  const codes = ls.map((l) => l.code);
  await Promise.all(ls.map(host));
  log(`${N} lobbies in match: ${codes.join(" ")}`);
  const up = await until(async () => { const st = await agent(); let all = true;
    for (const l of ls) { const d = st.detail.find((x) => x.code === l.code);
      if (d?.events.some((e) => e.name === "match_started")) continue; all = false; if (d) await rcon(d.port, "csp_start"); }
    return all; }, 240000, 8000);
  check(!!up, `all ${N} lobby servers up with a match started`);
  await sleep(30000);
  const before = await snap(codes);
  log("before crash:", table(before, codes));
  check(codes.every((c) => before[c]?.pid), "every lobby has its own server process");
  const procs = sh("pgrep -c hlds_linux").trim(); log(`hlds_linux processes in the container: ${procs}`);
  const victim = codes[1], vd = before[victim], others = codes.filter((c) => c !== victim);
  log(`kill -9 ${victim} (pid ${vd.pid}, :${vd.port})`);
  sh(`kill -9 ${vd.pid}`);
  const reaped = await until(async () => !(await agent()).detail.some((d) => d.code === victim), 20000, 500);
  check(!!reaped, "the crashed lobby is reaped from the pool within 20 s");
  check(await until(async () => sh(`ls /run/csp-slots`).split("\n").every((n) => n !== victim), 15000, 500) !== null || true, "slot dir listing read");
  check(!sh("ls /run/csp-slots").split("\n").includes(victim), "its slot directory is removed");
  const wstate = await until(async () => ls[1].states.slice(-2).join(">") === "in_match>open", 20000, 500);
  log(`Worker's view of the crashed lobby: state ${ls[1].state}, ws readyState ${ls[1].ws.readyState}, states ${ls[1].states.join(">")}`);
  check(!!wstate, "the Worker reopened the lobby (in_match -> open)");
  await sleep(45000);
  const after = await snap(others);
  log("after crash:", table(after, others));
  check(others.every((c) => after[c] && after[c].pid === before[c].pid), "the other lobbies kept their server processes (same pids)");
  check(others.every((c) => ls.find((l) => l.code === c).state === "in_match"), "the others are still in_match on the Worker");
  for (const c of others) { const out = await rcon(after[c].port, "status"); check(/hostname/.test(out), `${c} still answers rcon`); }
  check(sh("pgrep -c hlds_linux").trim() === String(N - 1), `${N - 1} hlds_linux processes left`);
  check((await fetch(`${AGENT}/status`)).ok && (await fetch(`${LOBBY}/healthz`)).ok, "pool-agent and Worker still answer");
  const fresh = await create(99); await host(fresh); ls.push(fresh);
  const back = await until(async () => (await agent()).detail.some((d) => d.code === fresh.code && d.events.some((e) => e.name === "server_ready")), 120000, 3000);
  check(!!back, "a new lobby starts in the freed capacity");
  log("final:", table(await snap([...others, fresh.code]), [...others, fresh.code]));
  for (const l of ls) try { l.ws.send(JSON.stringify({ t: "end" })); } catch {}
  await sleep(3000);
  log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
