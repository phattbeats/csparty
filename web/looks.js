// PHATT ID looks (PHA-5163): what each member's pawn wears, resolved by the arcade.
//
// The lobby Worker knows which game pid (_csp_pid) belongs to which PHATT ID member and tells the pool-agent
// ({t: "looks", code, members: [{pid, aid}]}; guests never leave the lobby). The agent asks the arcade what those
// members draw in CS Party (POST <ARCADE_URL>/api/render, signed as the csparty surface: X-Arcade-Surface/-Kid/-Ts/-Sig =
// HMAC-SHA256(secret, ts + "." + body), base64url) and hands each look to the plugin by rcon (csp_look). The arcade
// decides everything (ownership, the item registry); the key stays on the game host.
// Config (agent only): ARCADE_URL, ARCADE_KID, ARCADE_SECRET (the csparty entry of the arcade's SURFACE_SECRETS).
import crypto from "node:crypto";

const PID = /^[A-Za-z0-9_-]{6,23}$/, AID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT = /^[a-z0-9_]{1,32}$/, ASSET = /^[A-Za-z0-9_./-]{1,200}$/;   // both end up on an rcon line

export const looksOn = (env) => !!(env.ARCADE_URL && env.ARCADE_KID && env.ARCADE_SECRET);

export function signed(env, body, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const sig = crypto.createHmac("sha256", env.ARCADE_SECRET).update(`${ts}.${body}`).digest("base64url");
  return { "content-type": "application/json", "x-arcade-surface": "csparty", "x-arcade-kid": env.ARCADE_KID, "x-arcade-ts": ts, "x-arcade-sig": sig };
}

// members [{pid, aid}] -> [{pid, slot, asset}]. Never throws: no looks is fine.
export async function looksFor(env, members, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const ms = (Array.isArray(members) ? members : []).filter((m) => m && PID.test(String(m.pid)) && AID.test(String(m.aid))).slice(0, 16);
  if (!looksOn(env) || !ms.length) return [];
  try {
    const body = JSON.stringify({ arcade_ids: [...new Set(ms.map((m) => m.aid))] });
    const r = await fetchImpl(String(env.ARCADE_URL).replace(/\/+$/, "") + "/api/render", { method: "POST", headers: signed(env, body, now), body, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const renders = (await r.json())?.renders || {};
    return ms.flatMap((m) => Object.entries(renders[m.aid] || {}).filter(([slot, a]) => SLOT.test(slot) && typeof a === "string" && ASSET.test(a))
      .map(([slot, asset]) => ({ pid: m.pid, slot, asset })));
  } catch { return []; }
}
