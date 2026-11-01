/* Layout: full-width on computers; on phones the site looks and works like an app
 * (compact header, bottom tab bar, "More" menu with every section). */
(function () {
  "use strict";
  const TABS = [
    ["home", "Home", '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
    ["legal", "Legal Help", '<path d="M12 3v18M5 7h14M6 7l-3 6h6L6 7zm12 0-3 6h6l-3-6zM7 21h10"/>'],
    ["community", "Meechie's Book", '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14 20c0-2.4 1.4-4.4 3.5-5"/>'],
    ["radio", "Radio", '<circle cx="12" cy="13" r="3"/><path d="M5 9h14v11H5zM7 9l9-5"/>'],
    ["tv", "Movies & TV", '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 21h4M12 17v4"/>'],
  ];
  const css = document.createElement("style");
  css.textContent = `
:root{--tabbar:0px}
/* computers: use the whole screen */
@media (min-width:761px), (pointer:fine){
  .wrap{max-width:none!important;padding-inline:clamp(20px,3.2vw,56px)!important}
  #v-videos .yt-stage,#v-videos .tt-box,#v-videos .lv-card{max-width:1280px!important}
}
/* phones: app layout */
@media (max-width:760px) and (pointer:coarse){
  :root{--tabbar:calc(60px + env(safe-area-inset-bottom,0px))}
  body{padding-bottom:var(--tabbar)}
  body.has-player{padding-bottom:calc(var(--tabbar) + 150px)!important}
  header.bar nav.tabs{order:9;width:100%;margin:0!important;padding-bottom:2px}
  header.bar .brand small{display:none}
  .player-bar{bottom:var(--tabbar)!important;padding-bottom:0!important}
  #ai-fab,#ai-panel,#mw-fab{bottom:calc(var(--tabbar) + 12px)!important}
  body.has-player #ai-fab,body.has-player #ai-panel,body.has-player #mw-fab{bottom:calc(var(--tabbar) + 84px)!important}
  #ai-hi{bottom:calc(var(--tabbar) + 70px)!important}body.has-player #ai-hi{bottom:calc(var(--tabbar) + 142px)!important}
  #ai-panel{height:min(560px,calc(100dvh - var(--tabbar) - 120px))!important}
  .toast{bottom:calc(var(--tabbar) + 16px)!important}
  body.has-player .toast{bottom:calc(var(--tabbar) + 90px)!important}
  #v-clips .clips{height:calc(100dvh - 64px - var(--tabbar) - var(--shell-h,48px))!important}
  body.has-player #v-clips .clips{height:calc(100dvh - 64px - var(--tabbar) - 72px - var(--shell-h,48px))!important}
  #mw-bar{bottom:var(--tabbar)!important}
  .apptab{display:grid!important}
}
#hdr-right{display:flex;align-items:center;gap:6px;flex:none;margin-left:8px}
@media (max-width:640px){#hdr-right{position:static;margin-left:auto}#hdr-right .authbar{position:static!important;margin:0}}
#hdr-menu{display:inline-flex!important;align-items:center;place-items:center;gap:0;border:1px solid var(--gold,#d4a843);background:#15130f;color:var(--gold-hi,#f0cf78);border-radius:12px;padding:7px 12px;font:800 13px var(--body,system-ui);cursor:pointer;margin-left:8px}
/* computers: one clean row with the main sections; everything else is under "☰ Menu" */
@media (min-width:761px), (pointer:fine){
  header.bar nav.tabs{flex-wrap:nowrap!important;overflow-x:auto!important;overflow-y:hidden!important}
  header.bar nav.tabs a:not(.core):not([aria-current=page]){display:none!important}
  .appmore{align-items:flex-start;justify-content:flex-end}
  .appmore .sheet{width:min(560px,calc(100vw - 32px));max-height:min(80dvh,720px);margin:76px 16px 0 0;border:1px solid var(--gold,#d4a843);border-radius:20px;padding:14px 16px 16px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
  .appmore .grab{display:none}
  .appmore .grid{grid-template-columns:repeat(4,1fr)}
}
header.bar{backdrop-filter:blur(16px)}
/* phones: the header is one fixed 56px row (brand · Join · Menu). The section links live in the bottom tabs and ☰ Menu,
   so the header's link row is hidden here; before, it wrapped to a second row and spilled under the Book bar (visitor check, 2026-10-27). */
@media (max-width:760px){
  header.bar nav.tabs{display:none!important}
  header.bar .bar-in{flex-wrap:nowrap!important;gap:8px!important}
  header.bar .brand{min-width:0;flex:1 1 auto}
  header.bar .brand b{font-size:14px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
  header.bar .brand svg{flex:none}
}
@media (max-width:480px){header.bar .brand b{font-size:12.5px!important;letter-spacing:.02em!important}}
nav.tabs a{letter-spacing:.02em}
.apptab{display:none;position:fixed;left:0;right:0;bottom:0;z-index:9990;height:var(--tabbar);padding-bottom:env(safe-area-inset-bottom,0px);grid-template-columns:repeat(6,1fr);background:color-mix(in srgb,#0b0a08 94%,transparent);backdrop-filter:blur(14px);border-top:1px solid var(--gold-lo,#8c6d26)}
.apptab a,.apptab button{display:grid;justify-items:center;align-content:center;gap:3px;white-space:nowrap;letter-spacing:-.01em;color:var(--muted,#a99f8b);text-decoration:none;font:700 10.5px var(--body,system-ui);background:none;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.apptab svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.apptab a[aria-current=page]{color:var(--gold-hi,#f0cf78)}
.apptab a[aria-current=page] svg{filter:drop-shadow(0 0 6px rgba(212,168,67,.6))}
@media (max-width:760px) and (pointer:coarse){#hdr-menu{padding:6px 10px;font-size:16px;margin-left:6px}#hdr-menu .t{display:none}}
.appmore{position:fixed;inset:0;z-index:10040;background:rgba(0,0,0,.55);display:flex;align-items:flex-end}
.appmore[hidden]{display:none!important}
.appmore .sheet{width:100%;max-height:78dvh;overflow:auto;background:#15130f;border-top:1px solid var(--gold,#d4a843);border-radius:20px 20px 0 0;padding:10px 14px calc(var(--tabbar) + 14px);animation:sheetUp .22s ease}
@keyframes sheetUp{from{transform:translateY(40px);opacity:.4}}
.appmore .grab{width:44px;height:5px;border-radius:9px;background:#3a3223;margin:2px auto 12px}
.appmore .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.appmore .grid a{display:grid;justify-items:center;gap:6px;padding:14px 6px;border:1px solid var(--line,#3a3223);border-radius:14px;color:var(--text,#f3ecdc);text-decoration:none;font:700 13px var(--body,system-ui);text-align:center;background:#0f0d09}
.appmore .grid a span{font-size:24px}
.appmore .grid a[aria-current=page]{border-color:var(--gold,#d4a843);color:var(--gold-hi,#f0cf78)}`;
  document.head.appendChild(css);

  const ICON = { live: "🔴", predict: "🔮", jobs: "💼", books: "📚", liveradio: "📡", livetv: "📺", home: "🏠", services: "🧰", shop: "🛍️", community: "👥", radio: "📻", tv: "🍿", dj: "🎛️", clips: "🎬", videos: "📺", watch: "👀", world: "🌐", games: "🎮", creators: "🎨", chat: "💬", messages: "✉️", ads: "📌", promote: "📣", contact: "📞", friends: "🤝", dating: "💘", fans: "🔞", studio: "🎚️", preach: "✝️", markets: "📈", coin: "🪙", legal: "⚖️" };
  // the sections that always show in the computer header row (the rest live under "☰ Menu")
  const CORE = ["home", "legal", "services", "community", "radio", "tv", "videos", "shop", "messages", "live"];
  document.querySelectorAll("header nav.tabs a[data-go]").forEach((a) => { if (CORE.includes(a.dataset.go)) a.classList.add("core"); });
  const bar = document.createElement("nav");
  bar.className = "apptab"; bar.setAttribute("aria-label", "App tabs");
  bar.innerHTML = TABS.map(([v, n, p]) => `<a href="#${v}" data-go="${v}"><svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>${n}</a>`).join("") +
    `<button type="button" id="app-more" aria-label="More sections"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>More</button>`;
  const more = document.createElement("div");
  more.className = "appmore"; more.hidden = true;
  document.body.append(bar, more);

  function fillMore() {
    const links = [...document.querySelectorAll("header nav.tabs a[data-go]")];
    /* Curated order (2026-11-01): the doors visitors come for lead the grid —
       Radio, MW TV, Watch the Setup, Shop, Coin Jackpot — then everything
       else in header order (Array sort is stable). Kids and All Apps are
       pinned tiles ahead of this list. */
    const PIN = ["radio", "mwtv", "watch", "shop", "games"];
    links.sort((a, b) => { const ia = PIN.indexOf(a.dataset.go), ib = PIN.indexOf(b.dataset.go); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    more.innerHTML = `<div class="sheet" role="dialog" aria-label="All sections"><div class="grab"></div><div class="grid"><a href="/kids-app/"><span>🧒</span>Kids</a><a href="/apps/"><span>📲</span>All Apps</a>${links.map((a) => `<a href="#${a.dataset.go}" data-go="${a.dataset.go}"${a.getAttribute("aria-current") ? ' aria-current="page"' : ""}><span>${ICON[a.dataset.go] || "•"}</span>${[...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()}</a>`).join("")}</div></div>`;
  }
  document.getElementById("app-more").addEventListener("click", () => { fillMore(); more.hidden = false; });
  // a Menu button in the header too, so every section is always one tap away
  const auth = document.getElementById("authbar");
  if (auth && !document.getElementById("hdr-menu")) { const m = document.createElement("button"); m.type = "button"; m.id = "hdr-menu"; m.setAttribute("aria-label", "All sections"); m.innerHTML = '☰<span class="t"> Menu</span>'; const holder = document.createElement("span"); holder.id = "hdr-right"; auth.replaceWith(holder); holder.append(auth, m); m.addEventListener("click", () => { fillMore(); more.hidden = false; }); }
  more.addEventListener("click", (e) => { if (e.target === more || e.target.closest("[data-go]")) more.hidden = true; });
  addEventListener("keydown", (e) => { if (e.key === "Escape") more.hidden = true; });
  // keep the bottom tabs in step with the page
  const sync = () => { const cur = (document.querySelector("header nav.tabs a[aria-current=page]") || {}).dataset?.go || location.hash.slice(1) || "home"; bar.querySelectorAll("a").forEach((a) => (a.dataset.go === cur ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"))); };
  const nav = document.querySelector("header nav.tabs");
  if (nav) new MutationObserver(sync).observe(nav, { attributes: true, subtree: true, attributeFilter: ["aria-current"] });
  addEventListener("hashchange", sync); sync();

  /* Auto-update consolidation (P3, 2026-11-01): this file used to run its own
   * /version.json checker (every 5 min plus a 4 s first check) whose busy test
   * knew about media, inputs and dialogs but NOT about a live share or the
   * sound gate — right after a deploy it could reload a tab the gated
   * checkers would have held. That checker is retired. The shell checker in
   * app-core.js (sound gate + share gate + per-build loop guard) is now the
   * one shell update path; the dj.js guardian keeps its booth update note
   * and booth rules and stands down via the shared mw-guard stamp. */
})();

/* Featured music video on Home: plays muted when you scroll to it (like TikTok/Instagram); tap for sound. */
(function () {
  const v = document.getElementById("fv"), btn = document.getElementById("fv-snd"); if (!v) return;
  const home = document.getElementById("v-home");
  const vis = () => !home.hidden && document.visibilityState === "visible";
  new IntersectionObserver((e) => e.forEach((x) => { if (x.isIntersecting && x.intersectionRatio > 0.5 && vis()) v.play().catch(() => {}); else v.pause(); }), { threshold: [0, 0.5] }).observe(v);
  new MutationObserver(() => { if (home.hidden) v.pause(); }).observe(home, { attributes: true, attributeFilter: ["hidden"] });
  const sound = (on) => { const was = !v.muted; v.muted = !on; btn.textContent = on ? "🔊 Sound on" : "🔇 Tap for sound"; if (on) { window.MW_videoSound ? MW_videoSound.start() : (() => { try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {} })(); v.play().catch(() => {}); } else if (was) window.MW_videoSound?.end(); };
  v.addEventListener("pause", () => { if (!v.muted) sound(false); });
  btn.addEventListener("click", () => sound(v.muted));
  v.addEventListener("click", () => { if (v.muted) sound(true); else if (v.paused) v.play(); else v.pause(); });
  try { if (typeof media !== "undefined") media.addEventListener("play", () => { if (!v.muted) { v.muted = true; btn.textContent = "🔇 Tap for sound"; } }); } catch (_) {}
})();
