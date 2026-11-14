// PHA-5163: web/looks.js, the pool-agent's side of PHATT ID looks (node web/looks_test.js)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { looksFor, signed, looksOn } from "./looks.js";

const env = { ARCADE_URL: "https://arcade.example/", ARCADE_KID: "k1", ARCADE_SECRET: "s3cret" };
const ana = "3f2b1c4d-1111-4222-8333-944455556666", bob = "4a3b2c1d-2222-4333-8444-a55566667777";

const h = signed(env, "body", 1_700_000_000_000);
assert.equal(h["x-arcade-sig"], crypto.createHmac("sha256", "s3cret").update("1700000000.body").digest("base64url"), "same HMAC as arcade verifySurface");
assert.equal(h["x-arcade-surface"], "csparty");
assert.ok(looksOn(env) && !looksOn({ ARCADE_URL: "x" }));

let req = null;
const arcade = async (url, init) => { req = { url, init }; return new Response(JSON.stringify({ game: "csparty", renders: {
  [ana]: { hat: "sprites/csp/hat_benny.spr", spray: "bad asset; quit" }, [bob]: { hat: "sprites/csp/hat_owl.spr" } } })); };
const looks = await looksFor(env, [{ pid: "gp-ana-12345", aid: ana }, { pid: "gp-bob-12345", aid: bob }, { pid: "bad pid;x", aid: ana }, { pid: "gp-guest-123" }], { fetchImpl: arcade });
assert.equal(req.url, "https://arcade.example/api/render");
assert.deepEqual(JSON.parse(req.init.body), { arcade_ids: [ana, bob] });
assert.equal(req.init.headers["x-arcade-sig"], crypto.createHmac("sha256", "s3cret").update(`${req.init.headers["x-arcade-ts"]}.${req.init.body}`).digest("base64url"));
assert.deepEqual(looks, [{ pid: "gp-ana-12345", slot: "hat", asset: "sprites/csp/hat_benny.spr" }, { pid: "gp-bob-12345", slot: "hat", asset: "sprites/csp/hat_owl.spr" }],
  "only well-formed pids, only assets fit for an rcon line");

req = null;
assert.deepEqual(await looksFor(env, [{ pid: "gp-guest-123" }], { fetchImpl: arcade }), []); assert.equal(req, null, "no members: no call");
assert.deepEqual(await looksFor({}, [{ pid: "gp-ana-12345", aid: ana }], { fetchImpl: arcade }), [], "no arcade config: off");
assert.deepEqual(await looksFor(env, [{ pid: "gp-ana-12345", aid: ana }], { fetchImpl: async () => { throw new Error("down"); } }), [], "arcade down");
assert.deepEqual(await looksFor(env, [{ pid: "gp-ana-12345", aid: ana }], { fetchImpl: async () => new Response("no", { status: 401 }) }), [], "refused");
console.log("looks_test ok");
