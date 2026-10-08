# CS Party UX critique for public release (ISSUE)

Date: 2026-10-08. Live at critique time: server 0.5.27-vq, relay 0.4.26.
Evidence: screenshots of the real join page at 1280x720, phone portrait 390x844 and phone landscape 844x390 (`shots/before-*.png`), the overlay and Esc-menu states, plus a read of `web/public/boot.js` and `plugin/cs_party.sma`. Items marked *(code)* are from reading the source and the ISSUE gameplay frames; each gets re-checked live when its fix ships.

The journey, as a stranger: link -> join page -> download (47 MB) -> connecting -> first turn -> board -> minigame -> results -> Esc/leave/drop.

## Ranked findings

Severity: **P0** loses a stranger before they play, **P1** confuses a first match, **P2** rough edge.

### P0

1. **The join page never says what the game is.** The first thing on screen is "Pick your character. Each character has a different die." A stranger who got a link doesn't learn it's a Mario-Party-style board game inside Counter-Strike, that it's free, that it runs in the tab, or how long a match takes. *Fix:* one-line pitch, a three-step "how it plays" strip, and "what you need" chips (browser tab, 47 MB once, keyboard/phone/controller).
2. **The Join button is below the fold on desktop and a long scroll on phones.** At 1280x720 the name field is cut off at the bottom edge. In phone portrait the button is under two rows of characters, a preview and die faces. *Fix:* keep the detail panel (name + Join) sticky on desktop; on phone portrait put name + Join first and the roster after, since Random is a valid default.
3. **Fullscreen button covers the music control on phones** (`before-landing-phoneP.png`: it sits over the mute button and slider). *Fix:* hide the floating Fullscreen/Menu buttons while the join page is up.
4. **"Lost the party" is one generic card.** Server restart, dropped connection, wrong key and full party all look the same, the only action is Rejoin (a page reload), and the grey monospace body is hard to read. A restart should rejoin on its own, "party full" should offer a retry with a countdown, and a bad key should say where to get one. *Fix:* reason-specific title and next step, auto-retry for restart/drop (bounded), "Back to start" always present.

### P1

5. **Download/connect states are one status line plus a bar.** First visit is 5 minutes on a loaded server (measured in ISSUE). The page needs steps ("1 Download game  2 Unpack  3 Connect"), a what-happens-next line while waiting, and a cached/not-cached hint up front. *Fix:* step list driven from the existing `status()` calls.
6. **No first-time onboarding in the game.** Only `/help` in chat and a keyboard-only paragraph in the footer. A new player's first turn shows the buy menu with no explanation of "Jump at the crate", and no explanation of stars, spaces or where money goes. *(code)* *Fix:* a short, skippable 4-card primer on the join page before the download (turn, spaces, minigames, stars/money), remembered in localStorage, never gating Join.
7. **Minigame intro cards cover only the five map-change minigames** *(code: `MG_TUT` is empty for indices 0-7, and `boot.js HOWTO` has no entry for 12, Two Towers).* The eight round-based minigames get a one-line chat announce. Cards need the same layout everywhere: name, goal in one line, controls for the player's device, how it's scored. *Fix:* fill `MG_TUT` and `HOWTO` for all 13, one template.
8. **Results readability.** Results are a chat line plus a banner (`banner("%s wins %s!")`). Needs a 3-second read: winner, placement, money/star change. *(code)* *Fix:* a consistent results HUD block at the end of every minigame.
9. **Esc menu shows keyboard instructions to everyone.** On a phone it still offers "Mouse sensitivity" and tells you to use W/S/Space; on a controller it is the same. Settings that matter (HUD size, graphics, touch layout) aren't in it. *Fix:* device-aware menu; show only the relevant controls.
10. **Phone landscape join page** keeps the 120 px logo and still needs scrolling to reach Join. Fixed by the sticky panel in (2).

### P2

11. **Board readability** (space types, whose turn, time left): the map overlay exists (ISSUE); the legend for space colours is only in the strategy guide. A "?" key hint or legend toggle on the overlay would close it. *(code)*
12. **Lobby:** who is here / ready-up / invite-link copy / spectate live in the lobby Worker (ISSUE), which is not deployed yet (ISSUE). Reviewed after that lands.
13. **Not-signed-in / wrong-key flow** depends on ISSUE (Steam). The refused-key message is already clear; wording will change with Steam.
14. **Host restart / player drop** in the middle of a match: the server holds the seat for 60 s, but the page doesn't tell the player that. Say so on the reconnect card.
15. Controller prompts on the join page mention nothing; a "Press A to join" hint appears nowhere.

## Fix order and delivery

| Round | Scope | Deploy type |
|---|---|---|
| 1 | Findings 1-5, 10, 14: join page pitch + needs, sticky join, overlay fix, reason-specific lost/restart/full/key cards, step list | relay patch (page only), no match impact |
| 2 | Finding 6 primer, 9 device-aware Esc menu, 15 controller hint | relay patch |
| 3 | Findings 7-8: minigame cards and results (plugin) | server patch, gated on empty server |
| 4 | Finding 11 legend; 12-13 once ISSUE / ISSUE land | mixed |

Each round: test stack, before/after screenshots, deploy only when relay peers = 0.

## Round 2 status (ISSUE, relay 0.4.28)

Shipped findings 6, 9 and 15. A 4-card primer (turn, spaces, minigames, stars and money) opens once on a first visit, is remembered in `localStorage.csp_primer`, and can be reopened from the "How a match works" link; Skip, Esc, a backdrop click and the Join button all close it, so it never gates Join (`?primer=0` / `?primer=1` override). The Esc menu shows only the controls for the device used last (keyboard and mouse, controller, touch): the mouse-sensitivity slider and W/S text are hidden on phone and controller. With a controller connected the join page shows "Press A to join" and an A badge on the button; A/B/D-pad drive the primer. Test rig: `tools/dev/rig` gained `PAD=1` (fake standard-mapping controller, driven with `eval window.__padSet([buttons],[axes])`).
