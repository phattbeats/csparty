// Shared helpers for the lobby Worker and its Durable Objects.
export const SEATS = 4;
// 5 characters, no 0/O/1/I/L: 31^5 is about 29M codes
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
export const PID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
export const nick = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f"\\;]/g, "").trim().slice(0, 20) || "Player";
export const charOf = (c) => (Number.isInteger(+c) && +c >= 0 && +c <= 7 ? +c : -1);
export const pool = (env) => { try { return JSON.parse(env.POOL || "[]"); } catch { return []; } };

export const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const hmac = async (secret, msg) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
};
export const sha = async (s) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 16);
// constant-time string compare (both sides hashed first, so lengths don't leak either)
export const safeEqual = async (a, b) => {
  const [x, y] = await Promise.all([hmac("csp-cmp", String(a)), hmac("csp-cmp", String(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
};
// Keyed hashes for rate limits and bans. They are stable across days, so they are only kept where they are
// needed: the create log (24 h) and the ban list (until the ban ends).
export const ipKey = (ip, env) => sha(`ip|${ip}|${env.LOBBY_SECRET || ""}`);
export const pidKey = (pid, env) => sha(`pid|${pid}|${env.LOBBY_SECRET || ""}`);

// What a relay's /healthz says: connected browser peers, game data downloads in flight, seconds since either.
// null if it doesn't answer. Cache-busted: Cloudflare cached probes before.
export const relayHealth = async (url) => {
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/healthz?t=${Date.now()}`, { cf: { cacheTtl: 0 }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const h = await r.json();
    const g = h.game || h;   // relays with lobby servers (#4154) count their own server's players apart from the lobbies'
    return Number.isInteger(g.peers) ? { peers: g.peers, downloads: g.downloads || 0, idleSecs: g.idleSecs ?? Infinity,
      uptime: h.uptime || 0, rejected: h.rejected || 0 } : null;
  } catch { return null; }
};
export const isFree = (h) => !!h && h.peers === 0 && h.downloads === 0;
