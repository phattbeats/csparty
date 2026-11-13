// PHATT ID results (PHA-4091): members' seat_result lines (plugin -> pool-agent -> Directory.arcadeQueue) go to the
// arcade service as signed csparty events (POST <ARCADE_URL>/api/events, NDJSON). Guests never get here: the lobby
// dropped them in Lobby.arcadeSeats. Same HMAC as every arcade surface: X-Arcade-Surface/-Kid/-Ts/-Sig =
// HMAC-SHA256(secret, ts + "." + body), base64url (arcade src/auth.js verifySurface).
// Config: var ARCADE_URL, secrets ARCADE_KID + ARCADE_SECRET (the csparty entry of the arcade's SURFACE_SECRETS).
// Any of them unset = the queue just holds (capped at 500) until they are.
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const MAX_AGE = 6 * 864e5;           // the arcade refuses events older than 7 days
const MAX_TIMEOUTS = 20;             // per seat per match; more is a stuck seat, not play
// reasons the arcade will never accept (fnvmp-tracker/src/flush.js keeps the same list): drop instead of retrying
const PERMANENT = new Set(["unknown_member", "banned", "bad_time", "bad_id", "bad_arcade_id", "unknown_type", "bad_payload", "payload_too_big", "game_mismatch"]);
const permanent = (r) => PERMANENT.has(r) || /^(missing|bad_field|unexpected_field):/.test(String(r));

export const arcadeSvcOn = (env) => !!(env.ARCADE_URL && env.ARCADE_KID && env.ARCADE_SECRET);
// PHATT ID hub (clubhouse server/index.js /api/results/csparty): the profile cards read from here. Var PHATT_HUB,
// secret CSPARTY_RESULT_KEY. x-csp-ts / x-csp-sig = HMAC-SHA256(key, ts + "." + body), base64url.
export const hubOn = (env) => !!(env.PHATT_HUB && env.CSPARTY_RESULT_KEY);
export const arcadeOn = (env) => arcadeSvcOn(env) || hubOn(env);

export async function hubReport(it) {
  const run = (await hex(`${it.code}|${it.at}`)).slice(0, 32);
  return { sub: it.arcade_id, run, players: Math.min(4, Math.max(1, int(it.players))), placement: Math.min(4, Math.max(1, int(it.place))),
    score: Math.min(999, int(it.stars)), rounds: int(it.turns), mg_wins: Math.min(99, int(it.mg_wins)), awards: Math.min(99, int(it.awards)), timeouts: Math.min(99, int(it.timeouts)) };
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
// one seat to the hub -> "ok" (stored, or already stored), "drop" (never accepted), "retry"
export async function hubSend(it, env, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const body = JSON.stringify(await hubReport(it)), ts = String(Math.floor(now / 1000));
  try {
    const r = await fetchImpl(String(env.PHATT_HUB).replace(/\/+$/, "") + "/api/results/csparty", { method: "POST",
      headers: { "content-type": "application/json", "x-csp-ts": ts, "x-csp-sig": await hmac(env.CSPARTY_RESULT_KEY, `${ts}.${body}`) }, body, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.error && j.error !== "duplicate" ? "drop" : "ok";
    if (r.status === 400 || r.status === 404) return "drop";      // bad_report / unknown_member
    return "retry";                                               // 401 (key/clock), 429, 5xx
  } catch { return "retry"; }
}

async function hex(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

// one queued seat -> its arcade events. Ids come from the item, so a retry never counts twice.
export async function toEvents(it) {
  const base = "csp-" + (await hex(`${it.code}|${it.at}|${it.arcade_id}`)).slice(0, 32);
  const place = int(it.place), players = Math.max(1, int(it.players));
  const ev = (k, type, payload) => ({ id: `${base}-${k}`, game: "csparty", type, arcade_id: it.arcade_id, at: it.at, run_id: `csp-${it.code}`, payload });
  const out = [ev("me", "match_end", {
    players, party_size: players, placement: place, score: int(it.stars), rounds: int(it.turns), winner: place === 1,
    awards: int(it.awards), mg_wins: int(it.mg_wins), timeouts: int(it.timeouts),
  })];
  for (let i = 1; i <= Math.min(int(it.timeouts), MAX_TIMEOUTS); i++) out.push(ev(`t${i}`, "turn_timeout", { turn: i }));
  return out;
}

export async function signedHeaders(env, body, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const sig = await hmac(env.ARCADE_SECRET, `${ts}.${body}`);
  return { "content-type": "application/x-ndjson", "x-arcade-surface": "csparty", "x-arcade-kid": env.ARCADE_KID, "x-arcade-ts": ts, "x-arcade-sig": sig };
}

// One pass over the queue: post up to 4 seats' events (<= 100 lines), keep what should be retried.
// -> { queue, sent (seats done), dropped (lines refused for good), unlocked, error }. Never throws.
export async function drain(queue, env, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const stats = { sent: 0, dropped: 0, unlocked: 0, error: "" };
  let q = (queue || []).filter((it) => now - it.at < MAX_AGE);
  stats.dropped += (queue || []).length - q.length;
  if (!arcadeOn(env) || !q.length) return { queue: q, ...stats };
  if (hubOn(env)) { // hub first; an item marked hub:true is not sent there again
    for (const it of q.slice(0, 4).filter((x) => !x.hub)) {
      const o = await hubSend(it, env, { fetchImpl, now });
      if (o === "retry") { stats.error = "hub retry"; break; }
      it.hub = true; if (o === "drop") stats.dropped++;
    }
  }
  if (!arcadeSvcOn(env)) { const done = q.filter((x) => x.hub); stats.sent += done.length; return { queue: q.filter((x) => !x.hub), ...stats }; }
  const ready = q.filter((x) => !hubOn(env) || x.hub); // with both on, the arcade gets a seat only after the hub has it
  const batch = ready.slice(0, 4), rest = q.filter((x) => !batch.includes(x));
  const lines = (await Promise.all(batch.map(toEvents))).flat();
  const body = lines.map((e) => JSON.stringify(e)).join("\n");
  let res;
  try {
    const r = await fetchImpl(String(env.ARCADE_URL).replace(/\/+$/, "") + "/api/events", { method: "POST", headers: await signedHeaders(env, body, now), body, signal: AbortSignal.timeout(15_000) });
    if (r.status >= 400 && r.status < 500 && r.status !== 429) { stats.error = `arcade ${r.status}`; return { queue: q, ...stats }; } // config problem: hold
    if (!r.ok) throw new Error(`arcade ${r.status}`);
    res = await r.json();
  } catch (e) { stats.error = String(e?.message || e); return { queue: q, ...stats }; }
  const retry = new Set((res.rejected || []).filter((x) => !permanent(x.reason)).map((x) => x.id));
  stats.unlocked = (res.unlocked || []).length;
  const keep = [];
  for (const it of batch) {
    const ids = (await toEvents(it)).map((e) => e.id);
    if (ids.some((id) => retry.has(id))) keep.push(it); else stats.sent++;
  }
  stats.dropped += (res.rejected || []).filter((x) => permanent(x.reason)).length; // e.g. unknown_member: never opened the arcade
  return { queue: [...keep, ...rest], ...stats };
}
