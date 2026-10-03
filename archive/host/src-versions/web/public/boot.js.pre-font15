// CS Party browser client boot: download game data, start Xash3D (WebAssembly), join the server,
// and look after the connection: overlays for joining and for losing the server, plus a watchdog
// for map changes that stall.
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (t, err) => { $("status").textContent = t; $("status").className = err ? "err" : ""; console.log("[boot] " + t); };
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
  const GFX_ARGS = GFX === "low"
    ? ["+r_scene_scale", "0.6", "+gl_texture_lodbias", "1", "+r_detailtextures", "0", "+gl_msaa", "0", "+r_shadows", "0", "+r_decals", "32", "+fps_max", "60"]
    : [];
  // Touch: Xash3D's own on-screen controls (move stick, look, jump, use, fire, duck, numbers)
  // _csp_touch tells the server to move the CS Party HUD out from under the right-hand buttons
  // HUD size. Engine hud_scale (?hud=900) made glyphs render as white boxes and blacked out textures in
  // the WebGL build (confirmed by A/B on 2026-10-02), so it's opt-in only. ?font=1.5 tries the engine's
  // text-only scale (hud_fontscale) instead.
  const HUD_ARGS = [...(params.get("hud") ? ["+hud_scale", params.get("hud")] : []),
    ...(params.get("font") ? ["+hud_fontscale", params.get("font")] : [])];
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

  // ------------------------------------------------------------------ game data (cached in the browser)
  const CACHE = "csp-gamedata-v1";
  const GAMEDATA_V = "0.5.1";   // bump with every new gamedata.zip
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

  // ------------------------------------------------------------------ overlays
  const overlay = (title, text, { rejoin = false, spin = false } = {}) => {
    $("ov-title").textContent = title; $("ov-text").textContent = text || "";
    $("ov-rejoin").hidden = !rejoin; $("ov-spin").hidden = !spin;
    $("overlay").hidden = false; $("pause").hidden = true;
    if (rejoin && document.pointerLockElement) document.exitPointerLock();
  };
  const hideOverlay = => { $("overlay").hidden = true; };
  let toastTimer = 0;
  const toast = (t, ms = 0) => {
    $("toast").textContent = t; $("toast").hidden = !t;
    clearTimeout(toastTimer); if (t && ms) toastTimer = setTimeout(() => { $("toast").hidden = true; }, ms);
  };
  $("ov-rejoin").addEventListener("click", => location.reload());
  $("fs").addEventListener("click", async => {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      await screen.orientation?.lock?.("landscape").catch(() => {});   // Android; iPhone Safari has neither: home-screen app instead
    } catch {}
    $("canvas").focus();
  });
  let fsTimer = 0;
  addEventListener("mousemove", => {
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
  const consoleCmd = (c) => {
    if (!engine || !engine._Cbuf_AddText) return;
    const p = engine.stringToNewUTF8(c + "\n"); engine._Cbuf_AddText(p); engine._free(p);
    console.log("[watch] console: " + c);
  };
  const lost = (why) => {
    if (watch.gaveUp) return; watch.gaveUp = true;
    toast("");
    overlay("Lost the party", why || "The connection to the game server stopped.", { rejoin: true });
  };
  const onState = (st) => {
    const prev = watch.state; watch.state = st; watch.since = performance.now();
    console.log(`[watch] state ${prev} -> ${st}`);
    if (st === 4) {
      watch.retried = 0; watch.lastRx = performance.now();
      if (!watch.joined) { watch.joined = true; hideOverlay(); $("canvas").focus(); applySettings(); }
      toast("");
      return;
    }
    if (!watch.joined) {
      $("ov-text").textContent = st === 1 ? "Connecting to the server…" : st >= 2 ? "Loading the map…" : "Starting…";
      return;
    }
    if (st === 0) { lost(watch.reason || "Disconnected from the game server."); return; }
    toast("Loading the next map…");
  };
  // Any message in, on any of the engine's sockets, counts as the server being there.
  const NativeWS = window.WebSocket;
  class WatchedWS extends NativeWS {
    constructor(...a) {
      super(...a);
      watch.sockets.add(this);
      this.addEventListener("message", => { watch.lastRx = performance.now(); });
      this.addEventListener("close", (e) => {
        watch.sockets.delete(this);
        console.log(`[watch] relay socket closed (${e.code} ${e.reason || ""})`);
        if (e.code === 1006 && !watch.joined && performance.now() - watch.since < 3000) {
          lost(keyQuery ? "The party key was refused, or the relay is full." : "The relay refused the connection. The link may need a party key.");
        } else if (watch.sockets.size === 0 && watch.state !== 0) lost(e.code === 1001 ? "The party server is restarting. Rejoin in a few seconds." : "The connection to the party server dropped.");
      });
    }
  }
  setInterval(() => {
    const now = performance.now(), prevTick = watch.lastTick;
    const blocked = now - watch.lastTick > 3000;   // the engine held the main thread (map load): can't judge silence
    watch.lastTick = now;
    if (blocked) { watch.lastRx = now; watch.since += now - prevTick; return; }   // a frozen main thread is the engine loading, not a stall
    if (watch.gaveUp) return;
    if (!watch.joined) {
      if (watch.firstJoinDeadline && now > watch.firstJoinDeadline) lost("Couldn't join the game server. It may be down or full.");
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
      lost("The game server stopped answering.");
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
  const slider = (id, key, fmt) => {
    const el = $(id), out = $(id + "-v");
    el.value = SETTINGS[key]; out.textContent = fmt(SETTINGS[key]);
    el.addEventListener("input", => {
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
  const musicSave = => { try { localStorage.setItem("csp_music", JSON.stringify({ vol: music.vol, muted: music.muted })); } catch {} };
  const chanSync = (c) => {
    clearInterval(c.fade); c.el.volume = music.vol;
    if (!c.want || music.muted || !music.vol) c.el.pause();
    else c.el.play().catch(() => {});   // refused until the first interaction; musicKick retries
  };
  const musicSync = => {
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
  const boardPlay = => {
    if (board.want) return;
    if (music.want) musicStop();
    if (!board.el.src) board.el.src = BOARD_TRACKS[board.i];
    board.want = true; chanSync(board); fadeIn(board, 3000);
  };
  board.el.addEventListener("ended", => {
    board.i = (board.i + 1) % BOARD_TRACKS.length; board.el.src = BOARD_TRACKS[board.i]; if (board.want) chanSync(board);
  });
  // Join screen: the page gets about 20 s to itself before the theme fades in. Touching the music
  // controls (volume, unmute) starts it straight away.
  const MENU_DELAY = 20000;
  let menuTimer = setTimeout(() => {
    menuTimer = 0; if ($("gate").hidden || music.want) return;
    musicPlay(false); fadeIn(music, 3000);
  }, MENU_DELAY);
  const menuNow = => { if (menuTimer && !$("gate").hidden) { clearTimeout(menuTimer); menuTimer = 0; music.want = true; music.el.loop = true; } };
  for (const id of ["music-vol", "pz-music"]) $(id).addEventListener("input", (e) => {
    music.vol = +e.target.value; if (music.vol > 0) music.muted = false; menuNow(); musicSave(); musicSync();
  });
  $("music-mute").addEventListener("click", => { music.muted = !music.muted; if (!music.muted) menuNow(); musicSave(); musicSync(); });
  const musicKick = (e) => {
    if (e.target?.closest?.("#music")) return;   // the mute button decides for itself
    if (!music.muted && ((music.want && music.el.paused) || (board.want && board.el.paused))) musicSync();
  };
  for (const t of ["pointerdown", "keydown", "touchstart"]) addEventListener(t, musicKick, true);
  addEventListener("gamepadconnected", musicKick);
  const inGame = => engine && watch.state === 4 && $("overlay").hidden && $("gate").hidden;
  const openPause = => {
    if (!pause.hidden || !inGame()) return;
    pause.hidden = false; $("pz-resume").focus();
    if (document.pointerLockElement) document.exitPointerLock();
    padLoop();
  };
  const closePause = (fromClick) => {
    if (pause.hidden) return;
    pause.hidden = true; $("canvas").focus();
    // a click may take the mouse straight back; a key press isn't allowed to
    const r = fromClick ? $("canvas").requestPointerLock?.() : null;
    if (!fromClick) toast("Click the game to take the mouse back.", 3000);
    else r?.catch?.(() => toast("Click the game to take the mouse back.", 3000));
  };
  $("pz-resume").addEventListener("click", => closePause(true));
  $("pz-fs").addEventListener("click", => $("fs").click());
  $("pz-leave").addEventListener("click", => location.reload());   // pagehide disconnects properly
  // Mouse capture lost without the engine asking (Esc while captured, alt-tab): that's a pause.
  // The engine lets go itself on map changes and for its console; those go through exitPointerLock.
  let selfUnlock = 0;
  const nativeExit = Document.prototype.exitPointerLock;
  Document.prototype.exitPointerLock = function { selfUnlock = performance.now(); return nativeExit.call(this); };
  document.addEventListener("pointerlockchange", => {
    if (document.pointerLockElement) { if (!pause.hidden) document.exitPointerLock(); return; }   // never captured behind the menu
    if (performance.now() - selfUnlock < 1000) return;
    openPause();
  });
  // capture phase on window: runs before the engine's own key handler, so it can keep keys from it
  addEventListener("keydown", (e) => {
    if (!inGame()) return;
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
  const focusables = => [...pause.querySelectorAll("button, input")];
  const moveFocus = (d) => {
    const f = focusables(), i = f.indexOf(document.activeElement);
    f[(i + d + f.length) % f.length].focus();
  };
  // controller: D-pad/stick to move, left/right for sliders, A to pick, B or Start to go back
  let padPrev = {};
  function padLoop() {
    if (pause.hidden) { padPrev = {}; return; }
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (pad) {
      const ax = pad.axes || [], btn = (i) => !!pad.buttons[i]?.pressed;
      const now = { up: btn(12) || ax[1] < -0.6, down: btn(13) || ax[1] > 0.6, left: btn(14) || ax[0] < -0.6, right: btn(15) || ax[0] > 0.6,
        a: btn(0), b: btn(1) || btn(9) };
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
  addEventListener("pagehide", => { try { if (engine && watch.state >= 1) engine._CL_Disconnect(); } catch {} });


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
  const pickedChar = => +(charGrid.querySelector("input:checked")?.value ?? -1);
  const showChar = => {
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
  // controller on the join screen: D-pad / stick picks, A joins
  let gPrev = {}, gRaf = 0;
  const padGate = => {
    if ($("gate").hidden) return;
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (pad) {
      const b = (k) => !!pad.buttons[k]?.pressed, ax = pad.axes || [];
      const now = { l: b(14) || ax[0] < -0.6, r: b(15) || ax[0] > 0.6, u: b(12) || ax[1] < -0.6, d: b(13) || ax[1] > 0.6, a: b(0) };
      if (now.l && !gPrev.l) moveChar(-1, 0);
      if (now.r && !gPrev.r) moveChar(1, 0);
      if (now.u && !gPrev.u) moveChar(0, -1);
      if (now.d && !gPrev.d) moveChar(0, 1);
      if (now.a && !gPrev.a && !$("go").disabled) $("form").requestSubmit();
      gPrev = now;
    }
    gRaf = requestAnimationFrame(padGate);
  };
  addEventListener("gamepadconnected", => { if (!gRaf) padGate(); });

  // ------------------------------------------------------------------ start
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("name").value.trim().replace(/["\\;]/g, "").slice(0, 31) || "Player";
    const char = pickedChar();
    try { localStorage.setItem("csp_name", name); localStorage.setItem("csp_char", String(char)); } catch {}
    $("go").disabled = true;
    musicStop(2500);
    try {
      status("Checking game data…");
      const zip = await gameData();
      status("Unpacking…");
      const files = await unzipInWorker(zip);
      bar(0.85);
      status("Loading engine…");
      const libs = {};
      await Promise.all(Object.entries(LIBS).map(async ([dest, src]) => {
        const r = await fetch(src); if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
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
          if (t.includes("CSP_THEME_PLAY")) musicPlay(true);
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
        ...GFX_ARGS, ...TOUCH_ARGS, ...HUD_ARGS, "+name", name, ...(char >= 0 ? ["+setinfo", "_csp_char", String(char)] : []), "+connect", server, "gs"]);
    } catch (err) {
      console.error(err);
      $("gate").hidden = false; hideOverlay(); musicPlay(false);
      status(String(err.message || err), true);
      $("go").disabled = false;
    }
  });
})();
