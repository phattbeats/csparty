// PHA-4091: hub assertion check (node test/phattid_test.mjs). The check itself is phatt-id-verify (PHA-5152), whose
// self-test and shared vector run first in npm test; this is the lobby's use of it.
import assert from "node:assert/strict";
import { assertedMember, _resetKeyCache } from "../src/phattid.js";
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = { alg: "Ed25519", kid: "t", x: (await crypto.subtle.exportKey("jwk", kp.publicKey)).x }; // what the hub's /key serves
const b = (u) => Buffer.from(u).toString("base64url");
const sign = async (c) => { const body = b(JSON.stringify(c)); return `pa1.${body}.${b(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode("pa1." + body)))}`; };
const t = Math.floor(Date.now() / 1000), aud = "lobby.example";
const good = await sign({ sub: "arc-1", aud, iat: t, exp: t + 300, username: "brandy", name: "Brandy" });
const env = { PHATT_HUB: "https://hub.example" };
let fetches = 0;
const fetchImpl = async () => (fetches++, new Response(JSON.stringify(pub)));
_resetKeyCache();
assert.deepEqual(await assertedMember(good, env, aud, fetchImpl), { arcadeId: "arc-1", display: "Brandy" });
assert.deepEqual(await assertedMember(await sign({ sub: "arc-2", aud, iat: t, exp: t + 300, username: "sam" }), env, aud, fetchImpl), { arcadeId: "arc-2", display: "sam" }, "no name: the username");
assert.equal(await assertedMember(good, env, "other", fetchImpl), null, "wrong aud");
assert.equal(await assertedMember(await sign({ sub: "a", aud, iat: t - 900, exp: t - 1 }), env, aud, fetchImpl), null, "expired");
assert.equal(await assertedMember(good.slice(0, -4) + "AAAA", env, aud, fetchImpl), null, "bad sig");
assert.equal(fetches, 1, "one key fetch for all of that");
assert.equal(await assertedMember(good, {}, aud, fetchImpl), null, "hub unset = guest");
assert.equal(await assertedMember("", env, aud, fetchImpl), null, "no token = guest");
console.log("phattid ok");
