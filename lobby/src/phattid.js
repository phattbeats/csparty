// PHATT ID in the lobby (PHA-4091). The lobby page asks the hub for a short-lived signed assertion bound to this
// host (GET <hub>/auth/phatt-id/assert?aud=<host>, with the hub cookie) and passes it on the lobby WebSocket as
// ?pa=<assertion>. This checks the Ed25519 signature against the hub's public key (GET <hub>/auth/phatt-id/key).
// Same check as 7daystozelda web/cloudsave.js and clubhouse-games server/phattid.js verifyAssertion; keep in step.
// No assertion, or a bad one: the player is a guest, exactly as before.
export const ASSERT_PREFIX = "pa1";

const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function verifyAssertion(token, publicKey, { aud, now = Date.now() } = {}) {
  const [pre, body, sig] = String(token || "").split(".");
  if (pre !== ASSERT_PREFIX || !body || !sig || !publicKey?.x) return null;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKey.x }, { name: "Ed25519" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(sig), new TextEncoder().encode(pre + "." + body));
  } catch { return null; }
  if (!ok) return null;
  let c; try { c = JSON.parse(new TextDecoder().decode(unb64(body))); } catch { return null; }
  const t = Math.floor(now / 1000);
  if (!c || typeof c.sub !== "string" || !c.sub || c.aud !== aud || !(c.exp > t) || c.iat > t + 60) return null;
  return c;
}

// Hub key, cached per isolate for 10 minutes; refetched at once (at most every 30 s) when a signature fails.
let cached = null, at = 0;
async function hubKey(hub, force, fetchImpl) {
  if (cached && Date.now() - at < (force ? 30_000 : 600_000)) return cached;
  const r = await fetchImpl(`${hub}/auth/phatt-id/key`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`hub key ${r.status}`);
  const k = await r.json();
  if (!k?.x) throw new Error("hub key empty");
  cached = k; at = Date.now();
  return k;
}

// -> { arcadeId, display } or null. env.PHATT_HUB unset = PHATT ID off (everyone is a guest).
export async function assertedMember(token, env, aud, fetchImpl = globalThis.fetch) {
  const hub = String(env.PHATT_HUB || "").replace(/\/+$/, "");
  if (!hub || !token) return null;
  let c = null;
  for (const force of [false, true]) {
    let k; try { k = await hubKey(hub, force, fetchImpl); } catch { return null; }
    if ((c = await verifyAssertion(token, k, { aud }))) break;
  }
  return c ? { arcadeId: c.sub, display: String(c.display || c.name || c.username || "") } : null;
}
export const _resetKeyCache = () => { cached = null; at = 0; };
