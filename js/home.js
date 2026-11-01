/* Meechie's World — home tab: the live strip and the happening-now rail.
 * Loaded lazily the first time the home view opens (LAZY_SRC in app-core.js),
 * the same way the Cinema (movies.js) and Clips scripts load.
 * The strip reads the shared radio/dj doc through the app's own backend client
 * (MW_CF, the same one the feed and Live pages use) and shows, in order:
 * a live DJ battle, the station on air, or members streaming live.
 * The rail reuses that same fetched state (no second fetch), mirrors the
 * site's own online count from the #online element the app already keeps
 * updated, and shows fresh products from /api/store.
 * Everything fails silent: a source that does not answer leaves its block
 * hidden, and refreshes only run while the home view is on screen. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const E = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sec = $("#v-home");
  if (!sec) return;
  const strip = $("#home-live"), rail = $("#home-now");
  const bAir = $("#home-now-air"), bOnline = $("#home-now-online"), bShop = $("#home-now-shop");
  if (!strip || !rail) return;
  const visible = () => !sec.hidden;
  const cli = () => { try { return window.MW_CF ? window.MW_CF.createClient() : null; } catch (_) { return null; } };
  const nameOf = (l) => {
    if (l.host) return "Meechie";
    try { if (typeof handleOf === "function") { const h = handleOf(l.id); if (h && h !== "Member") return h; } } catch (_) {}
    return "A member";
  };

  let S = null, lives = [], lastFetch = 0, shopAt = 0, shopDone = false;

  async function fetchState() {
    const c = cli(); if (!c) return;
    try {
      const r = await c.from("docs").select("path,data").eq("path", "radio/dj").maybeSingle();
      if (!r.error && r.data) S = r.data.data || null;
    } catch (_) {}
    try {
      const r = await c.from("docs").select("path,data").eq("coll", "live").limit(100);
      if (!r.error && Array.isArray(r.data)) {
        const now = Date.now();
        lives = r.data
          .map((row) => ({ id: String(row.path || "").split("/")[1] || "", ...(row.data || {}) }))
          .filter((l) => l.onsite && now - (l.beat || l.startedAt || 0) < 90000);
      }
    } catch (_) {}
  }

  const playingDeck = () => {
    if (!S) return null;
    for (const k of ["A", "B", "C", "D"]) { const d = S[k]; if (d && d.playing && d.title) return d; }
    return null;
  };
  const battleLive = () => (S && S.battle && S.battle.on && S.battle.phase === "live") ? S.battle : null;
  const battleNames = (b) => [((b.p1 && b.p1.name) || "DJ 1"), ((b.p2 && b.p2.name) || "DJ 2")];

  function paintStrip() {
    const b = battleLive(), d = playingDeck();
    let html = "";
    if (b) {
      const [p1, p2] = battleNames(b);
      html = `<span>⚔️ BATTLE LIVE — ${E(p1)} vs ${E(p2)}</span><a class="btn" href="#radio" data-go="radio">Watch the battle</a>`;
    } else if (S && S.live && d) {
      html = `<span>🔴 LIVE NOW — ${E(d.title)}</span><a class="btn" href="#radio" data-go="radio">Tune in</a>`;
    } else if (lives.length) {
      html = `<span>📡 ${lives.length} streaming live now</span><a class="btn" href="#live" data-go="live">Watch live</a>`;
    }
    if (!html) { strip.hidden = true; if (strip._h) { strip.innerHTML = ""; strip._h = ""; } return; }
    if (strip._h !== html) { strip.innerHTML = html; strip._h = html; }
    strip.hidden = false;
  }

  function paintRail() {
    if (bAir) {
      const b = battleLive(), d = playingDeck();
      let air = "";
      if (b) { const [p1, p2] = battleNames(b); air = `⚔️ Battle live: ${E(p1)} vs ${E(p2)}`; }
      else if (S && S.live && d) air = `🔴 On air now: ${E(d.title)}`;
      else if (lives.length) air = "📡 Live now: " + lives.slice(0, 3).map((l) => E(nameOf(l))).join(", ");
      if (air) {
        const h = `<h4>ON AIR / LIVE NOW</h4><p>${air}</p>`;
        if (bAir._h !== h) { bAir.innerHTML = h; bAir._h = h; }
        bAir.hidden = false;
      } else bAir.hidden = true;
    }
    if (bOnline) {
      // the site's ONE online count: dj.js paintOnline publishes it from the
      // keeper ping (the same value the header chip shows). The chat header's
      // #online is that channel's own narrower count and must never feed
      // this rail — reading it is what made home disagree with the header.
      let n = (typeof window.MW_ONLINE_N === "number" && isFinite(window.MW_ONLINE_N)) ? window.MW_ONLINE_N : NaN;
      if (!isFinite(n)) { const el = $("#online-n"); n = el ? parseInt(String(el.textContent || "").replace(/[^\d]/g, ""), 10) : NaN; }
      if (Number.isFinite(n) && n >= 1) {
        const h = `<h4>ONLINE NOW</h4><p>● ${n} here now</p>`;
        if (bOnline._h !== h) { bOnline.innerHTML = h; bOnline._h = h; }
        bOnline.hidden = false;
      } else bOnline.hidden = true;
    }
    const any = [bAir, bOnline, bShop].some((x) => x && !x.hidden);
    rail.hidden = !any;
  }

  async function fetchShop() {
    if (!bShop) return;
    if (shopDone && Date.now() - shopAt < 600000) return;
    try {
      const c = window.MW_shopCatalog ? await window.MW_shopCatalog() : null;
      const ps = ((c && c.store) || []).filter((p) => p && p.img && p.title).slice(0, 4);
      if (!ps.length) return;
      bShop.innerHTML = `<h4>FRESH IN THE SHOP</h4><div class="home-now-prods">${ps.map((p) => `<a class="home-prod" href="#shop" data-go="shop"><img src="${E(p.img)}" alt="" loading="lazy"><b>${E(p.title)}</b>${p.price ? `<span>${E(p.price)}</span>` : ""}</a>`).join("")}</div>`;
      bShop.hidden = false;
      shopDone = true; shopAt = Date.now();
      paintRail();
    } catch (_) {}
  }

  async function refresh() {
    if (!visible()) return;
    if (Date.now() - lastFetch >= 20000) { lastFetch = Date.now(); await fetchState(); }
    paintStrip();
    paintRail();
    fetchShop();
  }
  const kick = () => { if (visible()) refresh(); };
  if (window.MutationObserver) new MutationObserver(kick).observe(sec, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-go="home"]')) setTimeout(kick, 80);
    const ai = e.target.closest("[data-ai-open]");
    if (ai) {
      const panel = $("#ai-panel"), fab = $("#ai-fab");
      if (panel && !panel.hidden) return; // already open: nothing to do
      if (fab) fab.click(); // the AI widget's own open path (its gold button)
    }
  });
  setInterval(refresh, 20000);
  kick();
})();
