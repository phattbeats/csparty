# CS Party lobby (Phase 1)

Make a party code, friends join by code or link, everyone picks a character and readies up, and the lobby sends
the whole party to a free game server with that party's own key. Design: `docs/lobby-design.md`.

- `src/index.js`: Cloudflare Worker. One SQLite-backed Durable Object per lobby (WebSocket Hibernation API) and
  one directory Durable Object (codes, create rate limit, public list, which pool server each lobby holds).
- `public/`: the lobby page (static assets served by the Worker). `npm run art` copies the portraits and logo
  from `web/public/art`.
- `web/relay.js`: with `LOBBY_SECRET` and `RELAY_ID` set, the relay also accepts the Worker's per-lobby keys
  (`CODE.EXPIRY.SIG`, HMAC-SHA256 over `csp-lobby|RELAY_ID|CODE|EXPIRY`) wherever it takes `?key=`. Its
  `/healthz` reports `peers`, `downloads` (game data in flight) and `idleSecs`, which is how the Worker knows a
  server is free.

## Flow

1. Create: `POST /api/lobbies` gives a 5-character code (no 0/O/1/I/L). The creator is host.
2. Join: `/?code=ABCDE` or type the code. Members are keyed by a random id in localStorage, so a reloaded tab
   gets its seat back (90 s grace while the lobby is open). Seats 1-4 play, anyone after that watches.
3. Ready: when every seated, connected member is ready and there are at least `MIN_HUMANS` (2), a
   `AUTOSTART_SECS` (5) countdown starts. The host can start any time, alone included; bots fill the seats.
4. Start: the directory picks the first pool server whose relay has no peers and no downloads. None free: the
   lobby queues and retries every 10 s. Each member gets `https://server/?key=…&name=…&char=…&lobby=…`, and the
   page goes there. The game page joins on its own the first time (`boot.js`), and the plugin's lobby countdown
   (`csp_autostart`) starts the match.
5. Back to the lobby: once the server's relay has had no peers and no downloads for 90 s (two checks a minute
   apart, after `MATCH_GRACE_SECS`), or the host presses "Back to the lobby", the server is released and the
   lobby opens for a rematch. A lobby nobody is connected to expires after 15 minutes.

## Matchmaking

- **Quick play** (`POST /api/quickplay`): joins the open public party that is looking for players, else the
  fullest open public one with a free seat (changed in the last 10 minutes). None: it starts a public party that
  is looking for players. The seat is held in the directory at once so two people arriving together don't collide.
- **Fill empty seats with random players** (host checkbox, `seeking`): lists the party publicly and sends quick
  players to it. Once `MIN_HUMANS` are in, the party starts by itself `FILL_SECS` (20) later, ready or not;
  bots fill the rest. Everyone ready still starts it after `AUTOSTART_SECS`.

## Analytics and admin (Phase 3)

- **Events** (`src/analytics.js`, design section 8): lobby made / joined / ready / all ready / left / expired,
  match started / queued / closed, reconnects, server capacity every minute, and, from the game servers, turns,
  minigame picks and results and match winners (`POST /api/events`, signed with `LOBBY_SECRET`; the P2
  pool-agent posts the plugin's `[CSPEV]` lines there). Every event goes through the directory, which hashes
  the player id with a random salt it keeps for one UTC day only (`sha256(id + salt)`), then writes it to
  **Workers Analytics Engine** (dataset `csparty_events`) and to hourly counters in its own SQLite
  (`rollup`). No IPs, no chat, no cross-day ids. IPs exist only as keyed hashes in the 24 h create log and
  the ban list.
- **Dashboard** at `/admin` (design section 9): live lobbies and servers (polled every 3 s while the tab is
  visible), lobby detail with roster and timeline, funnel, time to start, where people leave, minigames,
  winners, unique players per day, countries, errors and abuse, audit log, Analytics Engine SQL presets.
- **Actions**, all audited: close a lobby, kick (optionally ban the browser and IP hash for N hours), ban /
  unban a hash, pause new parties (maintenance banner), max lobbies, creates per IP, public listings off,
  drain a server (deploy gate: drain, wait for "safe to deploy", deploy), broadcast a line to every lobby,
  CSV of the hourly counters.
- **Auth**: `Authorization: Bearer <ADMIN_TOKEN>` (Worker secret, 24+ characters; unset = admin off). 10
  wrong tokens in 15 minutes lock that IP hash out for 15 minutes. Optional secrets `AE_ACCOUNT_ID` and
  `AE_READ_TOKEN` (Account Analytics: Read) turn on the Analytics Engine panel; everything else works without.
- Closing a lobby in Phase 1 frees its server slot and sends members home, but players already on the game
  server stay until they leave (stopping the server is the P2 pool-agent's job).

## Develop and test

```
cd lobby && npm install && cp .dev.vars.example .dev.vars
# a relay to hand out (no game server needed for the API test):
PORT=18095 GAME=127.0.0.1:27999 PARTY_KEY=statickey LOBBY_SECRET=dev-secret-change-me RELAY_ID=raid1 node ../web/relay.js --root ../web/public
npx wrangler dev --port 8787 --var 'POOL:[{"id":"raid1","url":"http://127.0.0.1:18095"}]' --var AUTOSTART_SECS:3 --var MATCH_GRACE_SECS:0 --var FILL_SECS:3
node test/lobby_test.mjs           # 40 checks; SLOW=1 adds the server-release path (about 4 minutes)
# restart wrangler dev with a fresh .wrangler, then (the last check locks the admin API for 15 minutes):
node test/admin_test.mjs           # 60 checks: events, funnel, game event ingest, every admin action, lockout
```

`tools/dev/admin_e2e.js` drives the dashboard in a real browser against the same setup (screenshots).
`tools/dev/lobby_e2e.js` runs two real browsers through create, join, ready, the hand-off and the match on a
real game server, then checks the lobby reopens (see its header).

## Deploy

1. Relay: set `LOBBY_SECRET` (same value as the Worker secret) and `RELAY_ID` (its id in `POOL`) on the relay
   container. The static `PARTY_KEY` keeps working.
2. Worker (needs a Cloudflare API token with Workers Scripts + Durable Objects edit, or run it yourself):
   `npx wrangler secret put LOBBY_SECRET` and `npx wrangler secret put ADMIN_TOKEN`, set `POOL` in
   `wrangler.toml` (or `--var POOL:...`), then `npm run deploy`. Add a custom
   domain (Workers > csparty-lobby > Domains) or use the workers.dev address.
