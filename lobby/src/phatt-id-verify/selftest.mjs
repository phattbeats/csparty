// phatt-id-verify self-test (PHA-5152), vendored unchanged into every server that takes a PHATT ID pass.
// Run: node <dir>/selftest.mjs   (Node 22+; plain node:assert, so it also runs under node --test)
// 1. The vendored files match SHA256SUMS: nobody edited this copy in place.
// 2. The shared vector: one good pass from the fixture hub key, and the forged, wrong-aud and expired ones refused.
// 3. The key cache: TTL, a rotated key picked up on a failed signature, at most one hub fetch a minute, pinned keys.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { VERSION, verifyPass, hubKey, checkPass, passFromHeader } from './phatt-id-verify.mjs';

const here = (f) => new URL(f, import.meta.url);
for (const line of fs.readFileSync(here('SHA256SUMS'), 'utf8').trim().split('\n')) {
  const [sum, file] = line.trim().split(/\s+/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(here(file))).digest('hex'), sum, `${file} differs from phatt-id-verify ${VERSION}: re-vendor it, do not edit it here`);
}

const V = JSON.parse(fs.readFileSync(here('vector.json'), 'utf8'));
for (const c of V.cases) assert.deepEqual(await verifyPass(c.token, V.key, { aud: V.aud, now: V.now }), c.expect, c.name);
const good = V.cases.find((c) => c.name === 'good');
assert.equal(await verifyPass(good.token, V.key, { now: V.now }), null, 'no aud given: refused');
assert.equal(await verifyPass(good.token, null, { aud: V.aud, now: V.now }), null, 'no key: refused');
assert.equal(await verifyPass(good.token, { x: 'AAAA' }, { aud: V.aud, now: V.now }), null, 'junk key: refused');

// a fake hub whose key can rotate
const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
let t = V.now, served = other, fetches = 0, down = false;
const fetch = async () => { fetches++; if (down) throw new Error('down'); return { ok: true, json: async () => ({ alg: 'Ed25519', kid: 'k', x: served }) }; };
const keys = hubKey({ hub: 'https://hub.test/', fetch, now: () => t });
const o = { aud: V.aud, now: V.now };

assert.equal(await checkPass(good.token, keys, o), null, 'the hub serves another key: refused');
assert.equal(fetches, 1, 'one fetch; the failed signature does not refetch within the minute');
served = V.key.x; // the hub rotates
assert.equal(await checkPass(good.token, keys, o), null, 'still within the minute: no refetch');
assert.equal(fetches, 1);
t += 60_000;
assert.deepEqual(await checkPass(good.token, keys, o), good.expect, 'a minute on, the failed signature refetches and the rotated key takes it');
assert.equal(fetches, 2);
for (const c of V.cases.filter((c) => !c.expect)) assert.equal(await checkPass(c.token, keys, o), null, 'checkPass: ' + c.name);
assert.equal(fetches, 2, 'bad passes never fetch within the minute');
t += 60_000;
await checkPass(V.cases.find((c) => c.name === 'wrong aud').token, keys, o);
await checkPass(V.cases.find((c) => c.name === 'expired').token, keys, o);
assert.equal(fetches, 2, 'a well-signed pass for the wrong aud or out of date never refetches');
t += 600_000;
down = true;
assert.deepEqual(await checkPass(good.token, keys, o), good.expect, 'TTL over and the hub down: the old key stands');
assert.equal(fetches, 3);
await keys.get(); await keys.get({ fresh: true });
assert.equal(fetches, 3, 'the hub down: no more than one try a minute');
assert.equal(await checkPass(good.token, hubKey({ fetch, now: () => t }), o), null, 'no key at all: a guest, no throw');

let pinnedFetches = 0;
const pinned = hubKey({ pinned: V.key.x, fetch: async () => { pinnedFetches++; throw new Error('no'); } });
assert.deepEqual(await checkPass(good.token, pinned, o), good.expect, 'pinned key');
assert.equal(await checkPass(V.cases[1].token, pinned, o), null);
assert.equal(pinnedFetches, 0, 'a pinned key never fetches');

let n = 0; const slow = hubKey({ fetch: async () => { n++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, json: async () => V.key }; } });
await Promise.all([slow.get(), slow.get(), slow.get({ fresh: true })]);
assert.equal(n, 1, 'concurrent gets share one fetch');

assert.equal(passFromHeader('PhattId ' + good.token), good.token);
assert.equal(passFromHeader('Bearer x'), null);
assert.equal(passFromHeader(undefined), null);

console.log(`phatt-id-verify ${VERSION}: ok (${V.cases.length} vector cases)`);
