// CS Party lobby page (#3989): create or join a party by code, pick a character, ready up. When the match
// starts the lobby hands every member a link to the game server with the party's own key, and this page
// takes them there.
(() => {
  const $ = (id) => document.getElementById(id);
  // same order and names as the plugin's SKIN_* tables and the game page (web/public/boot.js)
  const CHARS = [
    { n: "Phoenix Connexion", c: "#e6603f" }, { n: "Elite Crew", c: "#e3b52b" }, { n: "Arctic Avengers", c: "#a7d5e4" },
    { n: "Guerilla Warfare", c: "#9bad54" }, { n: "SEAL Team 6", c: "#6b9fd4" }, { n: "GSG-9", c: "#b5b9c1" },
    { n: "SAS", c: "#b98ad9" }, { n: "GIGN", c: "#e2e2d4" },
  ];
  const atlas = (i) => `--atlas-x:${(i % 4) * 100 / 3}%;--atlas-y:${i < 4 ? 0 : 100}%`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  let pid = store.get("csp_pid");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(pid || "")) { pid = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); store.set("csp_pid", pid); }
  $("name").value = store.get("csp_name") || "";
  let myChar = +(store.get("csp_char") ?? -1);
  if (!CHARS[myChar]) myChar = -1;
  const myName = () => $("name").value.trim().slice(0, 20) || "Player";

  const homeStatus = (t, err) => { $("home-status").textContent = t; $("home-status").className = "status" + (err ? " err" : ""); };
  const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

  // ------------------------------------------------------------------ home
  $("create").addEventListener("click", async () => {
    store.set("csp_name", myName());
    $("create").disabled = true; homeStatus("Making a party…");
    try {
      const r = await fetch("/api/lobbies", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid, name: myName(), char: myChar, public: $("public").checked }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      enter(j.code, "create");
    } catch (e) { homeStatus(String(e.message || e), true); }
    $("create").disabled = false;
  });
  $("quick").addEventListener("click", async () => {
    store.set("csp_name", myName());
    $("quick").disabled = true; homeStatus("Looking for a party…");
    try {
      const r = await fetch("/api/quickplay", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid, name: myName(), char: myChar }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      enter(j.code, j.created ? "create" : "quick");
    } catch (e) { homeStatus(String(e.message || e), true); }
    $("quick").disabled = false;
  });
  $("join-form").addEventListener("submit", (e) => { e.preventDefault(); tryJoin($("code").value, "code"); });
  $("code").addEventListener("input", () => { $("code").value = $("code").value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });

  // via: how they got here (code typed, invite link, public list), counted on join (no other effect)
  async function tryJoin(raw, via) {
    const code = String(raw || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) { homeStatus("Codes are 5 letters and numbers, like K7XQ2.", true); return; }
    store.set("csp_name", myName());
    homeStatus("Looking for the party…");
    try {
      const r = await fetch(`/api/lobbies/${code}`);
      if (r.status === 404) { homeStatus(`No party with code ${code}. It may have ended.`, true); history.replaceState(null, "", "/"); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      enter(code, via);
    } catch (e) { homeStatus(String(e.message || e), true); }
  }

  async function loadPublic() {
    try {
      const { lobbies } = await (await fetch("/api/public")).json();
      $("public-panel").hidden = !lobbies.length;
      $("public-list").innerHTML = lobbies.map((l) => `<li><button type="button" class="alt" data-code="${esc(l.code)}"><span>${esc(l.code)}</span><span>${l.seeking ? "LOOKING " : ""}${l.players}/4</span></button></li>`).join("");
    } catch {}
  }
  $("public-list").addEventListener("click", (e) => { const b = e.target.closest("button[data-code]"); if (b) tryJoin(b.dataset.code, "public"); });

  // ------------------------------------------------------------------ lobby
  let ws = null, code = "", via = "code", last = null, sawStart = false, retry = 0, countdown = 0, leaving = false;

  function enter(c, how) {
    code = c; via = how || "code"; leaving = false; sawStart = false; last = null;
    $("ready").hidden = true;   // until the lobby's first state: a click before the socket opens would be lost
    history.replaceState(null, "", `/?code=${code}`);
    $("home").hidden = true; $("lobby").hidden = false;
    $("lobby-code").textContent = code;
    $("eyebrow").textContent = "PARTY " + code;
    $("headline").textContent = "Ready up.";
    $("subline").textContent = "Send the code or the invite link. Bots fill the empty seats.";
    connect();
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({ pid, name: myName(), char: String(myChar), via });
    ws = new WebSocket(`${proto}://${location.host}/api/lobbies/${code}/ws?${q}`);
    const sock = ws;
    sock.onopen = () => { retry = 0; $("conn").textContent = "CONNECTED"; $("conn").className = ""; };
    sock.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "state") render(m); else if (m.t === "error") lobbyStatus(m.msg, true); else if (m.t === "closed") closedMsg = m.msg;
    };
    sock.onclose = (e) => {
      if (sock !== ws || leaving) return;
      $("conn").textContent = "RECONNECTING"; $("conn").className = "off";
      if (e.code === 4000) { lobbyStatus("This party is open in another tab.", true); $("conn").textContent = "OTHER TAB"; return; }
      // an admin closed the party or removed us (or we can't join right now): don't reconnect
      if (e.code === 4003 || e.code === 4010) { $("conn").textContent = ""; backHome(closedMsg || e.reason || "You left the party."); return; }
      setTimeout(async () => {
        // a lobby that expired answers 404: back to the start screen
        try { if ((await fetch(`/api/lobbies/${code}`)).status === 404) { backHome(`Party ${code} has ended.`); return; } } catch {}
        if (sock === ws && !leaving) connect();
      }, Math.min(10000, 500 * 2 ** retry++));
    };
  }
  let closedMsg = "";
  setInterval(() => { if (ws?.readyState === 1) ws.send("ping"); }, 30000);
  const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

  function backHome(msg) {
    leaving = true; try { ws?.close(); } catch {}
    ws = null; code = ""; clearInterval(countdown);
    history.replaceState(null, "", "/");
    $("lobby").hidden = true; $("home").hidden = false;
    $("eyebrow").textContent = "PARTY LOBBY"; $("headline").textContent = "Make a party, send the code."; $("subline").textContent = "Up to 4 players. Bots fill the empty seats.";
    homeStatus(msg || "", !!msg);
    closedMsg = "";
    loadPublic(); loadStatus();
  }
  $("leave").addEventListener("click", () => { send({ t: "leave" }); backHome(""); });
  $("copy").addEventListener("click", async () => {
    const link = `${location.origin}/?code=${code}`;
    try { await navigator.clipboard.writeText(link); $("copy").textContent = "Copied!"; } catch { prompt("Invite link:", link); }
    setTimeout(() => { $("copy").textContent = "Copy invite link"; }, 1500);
  });
  $("ready").addEventListener("click", () => send({ t: "ready", ready: $("ready").getAttribute("aria-pressed") !== "true" }));
  $("start").addEventListener("click", () => send({ t: "start" }));
  $("end").addEventListener("click", () => { if (confirm("End the match for everyone and go back to the lobby?")) send({ t: "end" }); });
  $("lobby-public").addEventListener("change", () => send({ t: "public", public: $("lobby-public").checked }));
  $("lobby-seeking").addEventListener("change", () => send({ t: "seeking", seeking: $("lobby-seeking").checked }));

  function lobbyStatus(t, err) { $("lobby-status").textContent = t; $("lobby-status").className = "status big" + (err ? " err" : ""); }

  // character grid: 8 characters + random; ones another member holds are greyed out
  $("char-grid").innerHTML = CHARS.map((ch, i) =>
    `<label class="char" style="--char-color:${ch.c}"><input type="radio" name="char" value="${i}"><span class="portrait" style="${atlas(i)}" aria-hidden="true"></span><span class="nm">${esc(ch.n)}</span></label>`).join("") +
    `<label class="char"><input type="radio" name="char" value="-1"><span class="rnd" aria-hidden="true">?</span><span class="nm">Random</span></label>`;
  const radios = [...$("char-grid").querySelectorAll("input")];
  const checkChar = (c) => { for (const r of radios) r.checked = +r.value === c; };
  checkChar(myChar);
  $("char-grid").addEventListener("change", (e) => {
    const c = +e.target.value;
    if (e.target.closest(".char.taken")) { checkChar(myChar); return; }
    myChar = c; store.set("csp_char", String(c)); send({ t: "char", char: c });
  });

  // maintenance and admin messages, above everything
  const banner = (t) => { $("banner").textContent = t || ""; $("banner").hidden = !t; };
  async function loadStatus() {
    try { const st = await (await fetch("/api/status")).json(); banner(st.message || st.notice); } catch {}
  }

  function render(s) {
    const prev = last; last = s;
    banner(s.notice);
    const me = s.members.find((m) => m.n === s.you), isHost = s.you === s.host;
    const players = s.members.filter((m) => m.role === "player");
    // seats
    $("seats").innerHTML = Array.from({ length: s.seats }, (_, i) => {
      const m = players[i];
      if (!m) return `<li class="seat empty"><div class="art"><span class="q">+</span></div><div class="cap"><span class="who">Open seat</span><span class="tag wait">BOT IF EMPTY</span></div></li>`;
      const ch = CHARS[m.char];
      const tag = !m.online ? (s.state === "in_match" ? `<span class="tag wait">IN GAME</span>` : `<span class="tag off">AWAY</span>`)
        : m.ready ? `<span class="tag ready">READY</span>` : `<span class="tag wait">NOT READY</span>`;
      return `<li class="seat${m.n === s.you ? " me" : ""}" style="--char-color:${ch ? ch.c : "#555"}">${m.n === s.host ? `<span class="host">HOST</span>` : ""}` +
        `<div class="art">${ch ? `<span class="portrait" style="${atlas(m.char)}"></span>` : `<span class="q">?</span>`}</div>` +
        `<div class="cap"><span class="who">${esc(m.name)}${m.n === s.you ? " (you)" : ""}</span><span class="muted small">${ch ? esc(ch.n) : "Random"}</span>${tag}</div></li>`;
    }).join("");
    const specs = s.members.filter((m) => m.role === "spectator");
    $("spectators").hidden = !specs.length;
    $("spectators").textContent = specs.length ? `Watching: ${specs.map((m) => m.name).join(", ")}` : "";
    // characters held by others
    const taken = new Set(s.members.filter((m) => m.n !== s.you && m.char >= 0).map((m) => m.char));
    for (const r of radios) { const t = taken.has(+r.value); r.closest(".char").classList.toggle("taken", t); r.disabled = t; }
    if (me && me.char !== myChar) { myChar = me.char; store.set("csp_char", String(myChar)); }
    checkChar(myChar);

    const open = s.state === "open", inMatch = s.state === "in_match";
    const seated = me?.role === "player";
    $("ready").hidden = !open || !seated;
    $("ready").setAttribute("aria-pressed", String(!!me?.ready));
    $("ready").textContent = me?.ready ? "Ready! (click to cancel)" : "Ready";
    $("start").hidden = !isHost || !open;
    $("public-wrap").hidden = !isHost; $("lobby-public").checked = s.public;
    $("seeking-wrap").hidden = !isHost; $("lobby-seeking").checked = s.seeking;
    $("end").hidden = !isHost || open;
    $("go").hidden = !(inMatch && s.go);
    if (s.go) $("go").href = s.go;

    clearInterval(countdown);
    if (s.error) lobbyStatus(s.error, s.state !== "queued");
    else if (open && s.startsIn > 0) {
      const at = Date.now() + s.startsIn;
      const tick = () => lobbyStatus(`${s.fill ? "Party is full enough. Bots fill the rest. Starting in" : "Everyone's ready. Starting in"} ${Math.max(0, Math.ceil((at - Date.now()) / 1000))}…`);
      tick(); countdown = setInterval(tick, 250);
    } else if (open) {
      const ready = players.filter((m) => m.ready && m.online).length, online = players.filter((m) => m.online).length;
      lobbyStatus(online < s.minHumans ? `Waiting for friends (${online}/${s.minHumans} to auto-start). ${isHost ? "Or start now with bots." : ""}`
        : `${ready}/${online} ready.`);
    } else if (s.state === "starting") lobbyStatus("Finding a server…");
    else if (s.state === "queued") lobbyStatus("Every server is busy. Waiting for one to free up…");
    else if (inMatch) lobbyStatus(sawStart ? "Server ready. Joining…" : "Match in progress.");

    // Started while we watched: go. Came back to a lobby mid-match: offer the button, don't bounce them.
    if (inMatch && prev && prev.state !== "in_match") sawStart = true;
    if (!inMatch) sawStart = false;
    if (inMatch && sawStart && s.go && !render.going) {
      render.going = true; lobbyStatus("Server ready. Joining…");
      setTimeout(() => { location.href = s.go; }, 1200);
    }
  }

  // ------------------------------------------------------------------ boot
  const q = new URLSearchParams(location.search).get("code");
  if (q) { $("code").value = q.toUpperCase(); tryJoin(q, "link"); } else loadPublic();
  loadStatus();
})();
