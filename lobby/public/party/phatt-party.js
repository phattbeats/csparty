/* PHATT PARTY: the universal lobby that travels across the arcade (docs/CROSSOVER.md §1).
 * One vanilla-JS file in a shadow root, copied byte-identically into every game repo. Canonical copy:
 * phattbeats/clubhouse-games client/party/phatt-party.js (served at <hub>/party/phatt-party.js).
 *
 * Use:   <script src="/party/phatt-party.js" data-game="pokernight" data-hub="https://clubhouse.phatt.vip" defer></script>
 *        data-game  this surface's id as the catalog knows it ('clubhouse' for the hub itself, 'pokernight', 'csparty', '7dtz')
 *        data-hub   origin of the party server (WebSocket at <hub>/party, catalog at <hub>/api/catalog, Clubhouse games
 *                   at <hub>/?game=<id>). Defaults to this page's origin. Local dev: data-hub="http://<ip>:4400".
 *        data-mount optional selector; the pill is appended there instead of <body>.
 *
 * On its own it: reads ?party=CODE&m=TOKEN from the URL, keeps the token in localStorage 'phatt.party.member' (and the
 * code in 'phatt.party.code'), connects, renders the floating Party pill + drawer (members, chat, invite link,
 * "Take the party to…"), shows the follow banner when the host moves the party, and auto-follows after 5 s.
 *
 * Window API (window.PhattParty):
 *   PhattParty.code            'ABC234' | null
 *   PhattParty.member          my token (32 hex)
 *   PhattParty.me              {id, name, avatar}                                  id = token
 *   PhattParty.members         [{id, name, avatar, game, room, status, online, level, title, host}]
 *   PhattParty.venue           {game, url, room, by, at} | null
 *   PhattParty.create({name, avatar}) -> Promise<code>      PhattParty.join(code) -> Promise<code>      PhattParty.leave()
 *   PhattParty.goto(gameId, {room})      host only: move the venue; the url comes from the catalog
 *   PhattParty.setWhere({room, status, game})   "I'm in room XYZ" (status 'lobby'|'playing'|'done'; game: hub surfaces only,
 *                                               which Clubhouse game I am at)
 *   PhattParty.setProfile({name, avatar, level, title})
 *   PhattParty.setInventory([cosmeticIds])      what I own on THIS origin; the server unions it into my member record
 *   PhattParty.inventory                        union of everything I own anywhere
 *   PhattParty.setGuard(() => 'You are mid-hand.' | '')
 *   PhattParty.on('party'|'goto'|'follow'|'chat'|'inventory'|'err', fn) -> off()
 *       'party'  (snapshot)            every change
 *       'goto'   (venue)               the host moved the party (also fires for the host)
 *       'follow' (venue)               go now: the venue is on THIS surface and the user/countdown/guard said yes
 *       'chat'   (line)  'inventory' (items)  'err' (msg)
 *   PhattParty.ready                   Promise<PhattParty>, settles after the first snapshot (or at once with no party)
 *   PhattParty.catalog                 {genres, games}      PhattParty.urlFor(gameId, {room}) -> url with ?party&m
 *   PhattParty.isHere(venue)           true when venue is on this surface      PhattParty.open() / close()  the drawer
 *   PhattParty.isHost                  boolean
 *
 * Wire (client → server): hello {party?, member?, name, avatar, game, create?} · chat {text} · goto {game, url, room?}
 *   · where {room?, status?, game?} · profile {name, avatar} · inventory {items} · leave · ping
 * Wire (server → client): party {code, host, you, members, venue, chat} · goto {venue} · chat {line} · inventory {items}
 *   · err {msg} · pong
 * Venue URLs: ?party=CODE&m=TOKEN appended (merged with the existing query, hash kept); party:'hash' games get #ROOM,
 * games with a catalog roomParam get ?<roomParam>=ROOM (CS Party's ?code=). */
(function () {
  'use strict';
  if (window.PhattParty) return;
  const script = document.currentScript;
  const GAME = ((script && script.dataset.game) || 'unknown').toLowerCase();
  // dev override of data-hub: ?hub=http://ip:4400 once (kept in localStorage 'phatt.party.hub'), or set that key by hand; empty string clears it
  const HUB_OVERRIDE = (() => { try { const u = new URLSearchParams(location.search); if (u.has('hub')) { if (u.get('hub')) localStorage.setItem('phatt.party.hub', u.get('hub')); else localStorage.removeItem('phatt.party.hub'); } return localStorage.getItem('phatt.party.hub'); } catch { return null; } })();
  const HUB = (HUB_OVERRIDE || (script && script.dataset.hub) || location.origin).replace(/\/+$/, '');
  const WS_URL = HUB.replace(/^http/, 'ws') + '/party';
  const LS_MEMBER = 'phatt.party.member', LS_CODE = 'phatt.party.code', LS_PROFILE = 'phatt.party.profile';
  const FOLLOW_SECONDS = 5;

  // ---- catalog (embedded copy of client/party/catalog.js output; refreshed from <hub>/api/catalog at startup) ----
  const MAIN_EVENTS_NAME = 'Main Events';
  let CATALOG = {
    genres: [
      { id: 'clubhouse', name: 'Clubhouse', blurb: 'Tables that take minutes. Drop in, drop out.' },
      { id: 'mainevents', name: MAIN_EVENTS_NAME, blurb: 'Nights that take hours.' }],
    games: [
      { id: 'pokernight', genre: 'clubhouse', name: 'Poker Night', url: 'https://poker.phatt.vip/', min: 1, max: 5, party: 'hash', icon: '🃏', list: { path: 'api/rooms', format: 'pokernight' } },
      { id: 'klondike', genre: 'clubhouse', name: 'Solitaire', url: '<hub>/?game=klondike', min: 1, max: 1, party: 'query', hub: true, icon: '♠' },
      { id: 'hearts', genre: 'clubhouse', name: 'Hearts', url: '<hub>/?game=hearts', min: 4, max: 4, party: 'query', hub: true, icon: '♥' },
      { id: 'crazyeights', genre: 'clubhouse', name: 'Crazy Eights', url: '<hub>/?game=crazyeights', min: 2, max: 8, party: 'query', hub: true, icon: '8' },
      { id: 'gofish', genre: 'clubhouse', name: 'Go Fish', url: '<hub>/?game=gofish', min: 2, max: 6, party: 'query', hub: true, icon: '≈' },
      { id: 'rummy', genre: 'clubhouse', name: 'Gin Rummy', url: '<hub>/?game=rummy', min: 2, max: 2, party: 'query', hub: true, icon: '♣' },
      { id: 'blackjack', genre: 'clubhouse', name: 'Blackjack', url: '<hub>/?game=blackjack', min: 1, max: 7, party: 'query', hub: true, icon: '21' },
      { id: 'dice', genre: 'clubhouse', name: 'Yacht Dice', url: '<hub>/?game=dice', min: 1, max: 8, party: 'query', hub: true, icon: '⚄' },
      { id: 'checkers', genre: 'clubhouse', name: 'Checkers', url: '<hub>/?game=checkers', min: 2, max: 2, party: 'query', hub: true, icon: '●' },
      { id: 'chess', genre: 'clubhouse', name: 'Chess', url: '<hub>/?game=chess', min: 2, max: 2, party: 'query', hub: true, icon: '♞' },
      { id: 'dominoes', genre: 'clubhouse', name: 'Dominoes', url: '<hub>/?game=dominoes', min: 2, max: 4, party: 'query', hub: true, icon: '▮' },
      { id: 'spades', genre: 'clubhouse', name: 'Spades', url: '<hub>/?game=spades', min: 4, max: 4, party: 'query', hub: true, icon: '♠' },
      { id: 'cribbage', genre: 'clubhouse', name: 'Cribbage', url: '<hub>/?game=cribbage', min: 2, max: 4, party: 'query', hub: true, icon: '❖' },
      { id: 'backgammon', genre: 'clubhouse', name: 'Backgammon', url: '<hub>/?game=backgammon', min: 2, max: 2, party: 'query', hub: true, icon: '⚁' },
      { id: 'csparty', genre: 'mainevents', name: 'CS Party', url: 'https://csparty.phatt.vip/', min: 1, max: 4, party: 'query', roomParam: 'code', icon: '🎲', list: { path: 'api/public', format: 'csparty' } },
      { id: '7dtz', genre: 'mainevents', name: '7 Days to Zelda', url: 'https://zelda.phatt.vip/', min: 1, max: 4, party: 'query', roomParam: 'camp', icon: '🗡', list: { path: 'api/rooms', format: '7dtz' } }],
  };
  const entry = (id) => CATALOG.games.find((g) => g.id === id) || null;
  const gameName = (id) => (id === 'clubhouse' ? 'the Clubhouse' : (entry(id) || {}).name || (id ? id[0].toUpperCase() + id.slice(1) : 'nowhere'));

  // ---- identity & state ----
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const q = new URLSearchParams(location.search);
  const hex32 = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
  const newToken = () => { const b = new Uint8Array(16); (crypto.getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; })); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
  const freshMember = !hex32(q.get('m')) && !hex32(ls.get(LS_MEMBER)); // minted right here: the hub cannot know this token yet
  let member = freshMember ? newToken() : hex32(q.get('m')) ? q.get('m') : ls.get(LS_MEMBER);
  ls.set(LS_MEMBER, member);
  const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let wantCode = /^[A-Z2-9]{6}$/.test(q.get('party') || '') ? q.get('party').toUpperCase() : (ls.get(LS_CODE) || null);
  let profile = (() => { try { return JSON.parse(ls.get(LS_PROFILE) || 'null') || {}; } catch { return {}; } })();
  if (!profile.name && GAME === 'pokernight') { try { const p = JSON.parse(localStorage.getItem('pn_mp_profile') || 'null'); if (p && p.name) profile = { name: p.name, avatar: p.avatar || null }; } catch { /* no PN profile */ } }

  const state = { code: null, host: null, members: [], venue: null, chat: [], inventory: [], connected: false, where: {} };
  const listeners = {};
  const emit = (ev, data) => { (listeners[ev] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error('PhattParty listener', e); } }); };
  let guard = () => '';
  let resolveReady; const ready = new Promise((r) => { resolveReady = r; });
  let pendingJoin = null; // {resolve, reject} for create()/join()
  let profileDirty = false; // setProfile() was called before we had a party; send it with the first snapshot

  // ---- socket ----
  let ws = null, retry = 0, retryTimer = null, pingTimer = null, createNext = false, hadSnapshot = false, wantConnection = false;
  const send = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; };
  function hello() {
    if (ws) ws.__said = true;
    send({ t: 'hello', party: createNext ? undefined : wantCode || undefined, member, name: profile.name || 'Guest', avatar: profile.avatar || null, game: GAME, create: createNext || undefined, level: profile.level, title: profile.title });
    createNext = false;
    // re-announce what the page already told us (the server processes these after the hello)
    if (Object.keys(state.where).length) send({ t: 'where', ...state.where });
    if (state.localInventory && state.localInventory.length) send({ t: 'inventory', items: state.localInventory });
  }
  function connect() {
    wantConnection = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) { if (ws.readyState === 1) hello(); return; } // still connecting: onopen says hello with the current wantCode/createNext
    clearTimeout(retryTimer);
    try { ws = new WebSocket(WS_URL); } catch (e) { return scheduleRetry(); }
    ws.onopen = () => {
      retry = 0; state.connected = true; clearInterval(pingTimer); pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
      // Let the page's own scripts (deferred/module, all run before 'load') call setProfile before we introduce ourselves.
      if (document.readyState === 'complete') hello(); else window.addEventListener('load', () => { if (ws && ws.readyState === 1 && !ws.__said) hello(); }, { once: true });
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
    ws.onclose = () => { state.connected = false; clearInterval(pingTimer); render(); if (wantConnection && (wantCode || pendingJoin)) scheduleRetry(); };
    ws.onerror = () => {};
  }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, Math.min(10000, 1500 * Math.pow(1.6, retry++))); }
  function disconnect() { wantConnection = false; clearTimeout(retryTimer); clearInterval(pingTimer); if (ws) { try { ws.close(); } catch { /* closed */ } } ws = null; state.connected = false; }

  function onMessage(m) {
    if (m.t === 'pong') return;
    if (m.t === 'party') {
      const wasCode = state.code;
      state.code = m.code || null; state.host = m.host || null; state.public = !!m.public; state.members = m.members || []; state.venue = m.venue || null; state.chat = m.chat || [];
      if (m.you && hex32(m.you) && m.you !== member) { member = m.you; ls.set(LS_MEMBER, member); }
      ls.set(LS_CODE, state.code);
      const mine = state.members.find((x) => x.id === member);
      if (mine && profileDirty && state.code && (mine.name !== profile.name || (mine.avatar || null) !== (profile.avatar || null))) { profileDirty = false; send({ t: 'profile', name: profile.name, avatar: profile.avatar || null, level: profile.level, title: profile.title }); }
      else if (mine) { profileDirty = false; profile = { ...profile, name: mine.name, avatar: mine.avatar }; ls.set(LS_PROFILE, JSON.stringify({ name: profile.name, avatar: profile.avatar })); }
      if (!state.code) { wantCode = null; disconnect(); }
      else wantCode = state.code;
      if (pendingJoin) { pendingJoin.resolve(state.code); pendingJoin = null; }
      if (!hadSnapshot) { hadSnapshot = true; resolveReady(api); }
      render();
      if (!wasCode && state.code && view === 'start') setView('party');
      emit('party', snapshot());
      return;
    }
    if (m.t === 'goto') { onGoto(m.venue); return; }
    if (m.t === 'chat') { state.chat.push(m.line); if (state.chat.length > 50) state.chat.shift(); if (!open && !m.line.system) { unread++; pulse(); } renderChat(); emit('chat', m.line); return; }
    if (m.t === 'inventory') { state.inventory = m.items || []; emit('inventory', state.inventory.slice()); return; }
    if (m.t === 'err') {
      if (m.msg === 'no such party' || m.msg === 'no party') { ls.set(LS_CODE, null); wantCode = null; state.code = null; if (!hadSnapshot) { hadSnapshot = true; resolveReady(api); } disconnect(); render(); }
      if (pendingJoin) { pendingJoin.reject(new Error(m.msg)); pendingJoin = null; }
      toast(m.msg);
      emit('err', m.msg);
    }
  }

  // ---- urls ----
  function urlFor(gameId, opts) {
    opts = opts || {};
    const g = entry(gameId); if (!g) return null;
    return withParty(g.url.replace('<hub>', HUB), { room: opts.room, hash: g.party === 'hash', roomParam: g.roomParam, bare: opts.bare, code: opts.code });
  }
  function withParty(base, opts) {
    opts = opts || {};
    let u; try { u = new URL(base, location.href); } catch { return base; }
    const code = opts.code || state.code;
    if (!opts.bare && code) { u.searchParams.set('party', code); u.searchParams.set('m', member); } else if (opts.bare) { u.searchParams.delete('party'); u.searchParams.delete('m'); }
    if (opts.hash && opts.room) u.hash = '#' + opts.room;
    if (opts.roomParam && opts.room) u.searchParams.set(opts.roomParam, opts.room);
    return u.toString();
  }
  const venueUrl = (v) => { const g = entry(v.game) || {}; return withParty(v.url, { room: v.room, hash: g.party === 'hash', roomParam: g.roomParam }); };
  const inviteUrl = () => withParty(state.venue ? venueUrl(state.venue) : HUB + '/', { code: state.code }).replace(/([?&])m=[0-9a-f]{32}&?/, '$1').replace(/[?&]$/, '');
  const isHere = (v) => !!v && (v.game === GAME || (GAME === 'clubhouse' && !!(entry(v.game) || {}).hub));

  // ---- moving ----
  let banner = null, bannerTimer = null;
  function onGoto(venue) {
    state.venue = venue;
    emit('goto', venue);
    const byMe = venue.by === member;
    if (isHere(venue)) {
      const g = byMe ? '' : guard();
      if (g) showBanner(venue, { guardText: g, onGo: () => emit('follow', venue) });
      else emit('follow', venue);
      return;
    }
    if (byMe) { const g = guard(); if (g) showBanner(venue, { guardText: g, onGo: () => navigate(venue), mine: true }); else navigate(venue); return; }
    showBanner(venue, { countdown: FOLLOW_SECONDS, onGo: () => navigate(venue) });
  }
  function navigate(venue) { if (!isHere(venue)) location.href = venueUrl(venue); }
  function showBanner(venue, opts) {
    hideBanner();
    const hostName = (state.members.find((x) => x.id === venue.by) || {}).name || 'The host';
    banner = el('div', 'banner'); banner.setAttribute('role', 'alert');
    const text = el('p');
    const g = entry(venue.game) || { name: venue.game };
    let left = opts.countdown;
    const guardP = opts.guardText ? el('p', 'warn', opts.guardText) : null;
    const line = () => (opts.mine ? 'Taking the party to ' + g.name + '.' : hostName + ' is taking the party to ' + g.name + (left != null ? ', following in ' + left + '…' : '.'));
    text.textContent = line();
    banner.appendChild(text); if (guardP) banner.appendChild(guardP);
    const row = el('div', 'row');
    const go = el('button', 'go', opts.mine ? 'Leave anyway' : 'Go now'); go.type = 'button';
    const stay = el('button', 'stay', 'Stay'); stay.type = 'button';
    go.onclick = () => { const g2 = guard(); if (g2 && !opts.guardText && !confirm(g2 + '\n\nLeave anyway?')) return; hideBanner(); opts.onGo(); };
    stay.onclick = () => hideBanner();
    row.appendChild(go); row.appendChild(stay); banner.appendChild(row);
    root.appendChild(banner);
    (opts.guardText ? stay : go).focus();
    if (left != null) {
      bannerTimer = setInterval(() => {
        left--; text.textContent = line();
        if (left <= 0) { const g3 = guard(); if (g3) { clearInterval(bannerTimer); left = null; text.textContent = line(); banner.insertBefore(el('p', 'warn', g3), row); stay.focus(); return; } hideBanner(); opts.onGo(); }
      }, 1000);
    }
  }
  function hideBanner() { clearInterval(bannerTimer); bannerTimer = null; if (banner) { banner.remove(); banner = null; } }

  // ---- UI ----
  const CSS = [
    ':host{all:initial;position:fixed;left:0;bottom:0;z-index:2147483000;font:14px/1.4 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;color:#f3e9d2;pointer-events:none}',
    '*{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;cursor:pointer;color:inherit}',
    'button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #ffe08a;outline-offset:2px}',
    '.pill{pointer-events:auto;position:fixed;left:14px;bottom:14px;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:5px 14px 5px 7px;border-radius:99px;',
    ' background:linear-gradient(#4a3322,#2a1a0e);border:1px solid #140b05;box-shadow:0 0 0 1px #c9a24a66,0 3px 0 #140b05,0 8px 20px #000a,inset 0 1px 0 #fff2;transition:transform .12s}',
    '.pill:hover{transform:translateY(-1px)}.pill:active{transform:translateY(1px)}',
    '.pill.pulse{animation:pulse .9s ease-out 2}@keyframes pulse{0%{box-shadow:0 0 0 1px #c9a24a66,0 3px 0 #140b05,0 8px 20px #000a}50%{box-shadow:0 0 0 4px #c9a24acc,0 3px 0 #140b05,0 8px 28px #c9a24a66}100%{box-shadow:0 0 0 1px #c9a24a66,0 3px 0 #140b05,0 8px 20px #000a}}',
    '.pill .lbl{font-size:14px;letter-spacing:.04em;color:#f3e9d2}.pill .lbl b{color:#c9a24a;font-weight:600}.pill .stack{display:flex}.pill .stack .av{margin-right:-9px;border:2px solid #2a1a0e}.pill .stack .av:last-child{margin-right:0}',
    '.pill .club{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,#e3c874,#8a6b25);color:#1d1206;font-size:18px;box-shadow:inset 0 -2px 3px #0006}',
    '.pill .unread{position:absolute;top:-6px;right:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:#e8833a;color:#1d0d04;font-weight:700;font-size:12px;display:grid;place-items:center;border:2px solid #2a1a0e}',
    '.av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:700;font-size:13px;color:#1d1206;background:#c9a24a;overflow:hidden;text-transform:uppercase}.av img{width:100%;height:100%;object-fit:cover;display:block}.av.emoji{font-size:18px;text-transform:none}',
    '.drawer{pointer-events:auto;position:fixed;left:14px;bottom:70px;width:min(360px,calc(100vw - 28px));max-height:min(72vh,640px);display:flex;flex-direction:column;border-radius:16px;overflow:hidden;',
    ' background:linear-gradient(#3f2a1a,#24150b);border:1px solid #000;box-shadow:0 0 0 2px #c9a24a44,0 26px 60px #000c,inset 0 1px 0 #fff2;animation:rise .18s ease-out}',
    '@keyframes rise{from{transform:translateY(10px);opacity:0}}',
    '.hd{display:flex;align-items:center;gap:10px;padding:10px 12px;background:linear-gradient(#4b3220,#2e1d11);border-bottom:1px solid #000;box-shadow:0 1px 0 #8a6b25}',
    '.hd h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.08em;color:#c9a24a;text-transform:uppercase;flex:1}',
    '.code{font-family:"Courier New",monospace;font-size:17px;letter-spacing:.2em;color:#f3e9d2;background:#1c120a;border:1px solid #5c4326;border-radius:8px;padding:3px 8px 3px 10px}',
    '.x{min-width:36px;min-height:36px;border-radius:8px;border:1px solid #140b05;background:linear-gradient(#4a3322,#33211a);box-shadow:0 2px 0 #140b05}.x:hover{filter:brightness(1.1)}',
    '.body{flex:1;overflow:auto;overscroll-behavior:contain;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
    '.sec{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#bda97f;display:flex;align-items:center;gap:8px;margin:4px 0 2px}.sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,#c9a24a66,transparent)}',
    '.mem{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;background:#1c120a88;border:1px solid #5c432655}.mem.off{opacity:.5}.mem .nm{display:flex;align-items:center;gap:6px;font-size:14px}.mem .nm .me{color:#bda97f;font-size:12px}',
    '.mem .info{flex:1;min-width:0}.mem .wh{font-size:12px;color:#c7b48c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mem .ttl{font-size:11px;color:#bda97f;font-style:italic}',
    '.lvl{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:99px;background:#1c120a;border:1px solid #c9a24a;color:#c9a24a;font-size:10px;font-weight:700}',
    '.crown{color:#e3c874;font-size:14px;filter:drop-shadow(0 1px 0 #000)}.dot{width:8px;height:8px;border-radius:50%;background:#8fc7a0;box-shadow:0 0 6px #8fc7a0aa;flex:none}.off .dot{background:#6b5a46;box-shadow:none}',
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:6px 14px;border-radius:8px;font-weight:700;background:linear-gradient(#d9b45c,#a17d2c);color:#2a1a07;border:1px solid #5d4614;text-shadow:0 1px 0 #ffe9a8aa;box-shadow:0 2px 0 #5d4614,0 4px 10px #0006,inset 0 1px 0 #fff5}',
    '.btn:hover{filter:brightness(1.08)}.btn:active{transform:translateY(1px);box-shadow:0 1px 0 #5d4614}.btn[disabled]{opacity:.45;pointer-events:none}',
    '.btn.ghost{background:linear-gradient(#4a3322,#33211a);color:#f3e9d2;border-color:#1a0f08;text-shadow:none;box-shadow:0 2px 0 #140b05,0 4px 10px #0006,inset 0 1px 0 #fff2;font-weight:600}',
    '.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.grow{flex:1}.muted{color:#8f7d58;font-style:italic;font-size:13px}',
    '.input{min-height:38px;background:#1c120a;color:#f3e9d2;border:1px solid #5c4326;border-radius:8px;padding:6px 10px;font:inherit;min-width:0;width:100%}',
    '.chat{display:flex;flex-direction:column;gap:3px;max-height:180px;min-height:60px;overflow:auto;padding:8px;border-radius:10px;background:#150d07;border:1px solid #000;box-shadow:inset 0 2px 8px #000a;font-size:13px}',
    '.chat .ln b{color:#e3c874;font-weight:600}.chat .ln.sys{color:#8f7d58;font-style:italic;font-size:12px}.chat .ln .ts{color:#6b5a46;font-size:11px;margin-left:6px}',
    '.invite{display:flex;gap:6px;align-items:center}.invite .input{font-size:12px;font-family:"Courier New",monospace}',
    '.cat .g{margin-bottom:8px}.cat .blurb{font-size:12px;color:#8f7d58;margin:-2px 0 6px;font-style:italic}',
    '.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}',
    '.tile{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:8px 10px;border-radius:10px;background:linear-gradient(160deg,#3c2819,#26170d);border:1px solid #0007;box-shadow:0 3px 8px #0007,inset 0 1px 0 #fff1,inset 0 0 0 1px #c9a24a22;min-height:64px;position:relative}',
    '.tile:hover{box-shadow:0 6px 12px #000a,inset 0 0 0 1px #c9a24a66}.tile[disabled]{opacity:.42;cursor:not-allowed}.tile .ico{position:absolute;right:8px;top:6px;color:#c9a24a;font-size:18px;opacity:.9}',
    '.brow{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;background:#26170d;border:1px solid #0007;margin-top:6px}.brow .info{flex:1;min-width:0}.brow .acts{display:flex;gap:6px;flex:none}.brow .btn{padding:5px 10px;font-size:12px}a.btn{text-decoration:none;display:inline-block}',
    '.tile .n{font-size:14px;padding-right:22px}.tile .p{font-size:11px;color:#c9a24a;letter-spacing:.06em}.tile .why{font-size:11px;color:#d9534f}.tile.here{box-shadow:inset 0 0 0 2px #8fc7a0aa}.tile .herelbl{font-size:10px;color:#8fc7a0;letter-spacing:.1em}',
    '.banner{pointer-events:auto;position:fixed;left:50%;top:14px;transform:translateX(-50%);width:min(520px,calc(100vw - 20px));padding:12px 14px;border-radius:12px;background:linear-gradient(#4a3322,#2c1b10);border:1px solid #000;box-shadow:0 0 0 2px #c9a24a77,0 18px 40px #000c;animation:rise .2s ease-out}',
    '.banner p{margin:0 0 8px;font-size:15px}.banner .warn{color:#ffd8b0;font-size:13px}.banner .row button{min-height:38px;padding:0 16px;border-radius:8px;border:1px solid #140b05;font-weight:700}',
    '.banner .go{background:linear-gradient(#d9b45c,#a17d2c);color:#2a1a07}.banner .stay{background:linear-gradient(#4a3322,#33211a);color:#f3e9d2}',
    '.toast{pointer-events:none;position:fixed;left:14px;bottom:70px;background:#2b1409;color:#ffd8b0;border:1px solid #a2511d;padding:8px 12px;border-radius:10px;box-shadow:0 8px 20px #000a;font-size:13px;animation:toast 2.6s forwards}',
    '@keyframes toast{0%{opacity:0;transform:translateY(8px)}10%,80%{opacity:1;transform:none}100%{opacity:0}}',
    '.start h3{margin:4px 0 2px;font-size:20px;font-weight:600;color:#f3e9d2}.start p{margin:0 0 8px;color:#bda97f;font-size:13px}',
    '@media (max-width:520px){.drawer{left:0;right:0;bottom:0;width:100vw;max-height:82vh;border-radius:16px 16px 0 0;padding-bottom:env(safe-area-inset-bottom)}.pill{left:10px;bottom:10px;min-height:40px;padding:4px 10px 4px 6px}.pill .lbl .txt{display:none}.toast{left:10px}}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  ].join('\n');

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const hue = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
  function avatarNode(m) {
    const a = el('span', 'av');
    const av = m.avatar || '';
    if (/^(https?:|data:|\/)/.test(av)) { const i = el('img'); i.src = av; i.alt = ''; a.appendChild(i); return a; }
    const name = m.name || '?';
    if (av && av.length <= 2 && !/^[\w\s]+$/.test(av)) { a.classList.add('emoji'); a.textContent = av; }
    else a.textContent = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1) || '?';
    a.style.background = 'hsl(' + hue(av || name) + ' 45% 62%)';
    a.title = av && !a.classList.contains('emoji') ? name + ' (' + av + ')' : name;
    return a;
  }
  function whereText(m) {
    if (!m.online) return 'offline';
    const v = state.venue;
    const atVenue = v && m.game === v.game;
    const g = m.game === 'clubhouse' ? 'the Clubhouse lobby' : gameName(m.game);
    if (v && !atVenue) return m.game === 'clubhouse' ? 'in the Clubhouse lobby' : 'away at ' + gameName(m.game);
    if (v && atVenue && !v.room && m.host && !m.room) return 'setting up the table';
    if (v && atVenue && !v.room && !m.room) return 'waiting for the table';
    if (m.status === 'playing') return 'playing ' + g;
    if (m.status === 'done') return 'finished a game at ' + g;
    return 'at ' + g;
  }

  let host, root, pill, drawer, open = false, unread = 0, view = 'party', chatBox, mountEl;
  function build() {
    host = el('div'); host.setAttribute('data-phatt-party', '');
    root = host.attachShadow({ mode: 'open' });
    const style = el('style'); style.textContent = CSS; root.appendChild(style);
    pill = el('button', 'pill'); pill.type = 'button'; pill.setAttribute('aria-haspopup', 'dialog'); pill.setAttribute('aria-expanded', 'false'); pill.setAttribute('aria-label', 'Party');
    pill.onclick = () => (open ? closeDrawer() : openDrawer());
    root.appendChild(pill);
    const sel = script && script.dataset.mount; mountEl = (sel && document.querySelector(sel)) || document.body;
    mountEl.appendChild(host);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { closeDrawer(); pill.focus(); } });
    render();
  }
  function pulse() { pill.classList.remove('pulse'); void pill.offsetWidth; pill.classList.add('pulse'); renderPill(); }
  let toastEl = null;
  function toast(msg) { if (toastEl) toastEl.remove(); toastEl = el('div', 'toast', msg); toastEl.setAttribute('role', 'status'); root.appendChild(toastEl); setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 2700); }

  function renderPill() {
    pill.textContent = '';
    if (!state.code) { pill.appendChild(el('span', 'club', '♣')); pill.appendChild(el('span', 'lbl', 'Party')); pill.setAttribute('aria-label', 'Party: start or join one'); return; }
    const online = state.members.filter((m) => m.online);
    const stack = el('span', 'stack');
    state.members.slice(0, 3).forEach((m) => stack.appendChild(avatarNode(m)));
    pill.appendChild(stack);
    const lbl = el('span', 'lbl'); lbl.appendChild(el('b', '', String(online.length))); lbl.appendChild(el('span', 'txt', ' in the party'));
    pill.appendChild(lbl);
    pill.setAttribute('aria-label', 'Party ' + state.code + ', ' + online.length + ' online' + (unread ? ', ' + unread + ' new messages' : ''));
    if (unread) pill.appendChild(el('span', 'unread', String(unread)));
    if (!state.connected) pill.style.filter = 'grayscale(.6)'; else pill.style.filter = '';
  }
  function render() { renderPill(); if (open) renderDrawer(); }
  function setView(v) { view = v; if (open) renderDrawer(); }
  function openDrawer() { open = true; unread = 0; view = state.code ? 'party' : 'start'; renderDrawer(); pill.setAttribute('aria-expanded', 'true'); renderPill(); drawer.querySelector('.x').focus(); }
  function closeDrawer() { open = false; if (drawer) { drawer.remove(); drawer = null; } pill.setAttribute('aria-expanded', 'false'); }

  function renderDrawer() {
    const prevScroll = drawer ? drawer.querySelector('.body').scrollTop : 0;
    if (drawer) drawer.remove();
    drawer = el('aside', 'drawer'); drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', 'Party');
    const hd = el('div', 'hd');
    const h2 = el('h2', '', view === 'catalog' ? 'Take the party to…' : view === 'browse' ? 'Open games' : 'Party');
    hd.appendChild(h2);
    if (state.code && view !== 'catalog') { const c = el('span', 'code', state.code); c.title = 'Party code'; hd.appendChild(c); }
    if (view === 'catalog' || view === 'browse') { const back = el('button', 'x', '‹'); back.type = 'button'; back.setAttribute('aria-label', 'Back'); back.onclick = () => setView(state.code ? 'party' : 'start'); hd.appendChild(back); }
    const x = el('button', 'x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close the party drawer'); x.onclick = () => { closeDrawer(); pill.focus(); };
    hd.appendChild(x); drawer.appendChild(hd);
    const body = el('div', 'body'); drawer.appendChild(body);
    root.appendChild(drawer); // attach first: the chat log paints into a connected node
    if (view === 'start') renderStart(body); else if (view === 'catalog') renderCatalog(body); else if (view === 'browse') renderBrowse(body); else renderParty(body);
    body.scrollTop = prevScroll;
  }

  function renderStart(body) {
    const s = el('div', 'start');
    s.appendChild(el('h3', '', 'Bring your friends along.'));
    s.appendChild(el('p', '', 'A party is a group that moves together: ' + gameName(GAME).replace(/^the /, 'the ') + ' now, Go Fish or Poker Night later. One code, one lobby, everywhere in the arcade.'));
    const name = el('input', 'input'); name.maxLength = 20; name.placeholder = 'Your name'; name.value = profile.name || ''; name.setAttribute('aria-label', 'Your name');
    s.appendChild(name);
    const row = el('div', 'row'); row.style.marginTop = '8px';
    const start = el('button', 'btn', 'Start a party'); start.type = 'button';
    start.onclick = () => { api.create({ name: name.value.trim() || profile.name || 'Guest', avatar: profile.avatar || null }).catch(() => {}); };
    row.appendChild(start); s.appendChild(row);
    s.appendChild(el('div', 'sec', 'or join one'));
    const jr = el('div', 'row');
    const code = el('input', 'input'); code.placeholder = 'CODE'; code.maxLength = 6; code.style.width = '110px'; code.style.letterSpacing = '.2em'; code.style.fontFamily = '"Courier New",monospace'; code.setAttribute('aria-label', 'Party code'); code.autocapitalize = 'characters';
    const join = el('button', 'btn ghost', 'Join'); join.type = 'button';
    const doJoin = () => { const c = cleanCode(code.value); if (c.length !== 6) { toast('A party code is 6 letters and numbers.'); return; } if (name.value.trim()) { profile.name = name.value.trim(); ls.set(LS_PROFILE, JSON.stringify(profile)); } api.join(c).catch(() => {}); };
    join.onclick = doJoin; code.onkeydown = (e) => { if (e.key === 'Enter') doJoin(); };
    jr.appendChild(code); jr.appendChild(join); s.appendChild(jr);
    body.appendChild(s);
    const br = el('button', 'btn ghost', 'Open games across the arcade'); br.type = 'button'; br.onclick = () => setView('browse'); body.appendChild(br);
  }

  function renderParty(body) {
    const me = state.members.find((m) => m.id === member) || {};
    const hostM = state.members.find((m) => m.id === state.host) || {};
    // invite
    const inv = el('div', 'invite');
    const link = el('input', 'input'); link.readOnly = true; link.value = inviteUrl(); link.setAttribute('aria-label', 'Invite link'); link.onclick = () => link.select();
    const copy = el('button', 'btn ghost', 'Copy'); copy.type = 'button'; copy.style.flex = 'none';
    copy.onclick = () => { const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1600); }; if (navigator.clipboard) navigator.clipboard.writeText(link.value).then(done, () => { link.select(); document.execCommand && document.execCommand('copy'); done(); }); else { link.select(); document.execCommand && document.execCommand('copy'); done(); } };
    inv.appendChild(link); inv.appendChild(copy); body.appendChild(inv);
    // venue line
    if (state.venue) { const v = state.venue; const g = entry(v.game) || { name: v.game }; body.appendChild(el('div', 'muted', 'The party is at ' + g.name + (v.room && !isHere(v) ? ' (room ' + v.room + ')' : '') + '.')); }
    // members
    const sec = el('div', 'sec', state.members.length + (state.members.length === 1 ? ' member' : ' members')); body.appendChild(sec);
    const list = el('div'); list.style.display = 'grid'; list.style.gap = '6px'; list.setAttribute('role', 'list');
    state.members.forEach((m) => {
      const r = el('div', 'mem' + (m.online ? '' : ' off')); r.setAttribute('role', 'listitem');
      r.appendChild(avatarNode(m));
      const info = el('div', 'info');
      const nm = el('div', 'nm');
      if (m.level) { const l = el('span', 'lvl', String(m.level)); l.title = 'Level ' + m.level; nm.appendChild(l); }
      nm.appendChild(el('span', '', m.name));
      if (m.id === member) nm.appendChild(el('span', 'me', '(you)'));
      if (m.host) { const c = el('span', 'crown', '♛'); c.title = 'Host'; c.setAttribute('aria-label', 'host'); nm.appendChild(c); }
      info.appendChild(nm);
      if (m.title) info.appendChild(el('div', 'ttl', m.title));
      info.appendChild(el('div', 'wh', whereText(m)));
      r.appendChild(info);
      r.appendChild(el('span', 'dot'));
      list.appendChild(r);
    });
    body.appendChild(list);
    // move
    const mv = el('div', 'row');
    if (me.host) { const b = el('button', 'btn', 'Take the party to…'); b.type = 'button'; b.onclick = () => setView('catalog'); mv.appendChild(b); }
    else mv.appendChild(el('span', 'muted', 'Only ' + (hostM.name || 'the host') + ' can move the party'));
    const br = el('button', 'btn ghost', 'Open games'); br.type = 'button'; br.title = 'Open games and lobbies across the whole arcade'; br.onclick = () => setView('browse'); mv.appendChild(br);
    const lv = el('button', 'btn ghost', 'Leave'); lv.type = 'button'; lv.style.marginLeft = 'auto'; lv.onclick = () => { if (confirm('Leave the party?')) api.leave(); };
    mv.appendChild(lv); body.appendChild(mv);
    if (me.host) {
      const pl = el('label', 'muted'); pl.style.display = 'flex'; pl.style.gap = '6px'; pl.style.alignItems = 'center'; pl.style.cursor = 'pointer';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!state.public; cb.onchange = () => send({ t: 'public', on: cb.checked });
      pl.appendChild(cb); pl.appendChild(document.createTextNode('List this party in Open games so others can join'));
      body.appendChild(pl);
    } else if (state.public) body.appendChild(el('div', 'muted', 'This party is listed in Open games.'));
    // chat
    body.appendChild(el('div', 'sec', 'Chat'));
    chatBox = el('div', 'chat'); chatBox.setAttribute('role', 'log'); chatBox.setAttribute('aria-live', 'polite'); body.appendChild(chatBox); renderChat();
    const cr = el('div', 'row'); cr.style.flexWrap = 'nowrap';
    const inp = el('input', 'input'); inp.maxLength = 200; inp.placeholder = 'Say something…'; inp.setAttribute('aria-label', 'Chat message');
    const sb = el('button', 'btn ghost', 'Send'); sb.type = 'button'; sb.style.flex = 'none';
    const doSend = () => { const t = inp.value.trim(); if (!t) return; if (send({ t: 'chat', text: t })) inp.value = ''; };
    sb.onclick = doSend; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } };
    cr.appendChild(inp); cr.appendChild(sb); body.appendChild(cr);
    if (!state.connected) body.appendChild(el('div', 'muted', 'Reconnecting…'));
  }
  function renderChat() {
    if (!chatBox || !chatBox.isConnected) return;
    chatBox.textContent = '';
    if (!state.chat.length) chatBox.appendChild(el('div', 'ln sys', 'Nobody has said anything yet.'));
    state.chat.forEach((l) => {
      const d = el('div', 'ln' + (l.system ? ' sys' : ''));
      if (!l.system) { d.appendChild(el('b', '', l.name + ': ')); }
      d.appendChild(document.createTextNode(l.text));
      const t = new Date(l.ts); d.appendChild(el('span', 'ts', String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')));
      chatBox.appendChild(d);
    });
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ---- the universal lobby browser: GET <hub>/api/browser (server/browser.js), refreshed while the view is open ----
  let browseData = null, browseTimer = 0, browseAt = 0;
  function loadBrowse(force) {
    if (!force && Date.now() - browseAt < 4000) return Promise.resolve(browseData);
    return fetch(HUB + '/api/browser', { mode: 'cors' }).then((r) => (r.ok ? r.json() : null)).then((d) => { browseData = d; browseAt = Date.now(); if (open && view === 'browse') renderDrawer(); return d; }).catch(() => { browseData = null; browseAt = Date.now(); if (open && view === 'browse') renderDrawer(); return null; });
  }
  function renderBrowse(body) {
    const me = state.members.find((m) => m.id === member) || {};
    const d = browseData;
    if (!d) { body.appendChild(el('div', 'muted', browseAt ? 'The arcade is not answering right now.' : 'Looking around the arcade…')); if (!browseAt) loadBrowse(true); }
    clearInterval(browseTimer); browseTimer = setInterval(() => { if (open && view === 'browse') loadBrowse(true); else clearInterval(browseTimer); }, 8000);
    const top = el('div', 'row'); top.appendChild(el('span', 'muted', state.code ? (me.host ? 'Join alone, or bring the whole party.' : 'Joining takes you there on your own; ' + ((state.members.find((m) => m.id === state.host) || {}).name || 'the host') + ' can bring the party.') : 'Everything open across the arcade right now.'));
    const rf = el('button', 'btn ghost', 'Refresh'); rf.type = 'button'; rf.style.marginLeft = 'auto'; rf.onclick = () => loadBrowse(true); top.appendChild(rf); body.appendChild(top);
    if (!d) return;
    const parties = (d.parties || []).filter((x) => x.code !== state.code);
    const games = (d.games || []).filter((g) => g.rooms.length || !g.ok);
    if (!parties.length && !games.some((g) => g.rooms.length)) body.appendChild(el('div', 'muted', 'Nothing open anywhere right now. Be the first.'));
    const cat = el('div', 'cat');
    if (parties.length) {
      const gd = el('div', 'g'); gd.appendChild(el('div', 'sec', 'Parties'));
      parties.forEach((x) => {
        const r = el('div', 'brow');
        const info = el('div', 'info'); info.appendChild(el('div', 'nm', '♣ ' + x.name)); info.appendChild(el('div', 'wh', x.online + ' online' + (x.venue ? ' · at ' + x.venue.gameName : ''))); r.appendChild(info);
        const j = el('a', 'btn', 'Join'); j.href = x.url; r.appendChild(j); gd.appendChild(r);
      });
      cat.appendChild(gd);
    }
    games.forEach((g) => {
      const gd = el('div', 'g');
      const sec = el('div', 'sec', (g.icon ? g.icon + ' ' : '') + g.name); gd.appendChild(sec);
      if (!g.ok) gd.appendChild(el('div', 'why', 'Not reachable right now' + (g.error ? ' (' + g.error + ')' : '')));
      g.rooms.forEach((rm) => {
        const r = el('div', 'brow');
        const info = el('div', 'info');
        info.appendChild(el('div', 'nm', rm.name));
        const who = rm.players && rm.players.length ? rm.players.join(', ') : rm.humans + (rm.humans === 1 ? ' player' : ' players');
        info.appendChild(el('div', 'wh', (rm.status === 'lobby' ? 'waiting · ' : 'playing · ') + who + ' · ' + rm.humans + '/' + rm.seats + (rm.free ? ' · ' + rm.free + ' open' : ' · full') + (rm.looking ? ' · looking for players' : '')));
        r.appendChild(info);
        const acts = el('div', 'acts');
        const j = el('a', 'btn', rm.free ? 'Join' : 'Watch'); j.href = state.code ? urlFor(g.id, { room: rm.id }) : rm.url; acts.appendChild(j);
        if (me.host) { const b = el('button', 'btn ghost', 'Bring the party'); b.type = 'button'; b.onclick = () => { api.goto(g.id, { room: rm.id }); setView('party'); }; acts.appendChild(b); }
        r.appendChild(acts); gd.appendChild(r);
      });
      cat.appendChild(gd);
    });
    body.appendChild(cat);
  }

  function renderCatalog(body) {
    const n = state.members.filter((m) => m.online).length || 1;
    const cat = el('div', 'cat');
    cat.appendChild(el('div', 'muted', n + (n === 1 ? ' of you online' : ' of you online') + '. Everyone follows when you pick.'));
    CATALOG.genres.forEach((genre) => {
      const games = CATALOG.games.filter((g) => g.genre === genre.id); if (!games.length) return;
      const gd = el('div', 'g');
      gd.appendChild(el('div', 'sec', genre.name));
      if (genre.blurb) gd.appendChild(el('div', 'blurb', genre.blurb));
      const tiles = el('div', 'tiles');
      games.forEach((g) => {
        const t = el('button', 'tile'); t.type = 'button';
        t.appendChild(el('span', 'ico', g.icon || '🎲'));
        t.appendChild(el('span', 'n', g.name));
        t.appendChild(el('span', 'p', g.min === g.max ? (g.min === 1 ? 'SOLO' : g.min + ' PLAYERS') : g.min + '–' + g.max + ' PLAYERS'));
        let why = '';
        if (n > g.max) why = 'Too many for ' + g.name + ' (' + g.max + ' max)';
        else if (n < g.min && !g.hub) why = 'Needs ' + g.min + ' players';
        else if (n < g.min && g.hub) t.appendChild(el('span', 'p', 'bots fill the rest'));
        if (why) { t.disabled = true; t.appendChild(el('span', 'why', why)); t.title = why; }
        if (state.venue && state.venue.game === g.id) { t.classList.add('here'); t.appendChild(el('span', 'herelbl', 'THE PARTY IS HERE')); }
        t.onclick = () => { api.goto(g.id); setView('party'); };
        tiles.appendChild(t);
      });
      gd.appendChild(tiles); cat.appendChild(gd);
    });
    body.appendChild(cat);
  }

  // ---- API ----
  const snapshot = () => ({ code: state.code, host: state.host, members: state.members.slice(), venue: state.venue, chat: state.chat.slice() });
  function startJoin(code, create) {
    return new Promise((resolve, reject) => {
      if (pendingJoin) pendingJoin.reject(new Error('superseded'));
      pendingJoin = { resolve, reject };
      wantCode = create ? null : code; createNext = !!create;
      if (ws && ws.readyState === 1) hello(); else connect();
    });
  }
  const api = {
    get code() { return state.code; },
    get member() { return member; },
    get me() { const m = state.members.find((x) => x.id === member); return { id: member, name: (m && m.name) || profile.name || null, avatar: m ? m.avatar : profile.avatar || null, level: m ? m.level : profile.level || null, title: m ? m.title : null }; },
    get members() { return state.members.slice(); },
    get venue() { return state.venue; },
    get host() { return state.host; },
    get isHost() { return !!state.code && state.host === member; },
    get inventory() { return state.inventory.slice(); },
    get catalog() { return CATALOG; },
    get connected() { return state.connected; },
    game: GAME, hub: HUB, ready,
    create(p) { if (p && (p.name || p.avatar)) { profile = { ...profile, name: p.name || profile.name, avatar: p.avatar === undefined ? profile.avatar : p.avatar }; ls.set(LS_PROFILE, JSON.stringify(profile)); } return startJoin(null, true); },
    join(code) { code = cleanCode(code); if (code.length !== 6) return Promise.reject(new Error('bad code')); return startJoin(code, false); },
    leave() { if (!state.code) return; send({ t: 'leave' }); ls.set(LS_CODE, null); wantCode = null; state.code = null; state.members = []; state.venue = null; state.chat = []; state.host = null; disconnect(); hideBanner(); render(); if (open) setView('start'); emit('party', snapshot()); },
    goto(gameId, opts) { opts = opts || {}; const g = entry(gameId); if (!g) { toast('Unknown game'); return false; } if (!api.isHost) { toast('Only the host can move the party'); return false; } return send({ t: 'goto', game: gameId, url: urlFor(gameId, { bare: true }), room: opts.room || undefined }); },
    setWhere(w) { w = w || {}; const msg = {}; ['room', 'status', 'game'].forEach((k) => { if (k in w) { msg[k] = w[k] == null ? null : String(w[k]); state.where[k] = msg[k]; } }); if (state.code) send({ t: 'where', ...msg }); },
    setProfile(p) { p = p || {}; profile = { ...profile, ...p }; ls.set(LS_PROFILE, JSON.stringify({ name: profile.name, avatar: profile.avatar })); if (state.code) send({ t: 'profile', name: profile.name, avatar: profile.avatar || null, level: profile.level, title: profile.title }); else profileDirty = true; render(); },
    setInventory(items) { state.localInventory = Array.isArray(items) ? items.slice() : []; if (state.code) send({ t: 'inventory', items: state.localInventory }); },
    setGuard(fn) { guard = typeof fn === 'function' ? fn : () => ''; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); }; },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    urlFor, isHere, open: () => { if (!open) openDrawer(); }, close: closeDrawer, toast,
  };
  window.PhattParty = api;

  // ---- boot ----
  function boot() {
    build();
    fetch(HUB + '/api/catalog', { mode: 'cors' }).then((r) => (r.ok ? r.json() : null)).then((c) => { if (c && Array.isArray(c.games) && c.games.length) { CATALOG = c; if (open) renderDrawer(); } }).catch(() => {});
    if (!wantCode) { hadSnapshot = true; resolveReady(api); return; }
    // A surface that has never seen me (no name on this origin yet) asks the hub who I am before saying hello: a hello
    // without a name introduces me as Guest and the party forgets the name and avatar I carried from the last game.
    if (profile.name || freshMember) connect(); // a fresh token has no record to look up (it would only 404)
    else fetch(HUB + '/api/party/' + wantCode + '/member/' + member, { mode: 'cors' }).then((r) => (r.ok ? r.json() : null)).then((m) => { if (m && m.name && m.name !== 'Guest') profile = { ...profile, name: m.name, avatar: m.avatar || null }; }).catch(() => {}).then(connect);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
