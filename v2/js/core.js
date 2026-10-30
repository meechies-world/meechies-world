/* ============================================================================
   MEECHIE'S WORLD — v2 CORE SHELL  (MAP §4.1)
   ----------------------------------------------------------------------------
   The core owns ONLY: boot, hash routing, the session, app modes, the entry
   greeting, the 5-minute guest wall, global chrome (header, phone bottom
   bar, menu sheet), and lazy-loading view modules on first entry.

   It must NEVER: block first paint on a view module; contain a view's own
   logic; write station state; fork a second session or data path. Every
   view talks to the server through this file's gateway, and to the station
   only through the read API handed to it in ctx (MAP §4.2/§4.4).

   Data: SAME live backend as the site today — /api/cf/* (session + docs
   store) and /api/station (presence). No forked data, no new backend.

   BOOT BUDGET (MAP §4.1/§4.5): this file + index.html + css/shell.css are
   the whole first load. Core JS target: under 60 KB transfer (gzip). The
   harness (v2/harness/check.mjs) measures it; a view's JS/CSS never counts
   against the shell — it loads when its view is first entered, and only
   then. That is the structural fix for the audit's finding that the DJ
   booth's code (half of all JS) used to parse on every page.
   ============================================================================ */

"use strict";

/* ------------------------------------------------------------------ *
 * 1. APP MODES (MAP §2.3) — the same contract as the live site:
 * /?app=<id> pins sessionStorage "mw-appmode"; the mode trims the chrome
 * to a slim app bar (its own bottom bar + a "Full site" escape hatch);
 * radio/ai modes hold a screen wake lock. The tab table is the live
 * site's own table, unchanged (MAP §4.6: app ids do not change).
 * ------------------------------------------------------------------ */
const APP_TABS = {
  book:   [["community", "🏠", "Feed"], ["friends", "👥", "Friends"], ["messages", "💬", "Messages"], ["clips", "🎬", "Clips"]],
  dating: [["dating", "❤️", "Dating"], ["messages", "💬", "Messages"], ["friends", "👥", "Friends"]],
  legal:  [["legal", "⚖️", "Legal Help"], ["contact", "📞", "Contact"]],
  shop:   [["shop", "🛍️", "Shop"], ["exclusives", "✨", "Exclusives"]],
  live:   [["live", "🔴", "Live"], ["predict", "🔮", "Predictions"], ["games", "🎮", "Games"]],
  studio: [["studio", "🎚️", "Studio"], ["dj", "🎵", "DJ"], ["radio", "📻", "Radio"]],
  tv:     [["tv", "📺", "Movies"], ["livetv", "📡", "Live TV"], ["videos", "🎬", "Videos"]],
  games:  [["games", "🎮", "Games"], ["predict", "🔮", "Predictions"], ["world", "🌐", "3D World"]],
  jobs:   [["jobs", "💼", "Jobs"], ["ads", "📌", "Ad Board"], ["promote", "📣", "Promote"]],
  books:  [["books", "📚", "Books"]],
  fans:   [["fans", "👑", "Fans"], ["messages", "💬", "Messages"]],
  world:  [["world", "🌐", "World"], ["chat", "💬", "Walkie"]],
  radio:  [["radio", "📻", "Radio"], ["dj", "🎛️", "DJ Station"], ["tv", "📺", "Watch"], ["videos", "🎬", "Videos"]],
  ai:     [["radio", "📻", "Radio"], ["dj", "🎛️", "DJ Station"], ["tv", "📺", "Watch"], ["videos", "🎬", "Videos"]],
};

const AppMode = (() => {
  let mode = null;
  try {
    const qa = new URLSearchParams(location.search).get("app");
    if (qa && APP_TABS[qa]) sessionStorage.setItem("mw-appmode", qa);
    const am = sessionStorage.getItem("mw-appmode");
    if (am && APP_TABS[am]) mode = am;
  } catch (_) {}
  if (mode) {
    document.documentElement.classList.add("appmode", "appmode-" + mode);
    if ((mode === "radio" || mode === "ai") && navigator.wakeLock) {
      let wl = null;
      const grab = () => {
        if (document.visibilityState === "visible" && !wl) {
          navigator.wakeLock.request("screen").then((w) => {
            wl = w;
            w.addEventListener("release", () => { wl = null; });
          }).catch(() => {});
        }
      };
      document.addEventListener("visibilitychange", grab);
      document.addEventListener("pointerdown", grab);
      grab();
    }
  }
  return {
    id: mode,
    tabs: mode ? APP_TABS[mode] : null,
    active: !!mode,
    exit() { try { sessionStorage.removeItem("mw-appmode"); } catch (_) {} },
  };
})();

function paintAppBar() {
  if (!AppMode.active || document.getElementById("appbar")) return;
  const bar = document.createElement("nav");
  bar.id = "appbar";
  bar.setAttribute("aria-label", AppMode.id + " app");
  let h = AppMode.tabs.map((t) =>
    `<a href="#${t[0]}" data-go="${t[0]}">${t[1]}<span>${t[2]}</span></a>`).join("");
  if (AppMode.id === "ai") h = `<a href="#" id="appbar-ai">🎙️<span>Meechie AI</span></a>` + h;
  bar.innerHTML = h + `<a href="/" id="appbar-full">🌐<span>Full site</span></a>`;
  document.body.appendChild(bar);
  document.getElementById("appbar-full").addEventListener("click", () => AppMode.exit());
  const aib = document.getElementById("appbar-ai");
  if (aib) aib.addEventListener("click", (e) => {
    e.preventDefault();
    openAI();
  });
  if (!location.hash && AppMode.tabs[0]) location.hash = "#" + AppMode.tabs[0][0];
}

/* ------------------------------------------------------------------ *
 * 2. SESSION — the live site's own session, shared, not forked:
 * localStorage "mw-cf-session" (JSON with access_token + user), sent as
 * `Authorization: Bearer <token>` (the cf-client.js pattern). A member
 * signed in on the live site is signed in here, on the same browser.
 * ------------------------------------------------------------------ */
const SESSION_KEY = "mw-cf-session";
const Session = {
  _s: null,
  load() {
    try { this._s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch (_) { this._s = null; }
    return this._s;
  },
  get() { return this._s; },
  user() { return (this._s && this._s.user) || null; },
  async refresh() {
    if (!this._s) return null;
    try {
      const r = await fetch("/api/cf/auth/session", {
        method: "POST",
        headers: Gateway.headers(),
        body: "{}",
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      if (j && j.data && j.data.session) {
        this._s = j.data.session;
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(this._s)); } catch (_) {}
      } else if (r.status === 401) {
        this._s = null;
        try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
      }
    } catch (_) { /* offline: keep the stored session, like the live site */ }
    return this._s;
  },
};

/* ------------------------------------------------------------------ *
 * 3. GATEWAY (MAP §4.4) — the one client every module uses.
 * rest(): POST /api/cf/rest with the live query shape
 *   {table, op, select, filters:[[col,op,val]], order, limit}
 * readDoc(): the docs-store read the whole site runs on.
 * ------------------------------------------------------------------ */
const Gateway = {
  headers(extra) {
    const s = Session.get();
    return {
      "content-type": "application/json",
      ...(s && s.access_token ? { authorization: "Bearer " + s.access_token } : {}),
      ...(extra || {}),
    };
  },
  async call(path, body) {
    try {
      const r = await fetch("/api/cf/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      const j = await r.json().catch(() => ({ error: { message: "Server error (" + r.status + ")" } }));
      if (!r.ok && !j.error) j.error = { message: "Server error (" + r.status + ")", code: String(r.status) };
      return j;
    } catch (_) {
      return { data: null, error: { message: "Network problem.", code: "network" } };
    }
  },
  async rest(q) {
    const j = await this.call("rest", {
      table: q.table, op: q.op || "select", select: q.select || "*",
      filters: q.filters || [], order: q.order || null,
      limit: q.limit == null ? null : q.limit,
    });
    return { data: j.data == null ? null : j.data, error: j.error || null };
  },
  /* The shared station document — read-only here. Writes belong to the
     station module's typed state layer (MAP §4.3), a later phase. */
  async readDoc(path) {
    const { data, error } = await this.rest({
      table: "docs", filters: [["path", "eq", path]], limit: 1,
    });
    if (error || !data || !data[0]) return null;
    return data[0].data;
  },
  readStation() { return this.readDoc("radio/dj"); },
};

/* ------------------------------------------------------------------ *
 * 4. PRESENCE — GET /api/station is the live site's presence ping
 * (PHASE1-VERIFY Item 5: ~12 s client cadence, 35 s online window).
 * The shell pings like any visitor (guests included) and paints the
 * header chip. cid is shell-scoped so test-address traffic is visible
 * as itself in the pings table.
 * ------------------------------------------------------------------ */
const Presence = {
  cid: null,
  last: null,
  /* the l=1 listening flag (Phase 5): the player engine reports this
     seat's TUNE IN state here, and every ping carries it — the live
     site's own rule (dj.js stationPing sends l = listening ? 1 : 0),
     so /api/station listening counts include v2 seats. */
  _listening: false,
  setListening(on) { this._listening = !!on; },
  init() {
    try {
      this.cid = sessionStorage.getItem("mw-v2-cid");
      if (!this.cid) {
        this.cid = "v2" + Math.random().toString(36).slice(2, 12);
        sessionStorage.setItem("mw-v2-cid", this.cid);
      }
    } catch (_) { this.cid = "v2guest"; }
    const tick = () => this.ping();
    tick();
    setInterval(tick, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.ping();
    });
  },
  async ping() {
    try {
      const u = Session.user();
      const qs = new URLSearchParams({ cid: this.cid });
      qs.set("l", this._listening ? "1" : "0");
      if (u && u.id) { qs.set("u", u.id); qs.set("n", u.name || ""); }
      const r = await fetch("/api/station?" + qs.toString(), { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) return;
      this.last = j;
      const chip = document.getElementById("online-chip");
      const n = document.getElementById("online-n");
      if (chip && n && typeof j.online === "number") {
        n.textContent = String(j.online);
        chip.hidden = false;
      }
    } catch (_) { /* presence is decoration; never break boot for it */ }
  },
};

/* ------------------------------------------------------------------ *
 * 5. VIEW REGISTRY + ROUTER (MAP §4.1/§4.2, inventory §2.1)
 * A view module loads ONLY when its view is first entered — dynamic
 * import, cached after first load. Each module exports:
 *   render(root, ctx)  — paint into the shell's <main>
 *   destroy()          — optional; called when leaving the view
 * ctx = { session, gateway, presence, view } — the only doors a view
 * gets. Placeholder modules render the view's name in brand style;
 * they are later phases, replaced one by one without touching core.
 * ------------------------------------------------------------------ */
const VIEWS = {
  home:      { name: "Home",            css: "css/home.css", load: () => import("./views/home.js") },
  community: { name: "Meechie's Book",  css: "css/book.css",     load: () => import("./views/community.js") },
  friends:   { name: "Friends",         css: "css/friends.css",  load: () => import("./views/friends.js") },
  messages:  { name: "Messages",        css: "css/messages.css", load: () => import("./views/messages.js") },
  clips:     { name: "Clips",           css: "css/clips.css",    load: () => import("./views/clips.js") },
  chat:      { name: "Chat & Walkie",   css: "css/chat.css",     load: () => import("./views/chat.js") },
  dating:    { name: "Dating",          css: "css/dating.css", load: () => import("./views/dating.js") },
  radio:     { name: "Radio",           css: "css/radio.css", load: () => import("./views/radio.js") },
  dj:        { name: "DJ Station",      css: "css/dj.css", load: () => import("./views/dj.js") },
  tv:        { name: "Cinema & TV",     css: "css/tv.css", load: () => import("./views/tv.js") },
  mwtv:      { name: "MW TV",           css: "css/mwtv.css", load: () => import("./views/mwtv.js") },
  watch:     { name: "Watch the Setup", css: "css/watch.css", load: () => import("./views/watch.js") },
  live:      { name: "Live",            css: "css/live.css", load: () => import("./views/live.js") },
  studio:    { name: "Studio",          css: "css/studio.css", load: () => import("./views/studio.js") },
  shop:      { name: "Shop",            css: "css/shop.css", load: () => import("./views/shop.js") },
  exclusives:{ name: "Exclusives",      css: "css/exclusives.css", load: () => import("./views/exclusives.js") },
  books:     { name: "Books",           css: "css/books.css", load: () => import("./views/books.js") },
  games:     { name: "Games",           css: "css/games.css", load: () => import("./views/games.js") },
  coin:      { name: "Meechie's Coin",  css: "css/coin.css", load: () => import("./views/coin.js") },
  jobs:      { name: "Jobs",            css: "css/jobs.css", load: () => import("./views/jobs.js") },
  ads:       { name: "Ad Board",        css: "css/ads.css", load: () => import("./views/ads.js") },
  promote:   { name: "Promote",         css: "css/promote.css", load: () => import("./views/promote.js") },
  legal:     { name: "Legal Help",      css: "css/legal.css", load: () => import("./views/legal.js") },
  contact:   { name: "Contact",         css: "css/contact.css", load: () => import("./views/contact.js") },
  services:  { name: "Services",        css: "css/services.css", load: () => import("./views/services.js") },
  fans:      { name: "Meechie's Fans",  css: "css/fans.css", load: () => import("./views/fans.js") },
  creators:  { name: "Creators",        css: "css/creators.css", load: () => import("./views/creators.js") },
  predict:   { name: "Predictions",     css: "css/predict.css", load: () => import("./views/predict.js") },
  markets:   { name: "Markets",         css: "css/markets.css", load: () => import("./views/markets.js") },
  preach:    { name: "ASAP Preach",     css: "css/preach.css", load: () => import("./views/preach.js") },
  connect:   { name: "Connect",         css: "css/connect.css", load: () => import("./views/connect.js") },
  videos:    { name: "Videos",          css: "css/videos.css", load: () => import("./views/videos.js") },
  world:     { name: "Virtual World",   css: "css/world.css", load: () => import("./views/world.js") },
  liveradio: { name: "Live Radio",      css: "css/directory.css", load: () => import("./views/directory.js") },
  livetv:    { name: "Live TV",         css: "css/directory.css", load: () => import("./views/directory.js") },
  profile:   { name: "Profile",         css: "css/profile.css", load: () => import("./views/profile.js") },
};

/* PERSISTENT STAGE (Phase 5, carried Phase 2 gap 2): the viewer views
   that carry an engine stage — radio, mwtv, watch — are mounted ONCE
   and kept alive in the shell, exactly the live site's own model (its
   sections stay mounted and are only hidden). Leaving one suspends it
   and hides its section; its engine screen, players and surfaces are
   never destroyed, so video and music never stop when the visitor
   navigates away (Law 5). Every other view keeps the mount/unmount
   lifecycle. A kept view exports optional suspend()/resume(). */
const KEEPALIVE = new Set(["radio", "mwtv", "watch"]);

const Router = {
  current: null,
  _mod: null,
  _cssDone: new Set(),
  _kept: new Map(),
  root: null,
  init(root) {
    this.root = root;
    addEventListener("hashchange", () => this.route());
    document.addEventListener("click", (e) => {
      const pf = e.target.closest("[data-profile]");
      if (pf) {
        const uid = pf.getAttribute("data-profile");
        if (uid) { e.preventDefault(); location.hash = "#profile/" + encodeURIComponent(uid); }
        return;
      }
      const a = e.target.closest("[data-go]");
      if (!a) return;
      const go = a.getAttribute("data-go");
      if (!go || !VIEWS[go]) return;
      e.preventDefault();
      if (location.hash !== "#" + go) location.hash = "#" + go;
      else this.route();
    });
    this.route();
  },
  name() {
    const h = (location.hash || "").replace(/^#\/?/, "").split(/[?&/]/)[0];
    return VIEWS[h] ? h : "home";
  },
  /* the tail after "#view/" — profile pages ride it (#profile/<uid>) */
  arg() {
    const h = (location.hash || "").replace(/^#\/?/, "");
    const parts = h.split("/");
    return parts.length > 1 ? decodeURIComponent(parts.slice(1).join("/")) : "";
  },
  async route() {
    const name = this.name();
    const arg = this.arg();
    if (name === this.current && this._mod) {
      /* same view, new argument (a different profile): re-render in place */
      if (KEEPALIVE.has(name)) { this.syncChrome(name); return; }
      if (arg && this._arg !== arg && this._mod.render && this._section) {
        this._arg = arg;
        this._mod.render(this._section, this._ctx(name));
      }
      this.syncChrome(name);
      return;
    }
    const prev = this.current;
    if (prev && prev !== name) {
      if (KEEPALIVE.has(prev) && this._kept.has(prev)) {
        const k = this._kept.get(prev);
        if (k.mod && k.mod.suspend) { try { k.mod.suspend(); } catch (_) {} }
        k.section.hidden = true;
      } else if (this._mod && this._mod.destroy) { try { this._mod.destroy(); } catch (_) {} }
      this._mod = null;
    }
    this.current = name;
    this._arg = arg;
    document.body.dataset.view = name;
    this.syncChrome(name);
    const def = VIEWS[name];
    if (def.css && !this._cssDone.has(def.css)) {
      this._cssDone.add(def.css);
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = def.css;
      document.head.appendChild(link);
    }
    if (KEEPALIVE.has(name) && this._kept.has(name)) {
      const k = this._kept.get(name);
      k.section.hidden = false;
      this._mod = k.mod;
      if (k.mod && k.mod.resume) { try { k.mod.resume(); } catch (_) {} }
      scrollTo(0, 0);
      return;
    }
    let mod;
    try {
      mod = await (def.load ? def.load() : PLACEHOLDER());
    } catch (_) {
      mod = await PLACEHOLDER();
    }
    if (this.current !== name) return; // navigated away while loading
    this._mod = mod;
    [...this.root.children].forEach((c) => { if (!c._mw2keep) c.remove(); });
    const section = document.createElement("section");
    section.className = "view view-" + name;
    section.id = "v-" + name;
    this._section = section;
    if (KEEPALIVE.has(name)) {
      section._mw2keep = true;
      this._kept.set(name, { section, mod });
    }
    this.root.appendChild(section);
    mod.render(section, this._ctx(name));
    scrollTo(0, 0);
  },
  _ctx(name) {
    return {
      session: Session, gateway: Gateway, presence: Presence,
      view: { id: name, arg: this._arg || "", ...VIEWS[name] },
    };
  },
  syncChrome(name) {
    document.querySelectorAll("[data-go]").forEach((a) => {
      if (a.getAttribute("data-go") === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  },
};

/* ------------------------------------------------------------------ *
 * 6. CHROME — the phone bottom bar + "More" sheet (the live site's
 * appnav pattern): five core tabs on phones, every section one tap
 * away in the sheet; a Menu button beside the auth bar on desktop.
 * ------------------------------------------------------------------ */
const PHONE_TABS = [
  ["home", "Home", '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ["legal", "Legal Help", '<path d="M12 3v18M5 7h14M6 7l-3 6h6L6 7zm12 0-3 6h6l-3-6zM7 21h10"/>'],
  ["community", "Meechie's Book", '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14 20c0-2.4 1.4-4.4 3.5-5"/>'],
  ["radio", "Radio", '<circle cx="12" cy="13" r="3"/><path d="M5 9h14v11H5zM7 9l9-5"/>'],
  ["tv", "TV", '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M10 21h4M12 17v4"/>'],
];
const ICON = {
  live: "🔴", predict: "🔮", jobs: "💼", books: "📚", liveradio: "📡",
  livetv: "📺", home: "🏠", services: "🧰", shop: "🛍️", community: "👥",
  radio: "📻", tv: "🍿", dj: "🎛️", clips: "🎬", videos: "📺", world: "🌐",
  games: "🎮", creators: "🎨", chat: "💬", messages: "✉️", ads: "📌",
  promote: "📣", contact: "📞", friends: "🤝", dating: "💘", fans: "🔞",
  studio: "🎚️", preach: "✝️", markets: "📈", coin: "🪙", legal: "⚖️",
  watch: "👀", mwtv: "📺", exclusives: "✨", connect: "🔌",
};
const DESKTOP_CORE = ["home", "legal", "services", "community", "radio", "tv", "videos", "shop", "messages", "live"];

function paintChrome() {
  // desktop header: mark the always-visible core links (appnav rule)
  document.querySelectorAll("header nav.tabs a[data-go]").forEach((a) => {
    if (DESKTOP_CORE.includes(a.getAttribute("data-go"))) a.classList.add("core");
  });
  // phone bottom bar
  const bar = document.createElement("nav");
  bar.className = "apptab";
  bar.setAttribute("aria-label", "App tabs");
  bar.innerHTML =
    PHONE_TABS.map(([v, n, p]) =>
      `<a href="#${v}" data-go="${v}"><svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>${n}</a>`).join("") +
    `<button type="button" id="app-more" aria-label="More sections"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>More</button>`;
  const more = document.createElement("div");
  more.className = "appmore";
  more.hidden = true;
  document.body.append(bar, more);
  const fillMore = () => {
    const links = [...document.querySelectorAll("header nav.tabs a[data-go]")];
    more.innerHTML = `<div class="sheet" role="dialog" aria-label="All sections"><div class="grab"></div><div class="grid">${links.map((a) => {
      const go = a.getAttribute("data-go");
      const label = [...a.childNodes].filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join("").trim() || VIEWS[go].name;
      return `<a href="#${go}" data-go="${go}"><span>${ICON[go] || "•"}</span>${label}</a>`;
    }).join("")}</div></div>`;
    Router.syncChrome(Router.current || Router.name());
  };
  const open = () => { fillMore(); more.hidden = false; };
  document.getElementById("app-more").addEventListener("click", open);
  more.addEventListener("click", (e) => {
    if (e.target === more || e.target.closest("[data-go]")) more.hidden = true;
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") more.hidden = true; });
  // header Menu button, beside the auth bar (appnav rule)
  const auth = document.getElementById("authbar");
  if (auth && !document.getElementById("hdr-menu")) {
    const m = document.createElement("button");
    m.type = "button";
    m.id = "hdr-menu";
    m.setAttribute("aria-label", "All sections");
    m.innerHTML = '☰<span class="t"> Menu</span>';
    const holder = document.createElement("span");
    holder.id = "hdr-right";
    auth.replaceWith(holder);
    holder.append(auth, m);
    m.addEventListener("click", open);
  }
}

function paintAuthBar() {
  const bar = document.getElementById("authbar");
  if (!bar) return;
  const u = Session.user();
  if (u) {
    const name = (u.user_metadata && (u.user_metadata.name || u.user_metadata.handle)) ||
      u.name || u.email || "Member";
    bar.innerHTML = `<span class="btn sm ghost" aria-label="Signed in">👤 ${String(name).slice(0, 24)}</span>`;
  } else {
    bar.innerHTML = `<a class="btn sm" href="/" data-auth="signup">Join free</a>`;
  }
}

/* ------------------------------------------------------------------ *
 * 7. ENTRY GREETING + GUEST WALL (Law 10) — the live rules, verbatim
 * in effect: the Enter screen shows once per visit (never on MW TV);
 * guests browse free for 5 minutes, then the wall — and on MW TV the
 * wall waits until the viewer steps back into the site proper.
 * Sign-in itself is the live site's own flow in this phase: the gate's
 * actions hand the visitor to the main site, session shared.
 * ------------------------------------------------------------------ */
function paintEnter() {
  let seen = false;
  try { seen = sessionStorage.getItem("mw_entered") === "1"; } catch (_) {}
  if (seen || (location.hash || "") === "#mwtv") return;
  const e = document.getElementById("enter");
  if (!e) return;
  e.hidden = false;
  document.documentElement.style.overflow = "hidden";
  const close = () => {
    e.hidden = true;
    document.documentElement.style.overflow = "";
    try { sessionStorage.setItem("mw_entered", "1"); } catch (_) {}
  };
  document.getElementById("en-go").addEventListener("click", close);
  document.getElementById("en-mute").addEventListener("click", close);
}

function armGuestWall() {
  const signedIn = () => {
    if (Session.get()) return true;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if ((/^sb-.*-auth-token$/.test(k) || k === SESSION_KEY) &&
            localStorage.getItem(k) && localStorage.getItem(k) !== "null") return true;
      }
    } catch (_) {}
    return /[?&#](code=|access_token=|type=recovery)/.test(location.href);
  };
  if (signedIn()) return;
  setTimeout(() => {
    if (signedIn() || window.MW_OUTAGE) return;
    const gate = () => {
      if (signedIn() || window.MW_OUTAGE) return;
      document.documentElement.classList.add("gated");
      const g = document.getElementById("gate");
      if (g) g.hidden = false;
      const e = document.getElementById("enter");
      if (e) e.hidden = true;
    };
    if (document.body.dataset.view === "mwtv") {
      const iv = setInterval(() => {
        if (document.body.dataset.view !== "mwtv") { clearInterval(iv); gate(); }
      }, 30000);
      return;
    }
    gate();
  }, 5 * 60 * 1000);
}

function wireGate() {
  const form = document.getElementById("gt-form");
  if (!form) return;
  const msg = document.getElementById("gt-msg");
  const toLive = (e) => {
    e.preventDefault();
    if (msg) msg.textContent = "Sign-in lives on the main site in this phase — taking you there…";
    setTimeout(() => { location.href = "/#home"; }, 600);
  };
  form.addEventListener("submit", toLive);
  ["gt-switch", "gt-forgot"].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", toLive);
  });
}

/* ------------------------------------------------------------------ *
 * 8. BOOT — chrome first, session refresh in the background, router
 * last. Nothing here waits on the network to paint the frame.
 * ------------------------------------------------------------------ */
Session.load();
paintChrome();
paintAppBar();
paintAuthBar();
paintEnter();
wireGate();
armGuestWall();
Presence.init();
Router.init(document.getElementById("view-root"));
Session.refresh().then(() => paintAuthBar());

/* ------------------------------------------------------------------ *
 * 8b. THE CEMENT MASTER BAND (Law 1, owner 2026-10-30 12:46) — the
 * band's markup is STATIC in index.html (shell furniture, styled by
 * shell.css from first paint); this is only its BINDING. The band
 * module (js/mini.js) and the player engine it rides are lazy like
 * any view module — never counted against the boot budget — loaded
 * once here at boot so the band binds on EVERY view, not just the
 * viewer views that used to mount the old floating mini themselves.
 * ------------------------------------------------------------------ */
let _bandLoading = null;
function loadBand() {
  if (_bandLoading) return _bandLoading;
  _bandLoading = import("./mini.js")
    .then((m) => m.mountBand({ session: Session, gateway: Gateway, presence: Presence, view: { id: "band" } }))
    .catch(() => { _bandLoading = null; return null; });
  return _bandLoading;
}
loadBand();

/* ------------------------------------------------------------------ *
 * 9. MEECHIE AI (Law 17) — the shell-wide assistant is a LAZY module
 * (js/ai.js): the live widget's bubble + panel, loaded after the
 * frame paints like any view module, never counted against the boot
 * budget. openAI() is the one door in — the AI app bar's Meechie AI
 * button calls it, and view modules can reach it via MW2.openAI.
 * In the AI app mode the panel opens on arrival, exactly like the
 * live /ai-app/ (Meechie is the point of that app).
 * ------------------------------------------------------------------ */
let _aiApi = null, _aiLoading = null;
function loadAI() {
  if (_aiApi) return Promise.resolve(_aiApi);
  if (_aiLoading) return _aiLoading;
  _aiLoading = import("./ai.js")
    .then((m) => { _aiApi = m.initAI({ session: Session, appMode: AppMode }); return _aiApi; })
    .catch(() => { _aiLoading = null; return null; });
  return _aiLoading;
}
async function openAI() {
  const api = await loadAI();
  if (api) api.openPanel();
}

/* The shell's public face for view modules and later core work. */
window.MW2 = { session: Session, gateway: Gateway, presence: Presence, router: Router, views: VIEWS, openAI };
window.__MW_BOOTED = true;

/* Meechie AI loads right after boot — requestIdleCallback keeps it
   off the first-paint path; the AI app mode opens its panel. */
try {
  const kick = () => { loadAI().then((api) => { if (api && AppMode.id === "ai") api.openPanel(); }); };
  if (window.requestIdleCallback) requestIdleCallback(kick, { timeout: 2500 });
  else setTimeout(kick, 1200);
} catch (_) {}

/* Device-saved skeleton (Phase 5, owner decision 2026-10-30):
   register the v2 service worker — registration ONLY. A new
   skeleton activates on the visitor's next natural load; this
   page never listens for the swap and never reloads itself
   (the stale-tab lesson of live #398, and the music must not
   stop). See v2/sw.js for the cache rules. */
try {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/v2/sw.js", { scope: "/v2/" }).catch(() => {});
} catch (_) {}
