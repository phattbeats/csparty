# CS Party lobby system, analytics and admin dashboard: design (ISSUE)

Status: proposal for approval (ISSUE). Nothing here is built. Prices and free-tier limits below are from memory of Cloudflare's published plans and **must be re-checked against current pricing before we commit**; items marked (verify) are the ones that matter.

## 1. Goal

Public "make a party code, friends join, ready up, play" like mitchellhynes.com/halo, but:

1. hostable off game-host (the control plane at least),
2. near-zero running cost,
3. able to survive a public post (hundreds of concurrent lobbies),
4. with analytics (lobbies, matches, minigame picks/results, drop-offs) and an **admin dashboard** to watch and operate it.

## 2. What we learned about the reference

The Halo site is a Cloudflare Worker for WebRTC signaling, Turnstile, a COI service worker, and the game running inside the host's browser. `bnunu/halo-ce-universal` is a Halo CE source port (game source plus `port/linux/src/p2p_signal.c`); the Worker itself is not in that repo, so I did not read it. Treat the Worker half as "standard Durable Object signaling room" until someone pulls the deployed JS from the site. That does not block this design.

The reference works because the whole game is a browser-runnable binary, so the host's tab *is* the server. That is the property we lack.

## 3. What is different for CS Party

- Game logic is an AMXX/Pawn plugin (`plugin/`) on ReHLDS + ReGameDLL_CS + Metamod-R + ReAPI: native x86, authoritative, one process per match.
- Browser players **already** work: the Xash3D wasm client talks WebSocket to `web/relay.js`, which bridges each tab to a UDP socket on the real ReHLDS server. Real CS 1.6 clients join the same server natively.
- So a lobby does not need a new client protocol. It needs to answer "which game server (host:port or relay URL) and which key do these 4 people connect to", and to know when a match starts and ends.
- A match is small: 4 seats, bots fill the rest, state already persisted (`data/cs_party_state.json`).

## 4. Options costed

### A. True P2P (host's browser runs the server)
Needs xash3d-fwgs server build plus ReGameDLL_CS compiled to wasm, and the party logic (many thousands of lines of Pawn using ReAPI/AMXX natives, zBot nav meshes, entity hacks) ported to C++ inside the game DLL or to a wasm-hosted AMXX. We have already hit wasm side-module symbol clashes and a 256-entity cap on the client side. Host tab CPU/RAM becomes a gameplay constraint, a host who closes the tab kills the lobby, and WebRTC needs a datagram transport shim under Xash's netcode. Hosting cost is about zero. Engineering cost is months, with high risk. Not a first step.

### B. Worker lobby + container-per-lobby pool
Worker + Durable Object for codes/ready state; a pool manager on the host(s) starts a ReHLDS container per lobby (or a pre-warmed server with a few lobbies sharing it via map instances; ReHLDS is one match per process, so containers). Fast to build (weeks) and reuses everything shipped. Limits: RAID CPU and home upload. Rough sizing to measure, not assume: one ReHLDS + 4 humans + bots is a fraction of a core; browser clients also pull ~50 to 100 KB/s each through the relay. A RAID box realistically carries **10 to 30** concurrent lobbies, not hundreds.

### C. Hybrid (recommended)
Phase 1 is B for friends and early public. The control plane is built provider-agnostic: the pool manager registers "capacity hosts" with the Worker (RAID now, any rented box later, someone else's box eventually). Past ~20 lobbies we either (a) add paid VPS capacity under an approved spend (flagged as a decision for Alex, no spend assumed here), or (b) invest in A. The lobby/analytics/admin layer is identical in all three, so none of the work is thrown away.

**Recommendation: C, building B first. Do not start A until B's real usage proves demand beyond what one or two hosts carry.** The honest answer to "hundreds of concurrent lobbies, nearly free" is that only A achieves it, and A is a separate project. The design keeps A reachable by making "where the match runs" a field on the lobby (`host: {kind: "pool"|"p2p", ...}`).

## 5. Architecture

```
Browser (lobby page)                    Cloudflare                       Host(s) (game-host, later others)
  create / join / ready  --HTTPS/WS-->  Worker "lobby-api"
                                          |-- Durable Object per lobby  (code, members, ready, state)
                                          |-- Durable Object "directory" (open lobbies, capacity hosts)
                                          |-- Turnstile (create only)
                                          |-- Analytics Engine (events)   <-- admin dashboard reads
                                          '-- D1 (bans, config, daily rollups)
                                                  ^
                                                  | outbound WSS from host (no inbound ports, no tunnel needed for control)
                                         pool-agent  (new, small node service next to relay.js)
                                          |- spawns/stops ReHLDS container per lobby
                                          |- reports match events (from plugin log lines / rcon / HTTP hook)
                                          '- relay.js serves the game WS (unchanged, per-lobby key)
Game traffic: browser <--WSS via relay--> ReHLDS (existing path). Cloudflare Tunnel or DNS-only A record to the host.
```

Key choices:
- **One Durable Object per lobby**, keyed by code, using SQLite-backed storage and the **WebSocket Hibernation API** so idle lobbies cost no duration billing.
- **Host connects outbound** to the Worker, so the home network exposes only the game relay, same as today.
- **Party key per lobby**: relay's existing `--key` mechanism, issued by the DO at start, so the game server only accepts people holding that lobby's link. Fixes the "gamedata.zip is Valve content" exposure too.
- **Codes**: 5 chars from an unambiguous alphabet (no 0/O/1/I/L), about 30M space, rate limited lookups, expire 15 min after the last member leaves.
- **Identity**: anonymous. A random `playerId` in localStorage plus a nickname. No accounts, no email.

## 6. Lobby flow

States: `open -> starting -> in_match -> finished | abandoned`.

1. **Create.** Page requests a code (Turnstile token, ~per-IP cap). Directory DO makes a lobby DO, creator becomes host, 4 seats, public/private toggle, board choice (existing `say /board` list), bots-fill toggle.
2. **Join.** Enter code or open `/?code=ABCDE` (shareable link). Joiner gets a seat (or spectator), picks a character from the existing grid. Over a WebSocket they see roster, ready flags, host.
3. **Ready.** Each member toggles ready. Start button enabled for the host always; auto-start when all humans are ready and at least `minHumans` (default 2, 1 allowed for solo vs bots) have been ready for 5 s. Host can also force start, remaining seats filled by bots (matches the "everyone readies up or the host starts" ask).
4. **Start.** DO picks a capacity host with free slots, sends `start_match{code, board, seats, partyKey}`; pool-agent starts a container, waits for healthy, returns `{relayUrl, key}`. Lobby goes `starting -> in_match`; all clients are told to connect (existing browser client, or a `connect` command for native CS 1.6).
5. **In match.** Plugin/agent emits events (turn count, minigame picked/result, winner). The lobby stays visible to members (roster, "match in progress").
6. **Reconnect.** The lobby DO remembers `playerId -> seat`. A dropped tab rejoins the same code and is reattached to its seat (the plugin already holds human seats 60 s across map changes; extend the hold to a configurable grace, default 90 s, keyed on the `playerId` passed as `setinfo _csp_pid`). After the grace the seat becomes a bot.
7. **Finish.** Winner event closes the match; container is stopped after a 2 min linger; lobby returns to `open` (rematch) or expires.
8. **Failure.** No capacity: lobby shows queue position and the admin sees it. Host agent disconnect: matches marked `orphaned`, players told, container reaped by the agent on reconnect.

## 7. Free-tier cost model (verify all figures)

Assumed usage for a viral day: 2,000 lobbies created, 4 players each, average lobby session 20 min of which about 3 min is pre-game on the lobby WebSocket.

| Resource | Free allowance (verify) | Our use per viral day | Verdict |
|---|---|---|---|
| Workers requests | 100k/day | page loads + create/join/lookup: about 40 to 60k | fits; static page served from Pages/Assets so it is not counted per hit |
| Durable Objects requests | 100k/day (SQLite-backed only on free) | WS messages bill ~20:1 incoming; ~2,000 lobbies x ~150 msgs = 300k raw = ~15k billed | fits |
| DO duration | 13k GB-s/day | hibernation: only active handlers count; 2,000 lobbies x ~few sec CPU wall | fits |
| D1 | 5M reads, 100k writes/day, 5 GB | bans/config reads cached; rollups once a day or hour | fits |
| Analytics Engine | **may require Workers Paid (~$5/mo, 10M datapoints/mo included)** (verify) | ~25 events per match x 2,000 = 50k/day = 1.5M/mo | fits paid; if free is not allowed, fall back to D1 rollups (below) |
| Turnstile | free | create only | free |
| TURN (only if we ever do A/WebRTC) | Cloudflare Realtime TURN ~1 TB/mo free then ~$0.05/GB (verify) | not used in B/C (game goes via WSS relay) | n/a until A |
| **Game hosting (B)** | RAID power + upload | the real cost; ~10 to 30 lobbies concurrent | set `MAX_LOBBIES`, queue the rest |

Cloudflare cost for phases 1 to 3 is **$0, or $5/mo if Analytics Engine needs Paid**. The cost that actually scales is game capacity, not the control plane. Cap concurrency in the agent so a spike queues instead of melting the host.

## 8. Analytics plan (privacy-light)

Principles: no accounts, no raw IPs stored, no chat text, no persistent cross-day player id. `playerId` is a random localStorage UUID, only ever stored hashed with a daily-rotating salt (`sha256(id + day-salt)`), so we can count unique players per day without tracking anyone across days. Country from `cf-ipcountry` only. Footnote on the page says what is collected. No cookies beyond localStorage.

Events (Analytics Engine datapoints: `blobs` = low-cardinality strings, `doubles` = numbers, `index1` = lobby code):

| Event | Blobs | Doubles |
|---|---|---|
| `lobby_created` | visibility, board, country | seats |
| `lobby_joined` | role (host/guest/spectator), via (code/link) | members_after |
| `lobby_ready` / `lobby_unready` | | secs_since_join |
| `lobby_left` | phase (open/starting/in_match), reason (leave/timeout) | secs_in_lobby |
| `match_started` | board, start_mode (all_ready/host_force), host_id | humans, bots, queue_wait_s |
| `turn_taken` (sampled) | character | turn_no |
| `minigame_picked` | minigame id, team split | round_no |
| `minigame_result` | minigame id, winner character | duration_s, participants |
| `match_finished` | winner character, bonus stars drawn | duration_s, rounds, humans |
| `match_abandoned` | reason (orphaned, all_left, crash) | duration_s, last_round |
| `reconnect` | outcome (reattached, expired) | gap_s |
| `capacity` (every 60 s per host) | host_id | running, max, cpu_pct, up_kbps |

Questions this answers: funnel (created -> 2nd joiner -> all ready -> started -> finished), median time-to-start, drop-off by phase and by round, which minigames get picked and which cause quits (abandon rate by last minigame), character and board win rates, concurrent lobbies by hour, capacity pressure.

Reading it: Analytics Engine SQL API from the dashboard Worker. If AE is not on free, the same Worker writes hourly counters to D1 (`rollup(hour, event, key, n, sum)`), which is enough for everything except ad hoc slicing.

Plugin side: add a tiny `csp_event(name, json)` forward in `cs_party.sma` that logs a tagged line (`[CSPEV] ...`); pool-agent tails the container log and ships events over its WS. No new network code in Pawn.

## 9. Admin dashboard

Purpose: see health at a glance, see what players are doing, and have a few safe levers. Single page, served by the same Worker at `/admin`.

**Access control.** Cloudflare Access (Zero Trust, free for up to 50 users) in front of `/admin/*` and `/api/admin/*`, allowing only Alex's identity. Defence in depth: the Worker also verifies the Access JWT (`Cf-Access-Jwt-Assertion`) and rejects without it. Fallback if we skip Access: a long random bearer token in a Worker secret, sent as `Authorization`, with a rate limit on failures. No admin routes are reachable unauthenticated, and the public API exposes no listing of private lobbies.

**Panels.**
1. **Live now**: concurrent lobbies by state, players online, open public lobbies, queue length, oldest lobby age. Auto-refresh over a WS from the directory DO (every 2 s).
2. **Lobby table**: code, state, host nickname, members/ready, board, age, capacity host, match round. Row click opens details with timeline and roster.
3. **Capacity hosts**: per host connected status, running/max lobbies, CPU, upload, agent version, last heartbeat. Red when heartbeat is stale or CPU/upload above threshold.
4. **Funnel and drop-off**: last 24 h / 7 d funnel (created, joined, ready, started, finished) with drop-off by phase, time-to-start distribution.
5. **Game stats**: minigame picks vs abandon rate, character and board win rates, avg match length, matches per hour.
6. **Traffic**: unique players per day (hashed), countries, new vs returning (from same-day salt only, so "returning" means within a day; honest limit of the privacy choice).
7. **Errors and abuse**: failed starts, orphaned matches, Turnstile failures, rate-limit hits, top creating IP hashes.
8. **Audit log**: every admin action with timestamp (D1).

**Actions (all POST, audited, confirm in UI).**
- Close/kill a lobby (stops its container, tells members).
- Kick a member / ban a `playerId` hash or IP hash for N hours.
- Global switches: pause new lobbies (maintenance banner), set `MAX_LOBBIES`, set per-IP create cap, force public listings off.
- Drain a capacity host (no new lobbies, let current ones finish) before a deploy. This ties into the deploy gate: **drain, wait for 0 running lobbies, then deploy**, which is the existing peers==0 rule made visible.
- Broadcast a one-line message to all lobbies (server banner).
- Download CSV of daily rollups.

**Implementation.** Static HTML + small vanilla JS (or Preact) from Workers Assets; data endpoints: `/api/admin/live` (DO), `/api/admin/stats?range=` (AE SQL / D1), `/api/admin/action`. Charts per our dataviz conventions. No third-party scripts. All admin queries are parameterized.

## 10. Abuse and safety

- Turnstile on create; per-IP create/join rate limits (Workers rate limiting or DO counters).
- Lobby code lookups rate limited; private lobbies not listed.
- Party key per lobby on the relay; agent caps lobbies and per-IP peers (existing `MAX_PEERS`/`MAX_PER_IP`).
- Nickname filter and length cap; no free text beyond nickname.
- Containers run unprivileged with CPU and memory limits, no volumes except read-only game data.
- gamedata.zip stays key-protected; public build will need a legal decision on shipping Valve content publicly (flag for Alex, existing key mechanism is a stopgap).

## 11. Phased plan

| Phase | Deliverable | Notes |
|---|---|---|
| 0 | Approval of this doc, decision on Analytics Engine ($5) vs D1-only, Access vs bearer for admin | Alex |
| 1 | Worker + lobby DO + directory DO, lobby page (create/join/ready/start), static pool of N already-running servers on RAID as the "capacity", party key plumbing | friends-only, no containers yet |
| 2 | pool-agent: container per lobby, outbound WS, capacity reporting, reconnect by `_csp_pid`, plugin `CSPEV` event lines | tested on the isolated RAID copy / harness with a browser client |
| 3 | Analytics events + admin dashboard (live, lobbies, hosts, funnel) + actions (kill, ban, pause, drain) | |
| 4 | Public hardening: Turnstile, rate limits, queueing, abuse panel, privacy note, Valve-content decision | public post gate |
| 5 | Capacity decision based on real numbers: add rented hosts (needs approved spend) or start A feasibility spike (xash server wasm + ReGameDLL wasm) | |

Each phase ships through the normal deploy gate (peers==0, no humans, merged onto newest main) with screenshots/logs on its issue. Child issues are created only after approval.

## 12. Open questions for Alex

1. OK to pay $5/mo for Workers Paid if Analytics Engine needs it, or D1-only?
2. Admin auth: Cloudflare Access (needs a Zero Trust org on the account) or bearer token?
3. Appetite for renting capacity beyond RAID once lobbies exceed about 20?
4. Is public distribution of Valve gamedata acceptable, or should the public build be invite-key only?
