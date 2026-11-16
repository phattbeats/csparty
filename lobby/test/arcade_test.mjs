// PHA-4091: members' seat results -> signed arcade events (node test/arcade_test.mjs)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { toEvents, drain, signedHeaders } from "../src/arcade.js";
const aid = "3f2b1c4d-1111-4222-8333-944455556666";
const it = { code: "ABCD", at: Date.now() - 1000, arcade_id: aid, place: 1, stars: 4, money: 30, mg_wins: 3, awards: 0, timeouts: 2, turns: 10, players: 3 };
const evs = await toEvents(it);
// PHA-5028: this seat finished the match (2 timeouts in 10 turns) and won minigames, so both dailies ride along
assert.deepEqual(evs.map((e) => e.type), ["match_end", "turn_timeout", "turn_timeout", "daily_complete", "daily_complete"]);
assert.deepEqual(evs.filter((e) => e.type === "daily_complete").map((e) => e.payload.daily), ["finish_match", "win_minigame"]);
assert.deepEqual(evs[0].payload, { players: 3, party_size: 3, placement: 1, score: 4, rounds: 10, winner: true, awards: 0, mg_wins: 3, timeouts: 2 });
assert.ok(evs.every((e) => /^[A-Za-z0-9_.:-]{1,64}$/.test(e.id)), "ids fit the arcade's id rule");
assert.deepEqual((await toEvents(it)).map((e) => e.id), evs.map((e) => e.id), "same item, same ids (retries dedupe)");
assert.ok(!JSON.stringify(evs).includes("money") && !("pid" in evs[0]), "no extra fields");

const env = { ARCADE_URL: "https://arcade.example/", ARCADE_KID: "k1", ARCADE_SECRET: "s3cret" };
const h = await signedHeaders(env, "body", 1_700_000_000_000);
assert.equal(h["x-arcade-sig"], createHmac("sha256", "s3cret").update("1700000000.body").digest("base64url"), "same HMAC as arcade verifySurface");

let seen = null;
const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ accepted: 3, rejected: [], unlocked: [{ key: "winner_winner" }] })); };
let r = await drain([it], env, { fetchImpl: ok });
assert.equal(seen.url, "https://arcade.example/api/events");
assert.equal(seen.init.body.split("\n").length, 5);
assert.deepEqual([r.queue.length, r.sent, r.unlocked], [0, 1, 1]);

r = await drain([it], env, { fetchImpl: async () => new Response(JSON.stringify({ rejected: [{ id: evs[0].id, reason: "unknown_member" }] })) });
assert.deepEqual([r.queue.length, r.dropped], [0, 1], "never-signed-into-arcade: dropped, not retried forever");
r = await drain([it], env, { fetchImpl: async () => new Response(JSON.stringify({ rejected: [{ id: evs[0].id, reason: "rate_limited" }] })) });
assert.equal(r.queue.length, 1, "rate limited: kept");
r = await drain([it], env, { fetchImpl: async () => { throw new Error("down"); } });
assert.deepEqual([r.queue.length, r.error], [1, "down"], "arcade down: kept");
r = await drain([it], env, { fetchImpl: async () => new Response("{}", { status: 401 }) });
assert.deepEqual([r.queue.length, r.error], [1, "arcade 401"], "bad key: held, not dropped");
r = await drain([it], {}, { fetchImpl: ok });
assert.equal(r.queue.length, 1, "unconfigured: held");
r = await drain([{ ...it, at: Date.now() - 8 * 864e5 }], env, { fetchImpl: ok });
assert.deepEqual([r.queue.length, r.dropped], [0, 1], "too old for the arcade: dropped");
// PHA-5028 dailies: reported, never priced; one id per member per day
{
  const dl = async (x) => (await toEvents(x)).filter((e) => e.type === "daily_complete").map((e) => e.payload.daily);
  assert.deepEqual(await dl({ ...it, mg_wins: 0 }), ["finish_match"], "no minigame won: only the finish daily");
  assert.deepEqual(await dl({ ...it, timeouts: 8 }), ["win_minigame"], "timed out of most of the match: not finished, but the minigame win stands");
  assert.deepEqual(await dl({ ...it, timeouts: 8, mg_wins: 0 }), [], "walked away and won nothing: no dailies");
  const a = (await toEvents(it)).find((e) => e.type === "daily_complete"), b = (await toEvents({ ...it, code: "WXYZ", at: it.at + 60_000 })).find((e) => e.type === "daily_complete");
  assert.equal(a.id, b.id, "a second match the same day is the same daily id: the arcade pays once");
  const c = (await toEvents({ ...it, at: it.at + 2 * 864e5 })).find((e) => e.type === "daily_complete");
  assert.notEqual(a.id, c.id, "another day, another id");
  assert.ok(!a.id.includes(aid) && /^[A-Za-z0-9_.:-]{1,64}$/.test(a.id) && !("xp" in a.payload), "no PHATT ID in the id, no XP chosen by the game");
}
console.log("arcade ok");

// PHATT ID hub path (clubhouse /api/results/csparty)
{
  const { hubReport } = await import("../src/arcade.js");
  const henv = { PHATT_HUB: "https://hub.example/", CSPARTY_RESULT_KEY: "k" };
  let got = null;
  const hub = async (url, init) => { got = { url, init }; return new Response(JSON.stringify({ ok: true })); };
  let r = await drain([{ ...it }], henv, { fetchImpl: hub, now: 1_700_000_000_000 + 1 });
  assert.equal(got.url, "https://hub.example/api/results/csparty");
  assert.equal(got.init.headers["x-csp-sig"], createHmac("sha256", "k").update(`1700000000.${got.init.body}`).digest("base64url"), "same HMAC as the hub");
  const b = JSON.parse(got.init.body);
  assert.deepEqual([b.sub, b.placement, b.players, b.score], [aid, 1, 3, 4]);
  assert.deepEqual((await hubReport(it)).run, b.run, "stable run id");
  assert.deepEqual([r.queue.length, r.sent], [0, 1]);
  r = await drain([{ ...it, at: Date.now() }], henv, { fetchImpl: async () => new Response("{}", { status: 503 }) });
  assert.equal(r.queue.length, 1, "hub down: kept");
  r = await drain([{ ...it, at: Date.now() }], henv, { fetchImpl: async () => new Response('{"error":"unknown_member"}', { status: 404 }) });
  assert.deepEqual([r.queue.length, r.dropped], [0, 1], "not a member: dropped");
}
console.log("hub ok");
