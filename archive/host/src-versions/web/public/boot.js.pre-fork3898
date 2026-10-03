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
  async function gameData() {
    const url = "gamedata.zip" + keyQuery;
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

  // ------------------------------------------------------------------ start
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("name").value.trim().replace(/["\\;]/g, "").slice(0, 31) || "Player";
    try { localStorage.setItem("csp_name", name); } catch {}
    $("go").disabled = true;
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
        ...GFX_ARGS, ...TOUCH_ARGS, "+name", name, "+connect", server, "gs"]);
    } catch (err) {
      console.error(err);
      $("gate").hidden = false; hideOverlay();
      status(String(err.message || err), true);
      $("go").disabled = false;
    }
  });
})();
