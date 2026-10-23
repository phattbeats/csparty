/* PHATT ARCADE DOCK: the one cross-game layer on every arcade page (docs/STANDARD.md, wire in docs/CROSSOVER.md §1, §4).
 * Chat (old Battle.net style: general channels, the party, your table, whispers, slash commands), Games (everything
 * open across the arcade + every game to play) and Party (the group that moves together). One vanilla-JS file in a
 * shadow root, copied byte-identically into every game repo. Canonical copy: phattbeats/clubhouse-games
 * client/party/phatt-party.js (served at <hub>/party/phatt-party.js).
 *
 * Use:   <script src="/party/phatt-party.js" data-game="pokernight" data-hub="https://clubhouse.phatt.vip" defer></script>
 *        data-game  this surface's id as the catalog knows it ('clubhouse' for the hub itself, 'pokernight', 'csparty', '7dtz')
 *        data-hub   origin of the hub (WebSocket at <hub>/party, catalog at <hub>/api/catalog, Clubhouse games at
 *                   <hub>/?game=<id>). Defaults to this page's origin. Local dev: ?hub=http://<ip>:4400 once.
 *        data-mount optional selector; the launcher is appended there instead of <body>.
 * The dock owns the bottom-left corner: it sets html[data-phatt-dock] so a page can keep ~72 px there clear.
 *
 * On its own it: connects to the hub for chat (party or not), reads ?party=CODE&m=TOKEN from the URL, keeps the member
 * token in localStorage 'phatt.party.member' (and the party code in 'phatt.party.code'), renders the launcher + panel,
 * shows the follow banner when the host moves the party, and auto-follows after 5 s.
 *
 * Window API (window.PhattParty), unchanged from round 2 plus open(tab) and the 'me' event:
 *   PhattParty.code / member / me {id, name, avatar, level, title} / members / venue / host / isHost / inventory / catalog
 *   PhattParty.create({name, avatar}) -> Promise<code>   join(code) -> Promise<code>   leave()
 *   PhattParty.goto(gameId, {room})        host only: move the venue; the url comes from the catalog
 *   PhattParty.setWhere({room, status, game})   where I am (status 'lobby'|'playing'|'done'; game: hub surfaces only).
 *                                          Also puts me in that room's Table chat, party or not.
 *   PhattParty.setProfile({name, avatar, level, title})   setInventory([ids])   setGuard(() => 'You are mid-hand.' | '')
 *   PhattParty.on('party'|'goto'|'follow'|'chat'|'inventory'|'err'|'me', fn) -> off()
 *       'me' (me) my name changed from the dock (/name or the rename box): the page should adopt it
 *   PhattParty.ready   Promise, settles after the first party snapshot (or at once with no party)
 *   PhattParty.urlFor(gameId, {room}) / isHere(venue) / open(tab?: 'chat'|'games'|'party') / close() / toast(msg)
 */
(function () {
  'use strict';
  if (window.PhattParty) return;
  const script = document.currentScript;
  const GAME = ((script && script.dataset.game) || 'unknown').toLowerCase();
  // dev override of data-hub: ?hub=http://ip:4400 once (kept in localStorage 'phatt.party.hub'); ?hub= clears it
  const HUB_OVERRIDE = (() => { try { const u = new URLSearchParams(location.search); if (u.has('hub')) { if (u.get('hub')) localStorage.setItem('phatt.party.hub', u.get('hub')); else localStorage.removeItem('phatt.party.hub'); } return localStorage.getItem('phatt.party.hub'); } catch { return null; } })();
  const HUB = (HUB_OVERRIDE || (script && script.dataset.hub) || location.origin).replace(/\/+$/, '');
  const WS_URL = HUB.replace(/^http/, 'ws') + '/party';
  const LS_MEMBER = 'phatt.party.member', LS_CODE = 'phatt.party.code', LS_PROFILE = 'phatt.party.profile', LS_TAB = 'phatt.dock.tab', LS_VIEW = 'phatt.dock.view';
  const FOLLOW_SECONDS = 5;

  // ---- catalog (embedded copy of client/party/catalog.js CATALOG; refreshed from <hub>/api/catalog at startup) ----
  let CATALOG = {"genres":[{"id":"clubhouse","name":"Clubhouse","blurb":"Tables that take minutes. Drop in, drop out."},{"id":"mainevents","name":"Main Events","blurb":"Nights that take hours."}],"games":[{"id":"pokernight","genre":"clubhouse","name":"Poker Night","url":"https://poker.phatt.vip/","min":1,"max":5,"party":"hash","icon":"🃏","list":{"path":"api/rooms","format":"pokernight"},"blurb":"Poker Night at the Inventory online: private rooms, a 3D table, a seat for friends."},{"id":"klondike","genre":"clubhouse","name":"Solitaire","url":"<hub>/?game=klondike","min":1,"max":1,"party":"query","hub":true,"icon":"♠","blurb":"Classic Klondike. Draw one or three.","category":"cards"},{"id":"hearts","genre":"clubhouse","name":"Hearts","url":"<hub>/?game=hearts","min":4,"max":4,"party":"query","hub":true,"icon":"♥","blurb":"Dodge the hearts and the Queen of Spades. Lowest score wins.","category":"cards"},{"id":"crazyeights","genre":"clubhouse","name":"Crazy Eights","url":"<hub>/?game=crazyeights","min":2,"max":8,"party":"query","hub":true,"icon":"8","blurb":"Match the suit or rank. Eights are wild. Empty your hand first.","category":"cards"},{"id":"gofish","genre":"clubhouse","name":"Go Fish","url":"<hub>/?game=gofish","min":2,"max":6,"party":"query","hub":true,"icon":"≈","blurb":"Ask for a rank, collect books of four.","category":"cards"},{"id":"rummy","genre":"clubhouse","name":"Gin Rummy","url":"<hub>/?game=rummy","min":2,"max":2,"party":"query","hub":true,"icon":"♣","blurb":"Meld, knock or go gin. First to 100.","category":"cards"},{"id":"blackjack","genre":"clubhouse","name":"Blackjack","url":"<hub>/?game=blackjack","min":1,"max":7,"party":"query","hub":true,"icon":"21","blurb":"Beat the dealer. Ten rounds, most chips wins.","category":"cards"},{"id":"dice","genre":"clubhouse","name":"Yacht Dice","url":"<hub>/?game=dice","min":1,"max":8,"party":"query","hub":true,"icon":"⚄","blurb":"Five dice, three rolls, thirteen boxes. Chase the Yacht.","category":"dice"},{"id":"checkers","genre":"clubhouse","name":"Checkers","url":"<hub>/?game=checkers","min":2,"max":2,"party":"query","hub":true,"icon":"●","blurb":"Jump, capture and crown kings on the classic wooden board.","category":"board"},{"id":"chess","genre":"clubhouse","name":"Chess","url":"<hub>/?game=chess","min":2,"max":2,"party":"query","hub":true,"icon":"♞","blurb":"The royal game: castling, en passant, promotion, checkmate.","category":"board"},{"id":"dominoes","genre":"clubhouse","name":"Dominoes","url":"<hub>/?game=dominoes","min":2,"max":4,"party":"query","hub":true,"icon":"▮","blurb":"Double-six. Draw game with a boneyard for 2-3, block game for 4.","category":"board"},{"id":"spades","genre":"clubhouse","name":"Spades","url":"<hub>/?game=spades","min":4,"max":4,"party":"query","hub":true,"icon":"♠","blurb":"Partners bid and take tricks. Spades are trump. First to 250.","category":"cards"},{"id":"cribbage","genre":"clubhouse","name":"Cribbage","url":"<hub>/?game=cribbage","min":2,"max":4,"party":"query","hub":true,"icon":"❖","blurb":"Peg around the board to 121.","category":"cards"},{"id":"backgammon","genre":"clubhouse","name":"Backgammon","url":"<hub>/?game=backgammon","min":2,"max":2,"party":"query","hub":true,"icon":"⚁","blurb":"Roll, race and bear off your fifteen checkers first.","category":"board"},{"id":"euchre","genre":"clubhouse","name":"Euchre","url":"<hub>/?game=euchre","min":4,"max":4,"party":"query","hub":true,"icon":"J","blurb":"Partners, bowers and going alone. First team to 10.","category":"cards"},{"id":"president","genre":"clubhouse","name":"President","url":"<hub>/?game=president","min":3,"max":8,"party":"query","hub":true,"icon":"♛","blurb":"Shed your cards first. Twos are high. Scum pays tribute.","category":"cards"},{"id":"cheat","genre":"clubhouse","name":"Cheat","url":"<hub>/?game=cheat","min":3,"max":8,"party":"query","hub":true,"icon":"?","blurb":"Lay cards face-down, claim a rank, and call out the liars.","category":"cards"},{"id":"thirtyone","genre":"clubhouse","name":"Thirty-One","url":"<hub>/?game=thirtyone","min":2,"max":8,"party":"query","hub":true,"icon":"31","blurb":"Three cards, one suit, knock before the table catches up.","category":"cards"},{"id":"oldmaid","genre":"clubhouse","name":"Old Maid","url":"<hub>/?game=oldmaid","min":2,"max":8,"party":"query","hub":true,"icon":"♕","blurb":"Pair them off, pass the queen, and do not be the one left holding her.","category":"cards"},{"id":"liarsdice","genre":"clubhouse","name":"Liar's Dice","url":"<hub>/?game=liarsdice","min":2,"max":8,"party":"query","hub":true,"icon":"⚂","blurb":"Five dice under a cup. Bid, bluff, and call the liar.","category":"dice"},{"id":"farkle","genre":"clubhouse","name":"Farkle","url":"<hub>/?game=farkle","min":2,"max":8,"party":"query","hub":true,"icon":"⚅","blurb":"Six dice, push your luck, bank before you farkle.","category":"dice"},{"id":"csparty","genre":"mainevents","name":"CS Party","url":"https://csparty.phatt.vip/","min":1,"max":4,"party":"query","roomParam":"code","icon":"🎲","list":{"path":"api/public","format":"csparty"},"blurb":"A Mario Party-style board game inside Counter-Strike 1.6. Up to 4 players, bots fill empty seats."},{"id":"7dtz","genre":"mainevents","name":"7 Days to Zelda","url":"https://zelda.phatt.vip/","min":1,"max":4,"party":"query","roomParam":"camp","icon":"🗡","list":{"path":"api/rooms","format":"7dtz"},"blurb":"Co-op Ocarina of Time survival in your browser: craft, build, and hold out through the raids."}]};
  const entry = (id) => CATALOG.games.find((g) => g.id === id) || null;
  const gameName = (id) => (id === 'clubhouse' ? 'the Clubhouse' : (entry(id) || {}).name || (id ? id[0].toUpperCase() + id.slice(1) : 'somewhere'));
  const gameIcon = (id) => (id === 'clubhouse' ? '♣' : (entry(id) || {}).icon || '🎮');
  const players = (g) => (g.min === g.max ? (g.min === 1 ? 'Solo' : g.min + ' players') : g.min + '–' + g.max + ' players');

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

  const state = { code: null, host: null, members: [], venue: null, chat: [], inventory: [], connected: false, where: {}, public: false };
  // the arcade chat: one store per channel + personal lines (whispers, command replies) that show in every view
  const chat = { you: null, online: 0, squelch: new Set(), general: { name: 'Arcade', users: [], lines: [] }, table: { name: null, title: null, users: [], lines: [] }, personal: [], unread: { general: 0, party: 0, table: 0 }, view: ls.get(LS_VIEW) || 'general', sent: [], sentAt: -1, lastWhisper: null };
  const listeners = {};
  const emit = (ev, data) => { (listeners[ev] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error('PhattParty listener', e); } }); };
  let guard = () => '';
  let resolveReady; const ready = new Promise((r) => { resolveReady = r; });
  let pendingJoin = null; // {resolve, reject} for create()/join()
  let profileDirty = false;

  // ---- socket (always on: chat works without a party) ----
  let ws = null, retry = 0, retryTimer = null, pingTimer = null, createNext = false, hadSnapshot = false;
  // nothing but hello/ping before the hello: the server would refuse it; hello() re-sends where/inventory, and profile goes dirty
  const send = (m) => { if (ws && ws.readyState === 1 && (ws.__said || m.t === 'hello' || m.t === 'ping')) { ws.send(JSON.stringify(m)); return true; } return false; };
  function hello() {
    if (ws) ws.__said = true;
    send({ t: 'hello', party: createNext ? undefined : wantCode || undefined, member, name: profile.name || 'Guest', avatar: profile.avatar || null, game: GAME, create: createNext || undefined, level: profile.level, title: profile.title });
    createNext = false;
    if (Object.keys(state.where).length) send({ t: 'where', ...state.where });
    if (state.localInventory && state.localInventory.length) send({ t: 'inventory', items: state.localInventory });
  }
  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) { if (ws.readyState === 1) hello(); return; }
    clearTimeout(retryTimer);
    try { ws = new WebSocket(WS_URL); } catch (e) { return scheduleRetry(); }
    ws.onopen = () => {
      retry = 0; state.connected = true; clearInterval(pingTimer); pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
      // Let the page's own scripts (deferred/module, all run before 'load') call setProfile before we introduce ourselves.
      if (document.readyState === 'complete') hello(); else window.addEventListener('load', () => { if (ws && ws.readyState === 1 && !ws.__said) hello(); }, { once: true });
      render();
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
    ws.onclose = () => { state.connected = false; clearInterval(pingTimer); render(); scheduleRetry(); };
    ws.onerror = () => {};
  }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(connect, Math.min(15000, 1500 * Math.pow(1.6, retry++))); }

  function onMessage(m) {
    if (m.t === 'pong') return;
    if (m.t === 'party') {
      const wasCode = state.code;
      state.code = m.code || null; state.host = m.host || null; state.public = !!m.public; state.members = m.members || []; state.venue = m.venue || null; state.chat = (m.chat || []).map(partyLine);
      if (m.you && hex32(m.you) && m.you !== member) { member = m.you; ls.set(LS_MEMBER, member); }
      ls.set(LS_CODE, state.code);
      const mine = state.members.find((x) => x.id === member);
      if (mine && profileDirty && (mine.name !== profile.name || (mine.avatar || null) !== (profile.avatar || null))) { profileDirty = false; send({ t: 'profile', name: profile.name, avatar: profile.avatar || null, level: profile.level, title: profile.title }); }
      else if (mine) { profileDirty = false; profile = { ...profile, name: mine.name, avatar: mine.avatar }; ls.set(LS_PROFILE, JSON.stringify({ name: profile.name, avatar: profile.avatar })); }
      wantCode = state.code;
      if (!state.code && chat.view === 'party') chat.view = 'general';
      if (pendingJoin) { pendingJoin.resolve(state.code); pendingJoin = null; }
      if (!hadSnapshot) { hadSnapshot = true; resolveReady(api); }
      if (!wasCode && state.code && open && tab === 'party') renderTab();
      render();
      emit('party', snapshot());
      return;
    }
    if (m.t === 'goto') { onGoto(m.venue); return; }
    if (m.t === 'chat') { const l = partyLine(m.line); state.chat.push(l); if (state.chat.length > 50) state.chat.shift(); addLine('party', l); emit('chat', m.line); return; }
    if (m.t === 'inventory') { state.inventory = m.items || []; emit('inventory', state.inventory.slice()); return; }
    if (m.t === 'hi') {
      chat.you = m.you; chat.online = m.online || 0; chat.squelch = new Set(m.squelch || []);
      if (m.you && m.you.name && m.you.name !== profile.name && m.you.name !== 'Guest' && !profile.name) { profile.name = m.you.name; }
      render(); return;
    }
    if (m.t === 'chan') {
      const c = m.kind === 'table' ? chat.table : chat.general;
      const changed = c.name !== m.name;
      c.name = m.name; c.title = m.title; c.users = m.users || []; c.lines = (m.history || []).slice();
      if (m.kind === 'table' && !m.name && chat.view === 'table') chat.view = 'general';
      if (changed) chat.unread[m.kind] = 0;
      if (open && tab === 'chat') { renderChips(); if (chat.view === m.kind) renderLog(); renderUsers(); } else renderLauncher();
      return;
    }
    if (m.t === 'users') {
      const c = m.kind === 'table' ? chat.table : chat.general;
      if (c.name === m.name) c.users = m.users || [];
      if (m.online != null) chat.online = m.online;
      renderLauncher(); if (open) { renderHeader(); if (tab === 'chat') { renderChips(); renderUsers(); } }
      return;
    }
    if (m.t === 'line') { onLine(m.line); return; }
    if (m.t === 'you') {
      if (chat.you) { chat.you.name = m.name; chat.you.away = m.away; }
      if (m.name && m.name !== profile.name) { profile.name = m.name; ls.set(LS_PROFILE, JSON.stringify({ name: profile.name, avatar: profile.avatar })); emit('me', api.me); }
      if (open) renderHeader();
      return;
    }
    if (m.t === 'err') {
      if (m.msg === 'no such party') { ls.set(LS_CODE, null); wantCode = null; state.code = null; if (!hadSnapshot) { hadSnapshot = true; resolveReady(api); } render(); toast('That party has ended.'); }
      else if (m.msg !== 'no party' && m.msg !== 'say hello first') toast(m.msg);
      if (pendingJoin) { pendingJoin.reject(new Error(m.msg)); pendingJoin = null; }
      emit('err', m.msg);
    }
  }

  // ---- chat lines ----
  function partyLine(l) { return { id: 'p' + l.id, ch: 'party', kind: l.system ? 'sys' : 'say', from: l.system ? null : { id: l.member, name: l.name }, text: l.text, ts: l.ts }; }
  function onLine(l) {
    if (l.squelch) chat.squelch = new Set(l.squelch);
    if (l.ch === 'general') addLine('general', l);
    else if (l.ch === 'table') addLine('table', l);
    else { // whispers, invites and command replies: personal, shown in every view
      chat.personal.push(l); if (chat.personal.length > 100) chat.personal.shift();
      if (l.kind === 'wfrom' || l.kind === 'invite') {
        chat.lastWhisper = l.from;
        if (!open || tab !== 'chat') { unreadW++; renderLauncher(); pulse(); toast(l.kind === 'invite' ? l.text : '<From: ' + l.from.name + '> ' + l.text, () => openDrawer('chat')); }
      }
      if (open && tab === 'chat') appendLine(l);
    }
  }
  function addLine(view, l) {
    const store = view === 'party' ? null : chat[view];
    if (store) { store.lines.push(l); if (store.lines.length > 100) store.lines.shift(); }
    if (l.from && chat.squelch.has(l.from.id)) return;
    const mine = l.from && l.from.id === member;
    if (open && tab === 'chat' && chat.view === view) { appendLine(l); return; }
    if (!mine && l.kind !== 'sys') { chat.unread[view]++; if (view !== 'general') pulse(); }
    renderLauncher(); if (open && tab === 'chat') renderChips();
  }
  let unreadW = 0;
  const viewLines = (view) => {
    const own = view === 'party' ? state.chat : view === 'table' ? chat.table.lines : chat.general.lines;
    return own.concat(chat.personal).filter((l) => !(l.from && chat.squelch.has(l.from.id) && l.kind !== 'wto')).sort((a, b) => a.ts - b.ts).slice(-150);
  };

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
    if (opts.bare) { u.searchParams.delete('party'); u.searchParams.delete('m'); }
    else { if (code) u.searchParams.set('party', code); u.searchParams.set('m', member); } // m: who I am carries to the next game (chat, party)
    if (opts.hash && opts.room) u.hash = '#' + opts.room;
    if (opts.roomParam && opts.room) u.searchParams.set(opts.roomParam, opts.room);
    return u.toString();
  }
  const venueUrl = (v) => { const g = entry(v.game) || {}; return withParty(v.url, { room: v.room, hash: g.party === 'hash', roomParam: g.roomParam }); };
  const inviteUrl = () => withParty(state.venue ? venueUrl(state.venue) : HUB + '/', { code: state.code }).replace(/([?&])m=[0-9a-f]{32}&?/, '$1').replace(/[?&]$/, '');
  const isHere = (v) => !!v && (v.game === GAME || (GAME === 'clubhouse' && !!(entry(v.game) || {}).hub));
  function go(url) { const g = guard(); if (g && !confirm(g + '\n\nLeave anyway?')) return; location.href = url; }

  // ---- moving the party ----
  let banner = null, bannerTimer = null;
  // the venue may have gained its room while a banner waited (the host's table got made): act on the latest copy
  const fresh = (v) => (state.venue && state.venue.at === v.at ? state.venue : v);
  function onGoto(venue) {
    state.venue = venue;
    emit('goto', venue);
    const byMe = venue.by === member;
    if (isHere(venue)) {
      const g = byMe ? '' : guard();
      if (g) showBanner(venue, { guardText: g, onGo: () => emit('follow', fresh(venue)) });
      else emit('follow', venue);
      return;
    }
    if (byMe) { const g = guard(); if (g) showBanner(venue, { guardText: g, onGo: () => navigate(venue), mine: true }); else navigate(venue); return; }
    showBanner(venue, { countdown: FOLLOW_SECONDS, onGo: () => navigate(venue) });
  }
  function navigate(venue) { venue = fresh(venue); if (!isHere(venue)) location.href = venueUrl(venue); }
  function showBanner(venue, opts) {
    hideBanner();
    const hostName = (state.members.find((x) => x.id === venue.by) || {}).name || 'The host';
    banner = el('div', 'banner'); banner.setAttribute('role', 'alert');
    const g = entry(venue.game) || { name: venue.game };
    const ico = el('span', 'bico', gameIcon(venue.game));
    const text = el('p');
    let left = opts.countdown;
    const line = () => (opts.mine ? 'Bringing the party to ' + g.name + '.' : hostName + ' is bringing the party to ' + g.name + '.' + (left != null ? ' Following in ' + left + '.' : ''));
    text.textContent = line();
    const box = el('div', 'bbody'); box.appendChild(text);
    if (opts.guardText) box.appendChild(el('p', 'warn', opts.guardText));
    const row = el('div', 'row');
    const goB = button(opts.mine ? 'Leave anyway' : 'Go now', 'btn');
    const stay = button('Stay', 'btn ghost');
    goB.onclick = () => { const g2 = guard(); if (g2 && !opts.guardText && !confirm(g2 + '\n\nLeave anyway?')) return; hideBanner(); opts.onGo(); };
    stay.onclick = () => hideBanner();
    row.appendChild(goB); row.appendChild(stay); box.appendChild(row);
    banner.appendChild(ico); banner.appendChild(box);
    root.appendChild(banner);
    (opts.guardText ? stay : goB).focus();
    if (left != null) {
      bannerTimer = setInterval(() => {
        left--; text.textContent = line();
        if (left <= 0) { const g3 = guard(); if (g3) { clearInterval(bannerTimer); left = null; text.textContent = line(); box.insertBefore(el('p', 'warn', g3), row); stay.focus(); return; } hideBanner(); opts.onGo(); }
      }, 1000);
    }
  }
  function hideBanner() { clearInterval(bannerTimer); bannerTimer = null; if (banner) { banner.remove(); banner = null; } }

  // ---- look: the PHATT ARCADE cabinet (same palette as the PHATT GAMING ARCADE selector) ----
  const CSS = [
    ':host{all:initial;position:fixed;left:0;bottom:0;z-index:2147483000;font:13px/1.45 Tahoma,Verdana,"Segoe UI",Arial,sans-serif;color:#f4e8cc;pointer-events:none;--o:#e8702a;--t:#5fb8ac;--c:#f4e8cc;--m:#cdbf9f;--d:#8f8068;--bg:#17110d;--bg2:#241a14;--line:#4a3a2c}',
    '*{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;cursor:pointer;color:inherit}',
    'button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #fff2a8;outline-offset:2px}',
    // launcher
    '.launch{pointer-events:auto;position:fixed;left:12px;bottom:12px;display:inline-flex;align-items:center;gap:8px;min-height:48px;padding:5px 14px 5px 6px;border-radius:12px;color:var(--c);',
    ' background:linear-gradient(#2b211a,#17110d);border:2px solid var(--c);box-shadow:0 3px 0 var(--o),0 5px 0 #000,0 10px 24px #000a;transition:transform .12s,box-shadow .12s}',
    '.launch:hover{transform:translateY(-1px);box-shadow:0 4px 0 var(--o),0 6px 0 #000,0 12px 26px #000a}.launch:active{transform:translateY(2px);box-shadow:0 1px 0 var(--o),0 2px 0 #000}',
    '.launch.pulse{animation:pulse .9s ease-out 2}@keyframes pulse{50%{box-shadow:0 3px 0 var(--o),0 5px 0 #000,0 0 0 6px #e8702a66}}',
    '.coin{width:38px;height:38px;flex:none;display:block;filter:drop-shadow(0 2px 0 #000) drop-shadow(0 4px 6px #0008);margin:-4px 0}.coin svg{display:block;width:100%;height:100%}.launch:hover .coin{transform:rotate(-8deg)}.coin{transition:transform .2s}',
    '.launch .lbl{display:flex;flex-direction:column;align-items:flex-start;line-height:1.15}.launch .lbl small{font-size:11px;color:var(--t);font-family:"Courier New",monospace;letter-spacing:.04em}',
    '.launch .stack{display:flex;margin-left:2px}.launch .stack .av{width:26px;height:26px;margin-right:-8px;border:2px solid #17110d;font-size:11px}.launch .stack .av:last-child{margin-right:0}',
    '.badge{position:absolute;top:-8px;right:-8px;min-width:22px;height:22px;padding:0 6px;border-radius:99px;background:var(--o);color:#1a0f06;font-weight:700;font-size:12px;display:grid;place-items:center;border:2px solid #17110d}',
    '.launch.off{filter:grayscale(.7)}',
    // panel
    '.panel{pointer-events:auto;position:fixed;left:12px;top:12px;bottom:76px;width:min(420px,calc(100vw - 24px));display:flex;flex-direction:column;border-radius:14px;overflow:hidden;',
    ' background:repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 2px,transparent 2px 4px),linear-gradient(var(--bg2),var(--bg));border:2px solid var(--c);box-shadow:0 0 0 2px #000,0 0 0 5px var(--o),0 0 0 7px #000,0 24px 70px #000d;animation:rise .16s ease-out}',
    '@keyframes rise{from{transform:translateX(-12px);opacity:0}}',
    '.hd{display:flex;align-items:center;gap:10px;padding:10px 10px 8px 12px;border-bottom:2px dashed #5fb8ac44}',
    '.brand{flex:1;display:flex;align-items:center;gap:8px;min-width:0}.brand .coin{width:34px;height:34px;margin:0}',
    '.wm{display:block;height:46px;width:auto}.launch .lbl .wma{display:block;height:18px;width:auto;margin:1px 0 3px}',
    '.mechip{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:2px 10px 2px 3px;border-radius:99px;background:#0e0b09;border:1px solid var(--line);max-width:190px}.mechip:hover{border-color:var(--t)}.mechip .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mechip .away{color:var(--o);font-size:11px}',
    '.x{min-width:36px;min-height:36px;border-radius:8px;background:var(--c);color:#17110d;border:2px solid;border-color:#fff #9c8a68 #9c8a68 #fff;font-weight:700}.x:hover{background:var(--o)}',
    '.tabs{display:flex;gap:4px;padding:8px 10px 0;border-bottom:2px solid #000}',
    '.tab{flex:1;position:relative;min-height:38px;border-radius:9px 9px 0 0;border:2px solid var(--line);border-bottom:0;background:#120d0a;color:var(--m);font-weight:700;letter-spacing:.04em}',
    '.tab[aria-selected=true]{background:var(--bg2);color:var(--c);border-color:var(--c);box-shadow:inset 0 3px 0 var(--o)}.tab .n.cnt{background:#8fd694;color:#0e2a12}.tab .n{margin-left:6px;display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--o);color:#1a0f06;font-size:11px}',
    '.body{flex:1;min-height:0;display:flex;flex-direction:column}',
    '.scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 12px 14px;display:flex;flex-direction:column;gap:10px}',
    '.sec{font:bold 11px/1.3 "Courier New",monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--t);display:flex;align-items:center;gap:8px;margin:6px 0 0}.sec::after{content:"";flex:1;height:0;border-top:2px dashed #5fb8ac44}.sec .r{order:2;text-transform:none;letter-spacing:0}',
    '.muted{color:var(--d);font-size:12px}.note{color:var(--m);font-size:12px}',
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:5px 12px;border-radius:8px;font-weight:700;text-decoration:none;white-space:nowrap;',
    ' background:var(--o);color:#1a0f06;border:2px solid #1a0f06;box-shadow:0 2px 0 #000}.btn:hover{background:#ff8a45}.btn:active{transform:translateY(1px);box-shadow:none}',
    '.btn.ghost{background:#2b211a;color:var(--c);border-color:var(--line)}.btn.ghost:hover{border-color:var(--c);background:#33271f}.btn[disabled],.btn.dis{opacity:.4;pointer-events:none}',
    '.btn.small{min-height:28px;padding:3px 9px;font-size:12px}.btn.quiet{background:none;border-color:transparent;box-shadow:none;color:var(--d);font-weight:400;text-decoration:underline}.btn.quiet:hover{color:var(--c);background:none}',
    '.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}',
    '.input{min-height:36px;background:#0e0b09;color:var(--c);border:2px solid var(--line);border-radius:8px;padding:5px 10px;font:inherit;min-width:0;width:100%}.input:focus{border-color:var(--t);outline:none}',
    '.mono{font-family:"Courier New",monospace;letter-spacing:.16em;text-transform:uppercase}',
    '.av{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:700;font-size:12px;color:#1a0f06;background:var(--o);overflow:hidden;text-transform:uppercase}.av img{width:100%;height:100%;object-fit:cover;display:block}.av.emoji{font-size:16px;text-transform:none}',
    '.lvl{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:4px;background:#0e0b09;border:1px solid var(--t);color:var(--t);font:bold 10px/1 "Courier New",monospace}',
    // chat
    '.chips{display:flex;gap:6px;padding:8px 10px;overflow-x:auto;border-bottom:1px solid #000;scrollbar-width:none}',
    '.chip{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:2px 10px;border-radius:99px;border:2px solid var(--line);background:#120d0a;color:var(--m);font-size:12px;font-weight:700}',
    '.chip[aria-pressed=true]{color:#1a0f06;background:var(--c);border-color:var(--c)}.chip .n{display:inline-grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:var(--o);color:#1a0f06;font-size:10px}',
    '.chip.g{}.chip.p .dotc{background:#8fd694}.chip.t .dotc{background:#f0a050}.dotc{width:8px;height:8px;border-radius:50%;background:var(--t)}',
    '.chip.who{margin-left:auto}',
    '.chatwrap{flex:1;min-height:0;display:flex;position:relative}',
    '.log{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px 10px;background:#0b0806;box-shadow:inset 0 3px 10px #000c;font-size:13px;word-wrap:break-word}',
    '.ln{padding:1px 0}.ln .ts{color:#5d5245;font-size:11px;margin-right:6px;font-family:"Courier New",monospace}.ln .who{color:#ffd479;cursor:pointer}.ln .who:hover{text-decoration:underline}',
    '.ln.sys,.ln.info,.ln.roll{color:var(--t)}.ln.sys{font-size:12px}.ln.err{color:#ff6b5b}.ln.emote{color:#ffd479;font-style:italic}.ln.wfrom,.ln.wto,.ln.invite{color:#c9b3ff}.ln.wfrom .who,.ln.wto .who,.ln.invite .who{color:#c9b3ff}',
    '.ln .tag{color:var(--d);font-size:11px}.ln.me .who{color:#fff2a8}.ln .act{margin-left:8px}',
    '.users{position:absolute;right:0;top:0;bottom:0;width:min(220px,70%);background:#120d0a;border-left:2px solid var(--line);overflow:auto;padding:8px;box-shadow:-10px 0 20px #000a}',
    '.u{display:flex;align-items:center;gap:8px;width:100%;padding:5px 6px;border-radius:6px;background:none;border:0;text-align:left}.u:hover{background:#2b211a}.u .gi{width:22px;text-align:center;font-size:15px;flex:none}.u .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.u .aw{color:var(--o);font-size:10px}.u.off{opacity:.5}',
    '.compose{display:flex;gap:6px;padding:8px 10px 10px;border-top:1px solid #000;position:relative;background:var(--bg2)}',
    '.hints{position:absolute;left:10px;right:10px;bottom:100%;background:#0e0b09;border:2px solid var(--line);border-radius:8px;padding:4px;max-height:200px;overflow:auto;box-shadow:0 -8px 20px #000a}.hint{display:block;width:100%;text-align:left;padding:4px 8px;border:0;background:none;border-radius:4px;font-size:12px;color:var(--m)}.hint b{color:var(--c);font-family:"Courier New",monospace}.hint:hover,.hint.on{background:#2b211a}',
    '.namebar{display:flex;gap:6px;padding:8px 10px;background:#2b1a0e;border-bottom:1px solid #000;align-items:center}',
    // games
    '.brow{min-width:0;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;background:#120d0a;border:2px solid var(--line)}.brow .gi{font-size:18px;width:24px;text-align:center;flex:none}.brow .info{flex:1;min-width:0}.brow .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.brow .wh{font-size:12px;color:var(--m);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.brow .acts{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}',
    '.st{display:inline-block;margin-right:6px;padding:1px 5px;border-radius:4px;font:bold 10px/1.3 "Courier New",monospace;letter-spacing:.08em;vertical-align:1px;background:var(--t);color:#0b2b27}.st.playing{background:var(--o);color:#1a0f06}.st.full{background:#6b5846;color:var(--c)}.st.party{background:#8fd694;color:#0e2a12}',
    '.genre .blurb{font-size:12px;color:var(--d);margin:-2px 0 6px}',
    '.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px}',
    '.tile{position:relative;display:flex;flex-direction:column;gap:2px;text-align:left;padding:8px 10px;border-radius:9px;background:linear-gradient(#2d221b,#1a130f);border:2px solid var(--line);min-height:62px;color:inherit;text-decoration:none}',
    'a.tile:hover,button.tile:hover{border-color:var(--o)}.tile .gi{position:absolute;right:8px;top:6px;font-size:17px;color:var(--o)}.tile .n{font-weight:700;padding-right:22px}.tile .p{font-size:11px;color:var(--t);font-family:"Courier New",monospace}.tile .why{font-size:11px;color:#ff9b8f}',
    '.tile.here{border-color:var(--t)}.tile .herel{font:bold 10px/1 "Courier New",monospace;color:var(--t);letter-spacing:.1em;margin-top:2px}.tile .ta{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}.tile.dis{opacity:.5}',
    // party
    '.hero h3{margin:2px 0 4px;font-size:18px}.hero p{margin:0;color:var(--m)}',
    '.codebox{display:flex;align-items:center;gap:8px}.code{font:bold 20px/1 "Courier New",monospace;letter-spacing:.24em;color:var(--o);background:#0e0b09;border:2px solid var(--line);border-radius:8px;padding:6px 8px 6px 12px}',
    '.mem{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:9px;background:#120d0a;border:2px solid var(--line)}.mem.off{opacity:.55}.mem .info{flex:1;min-width:0}.mem .nm{display:flex;align-items:center;gap:6px;font-weight:700}.mem .wh{font-size:12px;color:var(--m)}.mem .ttl{font-size:11px;color:var(--d);font-style:italic}',
    '.crown{color:#ffd479}.dot{width:9px;height:9px;border-radius:50%;background:#8fd694;box-shadow:0 0 6px #8fd694aa;flex:none}.off .dot{background:#5d5245;box-shadow:none}',
    '.toggle{display:flex;align-items:center;gap:8px;color:var(--m);font-size:12px;cursor:pointer}.toggle input{width:18px;height:18px;accent-color:var(--o)}',
    // banner + toast
    '.banner{pointer-events:auto;position:fixed;left:50%;top:12px;transform:translateX(-50%);width:min(520px,calc(100vw - 20px));display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border-radius:12px;background:linear-gradient(var(--bg2),var(--bg));border:2px solid var(--c);box-shadow:0 0 0 2px #000,0 0 0 4px var(--o),0 18px 40px #000c;animation:drop .2s ease-out}',
    '@keyframes drop{from{transform:translate(-50%,-10px);opacity:0}}.bico{font-size:26px;line-height:1;color:var(--o)}.bbody{flex:1}.banner p{margin:0 0 8px;font-size:14px}.banner .warn{color:#ffc9a0;font-size:12px}',
    '.toast{pointer-events:auto;position:fixed;left:12px;bottom:76px;max-width:min(380px,calc(100vw - 24px));background:#0e0b09;color:var(--c);border:2px solid var(--t);padding:8px 12px;border-radius:10px;box-shadow:0 8px 20px #000a;font-size:13px;animation:toast 4s forwards;cursor:default}.toast.click{cursor:pointer}',
    '@keyframes toast{0%{opacity:0;transform:translateY(8px)}6%,85%{opacity:1;transform:none}100%{opacity:0}}',
    '.withpanel .toast{left:448px;bottom:24px}.withpanel .banner{left:calc(50% + 218px);width:min(520px,calc(100vw - 470px))}',
    '@media (max-width:900px){.withpanel .banner{left:50%;width:min(520px,calc(100vw - 20px))}}',
    '@media (max-width:560px){.withpanel .toast{left:8px;right:8px;top:8px;bottom:auto}.panel{left:0;top:0;bottom:0;width:100vw;border-radius:0;box-shadow:none;border:0;padding-bottom:env(safe-area-inset-bottom)}.launch{left:8px;bottom:8px;min-height:44px;padding:4px 8px 4px 5px}.launch .lbl,.launch .stack{display:none}.launch.open{display:none}.toast{left:8px;bottom:62px}}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  ].join('\n');

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function button(text, cls, title) { const b = el('button', cls, text); b.type = 'button'; if (title) b.title = title; return b; }
  // The PHATT GAMING ARCADE mark as a 3D sphere: the orange body is lit (gradient + soft top-left light), the logo's flat
  // 2D P (cream, teal corner, the break cutting in from the stem's left, dark outline) sits on it, then a dark rim and a glint wrap both so it reads as a ball. Vector, so no image file to ship or sync.
  // The logo's own lettering (cut from arcade/phatt-gaming-arcade.webp, 2x): the full wordmark for the panel header and
  // ARCADE alone for the launcher. Embedded so every game shows it without shipping another file.
  const WM_FULL = 'data:image/webp;base64,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';
  const WM_ARCADE = 'data:image/webp;base64,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';
  function wordmark(src, h, cls) { const i = el('img', cls); i.src = src; i.alt = 'Phatt Gaming Arcade'; i.height = h; i.decoding = 'async'; return i; }
  let coinN = 0;
  function coin() {
    const id = 'pc' + (++coinN);
    const s = el('span', 'coin'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 100 100"><defs>'
      + '<radialGradient id="' + id + 'b" cx="38%" cy="32%" r="72%"><stop offset="0" stop-color="#ffa45c"/><stop offset=".55" stop-color="#e8702a"/><stop offset="1" stop-color="#9c4614"/></radialGradient>'
      + '<radialGradient id="' + id + 'l" cx="34%" cy="26%" r="58%"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>'
      + '<radialGradient id="' + id + 'r" cx="50%" cy="50%" r="50%"><stop offset=".7" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>'
      + '<linearGradient id="' + id + 'p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#e8d6b0"/></linearGradient>'
      + '<clipPath id="' + id + 'c"><circle cx="50" cy="50" r="44"/></clipPath></defs>'
      + '<circle cx="50" cy="50" r="44" fill="url(#' + id + 'b)"/>'
      + '<circle cx="50" cy="50" r="44" fill="url(#' + id + 'l)"/>'
      + '<g clip-path="url(#' + id + 'c)" stroke="#1a1410" stroke-width="5" stroke-linejoin="round">'
      + '<path fill="url(#' + id + 'p)" d="M23 21H64A23 23 0 0 1 64 67H41V105H23V52H57.5A5 5 0 0 0 57.5 42H23Z"/>'
      + '<path fill="#5fb8ac" stroke-width="3" d="M23 21H40L23 38Z"/></g>'
      + '<circle cx="50" cy="50" r="44" fill="url(#' + id + 'r)"/>'
      + '<ellipse cx="77" cy="24" rx="6" ry="3" fill="#fff" opacity=".6" transform="rotate(42 77 24)"/>'
      + '<circle cx="50" cy="50" r="45.5" fill="none" stroke="#1a1410" stroke-width="5"/></svg>';
    return s;
  }
  const hue = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
  function avatarNode(m) {
    const a = el('span', 'av');
    const av = m.avatar || '';
    if (/^(https?:|data:|\/)/.test(av)) { const i = el('img'); i.src = av; i.alt = ''; a.appendChild(i); return a; }
    const name = m.name || '?';
    if (av && av.length <= 2 && !/^[\w\s]+$/.test(av)) { a.classList.add('emoji'); a.textContent = av; }
    else a.textContent = name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1) || '?';
    a.style.background = 'hsl(' + hue(av || name) + ' 55% 62%)';
    return a;
  }
  const hhmm = (ts) => { const t = new Date(ts); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
  function whereText(m) {
    if (!m.online) return 'offline';
    const v = state.venue;
    const atVenue = v && m.game === v.game;
    if (v && !atVenue) return m.game === 'clubhouse' ? 'in the Clubhouse lobby' : 'away at ' + gameName(m.game);
    if (v && atVenue && !v.room && m.host && !m.room) return 'setting up the table';
    if (v && atVenue && !v.room && !m.room) return 'waiting for the table';
    if (m.status === 'playing') return 'playing ' + gameName(m.game);
    if (m.status === 'done') return 'finished a game of ' + gameName(m.game);
    return m.game === 'clubhouse' ? 'in the Clubhouse lobby' : 'at ' + gameName(m.game);
  }

  // ---- shell ----
  let hostEl, root, shell, launch, panel, open = false, tab = ls.get(LS_TAB) || 'chat', mountEl;
  let bodyEl, headerEl, tabsEl;
  function build() {
    hostEl = el('div'); hostEl.setAttribute('data-phatt-party', '');
    root = hostEl.attachShadow({ mode: 'open' });
    const style = el('style'); style.textContent = CSS; root.appendChild(style);
    shell = el('div', 'shell'); root.appendChild(shell); root = shell; // everything renders into the shell (it carries .withpanel)
    launch = button('', 'launch'); launch.setAttribute('aria-haspopup', 'dialog'); launch.setAttribute('aria-expanded', 'false');
    launch.onclick = () => (open ? closeDrawer() : openDrawer());
    root.appendChild(launch);
    const sel = script && script.dataset.mount; mountEl = (sel && document.querySelector(sel)) || document.body;
    mountEl.appendChild(hostEl);
    document.documentElement.setAttribute('data-phatt-dock', '');
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !(e.composedPath()[0] || {}).value) { closeDrawer(); launch.focus(); } });
    render();
  }
  function pulse() { launch.classList.remove('pulse'); void launch.offsetWidth; launch.classList.add('pulse'); }
  let toastEl = null, toastTimer = 0;
  function toast(msg, onClick) {
    if (toastEl) toastEl.remove(); clearTimeout(toastTimer);
    toastEl = el('div', 'toast' + (onClick ? ' click' : ''), msg); toastEl.setAttribute('role', 'status');
    if (onClick) toastEl.onclick = () => { if (toastEl) toastEl.remove(); toastEl = null; onClick(); };
    root.appendChild(toastEl); toastTimer = setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 4100);
  }
  const launcherUnread = () => chat.unread.party + chat.unread.table + unreadW;

  function renderLauncher() {
    if (!launch) return;
    launch.textContent = '';
    launch.appendChild(coin());
    const lbl = el('span', 'lbl'); lbl.appendChild(wordmark(WM_ARCADE, 18, 'wma'));
    const online = chat.online || 0;
    lbl.appendChild(el('small', '', !state.connected ? 'connecting…' : state.code ? 'party of ' + state.members.filter((m) => m.online).length : online + ' online'));
    launch.appendChild(lbl);
    if (state.code) { const st = el('span', 'stack'); state.members.filter((m) => m.online).slice(0, 3).forEach((m) => st.appendChild(avatarNode(m))); launch.appendChild(st); }
    const n = launcherUnread();
    if (n) launch.appendChild(el('span', 'badge', n > 99 ? '99+' : String(n)));
    launch.classList.toggle('off', !state.connected);
    launch.classList.toggle('open', open);
    launch.setAttribute('aria-label', 'PHATT Arcade: chat, games and party. ' + online + ' online' + (state.code ? ', in party ' + state.code : '') + (n ? ', ' + n + ' new' : ''));
  }
  function render() { renderLauncher(); if (open) { renderHeader(); renderTabs(); if (tab === 'party') renderTab(); } }

  function openDrawer(t) {
    if (t) { tab = t; ls.set(LS_TAB, tab); }
    if (open) { renderTabs(); renderTab(); return; }
    open = true;
    panel = el('aside', 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'PHATT Arcade');
    headerEl = el('div', 'hd'); tabsEl = el('div', 'tabs'); tabsEl.setAttribute('role', 'tablist'); bodyEl = el('div', 'body');
    panel.appendChild(headerEl); panel.appendChild(tabsEl); panel.appendChild(bodyEl);
    root.appendChild(panel); shell.classList.add('withpanel');
    launch.setAttribute('aria-expanded', 'true');
    renderHeader(); renderTabs(); renderTab(); renderLauncher();
  }
  function closeDrawer() { open = false; clearInterval(browseTimer); if (panel) { panel.remove(); panel = null; } shell.classList.remove('withpanel'); launch.setAttribute('aria-expanded', 'false'); renderLauncher(); }

  function renderHeader() {
    if (!headerEl) return;
    headerEl.textContent = '';
    const b = el('div', 'brand'); b.appendChild(coin()); b.appendChild(wordmark(WM_FULL, 46, 'wm')); headerEl.appendChild(b);
    const me = api.me;
    const chip = button('', 'mechip', 'Change your name'); chip.appendChild(avatarNode(me));
    if (me.level) chip.appendChild(el('span', 'lvl', String(me.level)));
    chip.appendChild(el('span', 'nm', me.name || 'Guest'));
    if (chat.you && chat.you.away != null) chip.appendChild(el('span', 'away', 'away'));
    chip.onclick = () => { openDrawer('chat'); showNameBar(true); };
    headerEl.appendChild(chip);
    const x = button('✕', 'x'); x.setAttribute('aria-label', 'Close'); x.onclick = () => { closeDrawer(); launch.focus(); };
    headerEl.appendChild(x);
  }
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.textContent = '';
    const chatN = chat.unread.party + chat.unread.table + unreadW;
    [['chat', 'Chat', chatN], ['games', 'Games', 0], ['party', 'Party', 0]].forEach(([id, label, n]) => {
      const t = button(label, 'tab'); t.setAttribute('role', 'tab'); t.setAttribute('aria-selected', String(tab === id));
      if (n) t.appendChild(el('span', 'n', String(n)));
      if (id === 'party' && state.code) { const c = el('span', 'n cnt', String(state.members.filter((m) => m.online).length)); c.title = 'in the party, online'; t.appendChild(c); }
      t.onclick = () => { tab = id; ls.set(LS_TAB, tab); renderTabs(); renderTab(); };
      tabsEl.appendChild(t);
    });
  }
  function renderTab() {
    if (!bodyEl) return;
    clearInterval(browseTimer);
    bodyEl.textContent = ''; chipsEl = logEl = usersEl = inputEl = nameBarEl = null;
    if (tab === 'games') renderGames(); else if (tab === 'party') renderParty(); else renderChat();
  }

  // ---- Chat tab ----
  let chipsEl, logEl, usersEl, inputEl, nameBarEl, hintsEl, showUsers = false;
  const COMMANDS = [['/join', '<channel>', 'move to a channel'], ['/channels', '', 'list channels'], ['/who', '[channel]', 'who is here'], ['/whois', '<name>', 'where someone is'], ['/w', '<name> <msg>', 'whisper'], ['/r', '<msg>', 'reply to a whisper'], ['/me', '<action>', 'emote'], ['/p', '<msg>', 'say it to your party'], ['/t', '<msg>', 'say it to your table'], ['/invite', '<name>', 'invite to your party'], ['/away', '[msg]', 'toggle away'], ['/squelch', '<name>', 'stop seeing someone'], ['/unsquelch', '<name>', 'undo squelch'], ['/roll', '[max | min-max]', 'roll the dice'], ['/name', '<new name>', 'change your name'], ['/clear', '', 'clear this view'], ['/help', '', 'all commands']];
  function views() {
    const v = [{ id: 'general', cls: 'g', label: '#' + (chat.general.name || 'Arcade') }];
    if (state.code) v.push({ id: 'party', cls: 'p', label: 'Party' });
    if (chat.table.name) v.push({ id: 'table', cls: 't', label: 'Table' });
    return v;
  }
  function renderChat() {
    if (!views().some((v) => v.id === chat.view)) chat.view = 'general';
    chipsEl = el('div', 'chips'); chipsEl.setAttribute('role', 'toolbar'); chipsEl.setAttribute('aria-label', 'Channels'); bodyEl.appendChild(chipsEl);
    nameBarEl = el('div', 'namebar'); nameBarEl.hidden = true; bodyEl.appendChild(nameBarEl);
    const wrap = el('div', 'chatwrap'); bodyEl.appendChild(wrap);
    logEl = el('div', 'log'); logEl.setAttribute('role', 'log'); logEl.setAttribute('aria-live', 'polite'); wrap.appendChild(logEl);
    usersEl = el('div', 'users'); usersEl.hidden = !showUsers; wrap.appendChild(usersEl);
    const comp = el('div', 'compose'); bodyEl.appendChild(comp);
    hintsEl = el('div', 'hints'); hintsEl.hidden = true; comp.appendChild(hintsEl);
    inputEl = el('input', 'input'); inputEl.maxLength = 200; inputEl.setAttribute('aria-label', 'Message'); inputEl.autocomplete = 'off'; inputEl.spellcheck = true;
    const sendB = button('Send', 'btn');
    comp.appendChild(inputEl); comp.appendChild(sendB);
    inputEl.oninput = () => renderHints();
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'ArrowUp' && chat.sent.length && (!inputEl.value || chat.sentAt >= 0)) { e.preventDefault(); chat.sentAt = chat.sentAt < 0 ? chat.sent.length - 1 : Math.max(0, chat.sentAt - 1); inputEl.value = chat.sent[chat.sentAt]; }
      else if (e.key === 'ArrowDown' && chat.sentAt >= 0) { e.preventDefault(); chat.sentAt++; if (chat.sentAt >= chat.sent.length) { chat.sentAt = -1; inputEl.value = ''; } else inputEl.value = chat.sent[chat.sentAt]; }
      else if (e.key === 'Tab' && inputEl.value.startsWith('/') && !inputEl.value.includes(' ')) { const m = COMMANDS.find((c) => c[0].startsWith(inputEl.value.toLowerCase())); if (m) { e.preventDefault(); inputEl.value = m[0] + ' '; renderHints(); } }
      else if (e.key === 'Escape') { if (inputEl.value) { inputEl.value = ''; renderHints(); } else { closeDrawer(); launch.focus(); } }
    };
    sendB.onclick = submit;
    renderChips(); renderLog(); renderUsers(); renderPlaceholder();
    if (!profile.name || profile.name === 'Guest') showNameBar(false);
    setTimeout(() => inputEl && inputEl.focus(), 0);
  }
  function renderPlaceholder() {
    if (!inputEl) return;
    const v = views().find((x) => x.id === chat.view);
    inputEl.placeholder = !state.connected ? 'Connecting to the arcade…' : 'Message ' + (chat.view === 'general' ? v.label : chat.view === 'party' ? 'your party' : 'your table') + '  ·  / for commands';
  }
  function showNameBar(focus) {
    if (!nameBarEl) return;
    nameBarEl.hidden = false; nameBarEl.textContent = '';
    const lab = el('span', 'note', 'Your name');
    const inp = el('input', 'input grow'); inp.maxLength = 20; inp.value = profile.name && profile.name !== 'Guest' ? profile.name : ''; inp.placeholder = 'What should people call you?'; inp.setAttribute('aria-label', 'Your name');
    const save = button('Save', 'btn small');
    const done = () => { const n = inp.value.trim(); if (!n) return; api.setProfile({ name: n }); emit('me', api.me); nameBarEl.hidden = true; renderHeader(); inputEl && inputEl.focus(); };
    save.onclick = done; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') { nameBarEl.hidden = true; } };
    nameBarEl.appendChild(lab); nameBarEl.appendChild(inp); nameBarEl.appendChild(save);
    if (focus) setTimeout(() => inp.focus(), 0);
  }
  function renderChips() {
    if (!chipsEl) return;
    chipsEl.textContent = '';
    views().forEach((v) => {
      const c = button('', 'chip ' + v.cls); c.setAttribute('aria-pressed', String(chat.view === v.id));
      if (v.id !== 'general') c.appendChild(el('span', 'dotc'));
      c.appendChild(document.createTextNode(v.label));
      const n = chat.unread[v.id]; if (n && chat.view !== v.id) c.appendChild(el('span', 'n', n > 99 ? '99+' : String(n)));
      if (v.id === 'table' && chat.table.title) c.title = chat.table.title;
      c.onclick = () => { chat.view = v.id; ls.set(LS_VIEW, v.id); chat.unread[v.id] = 0; renderChips(); renderLog(); renderUsers(); renderPlaceholder(); renderTabs(); renderLauncher(); inputEl && inputEl.focus(); };
      chipsEl.appendChild(c);
    });
    const list = usersFor(chat.view);
    const w = button('👥 ' + list.filter((u) => u.online !== false).length, 'chip who', 'Who is here'); w.setAttribute('aria-pressed', String(showUsers));
    w.onclick = () => { showUsers = !showUsers; renderChips(); renderUsers(); };
    chipsEl.appendChild(w);
    chat.unread[chat.view] = 0; unreadW = 0;
  }
  function usersFor(view) {
    if (view === 'party') return state.members.map((m) => ({ id: m.id, name: m.name, game: m.game, level: m.level, online: m.online, host: m.host }));
    if (view === 'table') return chat.table.users;
    return chat.general.users;
  }
  function renderUsers() {
    if (!usersEl) return;
    usersEl.hidden = !showUsers; if (!showUsers) return;
    usersEl.textContent = '';
    const list = usersFor(chat.view);
    const title = chat.view === 'general' ? '#' + chat.general.name : chat.view === 'party' ? 'Party' : chat.table.title || 'Table';
    usersEl.appendChild(el('div', 'sec', title + ' · ' + list.length));
    list.forEach((u) => {
      const b = button('', 'u' + (u.online === false ? ' off' : '')); b.title = gameName(u.game) + (u.away ? ' · away' : '') + ' · click to whisper';
      b.appendChild(el('span', 'gi', gameIcon(u.game)));
      if (u.level) b.appendChild(el('span', 'lvl', String(u.level)));
      b.appendChild(el('span', 'nm', displayName(u) + (u.id === member ? ' (you)' : '') + (u.host ? ' ♛' : '')));
      if (u.away) b.appendChild(el('span', 'aw', 'away'));
      b.onclick = () => { if (u.id !== member) prefill('/w ' + whisperName(u) + ' '); };
      usersEl.appendChild(b);
    });
  }
  const displayName = (u) => (u.dup && u.tag ? u.name + '#' + u.tag : u.name);
  const whisperName = (u) => (u.dup && u.tag ? u.name + '#' + u.tag : u.name);
  function prefill(text) { if (!inputEl) return; inputEl.value = text; inputEl.focus(); renderHints(); }
  function renderLog() {
    if (!logEl) return;
    logEl.textContent = '';
    const lines = viewLines(chat.view);
    if (!lines.length) logEl.appendChild(lineNode({ kind: 'sys', text: chat.view === 'general' ? 'Welcome to #' + chat.general.name + '. Say hi, or type /help.' : chat.view === 'party' ? 'Party chat. Only the party sees this.' : 'Table chat. Only people at this table see this.', ts: Date.now() }));
    lines.forEach((l) => logEl.appendChild(lineNode(l)));
    logEl.scrollTop = logEl.scrollHeight;
  }
  function appendLine(l) {
    if (!logEl) return;
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.appendChild(lineNode(l));
    while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
    if (atBottom || (l.from && l.from.id === member) || l.kind === 'wto' || l.ch === 'info') logEl.scrollTop = logEl.scrollHeight;
  }
  function whoNode(u, text) { const w = el('span', 'who', text); w.title = 'Whisper ' + u.name; w.onclick = () => { if (u.id !== member) prefill('/w ' + whisperName(u) + ' '); }; return w; }
  function lineNode(l) {
    const d = el('div', 'ln ' + (l.kind || 'say') + (l.from && l.from.id === member ? ' me' : ''));
    d.appendChild(el('span', 'ts', hhmm(l.ts)));
    const f = l.from;
    if (l.kind === 'say' && f) { d.appendChild(document.createTextNode('<')); d.appendChild(whoNode(f, displayName(f))); d.appendChild(document.createTextNode('> ' + l.text)); }
    else if (l.kind === 'emote' && f) { d.appendChild(document.createTextNode('<')); d.appendChild(whoNode(f, displayName(f))); d.appendChild(document.createTextNode(' ' + l.text + '>')); }
    else if (l.kind === 'roll' && f) { d.appendChild(whoNode(f, displayName(f))); d.appendChild(document.createTextNode(' ' + l.text)); }
    else if (l.kind === 'wfrom' && f) { d.appendChild(document.createTextNode('<From: ')); d.appendChild(whoNode(f, displayName(f))); d.appendChild(document.createTextNode('> ' + l.text)); }
    else if (l.kind === 'wto' && l.to) { d.appendChild(document.createTextNode('<To: ')); d.appendChild(whoNode(l.to, displayName(l.to))); d.appendChild(document.createTextNode('> ' + l.text)); }
    else if (l.kind === 'invite' && f) {
      d.appendChild(document.createTextNode(l.text));
      if (l.party && l.party !== state.code) { const j = button('Join party', 'btn small act'); j.onclick = () => { api.join(l.party).then(() => { toast('You joined ' + f.name + "'s party."); }).catch(() => {}); }; d.appendChild(j); }
    }
    else d.appendChild(document.createTextNode(l.text));
    return d;
  }
  function renderHints() {
    if (!hintsEl || !inputEl) return;
    const v = inputEl.value;
    if (!v.startsWith('/') || v.includes(' ')) { hintsEl.hidden = true; return; }
    const list = COMMANDS.filter((c) => c[0].startsWith(v.toLowerCase()));
    if (!list.length) { hintsEl.hidden = true; return; }
    hintsEl.hidden = false; hintsEl.textContent = '';
    list.forEach((c) => { const h = button('', 'hint'); h.appendChild(el('b', '', c[0] + ' ')); h.appendChild(document.createTextNode((c[1] ? c[1] + '  ' : '') + '· ' + c[2])); h.onclick = () => { inputEl.value = c[0] + ' '; inputEl.focus(); renderHints(); }; hintsEl.appendChild(h); });
  }
  function submit() {
    if (!inputEl) return;
    const text = inputEl.value.trim(); if (!text) return;
    chat.sent.push(text); if (chat.sent.length > 30) chat.sent.shift(); chat.sentAt = -1;
    const cmd = text.split(' ')[0].toLowerCase();
    if (cmd === '/clear' || cmd === '/cls') {
      if (chat.view === 'party') state.chat = []; else chat[chat.view].lines = [];
      chat.personal = []; inputEl.value = ''; renderHints(); renderLog(); return;
    }
    if (!state.connected) { toast('Still connecting to the arcade.'); return; }
    if ((cmd === '/name' || cmd === '/nick') && text.split(' ').slice(1).join(' ').trim()) { profile.name = text.split(' ').slice(1).join(' ').trim().slice(0, 20); ls.set(LS_PROFILE, JSON.stringify({ name: profile.name, avatar: profile.avatar })); }
    send({ t: 'say', ch: chat.view, text });
    inputEl.value = ''; renderHints();
  }

  // ---- Games tab: everything open across the arcade (GET <hub>/api/browser) + every game ----
  let browseData = null, browseTimer = 0, browseAt = 0;
  function loadBrowse(force) {
    if (!force && Date.now() - browseAt < 4000) return Promise.resolve(browseData);
    return fetch(HUB + '/api/browser', { mode: 'cors' }).then((r) => (r.ok ? r.json() : null)).then((d) => { browseData = d; browseAt = Date.now(); if (open && tab === 'games') renderOpenNow(); return d; }).catch(() => { browseData = null; browseAt = Date.now(); if (open && tab === 'games') renderOpenNow(); return null; });
  }
  let openNowEl = null;
  function renderGames() {
    const sc = el('div', 'scroll'); bodyEl.appendChild(sc);
    const host = api.isHost;
    if (state.code) sc.appendChild(el('div', 'note', host ? 'You are the host: Bring party takes everyone. Go alone takes just you.' : ((state.members.find((m) => m.id === state.host) || {}).name || 'The host') + ' picks where the party goes. Join takes just you.'));
    const s1 = el('div', 'sec', 'Open now'); const rf = button('Refresh', 'btn ghost small r'); rf.onclick = () => loadBrowse(true); s1.appendChild(rf); sc.appendChild(s1);
    openNowEl = el('div'); openNowEl.style.display = 'grid'; openNowEl.style.gridTemplateColumns = 'minmax(0,1fr)'; openNowEl.style.gap = '6px'; sc.appendChild(openNowEl);
    renderOpenNow(); loadBrowse(false);
    browseTimer = setInterval(() => { if (open && tab === 'games') loadBrowse(true); else clearInterval(browseTimer); }, 8000);
    const n = state.members.filter((m) => m.online).length || 1;
    CATALOG.genres.forEach((genre) => {
      const games = CATALOG.games.filter((g) => g.genre === genre.id); if (!games.length) return;
      const gd = el('div', 'genre');
      gd.appendChild(el('div', 'sec', genre.name));
      if (genre.blurb) gd.appendChild(el('div', 'blurb', genre.blurb));
      const tiles = el('div', 'tiles');
      games.forEach((g) => tiles.appendChild(tile(g, host, n)));
      gd.appendChild(tiles); sc.appendChild(gd);
    });
  }
  function tile(g, host, n) {
    const here = state.venue && state.venue.game === g.id;
    let why = '';
    if (host) { if (n > g.max) why = 'Too many for ' + g.name + ' (' + g.max + ' max)'; else if (n < g.min && !g.hub) why = 'Needs ' + g.min + ' players'; }
    const t = host ? el('div', 'tile') : el('a', 'tile');
    t.appendChild(el('span', 'gi', g.icon || '🎮'));
    t.appendChild(el('span', 'n', g.name));
    t.appendChild(el('span', 'p', players(g) + (host && n < g.min && g.hub ? ' · bots fill in' : '')));
    if (here) { t.classList.add('here'); t.appendChild(el('span', 'herel', 'THE PARTY IS HERE')); }
    if (!host) { t.href = urlFor(g.id); t.title = 'Play ' + g.name; t.onclick = (e) => { e.preventDefault(); go(t.href); }; return t; }
    if (why) t.appendChild(el('span', 'why', why));
    const ta = el('div', 'ta');
    const bring = button('Bring party', 'btn small' + (why ? ' dis' : '')); bring.onclick = () => { if (api.goto(g.id)) { tab = 'party'; renderTabs(); renderTab(); } };
    const alone = button('Go alone', 'btn ghost small'); alone.onclick = () => go(urlFor(g.id));
    ta.appendChild(bring); ta.appendChild(alone); t.appendChild(ta);
    return t;
  }
  function renderOpenNow() {
    if (!openNowEl) return;
    openNowEl.textContent = '';
    const d = browseData, host = api.isHost;
    if (!d) { openNowEl.appendChild(el('div', 'muted', browseAt ? 'The arcade is not answering right now.' : 'Looking around the arcade…')); return; }
    const parties = (d.parties || []).filter((x) => x.code !== state.code);
    const games = (d.games || []).filter((g) => g.rooms.length);
    const down = (d.games || []).filter((g) => !g.ok).map((g) => g.name);
    parties.forEach((x) => {
      const r = el('div', 'brow'); r.appendChild(el('span', 'gi', '♣'));
      const info = el('div', 'info'); info.appendChild(el('div', 'nm', x.name));
      const wh = el('div', 'wh'); wh.appendChild(el('span', 'st party', 'PARTY')); wh.appendChild(document.createTextNode(x.online + ' online' + (x.venue ? ' · at ' + x.venue.gameName : ''))); info.appendChild(wh); r.appendChild(info);
      const acts = el('div', 'acts'); const j = el('a', 'btn small', 'Join party'); j.href = withParty(HUB + '/?party=' + x.code, { code: x.code }); j.onclick = (e) => { e.preventDefault(); if (state.code && !confirm('Leave your party and join ' + x.name + '?')) return; go(j.href); }; acts.appendChild(j); r.appendChild(acts);
      openNowEl.appendChild(r);
    });
    games.forEach((g) => g.rooms.forEach((rm) => {
      const r = el('div', 'brow'); r.appendChild(el('span', 'gi', g.icon || gameIcon(g.id)));
      const info = el('div', 'info'); info.appendChild(el('div', 'nm', rm.name));
      const full = !rm.free;
      const wh = el('div', 'wh'); wh.appendChild(el('span', 'st ' + (full ? 'full' : rm.status === 'lobby' ? 'waiting' : 'playing'), full ? 'FULL' : rm.status === 'lobby' ? 'WAITING' : 'PLAYING'));
      const who = rm.players && rm.players.length ? rm.players.join(', ') : rm.humans + (rm.humans === 1 ? ' player' : ' players');
      wh.appendChild(document.createTextNode(g.name + ' · ' + who + ' · ' + rm.humans + '/' + rm.seats + (rm.spectators ? ' · ' + rm.spectators + ' watching' : '') + (rm.looking ? ' · looking for players' : '')));
      wh.title = wh.textContent; info.appendChild(wh); r.appendChild(info);
      const acts = el('div', 'acts');
      // a Clubhouse table lives on the hub this dock talks to (the server's HUB_URL may be the public address)
      const url = withParty(rm.hub ? HUB + '/?game=' + encodeURIComponent(g.id) + '&table=' + encodeURIComponent(rm.id) : rm.url || urlFor(g.id, { room: rm.id }));
      if (host) {
        const b = button('Bring party', 'btn small'); b.onclick = () => { if (api.goto(g.id, { room: rm.id })) { tab = 'party'; renderTabs(); renderTab(); } }; acts.appendChild(b);
        const a = el('a', 'btn ghost small', full ? 'Watch' : 'Go alone'); a.href = url; a.onclick = (e) => { e.preventDefault(); go(url); }; acts.appendChild(a);
      } else {
        const a = el('a', 'btn small' + (full ? ' ghost' : ''), full ? 'Watch' : 'Join'); a.href = url; a.onclick = (e) => { e.preventDefault(); go(url); }; acts.appendChild(a);
      }
      r.appendChild(acts); openNowEl.appendChild(r);
    }));
    if (!parties.length && !games.length) openNowEl.appendChild(el('div', 'muted', 'Nothing open right now. Play something below and it shows up here.'));
    if (down.length) openNowEl.appendChild(el('div', 'muted', (down.length === 1 ? down[0] + " isn't" : down.slice(0, -1).join(', ') + ' and ' + down[down.length - 1] + " aren't") + ' answering.'));
  }

  // ---- Party tab ----
  function renderParty() {
    const sc = el('div', 'scroll'); bodyEl.appendChild(sc);
    if (!state.code) {
      const h = el('div', 'hero'); h.appendChild(el('h3', '', 'Play together')); h.appendChild(el('p', '', 'A party is a group that moves together: ' + gameName(GAME) + ' now, Go Fish or Poker Night later. One code, everywhere in the arcade.'));
      sc.appendChild(h);
      const start = button('Start a party', 'btn'); start.style.alignSelf = 'flex-start';
      start.onclick = () => { api.create({ name: profile.name || 'Guest', avatar: profile.avatar || null }).then(() => renderTab()).catch(() => {}); };
      sc.appendChild(start);
      sc.appendChild(el('div', 'sec', 'Have a code?'));
      const jr = el('div', 'row');
      const code = el('input', 'input mono'); code.placeholder = 'CODE'; code.maxLength = 6; code.style.width = '130px'; code.setAttribute('aria-label', 'Party code'); code.autocapitalize = 'characters';
      const join = button('Join party', 'btn ghost');
      const doJoin = () => { const c = cleanCode(code.value); if (c.length !== 6) { toast('A party code is 6 letters and numbers.'); return; } api.join(c).then(() => renderTab()).catch(() => {}); };
      join.onclick = doJoin; code.onkeydown = (e) => { if (e.key === 'Enter') doJoin(); };
      jr.appendChild(code); jr.appendChild(join); sc.appendChild(jr);
      if (!state.connected) sc.appendChild(el('div', 'muted', 'Connecting to the arcade…'));
      return;
    }
    const me = state.members.find((m) => m.id === member) || {};
    const hostM = state.members.find((m) => m.id === state.host) || {};
    const cb = el('div', 'codebox'); const c = el('span', 'code', state.code); c.title = 'Party code'; cb.appendChild(c);
    const copy = button('Copy invite link', 'btn ghost small');
    copy.onclick = () => { const link = inviteUrl(); const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy invite link'; }, 1600); }; if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => prompt('Copy this link:', link)); else prompt('Copy this link:', link); };
    cb.appendChild(copy); sc.appendChild(cb);
    if (state.venue) { const v = state.venue; sc.appendChild(el('div', 'note', gameIcon(v.game) + '  The party is at ' + gameName(v.game) + (v.room && !isHere(v) ? ' (' + v.room + ')' : '') + '.')); }
    sc.appendChild(el('div', 'sec', state.members.length + (state.members.length === 1 ? ' member' : ' members')));
    const list = el('div'); list.style.display = 'grid'; list.style.gap = '6px'; list.setAttribute('role', 'list');
    state.members.forEach((m) => {
      const r = el('div', 'mem' + (m.online ? '' : ' off')); r.setAttribute('role', 'listitem');
      r.appendChild(avatarNode(m));
      const info = el('div', 'info'); const nm = el('div', 'nm');
      if (m.level) nm.appendChild(el('span', 'lvl', String(m.level)));
      nm.appendChild(el('span', '', m.name + (m.id === member ? ' (you)' : '')));
      if (m.host) { const cr = el('span', 'crown', '♛'); cr.title = 'Host'; nm.appendChild(cr); }
      info.appendChild(nm); if (m.title) info.appendChild(el('div', 'ttl', m.title)); info.appendChild(el('div', 'wh', whereText(m)));
      r.appendChild(info); r.appendChild(el('span', 'dot')); list.appendChild(r);
    });
    sc.appendChild(list);
    const mv = el('div', 'row');
    if (me.host) { const b = button('Bring party', 'btn'); b.title = 'Pick a game or an open table; everyone follows'; b.onclick = () => { tab = 'games'; renderTabs(); renderTab(); }; mv.appendChild(b); }
    else mv.appendChild(el('span', 'note', (hostM.name || 'The host') + ' picks where the party goes.'));
    const pc = button('Party chat', 'btn ghost'); pc.onclick = () => { chat.view = 'party'; openDrawer('chat'); }; mv.appendChild(pc);
    sc.appendChild(mv);
    if (me.host) {
      const t = el('label', 'toggle'); const cbx = el('input'); cbx.type = 'checkbox'; cbx.checked = !!state.public; cbx.onchange = () => send({ t: 'public', on: cbx.checked });
      t.appendChild(cbx); t.appendChild(document.createTextNode('List publicly: anyone can find and join this party in Games'));
      sc.appendChild(t);
    } else if (state.public) sc.appendChild(el('div', 'muted', 'This party is listed publicly.'));
    sc.appendChild(el('div', 'muted', 'Invite anyone online from chat: /invite Name. Or send the link.'));
    const lv = button('Leave party', 'btn quiet'); lv.style.alignSelf = 'flex-start'; lv.onclick = () => { if (confirm('Leave the party?')) api.leave(); };
    sc.appendChild(lv);
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
    get me() { const m = state.members.find((x) => x.id === member); return { id: member, name: (m && m.name) || profile.name || (chat.you && chat.you.name) || null, avatar: m ? m.avatar : profile.avatar || null, level: m ? m.level : profile.level || null, title: m ? m.title : null }; },
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
    leave() { if (!state.code) return; send({ t: 'leave' }); ls.set(LS_CODE, null); wantCode = null; state.code = null; state.members = []; state.venue = null; state.chat = []; state.host = null; if (chat.view === 'party') chat.view = 'general'; hideBanner(); render(); if (open) renderTab(); emit('party', snapshot()); },
    goto(gameId, opts) { opts = opts || {}; const g = entry(gameId); if (!g) { toast('Unknown game'); return false; } if (!api.isHost) { toast('Only the host can bring the party'); return false; } return send({ t: 'goto', game: gameId, url: urlFor(gameId, { bare: true }), room: opts.room || undefined }); },
    setWhere(w) { w = w || {}; const msg = {}; ['room', 'status', 'game'].forEach((k) => { if (k in w) { msg[k] = w[k] == null ? null : String(w[k]); state.where[k] = msg[k]; } }); send({ t: 'where', ...msg }); },
    setProfile(p) { p = p || {}; profile = { ...profile, ...p }; ls.set(LS_PROFILE, JSON.stringify({ name: profile.name, avatar: profile.avatar })); if (!send({ t: 'profile', name: profile.name, avatar: profile.avatar || null, level: profile.level, title: profile.title })) profileDirty = true; else if (!state.code) profileDirty = true; render(); },
    setInventory(items) { state.localInventory = Array.isArray(items) ? items.slice() : []; if (state.code) send({ t: 'inventory', items: state.localInventory }); },
    setGuard(fn) { guard = typeof fn === 'function' ? fn : () => ''; },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); }; },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    urlFor, isHere, open: (t) => openDrawer(t), close: closeDrawer, toast,
  };
  window.PhattParty = api;

  // ---- boot ----
  function boot() {
    build();
    fetch(HUB + '/api/catalog', { mode: 'cors' }).then((r) => (r.ok ? r.json() : null)).then((c) => { if (c && Array.isArray(c.games) && c.games.length) { CATALOG = c; if (open && tab === 'games') renderTab(); } }).catch(() => {});
    if (!wantCode) { hadSnapshot = true; resolveReady(api); }
    // A surface that has never seen me (no name on this origin yet) asks the hub who I am before saying hello: a hello
    // without a name introduces me as Guest and the party forgets the name and avatar I carried from the last game.
    if (profile.name || freshMember || !wantCode) connect();
    else fetch(HUB + '/api/party/' + wantCode + '/member/' + member, { mode: 'cors' }).then((r) => (r.ok ? r.json() : null)).then((m) => { if (m && m.name && m.name !== 'Guest') profile = { ...profile, name: m.name, avatar: m.avatar || null }; }).catch(() => {}).then(connect);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
