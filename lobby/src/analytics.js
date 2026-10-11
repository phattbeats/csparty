// Analytics events (#3991, docs/lobby-design.md section 8). Privacy-light: no accounts, no raw IPs, no chat.
// A player's random localStorage id is only ever written as sha256(id + salt-of-the-day), and the salt is a random
// value the directory forgets when the UTC day ends, so a player can be counted once per day but not followed
// across days. Country comes from Cloudflare's cf-ipcountry.
//
// Every event goes two places, both written by the directory Durable Object (Directory.record):
//   1. Workers Analytics Engine, dataset csparty_events, for ad hoc SQL. One layout for every event:
//        index1  lobby code ("" if none)
//        blob1   event name           blob2..blob5  the event's fields (EVENTS below, in order)
//        blob6   country              blob7         player hash (day-salted)     blob8  game server id
//        double1..double4  the event's numbers (EVENTS below, in order)
//   2. Hourly counters in the directory's SQLite (table rollup: hour, e, k, n, sum), which the admin dashboard
//      and the CSV export read. Exact (AE samples under load), instant, and needs no API token.

export const DATASET = "csparty_events";

// name: [blob fields, double fields]
export const EVENTS = {
  lobby_created: [["visibility", "board", "via"], ["seats"]],
  lobby_joined: [["role", "via"], ["members_after"]],
  lobby_ready: [[], ["secs_since_join"]],
  lobby_unready: [[], ["secs_since_join"]],
  lobby_all_ready: [[], ["secs_since_create", "humans"]],
  lobby_left: [["phase", "reason"], ["secs_in_lobby"]],
  lobby_expired: [["reached"], ["lifetime_s", "matches"]],
  lobby_closed: [["reason"], ["lifetime_s"]],
  match_started: [["board", "start_mode", "host_id"], ["humans", "bots", "queue_wait_s"]],
  start_queued: [["start_mode"], []],
  match_closed: [["reason", "outcome", "last_minigame"], ["duration_s", "last_round"]],
  reconnect: [["outcome"], ["gap_s"]],
  capacity: [["host_id", "status"], ["running", "max", "peers", "downloads"]],
  // from the game server: the P2 pool-agent tails the plugin's [CSPEV] lines and posts them to /api/events
  turn_taken: [["character"], ["turn_no"]],
  minigame_picked: [["minigame", "split"], ["round_no"]],
  minigame_result: [["minigame", "winner"], ["duration_s", "participants"]],
  match_finished: [["winner", "bonus_stars"], ["duration_s", "rounds", "humans"]],
  match_abandoned: [["reason"], ["duration_s", "last_round"]],
  // operations and abuse
  rate_limited: [["what"], []],
  rejected: [["why"], []],
  auth_failed: [[], []],
  admin_action: [["action"], []],
};
// what /api/events accepts from a game server
export const GAME_EVENTS = new Set(["turn_taken", "minigame_picked", "minigame_result", "match_finished", "match_abandoned", "capacity"]);

// low-cardinality strings only: anything else is cut down to this
export const blob = (s) => String(s ?? "").replace(/[^A-Za-z0-9_:.\-]/g, "").slice(0, 32);
export const num = (x) => (Number.isFinite(+x) ? Math.max(-1e9, Math.min(1e9, +x)) : 0);
export const secs = (ms) => Math.max(0, Math.round(ms / 1000));
export const hourOf = (t) => Math.floor(t / 3600e3) * 3600e3;
export const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// time from lobby made to first match start, for the dashboard's distribution
// (keys pass blob(): letters, digits, _ : . - only)
export const TTS_BUCKETS = ["lt30s", "30-60s", "1-2m", "2-5m", "5-10m", "10m_plus"];
export const ttsBucket = (s) => TTS_BUCKETS[s < 30 ? 0 : s < 60 ? 1 : s < 120 ? 2 : s < 300 ? 3 : s < 600 ? 4 : 5];

// A datapoint in the layout above. ev: {e, code, b: [], d: [], cc, h, slot}
export const datapoint = (ev) => {
  const b = (ev.b || []).slice(0, 4).map(blob);
  while (b.length < 4) b.push("");
  const d = (ev.d || []).slice(0, 4).map(num);
  while (d.length < 4) d.push(0);
  return { indexes: [blob(ev.code)], blobs: [ev.e, ...b, blob(ev.cc), ev.h || "", blob(ev.slot)], doubles: d };
};
