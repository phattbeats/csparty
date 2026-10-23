/* PHATT GAMING ARCADE selector: one file, copied byte-identically into every game repo.
 * Canonical copy: phattbeats/csparty lobby/public/arcade/phatt-arcade.js. Edit the GAMES list here, then copy the
 * file (and any new logo) to the sibling repos; tools/check_arcade_sync.sh in csparty verifies the copies match.
 *
 * Use:  a script tag, src="/arcade/phatt-arcade.js" data-game="csparty" defer
 * Options: data-mount="#selector" puts the button first inside that element (default: first child of body),
 *          data-base="/arcade/" overrides where logos load from (default: next to this script).
 * Dock:    when the Arcade dock (party/phatt-party.js, window.PhattParty) is on the page, the button opens its Games tab.
 * Guard:   PhattArcade.setGuard(() => "You're in a match." | "")  a non-empty string makes a game tile ask
 *          before it navigates away, so the selector never drops a player from a live game by accident.
 * All UI lives in a shadow root so no game stylesheet can restyle it. */
(function () {
  "use strict";
  var GAMES = [
    { id: "csparty", name: "CS Party", url: "https://csparty.phatt.vip/", logo: "csparty.webp", w: 640, h: 355,
      blurb: "A Mario Party-style board game inside Counter-Strike 1.6. Up to 4 players, bots fill empty seats." },
    { id: "7dtz", name: "7 Days to Zelda", url: "https://zelda.phatt.vip/", logo: "7-days-to-zelda.webp", w: 640, h: 266,
      blurb: "Co-op Ocarina of Time survival in your browser: craft, build, and hold out through the raids." },
    { id: "pokernight", name: "Poker Night Multiplayer", url: "https://poker.phatt.vip/", logo: "poker-night-multiplayer.webp", w: 640, h: 410,
      blurb: "Poker Night at the Inventory online: private rooms, a 3D table, and a seat for friends." }
  ];
  var script = document.currentScript;
  var current = (script && script.dataset.game) || "";
  var base = (script && script.dataset.base) || (script && script.src ? script.src.replace(/[^\/]*$/, "") : "/arcade/");
  var guard = function () { return ""; };

  var CSS = [
    ":host{all:initial;display:block;font:14px/1.4 Tahoma,Verdana,Arial,sans-serif;color:#f4e8cc}",
    "*{box-sizing:border-box}",
    "[hidden]{display:none!important}",
    ".bar{display:flex;justify-content:flex-start;padding:6px 8px;background:#0e0b09;border-bottom:3px solid #e8702a}",
    ".open{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:4px 12px 4px 8px;cursor:pointer;color:#f4e8cc;",
    " background:linear-gradient(#2b211a,#17110d);border:2px solid #f4e8cc;border-radius:8px;box-shadow:0 3px 0 #e8702a,0 5px 0 #000;font:inherit;touch-action:manipulation;transition:transform .12s,box-shadow .12s}",
    ".open:hover{transform:translateY(-1px);box-shadow:0 4px 0 #e8702a,0 6px 0 #000}",
    ".open:active{transform:translateY(2px);box-shadow:0 1px 0 #e8702a,0 2px 0 #000}",
    ".open img{display:block;height:34px;width:auto;flex:none}",
    ".open .grid-ic{font:bold 12px/1 'Courier New',monospace;letter-spacing:1px;color:#5fb8ac}",
    "button:focus-visible,a:focus-visible{outline:3px solid #fff2a8;outline-offset:3px}",
    "dialog{padding:0;border:0;background:transparent;color:inherit;max-width:min(920px,calc(100vw - 20px));width:100%;max-height:calc(100dvh - 20px);overflow:visible}",
    "dialog::backdrop{background:radial-gradient(ellipse at 50% 30%,rgba(60,28,10,.82),rgba(0,0,0,.92))}",
    ".cab{position:relative;display:flex;flex-direction:column;max-height:calc(100dvh - 20px);padding:14px 14px 16px;border-radius:16px;",
    " background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 2px,transparent 2px 4px),linear-gradient(#241a14,#120d0a);",
    " border:3px solid #f4e8cc;box-shadow:0 0 0 3px #000,0 0 0 6px #e8702a,0 0 0 9px #000,0 24px 80px #000}",
    ".top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:3px dashed #5fb8ac55}",
    ".top img{height:44px;width:auto;display:block}",
    ".close{min-width:44px;min-height:44px;padding:0 14px;cursor:pointer;font:bold 14px/1 Tahoma,Arial,sans-serif;color:#17110d;background:#f4e8cc;border:2px solid;border-color:#fff #9c8a68 #9c8a68 #fff;border-radius:6px}",
    ".close:hover{background:#e8702a}",
    "h2{margin:12px 0 2px;font:bold 12px/1.3 'Courier New',monospace;letter-spacing:2px;color:#5fb8ac;text-transform:uppercase}",
    ".sub{margin:0 0 12px;color:#cdbf9f;font-size:13px}",
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;overflow:auto;padding:4px 4px 8px;list-style:none;margin:0;overscroll-behavior:contain}",
    ".tile{position:relative;display:flex;flex-direction:column;height:100%;color:inherit;text-decoration:none;cursor:pointer;text-align:left;font:inherit;width:100%;",
    " background:linear-gradient(#2d221b,#1a130f);border:2px solid #6b5846;border-radius:10px;overflow:hidden;box-shadow:0 4px 0 #000;transition:transform .15s,border-color .15s,box-shadow .15s}",
    ".tile:hover{transform:translateY(-3px);border-color:#e8702a;box-shadow:0 7px 0 #000,0 0 18px #e8702a55}",
    ".tile[aria-current]{border-color:#5fb8ac;box-shadow:0 4px 0 #000,0 0 0 2px #5fb8ac55}",
    ".art{display:grid;place-items:center;aspect-ratio:16/10;padding:12px;background:radial-gradient(circle at 50% 40%,#3a2c22,#0f0b08)}",
    ".art img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block}",
    ".meta{display:grid;gap:4px;padding:10px 12px 14px;border-top:2px solid #0008}",
    ".name{font:bold 16px/1.2 Tahoma,Arial,sans-serif;color:#f4e8cc}",
    ".blurb{font-size:13px;color:#cdbf9f}",
    ".here{position:absolute;top:8px;right:8px;padding:3px 7px;background:#5fb8ac;color:#0b2b27;border-radius:4px;font:bold 11px/1 'Courier New',monospace;letter-spacing:1px}",
    ".go{margin-top:4px;font:bold 11px/1 'Courier New',monospace;letter-spacing:1.5px;color:#e8702a}",
    ".warn{margin:10px 0 0;padding:10px 12px;border:2px solid #e8702a;border-radius:8px;background:#2a160a}",
    ".warn p{margin:0 0 8px}.warn .row{display:flex;gap:8px;flex-wrap:wrap}",
    ".warn button{min-height:40px;padding:0 14px;cursor:pointer;font:bold 14px Tahoma,Arial,sans-serif;border-radius:6px;border:2px solid #f4e8cc;background:transparent;color:#f4e8cc}",
    ".warn button.leave{background:#e8702a;color:#17110d;border-color:#e8702a}",
    "@media (max-width:520px){.grid{grid-template-columns:1fr}.art{aspect-ratio:2/1;padding:8px}.top img{height:34px}.cab{padding:10px}}",
    "@media (prefers-reduced-motion:no-preference){dialog[open] .cab{animation:pop .22s ease-out}@keyframes pop{from{transform:translateY(10px) scale(.97);opacity:0}}}",
    "@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}"
  ].join("\n");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function img(file, w, h, alt) {
    var i = el("img");
    i.src = base + file; i.width = w; i.height = h; i.alt = alt; i.decoding = "async";
    return i;
  }

  function build() {
    var host = el("div");
    host.setAttribute("data-phatt-arcade", "");
    var root = host.attachShadow({ mode: "open" });
    var style = el("style"); style.textContent = CSS; root.appendChild(style);

    var bar = el("div", "bar");
    var open = el("button", "open");
    open.type = "button";
    open.setAttribute("aria-haspopup", "dialog");
    open.setAttribute("aria-label", "Open the Phatt Gaming Arcade game picker");
    open.appendChild(img("phatt-gaming-arcade.webp", 720, 258, ""));
    open.lastChild.style.width = "auto";
    open.appendChild(el("span", "grid-ic", "GAMES ▾"));
    bar.appendChild(open); root.appendChild(bar);

    var dlg = el("dialog");
    dlg.setAttribute("aria-labelledby", "arc-h");
    var cab = el("div", "cab");
    var top = el("div", "top");
    top.appendChild(img("phatt-gaming-arcade.webp", 720, 258, "Phatt Gaming Arcade"));
    var close = el("button", "close", "Close ✕");
    close.type = "button"; close.setAttribute("aria-label", "Close the game picker");
    top.appendChild(close); cab.appendChild(top);
    var h = el("h2", "", "Pick a cabinet"); h.id = "arc-h"; cab.appendChild(h);
    cab.appendChild(el("p", "sub", "Every game in the Phatt Gaming Arcade. Choose one to head to its lobby."));
    var list = el("ul", "grid"); cab.appendChild(list);
    var warn = el("div", "warn"); warn.hidden = true; warn.setAttribute("role", "alert"); cab.appendChild(warn);
    dlg.appendChild(cab); root.appendChild(dlg);

    function showWarn(msg, g) {
      warn.textContent = "";
      warn.appendChild(el("p", "", msg + " Go to " + g.name + " anyway?"));
      var row = el("div", "row");
      var stay = el("button", "", "Stay here"); stay.type = "button";
      var leave = el("button", "leave", "Leave for " + g.name); leave.type = "button";
      stay.onclick = function () { warn.hidden = true; };
      leave.onclick = function () { location.href = g.url; };
      row.appendChild(stay); row.appendChild(leave); warn.appendChild(row);
      warn.hidden = false; stay.focus();
    }

    GAMES.forEach(function (g) {
      var li = el("li");
      var isCur = g.id === current;
      var t = el(isCur ? "button" : "a", "tile");
      if (isCur) { t.type = "button"; t.setAttribute("aria-current", "true"); }
      else {
        t.href = g.url;
        t.onclick = function (e) {
          var msg = guard();
          if (msg) { e.preventDefault(); showWarn(msg, g); }
        };
      }
      var art = el("div", "art"); art.appendChild(img(g.logo, g.w, g.h, g.name + " logo")); t.appendChild(art);
      var meta = el("div", "meta");
      meta.appendChild(el("span", "name", g.name));
      meta.appendChild(el("span", "blurb", g.blurb));
      meta.appendChild(el("span", "go", isCur ? "YOU ARE HERE" : "PLAY ▶"));
      t.appendChild(meta);
      if (isCur) {
        t.appendChild(el("span", "here", "NOW PLAYING"));
        t.setAttribute("aria-label", g.name + ", the game you are in. Close the picker.");
        t.onclick = function () { dlg.close(); };
      }
      li.appendChild(t); list.appendChild(li);
    });

    function openIt() {
      // the Arcade dock (party/phatt-party.js) is the one game switcher when it is on the page: open its Games tab
      if (window.PhattParty && typeof window.PhattParty.open === "function") { window.PhattParty.open("games"); return; }
      warn.hidden = true; if (!dlg.open) dlg.showModal(); close.focus();
    }
    open.onclick = openIt;
    close.onclick = function () { dlg.close(); };
    dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", function () { open.focus(); });
    // The dialog covers the full viewport width of its box; clicks on the cabinet's outer margin land on <dialog>.
    return host;
  }

  function mount() {
    if (document.querySelector("[data-phatt-arcade]")) return;
    var host = build();
    var sel = script && script.dataset.mount;
    var target = sel && document.querySelector(sel);
    var parent = target || document.body;
    parent.insertBefore(host, parent.firstChild);
  }
  window.PhattArcade = { games: GAMES, setGuard: function (fn) { guard = fn || function () { return ""; }; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
