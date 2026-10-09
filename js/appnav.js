/* Layout: full-width on computers; on phones the site looks and works like an app
 * (compact header, bottom tab bar, "More" menu with every section). */
(function () {
  "use strict";
  const TABS = [
    ["home", "Home", '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
    ["clips", "Clips", '<path d="M8 5v14l11-7z"/>'],
    ["radio", "Radio", '<circle cx="12" cy="13" r="3"/><path d="M5 9h14v11H5zM7 9l9-5"/>'],
    ["community", "Feed", '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14 20c0-2.4 1.4-4.4 3.5-5"/>'],
  ];
  const css = document.createElement("style");
  css.textContent = `
:root{--tabbar:0px}
/* computers: use the whole screen */
@media (min-width:761px){
  .wrap{max-width:none!important;padding-inline:clamp(20px,3.2vw,56px)!important}
  #v-videos .yt-stage,#v-videos .tt-box,#v-videos .lv-card{max-width:1280px!important}
}
/* phones: app layout */
@media (max-width:760px){
  :root{--tabbar:calc(60px + env(safe-area-inset-bottom,0px))}
  body{padding-bottom:var(--tabbar)}
  body.has-player{padding-bottom:calc(var(--tabbar) + 150px)!important}
  header.bar nav.tabs{order:9;width:100%;margin:0!important;padding-bottom:2px}
  header.bar .brand small{display:none}
  .player-bar{bottom:var(--tabbar)!important}
  #ai-fab,#ai-panel,#mw-fab{bottom:calc(var(--tabbar) + 12px)!important}
  body.has-player #ai-fab,body.has-player #ai-panel,body.has-player #mw-fab{bottom:calc(var(--tabbar) + 84px)!important}
  #ai-panel{height:min(560px,calc(100dvh - var(--tabbar) - 120px))!important}
  .toast{bottom:calc(var(--tabbar) + 16px)!important}
  body.has-player .toast{bottom:calc(var(--tabbar) + 90px)!important}
  #v-clips .clips{height:calc(100dvh - 64px - var(--tabbar))!important}
  body.has-player #v-clips .clips{height:calc(100dvh - 64px - var(--tabbar) - 72px)!important}
  #mw-bar{bottom:var(--tabbar)!important}
  .apptab{display:grid!important}
}
#hdr-right{display:flex;align-items:center;gap:6px;flex:none;margin-left:8px}
@media (max-width:640px){#hdr-right{position:absolute;right:16px;top:12px;margin:0}#hdr-right .authbar{position:static!important;margin:0}}
#hdr-menu{display:inline-grid;place-items:center;gap:0;border:1px solid var(--gold,#d4a843);background:#15130f;color:var(--gold-hi,#f0cf78);border-radius:12px;padding:7px 12px;font:800 13px var(--body,system-ui);cursor:pointer;margin-left:8px}
@media (min-width:761px){#hdr-menu{display:none}header.bar nav.tabs{flex-wrap:wrap!important;overflow:visible!important;row-gap:4px}}
.apptab{display:none;position:fixed;left:0;right:0;bottom:0;z-index:9990;height:var(--tabbar);padding-bottom:env(safe-area-inset-bottom,0px);grid-template-columns:repeat(5,1fr);background:color-mix(in srgb,#0b0a08 94%,transparent);backdrop-filter:blur(14px);border-top:1px solid var(--gold-lo,#8c6d26)}
.apptab a,.apptab button{display:grid;justify-items:center;align-content:center;gap:3px;color:var(--muted,#a99f8b);text-decoration:none;font:700 10.5px var(--body,system-ui);background:none;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.apptab svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.apptab a[aria-current=page]{color:var(--gold-hi,#f0cf78)}
.apptab a[aria-current=page] svg{filter:drop-shadow(0 0 6px rgba(212,168,67,.6))}
@media (max-width:760px){#hdr-menu{padding:6px 10px;font-size:16px;margin-left:6px}#hdr-menu .t{display:none}}
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

  const ICON = { home: "🏠", services: "🧰", shop: "🛍️", community: "👥", radio: "📻", clips: "🎬", videos: "📺", world: "🌐", games: "🎮", creators: "🎨", chat: "💬", messages: "✉️", ads: "📌", promote: "📣", contact: "📞", friends: "🤝", dating: "💘", studio: "🎚️" };
  const bar = document.createElement("nav");
  bar.className = "apptab"; bar.setAttribute("aria-label", "App tabs");
  bar.innerHTML = TABS.map(([v, n, p]) => `<a href="#${v}" data-go="${v}"><svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>${n}</a>`).join("") +
    `<button type="button" id="app-more" aria-label="More sections"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>More</button>`;
  const more = document.createElement("div");
  more.className = "appmore"; more.hidden = true;
  document.body.append(bar, more);

  function fillMore() {
    const links = [...document.querySelectorAll("header nav.tabs a[data-go]")];
    more.innerHTML = `<div class="sheet" role="dialog" aria-label="All sections"><div class="grab"></div><div class="grid">${links.map((a) => `<a href="#${a.dataset.go}" data-go="${a.dataset.go}"${a.getAttribute("aria-current") ? ' aria-current="page"' : ""}><span>${ICON[a.dataset.go] || "•"}</span>${[...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()}</a>`).join("")}</div></div>`;
  }
  document.getElementById("app-more").addEventListener("click", () => { fillMore(); more.hidden = false; });
  // a Menu button in the header too, so every section is always one tap away
  const auth = document.getElementById("authbar");
  if (auth && !document.getElementById("hdr-menu")) { const m = document.createElement("button"); m.type = "button"; m.id = "hdr-menu"; m.setAttribute("aria-label", "All sections"); m.innerHTML = '☰<span class="t"> Menu</span>'; const holder = document.createElement("span"); holder.id = "hdr-right"; auth.replaceWith(holder); holder.append(auth, m); m.addEventListener("click", () => { fillMore(); more.hidden = false; }); }
  more.addEventListener("click", (e) => { if (e.target === more || e.target.closest("[data-go]")) more.hidden = true; });
  // keep the bottom tabs in step with the page
  const sync = () => { const cur = (document.querySelector("header nav.tabs a[aria-current=page]") || {}).dataset?.go || location.hash.slice(1) || "home"; bar.querySelectorAll("a").forEach((a) => (a.dataset.go === cur ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"))); };
  const nav = document.querySelector("header nav.tabs");
  if (nav) new MutationObserver(sync).observe(nav, { attributes: true, subtree: true, attributeFilter: ["aria-current"] });
  addEventListener("hashchange", sync); sync();
})();
