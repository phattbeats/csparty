// Types for phatt-id-verify.mjs (PHA-5152). Vendored with it, unchanged.
export declare const VERSION: string;
export declare const PREFIX: 'pa1';
export declare const SKEW_S: number;
export declare const HUB: string;

/** What a good pass says. `sub` is the PHATT ID: the Authentik user UUID, the arcade_id. */
export interface Pass {
  sub: string;
  /** the hub's member token (32 hex), or null */
  member: string | null;
  username: string;
  /** how the hub shows this member; the username when the pass has no name */
  name: string;
  groups: string[];
  aud: string;
  iat: number;
  exp: number;
}

export interface Key { x: string }

export interface HubKeys { get(o?: { fresh?: boolean }): Promise<Key | null> }

export declare function verifyPass(token: unknown, key: Key | null | undefined, o: { aud: string; now?: number }): Promise<Pass | null>;

export declare function hubKey(o?: {
  hub?: string;
  pinned?: string | null;
  fetch?: (input: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  now?: () => number;
  ttlMs?: number;
  refetchMs?: number;
}): HubKeys;

export declare function checkPass(token: unknown, keys: HubKeys, o: { aud: string; now?: number }): Promise<Pass | null>;

export declare function passFromHeader(h: unknown): string | null;
