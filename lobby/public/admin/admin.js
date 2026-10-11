// CS Party lobby admin dashboard (#3991). Polls /api/admin/live every 3 s while the tab is visible and the
// stats every minute. Every value from the server goes into the page through textContent (nicknames are
// player-typed). Actions ask for confirmation, and the server writes each one to the audit log.
(() => {
  const $ = (id) => document.getElementById(id);
  const CHARS = ["Phoenix Connexion", "Elite Crew", "Arctic Avengers", "Guerilla Warfare", "SEAL Team 6", "GSG-9", "SAS", "GIGN"];
  const charName = (k) => (/^\d$/.test(k) && CHARS[+k]) || k || "?";
  const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} } };
  let token = store.get("csp_admin");

  // ---------------------------------------------------------------- tiny DOM helpers (textContent only)
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v; else if (k === "style") e.style.cssText = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };
  const fill = (tbody, rows, empty = "Nothing yet.", cols = 1) => {
    tbody.replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: cols, class: "muted" }, empty))]));
  };
  const td = (v, cls) => el("td", { class: cls }, v);
  const fmtN = (n) => (Math.round(n * 10) / 10).toLocaleString();
  const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d`; };
  const when = (t) => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
  const toast = (t, err) => { $("toast").textContent = t; $("toast").className = "status" + (err ? " err" : " ok"); };

  // ---------------------------------------------------------------- API
  async function api(path, opts = {}) {
    const r = await fetch(`/api/admin/${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
    if (r.status === 401) { signOut((await r.json().catch(() => ({}))).error || "The token was refused."); throw new Error("signed out"); }
    const isCsv = (r.headers.get("Content-Type") || "").startsWith("text/csv");
    const body = isCsv ? await r.blob() : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  async function act(body, confirmText) {
    if (confirmText && !confirm(confirmText)) return null;
    try {
      const r = await api("action", { method: "POST", body: JSON.stringify(body) });
      toast(`Done: ${r.action}${r.target ? ` ${r.target}` : ""}`);
      refreshLive();
      return r;
    } catch (e) { toast(`${body.action} failed: ${e.message}`, true); return null; }
  }

  // ---------------------------------------------------------------- sign-in
  function signOut(msg) {
    token = null; store.set("csp_admin", null);
    $("app").hidden = true; $("login").hidden = false;
    $("login-status").textContent = msg || "";
    $("token").focus();
  }
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    token = $("token").value.trim();
    try {
      await api("live");
      store.set("csp_admin", token); $("token").value = "";
      start();
    } catch (err) { if (err.message !== "signed out") $("login-status").textContent = err.message; }
  });
  $("logout").addEventListener("click", () => signOut(""));

  // ---------------------------------------------------------------- tooltip for chart marks (hover and focus)
  const tip = $("tip");
  const showTip = (e, value, label) => {
    tip.replaceChildren(el("b", {}, value), label);
    tip.hidden = false;
    const r = e.target.getBoundingClientRect();
    tip.style.left = `${Math.min(innerWidth - 180, r.left)}px`; tip.style.top = `${Math.max(4, r.top - 44)}px`;
  };
  const tipped = (node, value, label) => {
    node.tabIndex = 0;
    node.setAttribute("aria-label", `${label}: ${value}`);
    for (const ev of ["pointerenter", "focus"]) node.addEventListener(ev, (e) => showTip(e, value, label));
    for (const ev of ["pointerleave", "blur"]) node.addEventListener(ev, () => { tip.hidden = true; });
    return node;
  };
  // horizontal bars, every value printed beside its bar
  function bars(box, items, { pctOf } = {}) {
    const max = Math.max(1, ...items.map((i) => i.n));
    const kids = [];
    for (const i of items) {
      const val = pctOf ? `${fmtN(i.n)} (${pctOf ? Math.round(100 * i.n / Math.max(1, pctOf)) : 0}%)` : fmtN(i.n);
      kids.push(el("span", { class: "lbl" }, i.label),
        el("div", { class: "track" }, tipped(el("div", { class: "bar", style: `width:${(100 * i.n / max).toFixed(1)}%` }), val, i.label)),
        el("span", { class: "val" }, val));
    }
    box.replaceChildren(...kids);
  }
  // hourly columns over the selected range, with first/last hour on the axis
  function spark(box, series, from, hours, label) {
    const byHour = new Map(series.map((r) => [r.hour, r.n]));
    const step = hours > 168 ? 24 : 1;   // 30 and 90 days: one column a day
    const cols = [];
    for (let t = from; t < from + hours * 3600e3; t += step * 3600e3) {
      let n = 0;
      for (let k = 0; k < step; k++) n += byHour.get(t + k * 3600e3) || 0;
      cols.push({ t, n });
    }
    const max = Math.max(1, ...cols.map((c) => c.n)), total = cols.reduce((a, c) => a + c.n, 0);
    box.setAttribute("aria-label", `${label}: ${total} in total, peak ${max}`);
    box.replaceChildren(...cols.map((c) => tipped(el("div", { class: "bar" + (c.n ? "" : " zero"), style: `height:${Math.max(1, 100 * c.n / max)}%` }),
      String(c.n), `${label}, ${step > 1 ? new Date(c.t).toLocaleDateString() : when(c.t)}`)));
    const axis = el("div", { class: "axis" }, el("span", {}, when(cols[0]?.t)), el("span", {}, `peak ${max} · total ${total}`), el("span", {}, step > 1 ? "per day" : "per hour"));
    box.nextElementSibling?.classList.contains("axis") ? box.nextElementSibling.replaceWith(axis) : box.after(axis);
  }

  // ---------------------------------------------------------------- live
  let live = null, openCode = "";
  async function refreshLive() {
    try {
      live = await api("live");
      renderLive(live);
      $("sync").textContent = `Live ${new Date().toLocaleTimeString()}`;
      if (openCode) loadDetail(openCode, true);
    } catch (e) { if (e.message !== "signed out") $("sync").textContent = `Live: ${e.message}`; }
  }
  function tile(v, k) { return el("div", { class: "tile" }, el("div", { class: "v" }, v), el("div", { class: "k" }, k)); }
  function renderLive(L) {
    const t = L.totals;
    $("tiles").replaceChildren(tile(t.active, "lobbies with people"), tile(t.online, "players in lobbies"), tile(t.byState.in_match || 0, "in a match"),
      tile(t.publicOpen, "open public lobbies"), tile(t.queued, "queued for a server"), tile(t.oldest ? ago(t.oldest) : "-", "oldest active lobby"));
    $("state-line").textContent = `All lobbies seen in 24 h: ${t.lobbies} (${Object.entries(t.byState).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}).`;
    // switches
    const c = L.cfg;
    $("pause-btn").textContent = c.paused ? "Resume new parties" : "Pause new parties";
    $("pause-btn").className = c.paused ? "" : "danger";
    $("pause-state").textContent = c.paused ? `PAUSED${c.pauseMsg ? `: "${c.pauseMsg}"` : ""}` : "Taking new parties.";
    if (document.activeElement?.closest("#f-caps") == null) {
      $("cap-max").value = c.maxLobbies; $("cap-create").value = c.createCap; $("cap-public").checked = c.publicOff;
    }
    $("bc-state").textContent = L.notice ? `Showing until ${when(L.notice.until)}: "${L.notice.text}"${L.broadcasting ? " (sending…)" : ""}` : "No broadcast.";
    // servers
    fill($("hosts").tBodies[0], L.hosts.map((h) => {
      const status = !h.ok ? ["DOWN", "err"] : h.drained ? (!h.code && !h.peers && !h.downloads ? ["DRAINED · SAFE TO DEPLOY", "ok"] : ["DRAINING", "warn"]) : ["UP", "ok"];
      return el("tr", {}, td(h.id), td(el("span", { class: `badge ${status[1]}` }, status[0])), td(h.agent ? `${h.running}/${h.max} lobby servers${h.code ? `: ${h.code}` : ""}` : h.code ? `${h.code} (${ago(L.now - h.since)})` : "-"),
        td(h.peers, "num"), td(h.downloads, "num"), td(h.uptime ? ago(h.uptime * 1000) : "-", "num"), td(h.rejected, "num"), td(h.at ? `${ago(L.now - h.at)} ago` : "-"),
        td(el("button", { type: "button", class: "mini alt", onclick: () => act({ action: "drain", id: h.id, on: !h.drained },
          h.drained ? `Undrain ${h.id}? It takes new lobbies again.` : `Drain ${h.id}? It gets no new lobbies; current ones finish.`) }, h.drained ? "Undrain" : "Drain")));
    }), "No servers in POOL.", 9);
    // lobbies
    fill($("lobbies").tBodies[0], L.lobbies.map((l) => {
      const tr = el("tr", { tabindex: 0, class: l.code === openCode ? "sel" : null, onclick: () => loadDetail(l.code), onkeydown: (e) => { if (e.key === "Enter") loadDetail(l.code); } },
        td(l.code), td(l.state), td(l.host || "-"), td(`${l.online} / ${l.players}`, "num"), td(l.ready, "num"),
        td(l.seeking ? "looking" : l.public ? "public" : "private"), td(l.slot || "-"), td(l.round || (l.lastmg ? l.lastmg : "-"), "num"),
        td(l.created ? ago(L.now - l.created) : "-", "num"), td(`${ago(L.now - l.updated)} ago`, "num"));
      return tr;
    }), "No lobbies in the last 24 hours.", 10);
    // abuse
    fill($("creators").tBodies[0], L.topCreators.map((r) => el("tr", {}, td(r.key), td(r.n, "num"), td(`${ago(L.now - r.last)} ago`),
      td(r.banned ? el("span", { class: "badge err" }, "BANNED") : el("button", { type: "button", class: "mini danger",
        onclick: () => { const h = prompt(`Ban IP hash ${r.key} from making or joining parties for how many hours?`, "24"); if (h) act({ action: "ban", kind: "ip", key: r.key, hours: +h, note: "top creator" }); } }, "Ban")))), "No creates in 24 h.", 4);
    fill($("bans").tBodies[0], L.bans.map((b) => el("tr", {}, td(b.key), td(b.kind), td(when(b.until)), td(b.note || ""),
      td(el("button", { type: "button", class: "mini alt", onclick: () => act({ action: "unban", key: b.key }, `Lift the ban on ${b.key}?`) }, "Unban")))), "No bans.", 5);
    fill($("audit").tBodies[0], L.audit.map((a) => el("tr", {}, td(when(a.at)), td(a.action), td(a.target || ""), td(fmtDetail(a.detail), "wrap"), td(a.who))), "No admin actions yet.", 5);
  }
  const fmtDetail = (d) => { try { return Object.entries(JSON.parse(d || "{}")).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}: ${v}`).join(", "); } catch { return d; } };

  // one lobby: roster with kick / ban, its timeline, kill
  async function loadDetail(code, quiet) {
    openCode = code;
    const box = $("detail");
    let d;
    try { d = await api(`lobby?code=${encodeURIComponent(code)}`); }
    catch (e) { if (!quiet) toast(`${code}: ${e.message}`, true); if (/no such/.test(e.message)) { openCode = ""; box.hidden = true; } return; }
    for (const tr of $("lobbies").tBodies[0].rows) tr.classList.toggle("sel", tr.cells[0]?.textContent === code);
    const members = el("table", {}, el("thead", {}, el("tr", {}, ...["#", "Name", "Seat", "Character", "Ready", "Online", "Country", "Joined", ""].map((h) => el("th", {}, h)))),
      el("tbody", {}, d.members.map((m) => el("tr", {}, td(m.n, "num"), td(`${m.name}${m.host ? " (host)" : ""}`), td(m.role), td(m.char >= 0 ? CHARS[m.char] : "random"),
        td(m.ready ? "yes" : "no"), td(m.online ? "yes" : m.gone ? `away ${ago(Date.now() - m.gone)}` : "no"), td(m.cc || "-"), td(`${ago(Date.now() - m.joined)} ago`),
        td(el("div", { class: "row" },
          el("button", { type: "button", class: "mini alt", onclick: () => act({ action: "kick", code, n: m.n }, `Remove ${m.name} from ${code}? They can join again.`) }, "Kick"),
          el("button", { type: "button", class: "mini danger", onclick: () => { const h = prompt(`Remove ${m.name} and ban their browser and IP hash for how many hours?`, "24"); if (h) act({ action: "kick", code, n: m.n, hours: +h }); } }, "Kick + ban")))))));
    const log = el("ol", { class: "timeline" }, (d.log || []).slice().reverse().map((x) => el("li", {}, `${new Date(x.at).toLocaleTimeString()}  ${x.e}${x.b ? ` ${x.b}` : ""}${x.n ? ` #${x.n}` : ""}`)));
    box.replaceChildren(
      el("div", { class: "row" }, el("h3", {}, `Lobby ${d.code}: ${d.state}`), el("span", { class: "muted small" },
        `made ${ago(Date.now() - d.created)} ago · ${d.matches} match${d.matches === 1 ? "" : "es"}${d.match ? ` · on ${d.match.slot} for ${ago(Date.now() - d.match.started)} (${d.match.mode})` : ""}${d.error ? ` · ${d.error}` : ""}`),
        el("button", { type: "button", class: "mini danger", onclick: async () => {
          const msg = prompt(`Close lobby ${code} for good? Members are sent back to the start page with this message:`, "This party was closed by an admin.");
          if (msg != null && await act({ action: "kill", code, msg })) { openCode = ""; box.hidden = true; } } }, "Close lobby"),
        el("button", { type: "button", class: "mini alt", onclick: () => { openCode = ""; box.hidden = true; } }, "Hide")),
      el("div", { class: "scroll" }, members), el("h3", {}, "Timeline (newest first)"), log);
    box.hidden = false;
  }

  // ---------------------------------------------------------------- stats
  async function refreshStats() {
    try { renderStats(await api(`stats?range=${$("range").value}`)); }
    catch (e) { if (e.message !== "signed out") toast(`Stats: ${e.message}`, true); }
  }
  function renderStats(S) {
    const T = {};   // T[event][key] = {n, sum}
    for (const r of S.totals) (T[r.e] ||= {})[r.k] = { n: r.n, sum: r.sum };
    const n = (e, k) => (k == null ? Object.values(T[e] || {}).reduce((a, v) => a + v.n, 0) : T[e]?.[k]?.n || 0);
    const sum = (e, k) => (k == null ? Object.values(T[e] || {}).reduce((a, v) => a + v.sum, 0) : T[e]?.[k]?.sum || 0);
    const rows = (e) => Object.entries(T[e] || {}).sort((a, b) => b[1].n - a[1].n);
    const hours = { "24h": 24, "7d": 168, "30d": 720, "90d": 2160 }[S.range];

    const created = n("funnel", "created");
    bars($("funnel"), [["created", "Party made"], ["second", "2nd player joined"], ["all_ready", "Everyone ready"], ["started", "Match started"], ["finished", "Match finished"]]
      .map(([k, label]) => ({ label, n: n("funnel", k) })), { pctOf: created });
    bars($("tts"), [["lt30s", "under 30 s"], ["30-60s", "30-60 s"], ["1-2m", "1-2 min"], ["2-5m", "2-5 min"], ["5-10m", "5-10 min"], ["10m_plus", "10 min+"]]
      .map(([k, label]) => ({ label, n: n("tts", k) })));
    fill($("dropoff").tBodies[0], [
      ...rows("lobby_left").map(([k, v]) => el("tr", {}, td("left the lobby"), td(k || "-"), td(v.n, "num"), td(ago(1000 * v.sum / Math.max(1, v.n)), "num"))),
      ...rows("lobby_expired").map(([k, v]) => el("tr", {}, td("lobby expired"), td({ alone: "nobody joined", joined: "never started", played: "after playing" }[k] || k), td(v.n, "num"), td(ago(1000 * v.sum / Math.max(1, v.n)), "num"))),
    ], "No one has left yet.", 4);

    // traffic
    bars($("players"), S.players.map((p) => ({ label: p.day, n: p.unique })));
    const pl = S.players.at(-1);
    $("players").append(el("span", { class: "lbl" }, "today, returning"), el("span"), el("span", { class: "val" }, String(pl?.returning ?? 0)));
    spark($("created-series"), S.series.filter((r) => r.e === "lobby_created"), S.from, hours, "Lobbies made");
    fill($("countries").tBodies[0], rows("country").map(([k, v]) => el("tr", {}, td(k || "?"), td(v.n, "num"))), "No visits yet.", 2);

    // game
    const closed = n("match_closed"), avgLen = closed ? sum("match_closed") / closed : 0;
    $("game-tiles").replaceChildren(tile(n("match_started"), "matches started"), tile(closed ? ago(1000 * avgLen) : "-", "avg match length"),
      tile(n("match_finished"), "finished (game events)"), tile(n("turn_taken"), "turns (sampled)"),
      tile((n("match_started") / hours).toFixed(2), "matches per hour (avg)"));
    spark($("started-series"), S.series.filter((r) => r.e === "match_started"), S.from, hours, "Matches started");
    const mgs = new Set([...Object.keys(T.minigame_picked || {}), ...Object.keys(T.minigame_result || {}), ...Object.keys(T.quit_after || {})]);
    fill($("minigames").tBodies[0], [...mgs].sort((a, b) => n("minigame_picked", b) - n("minigame_picked", a)).map((k) => {
      const picked = n("minigame_picked", k), res = n("minigame_result", k), quit = n("quit_after", k);
      return el("tr", {}, td(k), td(picked, "num"), td(res, "num"), td(res ? ago(1000 * sum("minigame_result", k) / res) : "-", "num"), td(quit, "num"),
        td(picked ? `${Math.round(100 * quit / picked)}%` : "-", "num"));
    }), "No minigame events yet.", 6);
    const chars = new Set([...Object.keys(T.match_finished || {}), ...Object.keys(T.minigame_winner || {})]);
    fill($("winners").tBodies[0], [...chars].sort((a, b) => n("match_finished", b) - n("match_finished", a)).map((k) =>
      el("tr", {}, td(charName(k)), td(n("match_finished", k), "num"), td(n("minigame_winner", k), "num"))), "No winners yet.", 3);
    fill($("modes").tBodies[0], [
      ...rows("match_started").map(([k, v]) => el("tr", {}, td("started"), td({ all_ready: "everyone ready", host_force: "host started", fill: "fill timer", queued: "after queue" }[k] || k), td(v.n, "num"))),
      ...rows("match_closed").map(([k, v]) => el("tr", {}, td("closed"), td({ server_empty: "everyone left the server", host_end: "host ended it", max_time: "3 h limit", slot_removed: "server removed", admin_kill: "admin closed it" }[k] || k), td(v.n, "num"))),
      ...rows("match_outcome").map(([k, v]) => el("tr", {}, td("outcome"), td(k), td(v.n, "num"))),
    ], "No matches yet.", 3);
    $("game-note").textContent = n("minigame_picked") || n("match_finished") ? ""
      : "Minigame, turn and winner numbers come from the game servers (P2 pool-agent posting [CSPEV] lines to /api/events). None have arrived in this range.";

    // errors and abuse
    const err = [];
    const add = (what, e, names = {}) => { for (const [k, v] of rows(e)) err.push(el("tr", {}, td(what), td(names[k] || k || "-"), td(v.n, "num"))); };
    add("queued: no free server", "start_queued");
    for (const k of ["max_time", "slot_removed", "admin_kill"]) if (n("match_closed", k)) err.push(el("tr", {}, td("match cut off"), td(k), td(n("match_closed", k), "num")));
    add("rate limited", "rate_limited"); add("refused", "rejected"); add("wrong admin token", "auth_failed", { "": "-" });
    fill($("errors").tBodies[0], err, "Nothing went wrong.", 3);
  }

  // ---------------------------------------------------------------- Analytics Engine
  async function runAe() {
    $("ae-state").textContent = "Running…";
    try {
      const r = await api(`ae?preset=${encodeURIComponent($("ae-preset").value || "events")}&range=${$("range").value}`);
      if (!$("ae-preset").options.length) $("ae-preset").replaceChildren(...(r.presets || []).map((p) => el("option", { value: p }, p.replace(/_/g, " "))));
      if (!r.configured) { $("ae-state").textContent = "Not set up: the Worker needs the AE_ACCOUNT_ID and AE_READ_TOKEN secrets (an API token with Account Analytics: Read). Events are still being written."; return; }
      if (r.error) { $("ae-state").textContent = `Query failed: ${r.error}`; return; }
      const cols = (r.meta || []).map((m) => m.name);
      $("ae").tHead.replaceChildren(el("tr", {}, cols.map((c) => el("th", {}, c))));
      fill($("ae").tBodies[0], (r.data || []).map((row) => el("tr", {}, cols.map((c) => td(typeof row[c] === "number" ? fmtN(row[c]) : row[c], typeof row[c] === "number" ? "num" : null)))), "No rows.", cols.length || 1);
      $("ae-state").textContent = `${r.rows ?? (r.data || []).length} rows · ${r.sql}`;
    } catch (e) { if (e.message !== "signed out") $("ae-state").textContent = e.message; }
  }
  $("ae-run").addEventListener("click", runAe);

  // ---------------------------------------------------------------- controls
  $("f-pause").addEventListener("submit", (e) => {
    e.preventDefault();
    const on = !live?.cfg.paused;
    act({ action: "pause", on, msg: $("pause-msg").value }, on ? "Pause new parties? Creating and quick play stop until you resume." : "Resume taking new parties?");
  });
  $("f-broadcast").addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = $("bc-msg").value.trim();
    if (!msg) { toast("Type a message first.", true); return; }
    act({ action: "broadcast", msg, minutes: +$("bc-min").value || 30 }, `Show "${msg}" on every lobby page for ${+$("bc-min").value || 30} minutes?`);
  });
  $("bc-clear").addEventListener("click", () => act({ action: "broadcast", msg: "" }, "Clear the broadcast?"));
  $("f-caps").addEventListener("submit", (e) => {
    e.preventDefault();
    act({ action: "caps", maxLobbies: +$("cap-max").value, createCap: +$("cap-create").value, publicOff: $("cap-public").checked },
      `Save caps: max lobbies ${+$("cap-max").value || "none"}, ${+$("cap-create").value} creates per IP per 10 min, public listings ${$("cap-public").checked ? "off" : "on"}?`);
    document.activeElement?.blur();
  });
  $("range").addEventListener("change", () => { refreshStats(); if ($("ae").tHead.rows.length) runAe(); });
  $("csv").addEventListener("click", async () => {
    try {
      const blob = await api(`export.csv?range=${$("range").value}`);
      const a = el("a", { href: URL.createObjectURL(blob), download: `csparty-rollups-${$("range").value}.csv` });
      document.body.append(a); a.click(); a.remove();
    } catch (e) { toast(`CSV: ${e.message}`, true); }
  });

  // ---------------------------------------------------------------- polling
  let timers = [];
  function start() {
    $("login").hidden = true; $("app").hidden = false;
    refreshLive(); refreshStats(); runAe();
    timers.forEach(clearInterval);
    timers = [setInterval(() => { if (!document.hidden && token) refreshLive(); }, 3000),
      setInterval(() => { if (!document.hidden && token) refreshStats(); }, 60000),
      setInterval(() => { $("clock").textContent = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC"; }, 1000)];
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token) { refreshLive(); refreshStats(); } });
  if (token) start(); else signOut("");
})();
