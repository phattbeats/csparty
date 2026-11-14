// PHATT ID in the lobby (PHA-4091). The lobby page asks the hub for a short-lived signed assertion bound to this
// host (GET <hub>/auth/phatt-id/assert?aud=<host>, with the hub cookie) and passes it on the lobby WebSocket as
// ?pa=<assertion>. The check is phatt-id-verify (PHA-5152), the one module every PHATT ID server vendors unchanged:
// Ed25519 against the hub's key (GET <hub>/auth/phatt-id/key), audience, expiry. Never edit src/phatt-id-verify/ here.
// No assertion, or a bad one: the player is a guest, exactly as before.
import { hubKey, checkPass } from "./phatt-id-verify/phatt-id-verify.mjs";

// Hub key, cached per isolate for 10 minutes; refetched (at most once a minute) when a signature fails (a rotated key).
let keys = null, keysFor = "";

// -> { arcadeId, display } or null. env.PHATT_HUB unset = PHATT ID off (everyone is a guest).
export async function assertedMember(token, env, aud, fetchImpl = globalThis.fetch) {
  const hub = String(env.PHATT_HUB || "").replace(/\/+$/, "");
  if (!hub || !token) return null;
  if (!keys || keysFor !== hub) { keys = hubKey({ hub, fetch: fetchImpl }); keysFor = hub; }
  const c = await checkPass(token, keys, { aud });
  return c ? { arcadeId: c.sub, display: c.name } : null;
}
export const _resetKeyCache = () => { keys = null; keysFor = ""; };
