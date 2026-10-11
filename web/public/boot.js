// CS Party browser client boot: download game data, start Xash3D (WebAssembly), join the server,
// and look after the connection: overlays for joining and for losing the server, plus a watchdog
// for map changes that stall.
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (t, err) => { $("status").textContent = t; $("status").className = err ? "err" : ""; console.log("[boot] " + t); };
  // join-page steps: 1 Download, 2 Unpack, 3 Start (the connect step has the overlay's own spinner)
  const phase = (n) => { const ol = $("phases"); ol.hidden = !n; for (const li of ol.children) { const k = +li.dataset.p; li.className = k < n ? "done" : k === n ? "on" : ""; } };
  const bar = (f) => { $("bar").style.width = Math.round(f * 100) + "%"; };
  const MB = (n) => (n / 1048576).toFixed(0);

  try { const n = localStorage.getItem("csp_name"); if (n) $("name").value = n; } catch {}
  const params = new URLSearchParams(location.search);
  const ROOT = "/xash";   // not "/": the engine strips trailing slashes and "/" becomes an empty base dir
  // party key from the invite link (?key=...), passed on to the protected game data and game socket
  const keyQuery = params.get("key") ? "?key=" + encodeURIComponent(params.get("key")) : "";

  // keyboard and mouse game; say so up front on phones and tablets instead of after a 44 MB download
  const TOUCH = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;
  if (TOUCH) { $("touch").hidden = false; document.documentElement.classList.add("touch"); }
  // Graphics: phones get the low profile (?gfx=low / ?gfx=high to override). r_scene_scale renders the
  // 3D scene at a fraction of the screen and upscales; the HUD stays sharp.
  const GFX = params.get("gfx") || (TOUCH ? "low" : "high");
  // Lighting: a model (player, pawn, viewmodel) takes only the light of the floor under it, and Xash3D has no
  // ambient minimum (r_lighting_ambient does nothing), so in dust2's tunnels and dark rooms players were black
  // shapes. lightgamma 1.8 (the engine's lowest; default 2.5) about doubles dark light for models and world
  // alike and adds ~7% in the sun. Measured against brightness 2-3, gamma, direct, gl_overbright: less lift for
  // the same wash-out, or none. ?lightgamma=2.5 restores the stock look.
  const GFX_ARGS = ["+lightgamma", params.get("lightgamma") || "1.8", ...(GFX === "low"
    ? ["+r_scene_scale", "0.6", "+gl_texture_lodbias", "1", "+r_detailtextures", "0", "+gl_msaa", "0", "+r_shadows", "0", "+r_decals", "32", "+fps_max", "60"]
    : [])];
  // Touch: Xash3D's own on-screen controls (move stick, look, jump, use, fire, duck, numbers)
  // _csp_touch tells the server to move the CS Party HUD out from under the right-hand buttons
  // HUD size. Engine hud_scale (?hud=900) made glyphs render as white boxes and blacked out textures in
  // the WebGL build (confirmed by A/B on 2026-10-02), so it's opt-in only. The engine's text-only scale
  // (hud_fontscale) renders clean, so text is 1.5x by default (Alex, 2026-10-03); ?font=1 restores it.
  const FONT_SCALE = params.get("font") || "1.5";
  // con_notifytime 0: no console lines at the top left. The server's music cues (echo CSP_MUSIC_*), cvar
  // chatter, AMXX's "Type 'amx_help'..." and the like printed there; Module.print below still gets every line,
  // and chat has its own HUD at the bottom left. ?notify=N brings them back for debugging.
  // scr_conspeed: the console snaps shut instead of sliding up over the first second of every new map
  const HUD_ARGS = [...(params.get("hud") ? ["+hud_scale", params.get("hud")] : []),
    "+hud_fontscale", FONT_SCALE, "+con_notifytime", params.get("notify") || "0", "+scr_conspeed", "100000"];
  const TOUCH_ARGS = TOUCH || params.has("touch") ? ["+touch_enable", "1", "+setinfo", "_csp_touch", "1"] : [];

  // engine pieces that live next to the page; written into the engine's filesystem before start
  const LIBS = {
    "filesystem_stdio.so": "filesystem_stdio.so",
    "libref_gles3compat.so": "libref_gles3compat.so",
    "libmenu.so": "libmenu.so",
    "cstrike/cl_dlls/client_emscripten_wasm32.so": "client_emscripten_wasm32.so",
    "cstrike/cl_dlls/menu_emscripten_wasm32.so": "menu_emscripten_wasm32.so",
    "cstrike/dlls/cs_emscripten_wasm32.so": "cs_emscripten_wasm32.so",   // empty stub: browsers never host
    "vgui.so": "vgui_stub.so",                                             // empty stub: no VGUI1 in the browser
    "valve/extras.pk3": "extras_engine.pk3",       // Xash3D's own: console fonts, FiraSans for the menus
    "cstrike/extras.pk3": "extras_cs16.pk3",       // cs16-client's menu art and touch layouts (trimmed)
  };
  const ENGINE_V = "2";   // bump when any of these files changes (2: menu module's own gpGlobals)

  // ------------------------------------------------------------------ game data (cached in the browser)
  const CACHE = "csp-gamedata-v1";
  const GAMEDATA_V = "0.5.28";   // bump with every new gamedata.zip
  async function gameData() {
    // v= changes the URL whenever the game data changes, so no cache in between can hand out an old copy
    const url = "gamedata.zip" + (keyQuery ? keyQuery + "&" : "?") + "v=" + GAMEDATA_V;
    const head = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (head.status === 403) throw new Error("This server needs a party key. Use the full invite link.");
    if (!head.ok) throw new Error(`Game data: HTTP ${head.status}`);
    const etag = head.headers.get("ETag");
    // Cache Storage only exists on https:// and localhost pages; plain-http LAN hosts fall back to the HTTP cache
    const cache = self.caches ? await caches.open(CACHE).catch(() => null) : null;
    const cacheKey = new URL("gamedata.zip", location.href).href;
    if (cache && etag) {
      const hit = await cache.match(cacheKey);
      if (hit && hit.headers.get("ETag") === etag) { status("Using saved game data…"); bar(0.8); return new Uint8Array(await hit.arrayBuffer()); }
    }
    // revalidate: the browser's HTTP cache may hold an older zip than the one the HEAD just described
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Game data: HTTP ${res.status}`);
    const gotTag = res.headers.get("ETag") || etag;
    const total = +res.headers.get("Content-Length") || 0;
    let data;
    if (!res.body || !total) data = new Uint8Array(await res.arrayBuffer());
    else {
      data = new Uint8Array(total); let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        data.set(value, got); got += value.length;
        bar(got / total * 0.8); status(`Downloading game data… ${MB(got)} of ${MB(total)} MB`);
      }
    }
    if (cache && etag) {
      try {
        for (const k of await cache.keys()) await cache.delete(k);
        await cache.put(cacheKey, new Response(new Blob([data]), { headers: { ETag: gotTag, "Content-Type": "application/zip" } }));
      } catch (e) { console.warn("[boot] couldn't save game data", e); }   // quota: fine, next visit downloads again
    }
    return data;
  }

  // one worker, synchronous unzip: ~6 s for the game data, and the page stays responsive.
  // (fflate's async unzip spawns a worker per file, which locks the page up on 5,000+ files.)
  function unzipInWorker(zip) {
    const src = `importScripts(${JSON.stringify(new URL("fflate.js", location.href).href)});
      onmessage = (e) => { try { const f = fflate.unzipSync(new Uint8Array(e.data));
        postMessage({ files: f }, Object.values(f).map((a) => a.buffer)); } catch (err) { postMessage({ error: String(err) }); } };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    return new Promise((ok, bad) => {
      w.onmessage = (e) => { w.terminate(); e.data.error ? bad(new Error(e.data.error)) : ok(e.data.files); };
      w.onerror = (e) => { w.terminate(); bad(new Error(e.message || "unzip failed")); };
      w.postMessage(zip.buffer, [zip.buffer]);
    });
  }

  function mkdirp(FS, dir) {
    let cur = "";
    for (const part of dir.split("/").filter(Boolean)) { cur += "/" + part; try { FS.mkdir(cur); } catch {} }
  }

  // ------------------------------------------------------------------ race map packs
  // Race pool maps aren't in gamedata.zip: each comes as its own small pack, mappacks/<map>.zip (tools/race_map.py).
  // The plugin names the map at the minigame intro (CSP_MAP_<map>), several seconds before the map change, so it's
  // in the file system when the engine loads it. A pack that fails leaves the engine's own download as the fallback.
  const mapPacks = new Map();   // map -> "loading" | "ok"
  async function fetchMapPack(map) {
    if (!engine || mapPacks.has(map)) return;
    try { engine.FS.stat(`${ROOT}/cstrike/maps/${map}.bsp`); mapPacks.set(map, "ok"); return; } catch {}   // in gamedata.zip
    mapPacks.set(map, "loading");
    try {
      const r = await fetch(`mappacks/${encodeURIComponent(map)}.zip${keyQuery}`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const files = await unzipInWorker(new Uint8Array(await r.arrayBuffer()));
      let n = 0;
      for (const [p, data] of Object.entries(files)) {
        if (p.endsWith("/")) continue;
        mkdirp(engine.FS, ROOT + "/" + p.split("/").slice(0, -1).join("/"));
        engine.FS.writeFile(ROOT + "/" + p, data, { canOwn: true }); n++;
      }
      mapPacks.set(map, "ok");
      console.log(`[boot] map pack ${map}: ${n} files`);
    } catch (e) { mapPacks.delete(map); console.warn(`[boot] map pack ${map}:`, e); }
  }

  // ------------------------------------------------------------------ overlays
  const overlay = (title, text, { rejoin = false, spin = false } = {}) => {
    $("ov-title").textContent = title; $("ov-text").textContent = text || "";
    $("ov-rejoin").hidden = !rejoin; $("ov-spin").hidden = !spin;
    $("ov-note").hidden = true; $("ov-start").hidden = true; clearInterval(rejoinTimer);
    $("overlay").hidden = false; $("pause").hidden = true;
    if (rejoin && document.pointerLockElement) document.exitPointerLock();
  };
  const hideOverlay = () => { $("overlay").hidden = true; };
  let toastTimer = 0;
  const toast = (t, ms = 0) => {
    $("toast").textContent = t; $("toast").hidden = !t;
    clearTimeout(toastTimer); if (t && ms) toastTimer = setTimeout(() => { $("toast").hidden = true; }, ms);
  };
  $("fs").addEventListener("click", async () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      await screen.orientation?.lock?.("landscape").catch(() => {});   // Android; iPhone Safari has neither: home-screen app instead
      await navigator.keyboard?.lock?.().catch(() => {});   // Chrome/Edge: in fullscreen, Ctrl+W and friends go to the game
    } catch {}
    $("canvas").focus();
  });
  // Chrome/Edge hand Ctrl+W and friends to the page only while the keyboard is locked, and only in fullscreen
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) navigator.keyboard?.lock?.().catch(() => {});
    else navigator.keyboard?.unlock?.();
  });
  let fsTimer = 0;
  addEventListener("mousemove", () => {
    if (!$("gate").hidden || document.pointerLockElement) return;
    $("fs").classList.add("show"); clearTimeout(fsTimer); fsTimer = setTimeout(() => $("fs").classList.remove("show"), 2500);
  });

  // ------------------------------------------------------------------ connection watch
  // Engine states (connstate_t): 0 disconnected, 1 connecting, 2 connected, 3 loading/validating, 4 in game.
  const watch = {
    state: -1, joined: false, since: performance.now(), lastRx: performance.now(), lastTick: performance.now(),
    retried: 0, reason: "", sockets: new Set(), gaveUp: false, firstJoinDeadline: 0,
  };
  let engine = null;
  // "chat" or "console" while the engine has the keyboard for typing (see the Esc menu below)
  let typing = "";
  const consoleCmd = (c) => {
    if (!engine || !engine._Cbuf_AddText) return;
    const p = engine.stringToNewUTF8(c + "\n"); engine._Cbuf_AddText(p); engine._free(p);
    console.log("[watch] console: " + c);
  };
  // What each way of losing the party means for the player, and whether the page can fix it by itself.
  // auto: seconds until the page rejoins on its own (a reload that submits the join form; max 5 tries in a row).
  const LOST = {
    restart: { title: "Server restarting", help: "Your seat is held for a minute.", auto: 8 },
    drop: { title: "Connection lost", help: "Your seat is held for a minute.", auto: 6 },
    full: { title: "The party is full", help: "All four seats are taken. Spectating isn't open yet.", auto: 20 },
    key: { title: "Invite link needed", help: "Ask whoever invited you for the full link.", auto: 0 },
    cap: { title: "Too many tabs", help: "Close your other CS Party tabs, then rejoin.", auto: 0 },
    "": { title: "Lost the party", help: "", auto: 8 },
  };
  let rejoinTimer = 0;
  const lost = (why, kind = "") => {
    if (watch.gaveUp) return; watch.gaveUp = true;
    toast(""); $("loading").hidden = true;
    const k = LOST[kind] || LOST[""];
    let tries = 0; try { tries = +sessionStorage.getItem("csp_rj_n") || 0; } catch {}
    const auto = tries < 5 ? k.auto : 0;
    overlay(k.title, [why || "The connection to the game server stopped.", k.help].filter(Boolean).join(" "), { rejoin: true, spin: !!auto });
    $("ov-rejoin").textContent = auto ? "Rejoin now" : "Rejoin";
    $("ov-start").hidden = false;
    if (auto) {
      let left = auto; const note = $("ov-note"); note.hidden = false;
      const tick = () => {
        note.textContent = `Rejoining in ${left} s…`;
        if (left-- <= 0) { clearInterval(rejoinTimer); try { sessionStorage.setItem("csp_rj_n", String(tries + 1)); } catch {} leave(true); }
      };
      tick(); rejoinTimer = setInterval(tick, 1000);
    }
  };
  // Minigame index (the plugin's MG_*) -> how-to card, shown over the loading screen while the map loads
  const HOWTO = {
    8: "HOW TO SURF\n- Land on the side of a ramp, not the top.\n- Hold A or D toward the ramp.\n- Never press W. Turn the mouse to steer.\n- Fall off and you restart this stage.",
    9: "HOW TO BHOP\n- Hold JUMP. You hop again every time you land.\n- Steer in the air with A / D and the mouse.\n- Don't hold W while in the air.\n- Lava sends you back to the last checkpoint.",
    10: "HOW TO CLIMB\n- Ladders: look up and hold W. Jump off with JUMP.\n- High ledges: JUMP, then hold DUCK in the air.\n- Beams are narrow: walk, don't run (hold SHIFT).\n- Fall and you go back to the last checkpoint.",
    11: "HOW TO MAZE\n- Find the way out. First one out wins.\n- The walls are too tall to jump.\n- Dead ends are common: turn back early.\n- Don't follow the player in front of you.",
  };
  let howto = "";

  // Tips: tips.json is the one catalog (the plugin's in-game HUD tips are generated from it by tools/gen_tips.py).
  // They rotate under the progress bar and on the map-change loading screen.
  let tipList = [], tipQueue = [], tipEl = null, tipTimer = 0;
  const tipDevice = () => TOUCH ? "touch" : ([...(navigator.getGamepads?.() || [])].some(Boolean) ? "pad" : "kbd");
  const tipNext = () => {
    if (!tipEl || !tipList.length) return;
    if (!tipQueue.length) {
      const dev = tipDevice();
      tipQueue = tipList.filter((t) => !t.dev || t.dev === dev).map((t) => t.text).sort(() => Math.random() - 0.5);
    }
    const b = document.createElement("b"); b.textContent = "TIP";
    tipEl.replaceChildren(b, tipQueue.pop());
    tipEl.hidden = false;
  };
  const tipStart = (el) => {
    if (tipEl === el) return;
    tipStop(); tipEl = el; tipNext();
    tipTimer = setInterval(tipNext, 7000);
  };
  const tipStop = () => { clearInterval(tipTimer); if (tipEl) tipEl.hidden = true; tipEl = null; };
  fetch("tips.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : { tips: [] }).catch(() => ({ tips: [] }))
    .then((j) => { tipList = j.tips || []; if (tipEl) tipNext(); });
  tipStart($("boot-tip"));

  const onState = (st) => {
    const prev = watch.state; watch.state = st; watch.since = performance.now(); typing = "";
    console.log(`[watch] state ${prev} -> ${st}`);
    // the engine draws its console full screen while it connects and loads; the loading screen covers it
    $("loading").hidden = !(st >= 1 && st <= 3) || watch.gaveUp;
    // after a stall-retry the wait is for the server, not the next map: say so
    $("loading-text").textContent = watch.retried > 0 && st < 4 ? "Reconnecting to the party… your seat is held." : "Loading the next map…";
    const hc = $("loading-howto"); hc.textContent = howto; hc.hidden = !howto;
    // the first join shows the "Joining the party" card over the loading screen, so the tip goes in the card then
    if (!$("loading").hidden) tipStart($($("overlay").hidden ? "loading-tip" : "ov-tip")); else if (tipEl === $("loading-tip") || tipEl === $("ov-tip")) tipStop();
    if (st === 4) howto = "";
    if (st === 4) { try { sessionStorage.removeItem("csp_rj_n"); } catch {} }
    if (st === 4) {
      watch.retried = 0; watch.lastRx = performance.now();
      if (watch.gaveUp) { watch.gaveUp = false; hideOverlay(); $("canvas").focus(); }   // a slow join or a retry made it after all
      if (!watch.joined) { watch.joined = true; tipStop(); hideOverlay(); $("canvas").focus(); applySettings(); readSettings(); padGame(); if (TOUCH) { consoleCmd("touch_removebutton chat"); consoleCmd("hud_saytext_time 0"); } voiceStart($("name").value.trim().slice(0, 31)); }
      toast("");
      return;
    }
    if (!watch.joined) {
      $("ov-text").textContent = st === 1 ? "Connecting to the server…" : st >= 2 ? "Loading the map…" : "Starting…";
      return;
    }
    if (st === 0) lost(watch.reason || "Disconnected from the game server.", /kick|ban/i.test(watch.reason) ? "" : "drop");
  };
  // Any message in, on any of the engine's sockets, counts as the server being there.
  const REFUSED = {
    4001: "The party key was refused.",
    4003: "No free seats right now.",
    4029: "Too many players are already connected from your network.",
  };
  const REFUSED_KIND = { 4001: "key", 4003: "full", 4029: "cap" };
  const NativeWS = window.WebSocket;
  class WatchedWS extends NativeWS {
    constructor(...a) {
      super(...a);
      watch.sockets.add(this);
      this.addEventListener("message", () => { watch.lastRx = performance.now(); });
      this.addEventListener("close", (e) => {
        watch.sockets.delete(this);
        console.log(`[watch] relay socket closed (${e.code} ${e.reason || ""})`);
        // the relay turns a refused connection into a close code, so the reason can be told apart
        // fatal while joining, or when it was the last socket; an extra socket refused mid-game isn't the party ending
        if (REFUSED[e.code] && (!watch.joined || watch.sockets.size === 0)) lost(REFUSED[e.code], REFUSED_KIND[e.code]);
        else if (e.code === 1006 && !watch.joined && performance.now() - watch.since < 3000) {
          lost(keyQuery ? "The party key was refused, or the relay is full." : "The relay refused the connection. The link may need a party key.", keyQuery ? "full" : "key");
        } else if (watch.sockets.size === 0 && watch.state !== 0) e.code === 1001 ? lost("The party server is restarting.", "restart") : lost("The connection to the party server dropped.", "drop");
      });
    }
  }
  setInterval(() => {
    const now = performance.now(), prevTick = watch.lastTick;
    const blocked = now - watch.lastTick > 3000;   // the engine held the main thread (map load): can't judge silence
    watch.lastTick = now;
    if (blocked) {
      watch.lastRx = now; watch.since += now - prevTick;
      if (watch.firstJoinDeadline) watch.firstJoinDeadline += now - prevTick;
      return;
    }   // a frozen main thread is the engine loading, not a stall
    if (watch.gaveUp) return;
    if (!watch.joined) {
      if (watch.firstJoinDeadline && now > watch.firstJoinDeadline) lost("Couldn't join the game server. It may be down or full.", "full");
      return;
    }
    const quiet = (now - watch.lastRx) / 1000, inState = (now - watch.since) / 1000;
    // In game but nothing from the server: a map change the client never heard about (seen with slow
    // clients: it sits on the old map while the server waits). "retry" reconnects to the same server; the
    // server holds the seat for 60 s and hands it back by name.
    const stalledInGame = watch.state === 4 && quiet > 15;
    const stalledLoading = watch.state >= 1 && watch.state <= 3 && inState > 45 && quiet > 15;   // slow is fine; silent isn't
    if ((stalledInGame || stalledLoading) && watch.retried < 2 && (now - (watch.retriedAt || 0)) / 1000 > 20) {
      watch.retried++; watch.retriedAt = now;
      toast("Reconnecting…");
      consoleCmd("retry");
    } else if (watch.retried >= 2 && (now - watch.retriedAt) / 1000 > 30 && (stalledInGame || stalledLoading)) {
      lost("The game server stopped answering.", "drop");
    }
  }, 1000);

  // ------------------------------------------------------------------ menu (Esc)
  // The engine's own Esc menu is Half-Life's (Training, Save/Load, Readme...) and its mouse doesn't work
  // in the browser build. Esc, or losing the mouse capture, opens this one instead; the engine never sees Esc.
  const pause = $("pause");
  const SETTINGS = { sensitivity: 3, volume: 0.7 };
  let savedSettings = {};
  try { savedSettings = JSON.parse(localStorage.getItem("csp_settings") || "{}"); Object.assign(SETTINGS, savedSettings); } catch {}
  function applySettings() { for (const k of Object.keys(savedSettings)) consoleCmd(`${k} ${SETTINGS[k]}`); }   // only what the player changed
  // The sliders show what the engine really has (its config, or a console change). host_writeconfig saves
  // config.cfg into the in-memory filesystem without a word on screen (asking for a cvar prints it top-left),
  // and the next frame or so the values are read back from there.
  const sliders = {};
  const readSettings = () => {
    consoleCmd("host_writeconfig");
    setTimeout(() => {
      let cfg = ""; try { cfg = engine.FS.readFile(ROOT + "/cstrike/config.cfg", { encoding: "utf8" }); } catch { return; }
      for (const k of Object.keys(sliders)) {
        const v = +(new RegExp(`^${k} "([-\\d.]+)"`, "m").exec(cfg)?.[1] ?? NaN);
        if (Number.isFinite(v)) { SETTINGS[k] = v; sliders[k](); }
      }
    }, 400);
  };
  const slider = (id, key, fmt) => {
    const el = $(id), out = $(id + "-v");
    (sliders[key] = () => { el.value = SETTINGS[key]; out.textContent = fmt(SETTINGS[key]); })();
    el.addEventListener("input", () => {
      SETTINGS[key] = +el.value; savedSettings[key] = +el.value; out.textContent = fmt(+el.value);
      consoleCmd(`${key} ${el.value}`);
      try { localStorage.setItem("csp_settings", JSON.stringify(savedSettings)); } catch {}
    });
  };
  slider("pz-sens", "sensitivity", (v) => v.toFixed(1));
  slider("pz-vol", "volume", (v) => Math.round(v * 100) + "%");

  // ------------------------------------------------------------------ music
  // The theme plays on the join screen (10% by default) and again when a match ends: the plugin echoes
  // CSP_THEME_PLAY into each client's console at the winner banner, CSP_THEME_STOP when the next match starts.
  // The board tracks play while the board is up (CSP_MUSIC_BOARD) and fade out for minigames (CSP_MUSIC_OFF),
  // alternating, same volume and mute. Plain <audio>, separate from the engine's sound. Browsers only allow
  // sound after a click or key press, so if the first play() is refused, the first interaction starts it.
  const music = { el: new Audio("audio/cs-party-theme.mp3"), vol: 0.1, muted: false, want: false, fade: 0 };
  music.el.preload = "auto";
  try { Object.assign(music, JSON.parse(localStorage.getItem("csp_music") || "{}")); } catch {}
  const BOARD_TRACKS = ["audio/board-server-hum.mp3", "audio/board-crt-arpeggios.mp3"];
  const board = { el: new Audio(), want: false, fade: 0, i: Math.floor(Math.random() * BOARD_TRACKS.length) };
  board.el.preload = "none";
  const musicSave = () => { try { localStorage.setItem("csp_music", JSON.stringify({ vol: music.vol, muted: music.muted })); } catch {} };
  const chanSync = (c) => {
    clearInterval(c.fade); c.el.volume = music.vol;
    if (!c.want || music.muted || !music.vol) c.el.pause();
    else c.el.play().catch(() => {});   // refused until the first interaction; musicKick retries
  };
  const musicSync = () => {
    for (const id of ["music-vol", "pz-music"]) { $(id).value = music.vol; $(id + "-v").textContent = Math.round(music.vol * 100) + "%"; }
    $("music").classList.toggle("muted", music.muted);
    $("music-mute").setAttribute("aria-pressed", String(music.muted));
    $("music-mute").setAttribute("aria-label", music.muted ? "Unmute music" : "Mute music");
    chanSync(music); chanSync(board);
  };
  const fadeOut = (c, ms) => {   // fade out, then pause
    c.want = false; clearInterval(c.fade);
    const step = c.el.volume / (ms / 50);
    c.fade = setInterval(() => {
      if (c.el.volume <= step) { clearInterval(c.fade); c.el.pause(); c.el.volume = music.vol; return; }
      c.el.volume -= step;
    }, 50);
  };
  const fadeIn = (c, ms) => {   // after play(); if it was refused, musicKick starts it at full volume
    if (c.el.paused) return;
    const step = music.vol / (ms / 50); c.el.volume = 0;
    c.fade = setInterval(() => {
      if (c.el.volume + step >= music.vol) { clearInterval(c.fade); c.el.volume = music.vol; return; }
      c.el.volume += step;
    }, 50);
  };
  const musicPlay = (fromStart) => {   // join screen: loop; match end: play the song through once
    if (board.want) fadeOut(board, 1500);
    music.want = true; music.el.loop = !fromStart; if (fromStart) music.el.currentTime = 0; chanSync(music);
  };
  const musicStop = (ms = 1500) => { clearTimeout(menuTimer); menuTimer = 0; fadeOut(music, ms); };
  // Each time the board comes up, a board track starts at a random point (not in its last minute) and
  // fades in; near the end it fades out and the other track fades in from its own random point.
  const boardCue = (i) => {
    board.i = i; board.el.src = BOARD_TRACKS[i]; board.cue = true;
    board.el.addEventListener("loadedmetadata", () => {
      const d = board.el.duration; if (d > 90) board.el.currentTime = Math.random() * (d - 60);
    }, { once: true });
  };
  const boardPlay = () => {
    if (board.want) return;
    if (music.want) musicStop();
    if (!board.el.src || board.el.ended) boardCue(board.i); else if (board.el.duration > 90) board.el.currentTime = Math.random() * (board.el.duration - 60);
    board.want = true; board.cue = false; chanSync(board); fadeIn(board, 3000);
  };
  const boardNext = () => {
    boardCue((board.i + 1) % BOARD_TRACKS.length);
    if (board.want) { board.cue = false; chanSync(board); fadeIn(board, 3000); }
  };
  board.el.addEventListener("timeupdate", () => {
    const left = board.el.duration - board.el.currentTime;
    if (!board.want || board.cue || !(left < 4)) return;
    board.cue = true; clearInterval(board.fade);   // fade out over the last 3 s, then switch
    const step = board.el.volume / 60;
    board.fade = setInterval(() => {
      if (board.el.volume > step) { board.el.volume -= step; return; }
      clearInterval(board.fade); boardNext();
    }, 50);
  });
  board.el.addEventListener("ended", () => { clearInterval(board.fade); if (board.want) boardNext(); });
  // Join screen: the page gets about 20 s to itself before the theme fades in. Touching the music
  // controls (volume, unmute) starts it straight away.
  const MENU_DELAY = 20000;
  let menuTimer = setTimeout(() => {
    menuTimer = 0; if ($("gate").hidden || music.want) return;
    musicPlay(false); fadeIn(music, 3000);
  }, MENU_DELAY);
  const menuNow = () => { if (menuTimer && !$("gate").hidden) { clearTimeout(menuTimer); menuTimer = 0; music.want = true; music.el.loop = true; } };
  for (const id of ["music-vol", "pz-music"]) $(id).addEventListener("input", (e) => {
    music.vol = +e.target.value; if (music.vol > 0) music.muted = false; menuNow(); musicSave(); musicSync();
  });
  $("music-mute").addEventListener("click", () => { music.muted = !music.muted; if (!music.muted) menuNow(); musicSave(); musicSync(); });
  const musicKick = (e) => {
    if (e.target?.closest?.("#music")) return;   // the mute button decides for itself
    if (!music.muted && ((music.want && music.el.paused) || (board.want && board.el.paused))) musicSync();
  };
  for (const t of ["pointerdown", "keydown", "touchstart"]) addEventListener(t, musicKick, true);
  addEventListener("gamepadconnected", musicKick);
  // Which controls the menu explains: the device used last (touch screen, controller, or keyboard and mouse).
  let lastInput = TOUCH ? "touch" : "kbd";
  const padNow = () => [...(realPads?.() || [])].find(Boolean);
  const seen = (d) => { if (d === lastInput) return; lastInput = d; if (!pause.hidden) showDevice(); };
  addEventListener("pointerdown", (e) => seen(e.pointerType === "touch" ? "touch" : e.pointerType === "mouse" ? "kbd" : lastInput), true);
  addEventListener("keydown", () => seen("kbd"), true);
  const padActive = (p) => p.buttons.some((x, i) => i !== 8 && i !== 9 && x.pressed) || p.axes.some((v) => Math.abs(v) > 0.6);
  const showDevice = () => {
    const dev = lastInput;
    pause.dataset.dev = dev;
    for (const el of pause.querySelectorAll("[data-dev]")) el.hidden = !el.dataset.dev.split(" ").includes(dev);
  };
  const inGame = () => engine && watch.state === 4 && $("overlay").hidden && $("gate").hidden;
  const openPause = () => {
    if (!pause.hidden || !inGame()) return;
    if (padNow()?.buttons.some((x, i) => (i === 8 || i === 9) && x.pressed)) lastInput = "pad";   // opened with Start/Back
    showDevice(); pause.hidden = false; $("pz-resume").focus();
    pauseAt = performance.now(); padPrev = null; leaveArm(false); readSettings();
    if (document.pointerLockElement) document.exitPointerLock();
    padLoop();
  };
  const closePause = (fromClick) => {
    if (pause.hidden) return;
    pause.hidden = true; $("canvas").focus();
    gamePrev = true;   // a Start/Back press that closed the menu mustn't reopen it from padGame
    // the A or B press that closed the menu is still down: the game would read it as a fresh jump/use
    // (picking a turn-menu item, or "Keep the money"). Hide whatever is held until it's let go.
    const pad = [...(realPads?.() || [])].find(Boolean);
    padHeld = new Set(); stickHeld = new Set();
    if (pad) {
      pad.buttons.forEach((b, i) => { if (b.pressed) padHeld.add(i); });
      pad.axes.forEach((v, i) => { if (Math.abs(v) > 0.3) stickHeld.add(i); });
    }
    // a click may take the mouse straight back; a key press isn't allowed to
    const r = fromClick ? $("canvas").requestPointerLock?.() : null;
    if (!fromClick) toast("Click the game to take the mouse back.", 3000);
    else r?.catch?.(() => toast("Click the game to take the mouse back.", 3000));
  };
  $("pz-resume").addEventListener("click", () => closePause(true));
  $("pz-fs").addEventListener("click", () => $("fs").click());
  // ------------------------------------------------------------------ touch menu buttons (PHA-4121)
  // Phones have no number keys, and sliding a thumb to cycle the cursor proved too fiddly. While one of the
  // server's menus is up, the plugin echoes its real items (CSP_NAV_I lines, then _END) to touch players only,
  // and the page draws one button per usable item, plus up / down / OK / Back. A tap sends ONE console command
  // ("csp_nav pick <seq> <item>"): no key is ever held, so nothing can stick, repeat or outlive a lost touch.
  // <seq> names the menu the player saw; once it is answered or replaced the server ignores a late tap.
  const navpad = $("navpad"), navRows = $("nav-rows");
  const nav = { seq: 0, usable: 0, quiet: 0, items: [], pos: 0, back: -1, stage: null, used: 0, usedTimer: 0, down: new Map() };
  const navClose = () => { nav.seq = 0; nav.items = []; nav.stage = null; nav.used = 0; navDraw(); };
  const navLine = (t) => {
    let m;
    if ((m = /CSP_NAV_I\|(\d+)\|(\d+)\|([01])\|(.*)$/.exec(t))) {
      if (!nav.stage || nav.stage.seq !== +m[1]) nav.stage = { seq: +m[1], items: [] };
      nav.stage.items[+m[2]] = { i: +m[2], ok: m[3] === "1", label: m[4].trim() };
    } else if ((m = /CSP_NAV_END\|(\d+)\|(\d+)\|(-?\d+)\|(-?\d+)/.exec(t))) {
      if (!nav.stage || nav.stage.seq !== +m[1]) return;
      nav.seq = +m[1]; nav.items = Array.from({ length: +m[2] }, (_, i) => nav.stage.items[i]).filter(Boolean);
      nav.pos = +m[3]; nav.back = +m[4]; nav.stage = null; nav.used = 0; navDraw();
    } else if ((m = /CSP_NAV_POS\|(\d+)\|(\d+)/.exec(t))) {
      if (+m[1] === nav.seq) { nav.pos = +m[2]; navMark(); }
    } else if (t.includes("CSP_NAV_CLOSE")) navClose();
  };
  const navMark = () => { for (const b of navRows.children) b.classList.toggle("cur", +b.dataset.i === nav.pos); };
  const navBtn = (cls, num, label, act, args) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = cls; b.dataset.act = act; if (args !== undefined) b.dataset.i = args;
    if (num) { const n = document.createElement("b"); n.textContent = num; b.append(n); }
    const sp = document.createElement("span"); sp.textContent = label; b.append(sp);
    return b;
  };
  // shown only while a menu is up in the game itself: the Esc menu, join and lost-connection cards cover or replace it
  function navShow() { const on = !!nav.seq && !!nav.usable && inGame() && pause.hidden; if (!on && !navpad.hidden) navRelease(); navpad.hidden = !on; }
  function navDraw() {
    navRows.replaceChildren(); nav.down.clear();
    // every item keeps its real number; greyed ones (can't afford it, not now) stay on the pad, dimmed and untappable, so the
    // shop still reads as a price list. A plain Back/Done/Never mind is the Back button's job.
    const backItem = nav.items.find((it) => it.i === nav.back), plainBack = !!backItem && /^(back|done|never mind)$/i.test(backItem.label);
    const shown = nav.items.filter((it) => it.label && it.label !== "-" && !(plainBack && it.i === nav.back)), usable = shown.filter((it) => it.ok);
    const backBtn = $("nav-ctl").querySelector('[data-act="back"]');
    backBtn.hidden = !backItem; backBtn.textContent = !backItem || plainBack ? "Back" : backItem.label;   // "Walk on", "Keep the money": the safe way out, under its own name
    nav.usable = usable.length + (backItem ? 1 : 0);
    navShow();
    if (navpad.hidden) return;
    const cols = shown.length > 4 ? 2 : 1;   // two columns keep a long list out of the chat lines at the bottom
    navRows.style.setProperty("--rows", Math.max(1, Math.ceil(shown.length / cols)));
    navRows.style.setProperty("--cols", cols);
    for (const it of shown) { const b = navBtn("opt", String(it.i + 1), it.label, "pick", it.i); b.disabled = !it.ok; navRows.append(b); }
    navMark();
  }
  const navDbg = (m) => { const l = (window.__navlog ||= []); l.push(Math.round(performance.now()) + " " + m); if (l.length > 60) l.shift(); };   // devtools / tests: what the pad did
  const navSend = (b) => {
    navDbg("send " + b.dataset.act + " " + (b.dataset.i ?? "") + " seq " + nav.seq);
    const act = b.dataset.act, seq = nav.seq;
    if (!seq || !inGame()) return;
    if (act === "up" || act === "down") { consoleCmd(`csp_nav ${act} ${seq}`); return; }
    if (nav.used === seq || performance.now() < nav.quiet) return;   // one answer per menu, and a beat before the next menu takes taps: a double tap can't pick twice
    nav.used = seq; nav.quiet = performance.now() + 450; clearTimeout(nav.usedTimer); nav.usedTimer = setTimeout(() => { if (nav.used === seq) nav.used = 0; }, 1500);   // no reply: let the player try again
    consoleCmd(act === "pick" ? `csp_nav pick ${seq} ${b.dataset.i}` : `csp_nav ${act} ${seq}`);
  };
  // A tap counts on release, over the button it began on. Everything that could lose the release (cancel, leaving the
  // button, focus loss, rotating, the tab hiding, another overlay opening) just forgets the press: nothing was sent.
  const navRelease = (ev) => { navDbg("release-all " + (ev?.type || "") + " held=" + nav.down.size); for (const b of nav.down.values()) b.classList.remove("down"); nav.down.clear(); };
  // Touches are followed by identifier (changedTouches carry the finger's own coordinates); a mouse, if one is ever used on the pad, goes by pointer events.
  const navEnd = (id, x, y, how) => {
    navDbg("end " + how + " " + Math.round(x) + "," + Math.round(y) + " " + (nav.down.has(id) ? "known" : "unknown"));
    const b = nav.down.get(id); if (!b) return;
    nav.down.delete(id); b.classList.remove("down");
    const over = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y)?.closest("button") : b;
    if (over === b) navSend(b);
  };
  navpad.addEventListener("touchstart", (e) => {
    for (const t of e.changedTouches) { const b = e.target.closest?.("button"); if (b && !b.disabled && !nav.down.has(t.identifier)) { nav.down.set(t.identifier, b); b.classList.add("down"); } }
  }, { passive: false });
  navpad.addEventListener("touchend", (e) => { for (const t of e.changedTouches) navEnd(t.identifier, t.clientX, t.clientY, "touchend"); });
  navpad.addEventListener("touchcancel", (e) => { for (const t of e.changedTouches) { nav.down.get(t.identifier)?.classList.remove("down"); nav.down.delete(t.identifier); } });
  navpad.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || TOUCH) return;   // on a touch screen a mouse-type press is Chrome's synthesized tap, aimed wherever the finger lands once the menu is up: never a pick
    const b = e.target.closest("button"); if (!b || b.disabled || nav.down.has("p" + e.pointerId)) return;
    nav.down.set("p" + e.pointerId, b); b.classList.add("down");
  });
  navpad.addEventListener("pointerup", (e) => { if (e.pointerType !== "touch" && !TOUCH) navEnd("p" + e.pointerId, e.clientX, e.clientY, "pointerup"); });
  navpad.addEventListener("pointercancel", (e) => { nav.down.get("p" + e.pointerId)?.classList.remove("down"); nav.down.delete("p" + e.pointerId); });
  for (const t of ["pointerdown", "pointerup", "pointermove", "pointercancel"]) navpad.addEventListener(t, (e) => e.stopPropagation());   // after the handlers above: they still run first
  // touches and mouse presses on the pad never reach the engine's own touch zones (stick, look)
  for (const t of ["touchstart", "touchmove", "touchend", "touchcancel", "mousedown", "mouseup", "click", "contextmenu"]) navpad.addEventListener(t, (e) => { e.stopPropagation(); e.preventDefault(); });
  for (const t of ["blur", "orientationchange", "pagehide", "resize"]) addEventListener(t, navRelease);
  document.addEventListener("visibilitychange", navRelease);
  setInterval(navShow, 200);

  // phones have no Esc: an on-screen button opens the menu (shown on touch screens only)
  $("pz-open").addEventListener("click", () => openPause());

  // Phone chat (PHA-4058). The engine's own chat HUD is ~8 px text and its on-screen keyboard is a second
  // system keyboard layered on the game, so on touch screens chat is DOM: a feed fed from the engine's
  // "<name> text" console lines, and a compose bar that rides above the soft keyboard and sends say / say_team.
  // While the bar is open, keys never reach the engine (window capture, below) and touches stay on the panel.
  const chat = { open: false, team: false, feed: $("chat-feed"), bar: $("chat-bar"), input: $("chat-input") };
  const CHAT_MAX = 6, CHAT_FADE = 9000;
  const chatLine = (raw) => {
    if (!TOUCH) return;
    // players print as "name : text" (the server's own say as "<name> text"); team chat adds a "(Terrorist)" style prefix
    const m = /^(?:\[[\d:]+\]\s*)?((?:\*DEAD\*|\*SPEC\*|\(Terrorist\)|\(Counter-Terrorist\)|\(Spectator\)|\s)*)(?:<(.{1,48}?)>|([^\s\[\]"<>:][^\[\]"<>:]{0,40}?) : )\s*(.+)$/.exec(raw.replace(/\^\d/g, "").replace(/Unknown command: \S+/, "").trimEnd());
    if (!m) return;
    const who = (m[2] || m[3]).replace(/^\(\d+\)/, "");
    const li = document.createElement("li"), name = document.createElement("b");
    name.textContent = who + ":";
    if (/Terrorist\)/.test(m[1]) || /Counter/.test(m[1])) li.className = "team";
    li.append(name, " " + m[4]);
    chat.feed.append(li);
    while (chat.feed.children.length > CHAT_MAX + (chat.open ? 20 : 0)) chat.feed.firstChild.remove();
    chat.feed.scrollTop = chat.feed.scrollHeight;
    setTimeout(() => li.classList.add("old"), CHAT_FADE);
  };
  // keep the bar on the visible area: on-screen keyboard height and the notch/home-bar insets
  const chatLayout = () => {
    const v = window.visualViewport;
    const kb = v ? Math.max(0, innerHeight - v.height - v.offsetTop) : 0;
    const root = document.documentElement.style;
    root.setProperty("--chat-kb", kb + "px");
    root.setProperty("--chat-vh", (v ? v.height : innerHeight) + "px");
    chat.feed.scrollTop = chat.feed.scrollHeight;
  };
  const chatSet = (open) => {
    chat.open = open; chat.bar.hidden = !open;
    document.documentElement.classList.toggle("chatting", open);
    if (open) { chatLayout(); chat.input.focus({ preventScroll: true }); if (document.pointerLockElement) document.exitPointerLock(); }
    else { chat.input.blur(); $("canvas").focus(); }
  };
  const chatMode = (team) => { chat.team = team; $("chat-mode").textContent = team ? "Team" : "All"; $("chat-mode").setAttribute("aria-pressed", team); };
  if (TOUCH) {
    window.visualViewport?.addEventListener("resize", chatLayout);
    window.visualViewport?.addEventListener("scroll", chatLayout);
    $("chat-open").addEventListener("click", () => chatSet(!chat.open));
    $("chat-close").addEventListener("click", () => chatSet(false));
    $("chat-mode").addEventListener("click", () => { chatMode(!chat.team); chat.input.focus({ preventScroll: true }); });
    // tapping a bar button must not drop the soft keyboard (the input keeps focus)
    for (const id of ["chat-mode", "chat-send"]) $(id).addEventListener("pointerdown", (e) => e.preventDefault());
    $("chat-bar").addEventListener("submit", (e) => {
      e.preventDefault();
      const t = chat.input.value.replace(/["\\;\r\n]+/g, " ").trim().slice(0, 120);
      if (t) consoleCmd(`${chat.team ? "say_team" : "say"} "${t}"`);
      chat.input.value = ""; chatSet(false);
    });
    // nothing typed or touched on the chat panels reaches the game
    for (const id of ["chat-bar", "chat-feed", "chat-open"]) for (const t of ["touchstart", "touchmove", "touchend", "pointerdown", "pointerup", "mousedown", "mouseup", "wheel"])
      $(id).addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    for (const t of ["keydown", "keyup", "keypress"]) addEventListener(t, (e) => {
      if (!chat.open) return;
      e.stopImmediatePropagation();
      if (t === "keydown" && e.key === "Escape") { e.preventDefault(); chatSet(false); }
    }, true);
  }
  // Mouse capture lost without the engine asking (Esc while captured, alt-tab): that's a pause.
  // The engine lets go itself on map changes and for its console; those go through exitPointerLock.
  // It also lets go whenever the keyboard leaves the game (chat, console, a menu with a mouse cursor).
  // In game, outside a map change and with our menu shut, that release means the player is typing,
  // and Esc then belongs to the engine (it closes chat and the console), not to our menu.
  let selfUnlock = 0, lastKey = "";
  const nativeExit = Document.prototype.exitPointerLock;
  Document.prototype.exitPointerLock = function () {
    selfUnlock = performance.now();
    if (inGame() && pause.hidden && selfUnlock - watch.since > 1500) typing = lastKey === "Backquote" ? "console" : "chat";
    return nativeExit.call(this);
  };
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement) { typing = ""; if (!pause.hidden) document.exitPointerLock(); return; }   // never captured behind the menu
    if (performance.now() - selfUnlock < 1000) return;
    openPause();
  });
  // Voice chat (PHA-4058): push-to-talk, browser to browser over WebRTC (a mesh; the party is at most 10).
  // The relay's /voice socket only introduces peers and forwards offers/answers/ICE; the audio never touches it.
  // Hold V (keyboard) or the mic button (touch) to talk. Each peer has a Mute button in the Esc menu.
  const voice = { ws: null, id: 0, peers: new Map(), mic: null, micAsk: null, talking: false, retry: 0, name: "", on: false, muted: new Set() };
  try { voice.muted = new Set(JSON.parse(localStorage.getItem("csp_vmute") || "[]")); } catch {}
  const STUN = [{ urls: "stun:stun.l.google.com:19302" }];
  const vsend = (o) => { if (voice.ws?.readyState === 1) voice.ws.send(JSON.stringify(o)); };
  const voiceRender = () => {
    const talkers = [...voice.peers.values()].filter((p) => p.talking).map((p) => p.name);
    if (voice.talking) talkers.unshift("You");
    $("voice-talk").textContent = talkers.length ? "\u{1F399} " + talkers.join(", ") : "";
    $("voice-talk").hidden = !talkers.length;
    const list = $("voice-list"); list.replaceChildren();
    for (const p of voice.peers.values()) {
      const row = document.createElement("div"), nm = document.createElement("span"), bt = document.createElement("button");
      nm.textContent = p.name + (p.state === "connected" ? "" : " …");
      bt.type = "button"; bt.className = "alt"; bt.textContent = voice.muted.has(p.name) ? "Unmute" : "Mute";
      bt.addEventListener("click", () => {
        voice.muted.has(p.name) ? voice.muted.delete(p.name) : voice.muted.add(p.name);
        p.audio.muted = voice.muted.has(p.name);
        try { localStorage.setItem("csp_vmute", JSON.stringify([...voice.muted])); } catch {}
        voiceRender();
      });
      row.append(nm, bt); list.append(row);
    }
    $("voice-box").hidden = !voice.on;
  };
  const voicePeerClose = (id) => {
    const p = voice.peers.get(id); if (!p) return;
    try { p.pc.close(); } catch {}
    p.audio.srcObject = null; p.audio.remove(); voice.peers.delete(id); voiceRender();
  };
  const voicePeer = (id, name, initiator) => {
    let p = voice.peers.get(id); if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: STUN });
    const audio = document.createElement("audio");
    audio.autoplay = true; audio.muted = voice.muted.has(name); audio.hidden = true; document.body.append(audio);
    p = { id, name, pc, audio, talking: false, state: "new", queue: [], sender: null };
    voice.peers.set(id, p);
    p.sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;   // the mic track is swapped in later, no renegotiation
    if (voice.mic) p.sender.replaceTrack(voice.mic).catch(() => {});
    pc.onicecandidate = (e) => { if (e.candidate) vsend({ t: "sig", to: id, data: { ice: e.candidate } }); };
    pc.ontrack = (e) => { audio.srcObject = new MediaStream([e.track]); audio.play().catch(() => {}); };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState; voiceRender();
      if (pc.connectionState === "failed" || pc.connectionState === "closed") voicePeerClose(id);
    };
    if (initiator) pc.onnegotiationneeded = async () => {
      try { await pc.setLocalDescription(await pc.createOffer()); vsend({ t: "sig", to: id, data: { sdp: pc.localDescription } }); } catch {}
    };
    voiceRender();
    return p;
  };
  const voiceSig = async (from, data) => {
    const p = voice.peers.get(from); if (!p) return;
    try {
      if (data.sdp) {
        await p.pc.setRemoteDescription(data.sdp);
        for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === "offer") { await p.pc.setLocalDescription(await p.pc.createAnswer()); vsend({ t: "sig", to: from, data: { sdp: p.pc.localDescription } }); }
      } else if (data.ice) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.ice).catch(() => {}); else p.queue.push(data.ice);
      }
    } catch {}
  };
  const voiceStart = (name) => {
    if (!window.RTCPeerConnection || voice.ws || !name) return;
    voice.name = name;
    const ws = new NativeWS(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice${keyQuery}`);
    voice.ws = ws;
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "welcome") {
        voice.id = m.id; voice.on = true; voice.retry = 0;
        vsend({ t: "hello", name: voice.name });
        for (const q of m.peers) voicePeer(q.id, q.name, true);   // the newcomer calls everyone already here
        voiceRender();
      } else if (m.t === "join") voicePeer(m.id, m.name, false);
      else if (m.t === "sig") voiceSig(m.from, m.data || {});
      else if (m.t === "talk") { const p = voice.peers.get(m.id); if (p) { p.talking = !!m.on; voiceRender(); } }
      else if (m.t === "leave") voicePeerClose(m.id);
    };
    ws.onclose = (e) => {
      voice.ws = null; voice.on = false;
      for (const id of [...voice.peers.keys()]) voicePeerClose(id);
      voiceRender();
      if (e.code >= 4000 || voice.retry > 5) return;   // refused (key, full): don't hammer
      setTimeout(() => voiceStart(voice.name), 2000 * ++voice.retry);
    };
  };
  const voiceMic = () => voice.micAsk || (voice.micAsk = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then((s) => {
    voice.mic = s.getAudioTracks()[0]; voice.mic.enabled = false;
    for (const p of voice.peers.values()) p.sender.replaceTrack(voice.mic).catch(() => {});
    return voice.mic;
  }).catch(() => { voice.micAsk = null; toast("Microphone blocked: allow it in the browser to talk.", 4000); return null; }));
  let pttWant = false;
  const voicePtt = async (on) => {
    pttWant = on;
    if (on && !voice.on) return;
    if (on && !voice.mic) { await voiceMic(); if (!pttWant) return; }
    if (!voice.mic || voice.talking === on) return;
    voice.mic.enabled = on; voice.talking = on; vsend({ t: "talk", on });
    $("mic").classList.toggle("live", on); voiceRender();
  };
  $("mic").addEventListener("pointerdown", (e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {} voicePtt(true); });
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) $("mic").addEventListener(t, () => voicePtt(false));
  $("mic").addEventListener("contextmenu", (e) => e.preventDefault());
  for (const t of ["touchstart", "touchmove", "touchend", "mousedown", "mouseup"]) $("mic").addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  addEventListener("keydown", (e) => { if (e.code === "KeyV" && !e.repeat && inGame() && !typing && pause.hidden && !chat.open && !e.ctrlKey && !e.metaKey && !e.altKey) voicePtt(true); }, true);
  addEventListener("keyup", (e) => { if (e.code === "KeyV") voicePtt(false); }, true);
  addEventListener("blur", () => voicePtt(false));
  // capture phase on window: runs before the engine's own key handler, so it can keep keys from it
  addEventListener("keydown", (e) => {
    if (!inGame()) return;
    lastKey = e.code;
    if (typing && pause.hidden) {   // the engine closes chat on Enter/Esc and its console on Esc/`
      if (e.key === "Escape" || (typing === "chat" ? e.key === "Enter" : e.code === "Backquote")) typing = "";
      return;
    }
    if (e.key === "Escape") {
      e.stopImmediatePropagation(); e.preventDefault();
      if (!e.repeat) pause.hidden ? openPause() : closePause(false);
      return;
    }
    if (pause.hidden) return;
    e.stopImmediatePropagation();   // menu open: keys work the menu, not the game
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveFocus(e.key === "ArrowDown" ? 1 : -1); }
  }, true);
  // Menu open: mouse buttons stay out of the engine. SDL keeps a pending "capture the mouse" request
  // (queued on map changes) that fires on the next mouseup anywhere, which would grab the mouse mid-menu.
  // Stopping propagation here leaves the menu's own clicks and slider drags alone (those are default actions).
  for (const t of ["mousedown", "mouseup"]) addEventListener(t, (e) => { if (!pause.hidden) e.stopPropagation(); }, true);
  const focusables = () => [...pause.querySelectorAll("button, input")].filter((el) => !el.closest("[hidden]"));
  const moveFocus = (d) => {
    const f = focusables(), i = f.indexOf(document.activeElement);
    const el = f[Math.max(0, Math.min(f.length - 1, i + d))];   // no wrap: Up from the top must not land on Leave
    el.focus(); el.scrollIntoView({ block: "nearest" });   // the menu scrolls on short screens: keep the focus in view
  };
  // controller: D-pad/stick to move, left/right for sliders, A to pick, B, Back or Start to go back
  let padPrev = {}, pauseAt = 0;
  // While the menu is open the engine sees every controller at rest (SDL polls navigator.getGamepads), so
  // D-pad and A work the menu without also moving, jumping or picking in the game.
  const realPads = navigator.getGamepads?.bind(navigator);
  // In game, Back and Start are ours too (they open this menu): the engine binds Back to "pause", which
  // would freeze the server for everyone.
  const UP = { pressed: false, touched: false, value: 0 };
  let padHeld = new Set(), stickHeld = new Set();
  if (realPads) navigator.getGamepads = () => {
    const pads = realPads();
    if (!engine) return pads;   // join screen
    const t = performance.now(), rest = !pause.hidden;
    return [...pads].map((p) => p && { id: p.id, index: p.index, mapping: p.mapping, connected: p.connected, timestamp: rest || padHeld.size || stickHeld.size ? t : p.timestamp,
      axes: p.axes.map((v, i) => {
        if (rest) return 0;
        if (stickHeld.has(i)) { if (Math.abs(v) > 0.3) return 0; stickHeld.delete(i); }
        return v;
      }),
      buttons: [...p.buttons].map((b, i) => {
        if (rest || i === 8 || i === 9) return UP;
        if (padHeld.has(i)) { if (b.pressed) return UP; padHeld.delete(i); }
        return b;
      }) });
  };
  // controller in game: Start or Back opens the menu
  let gamePrev = true;
  function padGame() {
    const pad = [...(realPads?.() || [])].find(Boolean);
    const down = !!pad && (!!pad.buttons[8]?.pressed || !!pad.buttons[9]?.pressed);
    if (pad && padActive(pad)) seen("pad");
    if (down && !gamePrev && pause.hidden) openPause();
    gamePrev = down;   // tracked while the menu is open too, so the press that closes it can't reopen it
    requestAnimationFrame(padGame);
  }
  function padLoop() {
    if (pause.hidden) { padPrev = {}; return; }
    const pad = [...(realPads?.() || [])].find(Boolean);
    if (pad) {
      const ax = pad.axes || [], btn = (i) => !!pad.buttons[i]?.pressed;
      if (padActive(pad) || btn(8) || btn(9)) seen("pad");
      const now = { up: btn(12) || ax[1] < -0.6, down: btn(13) || ax[1] > 0.6, left: btn(14) || ax[0] < -0.6, right: btn(15) || ax[0] > 0.6,
        a: btn(0), b: btn(1) || btn(8) || btn(9) };
      // the press that opened the menu (or one still held from the game) doesn't count
      if (!padPrev || performance.now() - pauseAt < 300) padPrev = now;
      const hit = (k) => now[k] && !padPrev[k];
      if (hit("down")) moveFocus(1);
      if (hit("up")) moveFocus(-1);
      const el = document.activeElement;
      if ((hit("left") || hit("right")) && el?.type === "range") {
        hit("right") ? el.stepUp() : el.stepDown(); el.dispatchEvent(new Event("input"));
      }
      if (hit("a") && el?.tagName === "BUTTON") el.click();
      if (hit("b")) closePause(false);
      padPrev = now;
    }
    requestAnimationFrame(padLoop);
  }

  // Closing the tab: say goodbye properly, so the server frees the slot now instead of holding a ghost
  // until it times out (and the seat-hold clock starts from the real moment you left).
  addEventListener("pagehide", () => { try { if (engine && watch.state >= 1) engine._CL_Disconnect(); } catch {} });
  // Ctrl is duck and W is forward, and Ctrl+W closes the tab (so do a mouse's back button and Ctrl+R).
  // Mid-match the browser asks first. Leave and Rejoin are on purpose and skip the question.
  let leaving = false;
  addEventListener("beforeunload", (e) => {
    if (leaving || !engine || watch.state < 1 || watch.gaveUp) return;
    e.preventDefault(); e.returnValue = "";
  });
  const leave = (rejoin) => {
    leaving = true; clearInterval(rejoinTimer);
    try { rejoin === true ? sessionStorage.setItem("csp_rejoin", "1") : sessionStorage.removeItem("csp_rejoin"); } catch {}
    location.reload();
  };
  $("ov-rejoin").addEventListener("click", () => leave(true));
  $("ov-start").addEventListener("click", () => { try { sessionStorage.removeItem("csp_rj_n"); } catch {} leave(false); });
  // Leave takes two presses, so a stray A/Enter/Space in the menu can't end your party
  let leaveTimer = 0;
  const leaveBtn = $("pz-leave"), leaveText = leaveBtn.textContent;
  function leaveArm(on) {
    clearTimeout(leaveTimer); leaveBtn.dataset.armed = on ? "1" : "";
    leaveBtn.textContent = on ? "Press again to leave" : leaveText;
    if (on) leaveTimer = setTimeout(() => leaveArm(false), 3000);
  }
  leaveBtn.addEventListener("click", () => { leaveBtn.dataset.armed ? leave(false) : leaveArm(true); });   // pagehide disconnects properly
  leaveBtn.addEventListener("blur", () => leaveArm(false));


  // ------------------------------------------------------------------ character select
  // Same order, names and dice as the plugin's SKIN_* tables. The pick rides along as setinfo _csp_char;
  // the server honours it at match start (first come, first served) and deals out the rest at random.
  const CHARS = [
    { n: "Phoenix Connexion", a: "PX",  c: "#e6603f", d: [1, 2, 3, 4, 5, 6], s: "The classic",           t: "The classic die. Anything from 1 to 6." },
    { n: "Elite Crew",        a: "L",   c: "#e3b52b", d: [0, 0, 3, 5, 6, 7], s: "High roller",           t: "Two blanks, but the big rolls go up to 7." },
    { n: "Arctic Avengers",   a: "AA",  c: "#a7d5e4", d: [2, 2, 3, 3, 5, 6], s: "Steady mover",          t: "Never rolls a 1. A safe, steady die." },
    { n: "Guerilla Warfare",  a: "GW",  c: "#9bad54", d: [1, 1, 1, 6, 6, 6], s: "All or nothing",        t: "All or nothing: a 1 or a 6." },
    { n: "SEAL Team 6",       a: "ST6", c: "#6b9fd4", d: [3, 3, 3, 4, 4, 4], s: "The planner",           t: "Always a 3 or a 4. Plan every move." },
    { n: "GSG-9",             a: "G9",  c: "#b5b9c1", d: [0, 2, 2, 5, 5, 7], s: "Wild card",             t: "Swingy: a blank, some 2s and 5s, one 7." },
    { n: "SAS",               a: "SAS", c: "#b98ad9", d: [1, 3, 3, 3, 5, 6], s: "Reliable with a twist", t: "Mostly 3s, with a shot at a 5 or 6." },
    { n: "GIGN",              a: "GN",  c: "#e2e2d4", d: [2, 2, 2, 2, 6, 7], s: "Slow, then go",         t: "Plods along at 2, then bursts for 6 or 7." },
  ];
  // portraits come from art/character-atlas.png: 4 columns (the order above) by 2 rows (T, CT)
  const atlas = (i) => `--atlas-x:${(i % 4) * 100 / 3}%;--atlas-y:${i < 4 ? 0 : 100}%`;
  const tile = (ch, i) =>
    `<label class="character-tile" style="--char-color:${ch.c}"><input type="radio" name="char" value="${i}" aria-label="${ch.n}, ${i < 4 ? "Terrorist" : "Counter-Terrorist"}, die ${ch.d.join(" ")}">` +
    `<span class="card-art" aria-hidden="true"><span class="portrait" style="display:block;${atlas(i)}"></span><span class="player-tag">P1</span></span>` +
    `<span class="card-caption"><span class="badge" aria-hidden="true">${ch.a}</span><span class="character-name">${ch.n}</span></span></label>`;
  const charGrid = $("char-grid");
  charGrid.innerHTML =
    `<div class="team-heading"><span>TERRORISTS</span><span class="team-line"></span><span class="team-short">T</span></div>` +
    `<div class="character-row">${CHARS.slice(0, 4).map((ch, i) => tile(ch, i)).join("")}</div>` +
    `<div class="team-heading ct"><span>COUNTER-TERRORISTS</span><span class="team-line"></span><span class="team-short">CT</span></div>` +
    `<div class="character-row">${CHARS.slice(4).map((ch, i) => tile(ch, i + 4)).join("")}</div>` +
    `<label class="random-tile"><input type="radio" name="char" value="-1" aria-label="Random character"><span class="random-icon" aria-hidden="true">?</span>` +
    `<span class="random-copy"><strong>Random</strong><span>Let the server pick.</span></span><span class="random-check" aria-hidden="true">P1</span></label>`;
  const radios = [...charGrid.querySelectorAll("input")];
  const pickedChar = () => +(charGrid.querySelector("input:checked")?.value ?? -1);
  const showChar = () => {
    const i = pickedChar(), ch = CHARS[i], detail = document.querySelector("#gate .detail");
    const faces = $("die-faces"); faces.replaceChildren();
    faces.hidden = !ch; document.querySelector("#gate .die-heading").hidden = !ch;
    $("preview-portrait").hidden = !ch; $("preview-random").hidden = !!ch;
    detail.style.setProperty("--char-color", ch ? ch.c : "#f4a331");
    $("preview-badge").textContent = ch ? ch.a : "?";
    $("detail-team").textContent = ch ? (i < 4 ? "T" : "CT") : "?";
    $("character-style").textContent = ch ? ch.s : "Leave it to chance";
    $("character-name").textContent = ch ? ch.n : "Random";
    $("character-summary").textContent = ch ? ch.t : "You get whoever's left when the match starts.";
    if (ch) {
      $("preview-portrait").setAttribute("style", atlas(i));
      for (const [k, v] of ch.d.entries()) {
        const f = document.createElement("span"); f.className = "die-face" + (v ? "" : " zero"); f.setAttribute("role", "listitem");
        f.setAttribute("aria-label", `Face ${k + 1}: ${v ? v : "blank, zero"}`); f.textContent = String(v); faces.append(f);
      }
    }
    $("char-info").textContent = ch ? `${ch.n} selected. Die faces ${ch.d.join(", ")}. ${ch.t}` : "Random selected. You get whoever's left when the match starts.";
  };
  let savedChar = -1;
  try { const c = localStorage.getItem("csp_char"); if (c !== null && CHARS[+c]) savedChar = +c; } catch {}
  if (params.has("char") && CHARS[+params.get("char")]) savedChar = +params.get("char");
  radios.find((r) => +r.value === savedChar).checked = true;
  showChar();
  charGrid.addEventListener("change", showChar);
  // grid moves for arrows and controllers: left/right steps, up/down jumps a row (radios only step in a line)
  const moveChar = (dx, dy) => {
    let i = pickedChar(); if (i < 0) i = dy < 0 ? 8 : -1;   // Random sits under the grid as slot 8
    let j = i;
    if (dx) j = i < 0 || i === 8 ? (dx > 0 ? 0 : 7) : (i + dx + 8) % 8;
    if (dy) j = i === -1 || i === 8 ? (dy > 0 ? 0 : 4) : (dy > 0 ? (i < 4 ? i + 4 : 8) : (i < 4 ? 8 : i - 4));
    const r = radios.find((x) => +x.value === (j === 8 ? -1 : j));
    r.checked = true; r.focus(); showChar();
  };
  charGrid.addEventListener("keydown", (e) => {
    const m = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (m) { e.preventDefault(); moveChar(...m); }
  });
  // ---- first-visit primer: 4 short cards before the download; remembered, skippable, and Join never waits on it
  const primer = $("primer");
  const JUMP = { kbd: "<b>Space</b>", pad: "<b>A</b>", touch: "the <b>Jump</b> button" };
  const CARDS = [
    ["Your turn", () => `On your turn, ${JUMP[padOrTouch()]} picks "Jump at the crate", then again to roll your character's die. The crate floats over your head. That is the whole turn: two presses.`],
    ["The spaces", () => `Land on a <b>blue</b> space to earn money, a <b>red</b> one to lose some, a <b>?</b> for a random event. Black Markets sell board items. Duel spaces start a fight.`],
    ["The minigames", () => `After everyone has moved, a minigame decides it: a real Counter-Strike round (bomb, pistols, knives) or a race (surf, bhop, maze). Space colours pick the teams. Survive a gear round and you keep your gear.`],
    ["Stars and money", () => `Your money is your CS cash. Reach the hostages and pay <b>$5,000</b> for a <b>star</b>. The hostages move after every rescue. Most stars wins. ${padOrTouch() === "touch" ? "" : `<b>${lastPadSeen ? "Y" : "Tab"}</b> shows the stars.`}`],
  ];
  let lastPadSeen = false, prIdx = 0;
  const padOrTouch = () => lastPadSeen ? "pad" : TOUCH ? "touch" : "kbd";
  const primerRender = () => {
    const [title, text] = CARDS[prIdx];
    $("pr-num").textContent = `STEP ${prIdx + 1} OF ${CARDS.length}`; $("pr-count").textContent = `${prIdx + 1} / ${CARDS.length}`;
    $("pr-title").textContent = title; $("pr-text").innerHTML = text();
    $("pr-dots").replaceChildren(...CARDS.map((_, i) => { const d = document.createElement("i"); if (i === prIdx) d.className = "on"; return d; }));
    $("pr-back").hidden = prIdx === 0;
    $("pr-next").textContent = prIdx === CARDS.length - 1 ? "Got it" : "Next";
    $("pr-skip").hidden = prIdx === CARDS.length - 1;
    $("pr-hint").textContent = lastPadSeen ? "A next, B skip" : TOUCH ? "" : "Enter next, Esc skip. Shows once; reopen it from the link under the title.";
  };
  const primerOpen = (at) => {
    prIdx = at | 0; primerRender(); primer.hidden = false; $("gate").inert = true; $("pr-next").focus();
  };
  const primerClose = () => {
    if (primer.hidden) return;
    primer.hidden = true; $("gate").inert = false;
    try { localStorage.setItem("csp_primer", "1"); } catch {}
    ($("name").value ? $("go") : $("name")).focus({ preventScroll: true });
  };
  const primerStep = (d) => { if (prIdx + d >= CARDS.length) return primerClose(); prIdx = Math.max(0, prIdx + d); primerRender(); };
  $("pr-next").addEventListener("click", () => primerStep(1));
  $("pr-back").addEventListener("click", () => primerStep(-1));
  $("pr-skip").addEventListener("click", primerClose);
  primer.addEventListener("pointerdown", (e) => { if (e.target === primer) primerClose(); });
  addEventListener("keydown", (e) => { if (!primer.hidden && e.key === "Escape") { e.preventDefault(); primerClose(); } }, true);
  $("how-link").addEventListener("click", () => primerOpen(0));
  { let seenBefore = false; try { seenBefore = localStorage.getItem("csp_primer") === "1"; } catch {}
    const q = params.get("primer");
    if (q === "1" || (q !== "0" && !seenBefore)) primerOpen(0); }

  // controller on the join screen: D-pad / stick picks, A joins (and drives the primer while it's up)
  let gPrev = {}, gRaf = 0;
  const padHint = (on) => {
    $("pad-hint").hidden = !on;
    const k = document.querySelector("#go .join-key"); k.classList.toggle("pad", on); k.textContent = on ? "A" : "\u21b5";
  };
  const padGate = () => {
    if ($("gate").hidden) return;
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (pad) {
      const b = (k) => !!pad.buttons[k]?.pressed, ax = pad.axes || [];
      const now = { l: b(14) || ax[0] < -0.6, r: b(15) || ax[0] > 0.6, u: b(12) || ax[1] < -0.6, d: b(13) || ax[1] > 0.6, a: b(0) };
      if (!lastPadSeen) { lastPadSeen = true; padHint(true); if (!primer.hidden) primerRender(); }
      if (!primer.hidden) {   // the primer owns the pad until it's closed
        if (now.r && !gPrev.r || now.a && !gPrev.a) primerStep(1);
        if (now.l && !gPrev.l) primerStep(-1);
        if (pad.buttons[1]?.pressed && !gPrev.b) primerClose();
        gPrev = { ...now, b: !!pad.buttons[1]?.pressed }; gRaf = requestAnimationFrame(padGate); return;
      }
      if (now.l && !gPrev.l) moveChar(-1, 0);
      if (now.r && !gPrev.r) moveChar(1, 0);
      if (now.u && !gPrev.u) moveChar(0, -1);
      if (now.d && !gPrev.d) moveChar(0, 1);
      if (now.a && !gPrev.a && !$("go").disabled) $("form").requestSubmit();
      gPrev = now;
    }
    gRaf = requestAnimationFrame(padGate);
  };
  addEventListener("gamepadconnected", () => { if (!gRaf) padGate(); });
  if ([...(navigator.getGamepads?.() || [])].some(Boolean)) { lastPadSeen = true; padHint(true); if (!primer.hidden) primerRender(); if (!gRaf) padGate(); }

  // ------------------------------------------------------------------ start
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    primerClose();   // Join never waits on the primer
    const name = $("name").value.trim().replace(/["\\;]/g, "").slice(0, 31) || "Player";
    const char = pickedChar();
    try { localStorage.setItem("csp_name", name); localStorage.setItem("csp_char", String(char)); } catch {}
    $("go").disabled = true;
    musicStop(2500);
    try {
      phase(1); status("Checking game data…");
      const zip = await gameData();
      phase(2); status("Unpacking…");
      const files = await unzipInWorker(zip);
      bar(0.85);
      phase(3); status("Loading engine…");
      const libs = {};
      await Promise.all(Object.entries(LIBS).map(async ([dest, src]) => {
        const r = await fetch(src + "?v=" + ENGINE_V); if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
        libs[dest] = new Uint8Array(await r.arrayBuffer());
      }));

      const proto = location.protocol === "https:" ? "wss" : "ws";
      window.WebSocket = WatchedWS;   // the engine's sockets are created through this
      const Module = {
        canvas: $("canvas"),
        // every UDP destination the engine talks to becomes a WebSocket to our relay
        websocket: { url: `${proto}://${location.host}/relay${keyQuery}`, subprotocol: "binary" },
        locateFile: (f) => f,
        print: (t) => {
          console.log(t);
          chatLine(t);
          const mp = /CSP_MAP_([\w.\-]+)/.exec(t);
          if (mp) fetchMapPack(mp[1]);
          if (t.includes("CSP_NAV")) navLine(t);
          const hw = /CSP_HOWTO_(\d+)/.exec(t);
          if (hw) howto = HOWTO[+hw[1]] || "";
          else if (t.includes("CSP_MAPVIEW_")) $("maplegend").hidden = !t.includes("CSP_MAPVIEW_1");
          else if (t.includes("CSP_THEME_PLAY")) musicPlay(true);
          else if (t.includes("CSP_THEME_STOP") && music.want) musicStop();
          else if (t.includes("CSP_MUSIC_BOARD")) boardPlay();
          else if (t.includes("CSP_MUSIC_OFF") && board.want) fadeOut(board, 1500);
          const m = /Server issued disconnect\. Reason: (.*)/.exec(t) || /(Server connection timed out)/.exec(t);
          if (m) watch.reason = m[1].replace(/\^\d/g, "").trim();
        },
        printErr: (t) => console.warn(t),
        onClientState: onState,
      };
      const em = await Xash3D(Module);
      engine = em;
      window.__csp = em;   // devtools: __csp.FS
      bar(0.92);
      status("Writing files…");
      // canOwn: MEMFS keeps our buffer instead of copying it, and we drop our reference as we go.
      // Without this the tab holds the game data twice before the engine loads anything.
      for (const p of Object.keys(files)) {
        const data = files[p]; delete files[p];
        if (p.endsWith("/")) continue;
        mkdirp(em.FS, ROOT + "/" + p.split("/").slice(0, -1).join("/"));
        em.FS.writeFile(ROOT + "/" + p, data, { canOwn: true });
      }
      for (const [p, data] of Object.entries(libs)) { mkdirp(em.FS, ROOT + "/" + p.split("/").slice(0, -1).join("/")); em.FS.writeFile(ROOT + "/" + p, data); }
      // Ctrl stays duck; C is a spare duck key for when the browser keeps Ctrl+W. (+duck can't ride the command line: a leading + starts a new command.)
      em.FS.writeFile(ROOT + "/cstrike/csp_keys.cfg", "bind c +duck\n");
      em.FS.chdir(ROOT);
      bar(1);
      $("gate").hidden = true;
      document.documentElement.classList.add("ingame");
      overlay("Joining the party", "Starting…", { spin: true });
      watch.firstJoinDeadline = performance.now() + 150000;
      // any non-loopback address works: the relay decides where packets really go.
      // (127.0.0.1 would make the engine think it's a local game and never touch the network.)
      const server = params.get("server") || "10.27.0.1:27015";
      em.callMain(["-game", "cstrike", "+cl_advertise_engine_in_name", "0", "-windowed", "-ref", "gles3compat", "-noip6",
        ...(params.has("dev") ? ["-dev", "2", "-log"] : []), ...(params.has("nosound") ? ["-nosound"] : []),
        ...GFX_ARGS, ...TOUCH_ARGS, ...HUD_ARGS, "+exec", "csp_keys.cfg", "+name", name, ...(char >= 0 ? ["+setinfo", "_csp_char", String(char)] : []), "+connect", server, "gs"]);
    } catch (err) {
      console.error(err);
      $("gate").hidden = false; hideOverlay(); musicPlay(false); phase(0);
      status(String(err.message || err), true);
      $("go").disabled = false;
    }
  });

  // A reload that came from the lost-party card rejoins on its own (the saved name and character are already filled in).
  try {
    if (sessionStorage.getItem("csp_rejoin")) {
      sessionStorage.removeItem("csp_rejoin");
      status("Rejoining the party…"); $("form").requestSubmit();
    }
  } catch {}

  // ------------------------------------------------------------------ lobby hand-off (lobby/, #3989)
  // The lobby page sends everyone here with ?key= (that lobby's party key), ?name=, ?char= and ?lobby= (the
  // lobby page, to go back to). The first arrival joins at once: the server's countdown starts with the first
  // player in, so the party should land together. A reload (Leave) stays on this screen.
  let lobbyUrl = null;
  try { lobbyUrl = new URL(params.get("lobby") || ""); } catch {}
  if (lobbyUrl && /^https?:$/.test(lobbyUrl.protocol)) {
    if (params.get("name")) $("name").value = params.get("name").slice(0, 31);
    const back = document.createElement("div"); back.className = "note";
    const a = document.createElement("a"); a.href = lobbyUrl.href; a.textContent = "Back to the lobby"; a.style.color = "inherit";
    back.append(`Party ${lobbyUrl.searchParams.get("code") || ""}: `, a);
    $("form").before(back);
    const once = "csp_lobby_" + (params.get("key") || "");
    let first = true; try { first = !sessionStorage.getItem(once); sessionStorage.setItem(once, "1"); } catch {}
    if (first) $("form").requestSubmit();
  }
})();
