// Public hardening (#3992) against `wrangler dev`: per-IP lookup and join limits, the name and party-name filter,
// Turnstile on create, and the abuse panel counting all of it. Run it on its own (it uses up this IP's limits for a
// minute), after a fresh `wrangler dev` or at least a minute after the other suites.
//   npx wrangler dev --port 8787 --var 'POOL:[]'                         node test/harden_test.mjs
//   with Turnstile, test keys (always pass / always fail):
//   npx wrangler dev --port 8787 --var 'POOL:[]' --var TURNSTILE_SITEKEY:1x00000000000000000000AA --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA
//                                                                        TURNSTILE=pass node test/harden_test.mjs
//   ... --var TURNSTILE_SECRET:2x0000000000000000000000000000000AA     TURNSTILE=fail node test/harden_test.mjs
const LOBBY = process.env.LOBBY || "http://127.0.0.1:8787";
const TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token-change-me-0123456789";
const TS = process.env.TURNSTILE || "off";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

const admin = async (path, body) => {
  const r = await fetch(`${LOBBY}/api/admin/${path}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const stats = async () => {
  const T = {};
  for (const r of (await admin("stats?range=24h")).body.totals) (T[r.e] ||= {})[r.k] = r.n;
  return (e, k) => T[e]?.[k] || 0;
};
const create = async (body) => {
  const r = await fetch(`${LOBBY}/api/lobbies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const member = (code, pid, name) => {
  const m = { states: [], errors: [] };
  const ws = new WebSocket(`${LOBBY.replace(/^http/, "ws")}/api/lobbies/${code}/ws?${new URLSearchParams({ pid, name, char: "-1" })}`);
  m.ws = ws;
  ws.onmessage = (e) => { const x = JSON.parse(e.data); (x.t === "state" ? m.states : m.errors).push(x); };
  m.closed = new Promise((r) => { ws.addEventListener("close", (e) => r({ code: e.code, reason: e.reason })); });
  m.opened = new Promise((r) => { ws.addEventListener("open", () => r(true)); ws.addEventListener("close", () => r(false)); });
  return m;
};

check((await admin("action", { action: "caps", createCap: 200 })).status === 200, "admin: raise the create cap so this test can make parties");
const before = await stats();

// --- Turnstile
const st = await (await fetch(`${LOBBY}/api/status`)).json();
check(TS === "off" ? st.turnstile === "" : st.turnstile === "1x00000000000000000000AA", `/api/status names the Turnstile site key (${JSON.stringify(st.turnstile)})`);
check(Number.isInteger(st.queued), `/api/status reports the queue length (${st.queued})`);
if (TS === "fail") {
  const r = await create({ pid: "pid-tsfail01", name: "Mallory", ts: "XXXX.DUMMY.TOKEN.XXXX" });
  check(r.status === 403 && r.body.turnstile === true, `create with a failing Turnstile token -> 403 (${r.status} ${r.body.error})`);
  const q = await fetch(`${LOBBY}/api/quickplay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pid: "pid-tsfail02", name: "Mallory" }) });
  check(q.status === 403, `quick play that would make a party needs Turnstile too (${q.status})`);
  check((await stats())("rejected", "turnstile") > before("rejected", "turnstile"), "abuse panel counts the Turnstile failure");
  // a party made by the admin-free path doesn't exist, so the rest of this suite needs a passing secret
  process.exit(failed ? 1 : 0);
}
if (TS === "pass") {
  const r = await create({ pid: "pid-tsnone01", name: "Nobody" });
  check(r.status === 403, `create without a token -> 403 (${r.status})`);
}
const ts = TS === "pass" ? "XXXX.DUMMY.TOKEN.XXXX" : undefined;

// --- name and party-name filter
const a = await create({ pid: "pid-harden01", name: "Alice", title: "sh1t show", ts });
check(a.status === 200, `create -> ${a.body.code}`);
const code = a.body.code;
const info = await (await fetch(`${LOBBY}/api/lobbies/${code}`)).json();
check(info.title === "", `an obscene party name is dropped (${JSON.stringify(info.title)})`);
const A = member(code, "pid-harden01", "Alice");
const B = member(code, "pid-harden02", "n1gg3r");
const C = member(code, "pid-harden03", "Scunthorpe");
await Promise.all([A.opened, B.opened, C.opened]);
await sleep(600);
const roster = A.states.at(-1)?.members.map((m) => m.name) || [];
check(roster.includes("Player") && !roster.some((n) => /n1gg/i.test(n)), `a slur as a name becomes "Player" (${roster.join(", ")})`);
check(roster.includes("Scunthorpe"), "a harmless name with a rude substring is kept (Scunthorpe)");
check(B.errors.some((e) => e.t === "error" && e.name), "the page is told its name was refused (so it clears the box)");
B.ws.send(JSON.stringify({ t: "name", name: "B0bby" }));
C.ws.send(JSON.stringify({ t: "name", name: "a s s h o l e" }));
await sleep(600);
const roster2 = A.states.at(-1)?.members.map((m) => m.name) || [];
check(roster2.includes("B0bby") && !roster2.some((n) => /a s s/i.test(n)), `renames go through the filter too (${roster2.join(", ")})`);
for (const m of [A, B, C]) m.ws.close();
await sleep(300);

// --- code lookups: 30 a minute per IP, then 429 (a code is 1 in 29M, so guessing is out)
let firstRefused = 0;
for (let i = 1; i <= 45 && !firstRefused; i++) {
  const r = await fetch(`${LOBBY}/api/lobbies/ZZZZ${"ABCDEFGHJKMNPQRSTUVWXYZ23456789"[i % 31]}`);
  if (r.status === 429) firstRefused = i;
  else if (r.status !== 404) { check(false, `lookup ${i}: unexpected ${r.status}`); break; }
}
check(firstRefused > 20 && firstRefused <= 32, `code lookups refused after about 30 a minute (lookup ${firstRefused} got 429)`);
const r429 = await fetch(`${LOBBY}/api/lobbies/${code}`);
check(r429.status === 429 && /Too many tries/.test((await r429.json()).error), "even a real code is refused while limited, with a message the page shows");

// --- lobby joins: 20 sockets a minute per IP, then closed with 4029 and the reason
let refusedAt = 0, reason = "";
for (let i = 1; i <= 30 && !refusedAt; i++) {
  const m = member(code, `pid-joiner${String(i).padStart(2, "0")}`, `J${i}`);
  const ok = await m.opened;
  const end = await Promise.race([m.closed, sleep(250).then(() => null)]);
  if (end?.code === 4029) { refusedAt = i; reason = end.reason; }
  else if (!ok) { check(false, `join ${i}: closed ${end?.code}`); break; }
  m.ws.close();
}
check(refusedAt > 12 && refusedAt <= 22, `lobby joins refused after about 20 a minute (join ${refusedAt} closed 4029)`);
check(/Too many tries/.test(reason), `the close reason says why (${reason})`);

// --- the abuse panel
await sleep(500);
const after = await stats();
check(after("rate_limited", "lookup") > before("rate_limited", "lookup"), "abuse panel: code lookups rate limited");
check(after("rate_limited", "join") > before("rate_limited", "join"), "abuse panel: lobby joins rate limited");
check(after("rate_limited", "lookup") - before("rate_limited", "lookup") <= 2, "a limited IP is counted once a minute, not per refused request");
check(after("rejected", "name") >= before("rejected", "name") + 2, `abuse panel: filtered names (${after("rejected", "name") - before("rejected", "name")})`);
check(after("rejected", "title") > before("rejected", "title"), "abuse panel: filtered party names");

await admin("action", { action: "caps", createCap: 10 });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
