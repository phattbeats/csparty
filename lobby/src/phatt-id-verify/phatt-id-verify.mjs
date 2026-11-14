// phatt-id-verify v1 (PHA-5152): the one check of a PHATT ID pass, for every server that takes one.
// Canonical copy: github.com/phattbeats/phatt-id-verify. Each server vendors this directory unchanged; its selftest.mjs
// fails if the file was edited in place. Change it there, bump VERSION, re-vendor everywhere.
//
// A pass is what the hub (clubhouse.phatt.vip, server/phattid.js assertFor) signs for one other server:
//   pa1.<base64url JSON claims>.<base64url Ed25519 signature over "pa1.<claims>">
//   claims: { sub, member, username, name, groups, aud, iat, exp }, good for 5 minutes, for one audience (a host name)
// The hub's public key is GET <hub>/auth/phatt-id/key -> { alg: 'Ed25519', kid, x }.
// Web Crypto only (globalThis.crypto.subtle, atob, TextEncoder), so the same file runs on Node 22+ and Cloudflare Workers.

export const VERSION = '1.0.0';
export const PREFIX = 'pa1';
export const SKEW_S = 60; // an iat this far in the future is still taken (clock drift between the hub and us)
export const HUB = 'https://clubhouse.phatt.vip';

const B64U = /^[A-Za-z0-9_-]+$/;
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);

// -> { pass } or { why }: 'shape' | 'sig' (not signed by this key) | 'aud' | 'exp' (expired, or iat too far ahead)
async function check(token, key, aud, now) {
  const parts = String(token ?? '').split('.');
  const [pre, body, sig] = parts;
  if (parts.length !== 3 || pre !== PREFIX || !B64U.test(body || '') || !B64U.test(sig || '') || body.length > 4000 || sig.length > 200) return { why: 'shape' };
  if (!key || typeof key.x !== 'string') return { why: 'sig' };
  let ok = false;
  try {
    const k = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.x }, { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, k, unb64u(sig), new TextEncoder().encode(pre + '.' + body));
  } catch { ok = false; }
  if (!ok) return { why: 'sig' };
  let c; try { c = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return { why: 'shape' }; }
  if (!c || typeof c !== 'object' || typeof c.sub !== 'string' || !c.sub || typeof c.iat !== 'number' || typeof c.exp !== 'number') return { why: 'shape' };
  if (typeof aud !== 'string' || !aud || c.aud !== aud) return { why: 'aud' };
  const t = Math.floor(now / 1000);
  if (!(c.exp > t) || c.iat > t + SKEW_S) return { why: 'exp' };
  return {
    pass: {
      sub: c.sub,
      member: /^[0-9a-f]{32}$/.test(c.member || '') ? c.member : null, // the hub's member token, when it is one
      username: str(c.username, 64),
      name: str(c.name, 40) || str(c.username, 40),
      groups: Array.isArray(c.groups) ? c.groups.filter((g) => typeof g === 'string').slice(0, 20) : [], // the hub's allow-listed groups (household, club)
      aud: c.aud, iat: c.iat, exp: c.exp,
    },
  };
}

// The pass against one key: the claims, or null. Never throws.
export async function verifyPass(token, key, { aud, now = Date.now() } = {}) {
  return (await check(token, key, aud, now)).pass ?? null;
}

// The hub's key, cached. get() refetches after ttlMs; get({ fresh: true }) refetches now (the hub may have rotated it).
// Either way the hub is asked at most once per refetchMs, and a failed fetch keeps the old key. A pinned key (the `x`
// of /key) is never fetched. -> { x } or null (no key yet and the hub is unreachable).
export function hubKey({ hub = HUB, pinned = null, fetch: fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, ttlMs = 600_000, refetchMs = 60_000 } = {}) {
  const url = String(hub || HUB).replace(/\/+$/, '') + '/auth/phatt-id/key';
  let key = pinned ? { x: String(pinned) } : null, tried = -Infinity, at = -Infinity, inflight = null;
  const load = async () => {
    tried = now();
    try {
      const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
      const k = r.ok ? await r.json() : null;
      if (k && k.alg === 'Ed25519' && typeof k.x === 'string' && k.x) { key = { x: k.x }; at = now(); }
    } catch { /* keep the old key, if any */ }
    return key;
  };
  return {
    async get({ fresh = false } = {}) {
      if (pinned) return key;
      const t = now();
      if (key && !fresh && t - at < ttlMs) return key;
      if (t - tried < refetchMs) return inflight ?? key;
      inflight ??= load().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

// The pass against the hub's key: the claims, or null (a guest). Never throws. A pass that fails only on its
// signature is tried once more with a refetched key, so a rotated hub key is picked up without a restart.
export async function checkPass(token, keys, { aud, now = Date.now() } = {}) {
  if (!token) return null;
  try {
    const k = await keys.get();
    const r = await check(token, k, aud, now);
    if (r.pass || r.why !== 'sig') return r.pass ?? null;
    const k2 = await keys.get({ fresh: true });
    return k2 && k2.x !== k?.x ? (await check(token, k2, aud, now)).pass ?? null : null;
  } catch { return null; }
}

// `Authorization: PhattId <pass>` -> the pass, or null
export function passFromHeader(h) {
  const m = /^PhattId\s+(\S+)$/i.exec(String(h ?? '').trim());
  return m ? m[1] : null;
}
