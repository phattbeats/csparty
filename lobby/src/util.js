// Shared helpers for the lobby Worker and its Durable Objects.
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
export const SEATS = 4;
// 5 characters, no 0/O/1/I/L: 31^5 is about 29M codes
export const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
export const PID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
// Names and party titles are the only free text (#3992). Slurs and obscenities, leetspeak and spacing included
// (the obscenity package's English set), turn a name into "Player" and drop a title, rather than starring words out.
// "dick" is left out: it is also a name.
const obscene = new RegExpMatcher({ ...englishDataset.removePhrasesIf((p) => p.metadata?.originalWord === "dick").build(), ...englishRecommendedTransformers });
// also with spaced-out letters joined ("a s s" -> "ass"); only runs of single characters, so words keep their gaps
export const rude = (s) => {
  const t = String(s ?? "");
  return obscene.hasMatch(t) || obscene.hasMatch(t.replace(/(?<=(?:^|[\s._*-])\w)[\s._*-]+(?=\w(?:$|[\s._*-]))/g, ""));
};
export const nick = (s) => {
  const n = String(s ?? "").replace(/[\u0000-\u001f\u007f"\\;]/g, "").trim().slice(0, 20);
  return n && !rude(n) ? n : "Player";
};
export const title = (s) => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f<>"\\;]/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
  return rude(t) ? "" : t;
};
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

// Per-IP request limits (#3992): a Workers rate-limit binding (wrangler.toml [[ratelimits]]) when there is one,
// else a counter in this isolate. Both are approximate (per location / per isolate), which is enough to stop a
// script walking the code space; the strict per-IP create cap stays in the directory.
const memo = new Map();
export const allow = async (binding, key, limit = 30) => {
  if (binding) { try { return (await binding.limit({ key })).success; } catch { return true; } }
  const now = Date.now(), win = Math.floor(now / 60e3);
  if (memo.size > 5000) memo.clear();
  const k = `${limit}|${key}`, e = memo.get(k);
  if (!e || e.win !== win) { memo.set(k, { win, n: 1 }); return true; }
  return ++e.n <= limit;
};

// Cloudflare Turnstile (#3992), on making a party only. Off unless TURNSTILE_SECRET is set (and TURNSTILE_SITEKEY
// for the page). A siteverify that can't be reached lets the create through: Turnstile being down mustn't close the
// lobby, and the per-IP create cap still holds.
export const turnstileOk = async (env, token, ip) => {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET); body.append("response", token);
    if (ip && ip !== "local") body.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return true;
    return !!(await r.json()).success;
  } catch { return true; }
};
