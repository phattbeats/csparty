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

## Lobby servers (Phase 2, #4154)

With a pool-agent (`web/pool-agent.js`) on a game host, every lobby gets a game server of its own instead of
sharing the static `POOL`:

- The agent connects out to `/api/agent` (signed with `LOBBY_SECRET`, no inbound port). It reports its cap
  (`MAX_LOBBIES`), what it runs, and its CPU, load and upload every 30 s.
- On start the directory picks the host with the most room and tells its agent to start `code`. The lobby shows
  "Starting your party's server…" until the agent answers `started` (the plugin printed `[CSPEV] server_ready`),
  then everyone gets a key signed for `<host>.pool`. The relay routes that key to the lobby's own container.
- Every host full: the lobby queues, first come first served, and shows its place in line. A free static `POOL`
  server is still used for whoever is first in line, so the old setup keeps working as overflow and fallback.
- The game page carries `?pid=` (a random id per lobby member, not their lobby id) as `setinfo _csp_pid`. The
  plugin owns seats by it, so a dropped player gets their own seat back within `csp_seat_grace` (90 s), even with
  two players of the same name.
- The plugin's `[CSPEV]` lines (turn, minigame picked/result, match started/finished/aborted, humans,
  reconnect) go to the directory (`events` table, the last 5000; Phase 3 analytics reads them). Turn and minigame
  show on the lobby page. `match_finished` reopens the lobby, and the game page sends everyone back to it
  (`CSP_BACK_TO_LOBBY`) for the rematch. The agent stops the container once it is empty, at most 2 min later.
- Failures: a server that doesn't start goes back in line (3 tries, then the lobby reopens with a message); a
  crash or an agent restart that lost it reopens the lobby and says so; an agent gone 10 min writes its matches
  off; a draining host (agent `DRAIN=1` or `{t:"drain"}`) takes no new lobbies.
- `GET /api/capacity` shows hosts and the queue length (no lobby codes).

## Develop and test

```
cd lobby && npm install && cp .dev.vars.example .dev.vars
# a relay to hand out (no game server needed for the API test):
PORT=18095 GAME=127.0.0.1:27999 PARTY_KEY=statickey LOBBY_SECRET=dev-secret-change-me RELAY_ID=raid1 node ../web/relay.js --root ../web/public
npx wrangler dev --port 8787 --var 'POOL:[{"id":"raid1","url":"http://127.0.0.1:18095"}]' --var AUTOSTART_SECS:3 --var MATCH_GRACE_SECS:0 --var FILL_SECS:3
node test/lobby_test.mjs           # 40 checks; SLOW=1 adds the server-release path (about 4 minutes)
```

Pool-agent protocol against `wrangler dev` and a real relay (the script plays the agent):

```
PORT=18096 GAME=127.0.0.1:27999 PARTY_KEY=statickey LOBBY_SECRET=dev-secret-change-me RELAY_ID=fake1 POOL_AGENT=http://127.0.0.1:18097 node ../web/relay.js --root ../web/public
npx wrangler dev --port 8788 --var 'POOL:[]' --var AUTOSTART_SECS:3
node test/pool_test.mjs            # 36 checks: auth, start/started, relay routing + 4004, queue order, failures, rematch, drain, agent restart
```

`tools/dev/pool_e2e.js` runs the real thing on a Docker host (relay + agent + `wrangler dev` + two GPU browsers):
both players named "Alice", both drop and come back in the opposite order, each gets their own seat back; the
match ends, both pages return to the lobby, the container goes. `tools/dev/pool_measure.js` measures CPU, memory
and upload per lobby server.

`tools/dev/lobby_e2e.js` runs two real browsers through create, join, ready, the hand-off and the match on a
real game server, then checks the lobby reopens (see its header).

## Deploy

1. Relay: set `LOBBY_SECRET` (same value as the Worker secret) and `RELAY_ID` (its id in `POOL`) on the relay
   container. The static `PARTY_KEY` keeps working.
2. Worker (needs a Cloudflare API token with Workers Scripts + Durable Objects edit, or run it yourself):
   `npx wrangler secret put LOBBY_SECRET`, set `POOL` in `wrangler.toml`, then `npm run deploy`. Add a custom
   domain (Workers > csparty-lobby > Domains) or use the workers.dev address.
3. Lobby servers: `deploy/csparty-up.sh agent` on the game host (`LOBBY_WS` and `PUBLIC_URL` in its `.env`), and
   the relay with `POOL_AGENT=http://127.0.0.1:8097`. `GET /api/capacity` should list the host online.
