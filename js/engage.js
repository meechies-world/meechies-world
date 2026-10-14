/* Engagement, kept honest:
 *  - Like counts under 25 are hidden (people just see the heart) until they're worth showing. The owner always sees them.
 *  - 🔥 Trending badges go on the posts with the most REAL likes and comments this week (in index.html).
 *  - Real play counts on songs and the Originals videos: each member counts once per song per day
 *    (supabase/plays.sql). Shown once a song passes 25 plays.
 *  - Share buttons (phone share sheet → TikTok, Snapchat, texts…) and double-tap a photo or video to like it. */
(function () {
  "use strict";
  const MIN = (window.MW_SHOW_MIN = 25);
  const sb = () => (window.MW && MW.sb) || null;
  const owner = () => typeof isOwner !== "undefined" && isOwner;
  const say = (t) => (typeof toast === "function" ? toast(t) : 0);
  const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K" : String(n)).replace(".0", "");

  const css = document.createElement("style");
  css.textContent = `
.trend-badge{display:inline-flex;align-items:center;gap:4px;font:800 12px var(--body);color:#0b0a08;background:linear-gradient(180deg,#f0cf78,#c99a35);border-radius:999px;padding:4px 10px;margin-right:4px}
.plays-n{font:600 11.5px var(--body);color:var(--muted);white-space:nowrap;margin-left:6px}
.orig-card .plays-n{position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.7);color:#fff;border-radius:999px;padding:3px 9px;margin:0;pointer-events:none}
.mw-heart{position:fixed;z-index:10060;pointer-events:none;font-size:84px;transform:translate(-50%,-50%) scale(.4);opacity:0;animation:mwHeart .8s ease-out forwards;text-shadow:0 6px 24px rgba(0,0,0,.5)}
@keyframes mwHeart{20%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}60%{opacity:1;transform:translate(-50%,-60%) scale(1)}100%{opacity:0;transform:translate(-50%,-90%) scale(.9)}}`;
  document.head.appendChild(css);

  /* ---------- share ---------- */
  window.MW_share = async (text, hash) => {
    const url = location.origin + "/" + (hash || "");
    const data = { title: "Meechie's World", text: (String(text || "").slice(0, 120) || "Check this out on Meechie's World") + "\n", url };
    try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(data.text + url); say("Link copied. Paste it in TikTok, Snapchat or a text."); } catch (_) { say(url); }
  };

  /* ---------- double-tap to like ---------- */
  let lastTap = 0, lastEl = null;
  document.addEventListener("click", (e) => {
    const media = e.target.closest && e.target.closest(".post .photo, .post .vid");
    if (!media) return;
    const now = Date.now();
    if (lastEl === media && now - lastTap < 350) {
      const post = media.closest(".post"), btn = post && post.querySelector("[data-like]");
      if (btn && !btn.classList.contains("on")) btn.click();
      const h = document.createElement("div"); h.className = "mw-heart"; h.textContent = "❤️"; h.style.left = e.clientX + "px"; h.style.top = e.clientY + "px";
      document.body.appendChild(h); setTimeout(() => h.remove(), 900);
      lastTap = 0; lastEl = null; return;
    }
    lastTap = now; lastEl = media;
  }, true);

  /* ---------- real play counts ---------- */
  let counts = {}, loaded = false;
  async function load() {
    const c = sb(); if (!c) return;
    try { const { data, error } = await c.from("plays").select("id,n").limit(2000); if (error) return; counts = {}; (data || []).forEach((r) => (counts[r.id] = +r.n || 0)); loaded = true; paint(); } catch (_) {}
  }
  const bumped = new Set();
  async function bump(id) {
    if (!id || bumped.has(id)) return; bumped.add(id);
    const c = sb(); if (!c) return;
    try { const { error } = await c.rpc("bump_play", { p_id: id }); if (!error) { counts[id] = (counts[id] || 0) + 1; paint(); } } catch (_) {}
  }
  const label = (id) => { const n = counts[id] || 0; return n >= MIN || (owner() && n) ? `▶ ${short(n)} play${n === 1 ? "" : "s"}` : ""; };
  function paint() {
    if (!loaded) return;
    // songs in the Library
    const list = typeof tracks !== "undefined" ? tracks : [];
    document.querySelectorAll("#tracks .track").forEach((row) => {
      const b = row.querySelector("[data-play]"); if (!b) return; const t = list[+b.dataset.play]; if (!t) return;
      const txt = label("t:" + t.id); let s = row.querySelector(".plays-n");
      if (!txt) { if (s) s.remove(); return; }
      if (!s) { s = document.createElement("span"); s.className = "plays-n"; const small = row.querySelector(".t small"); (small || row).appendChild(s); }
      if (s.textContent !== " · " + txt) s.textContent = " · " + txt;
    });
    // Originals videos
    document.querySelectorAll(".orig-card[data-o]").forEach((c) => {
      const txt = label("o:" + c.dataset.o); let s = c.querySelector(".plays-n");
      if (!txt) { if (s) s.remove(); return; }
      if (!s) { s = document.createElement("span"); s.className = "plays-n"; c.appendChild(s); }
      if (s.textContent !== txt) s.textContent = txt;
    });
  }
  // keep labels on the Library list when it re-renders
  const tl = document.getElementById("tracks");
  if (tl) new MutationObserver(() => { if (!tl.querySelector(".track .plays-n") && loaded) paint(); }).observe(tl, { childList: true });

  // a song counts after 30 seconds of real listening (radio or library); a video after 5 seconds
  const listened = new Map();
  function watch(el, idOf, need) {
    let last = 0;
    el.addEventListener("timeupdate", () => {
      if (el.paused) return;
      const id = idOf(); if (!id) return;
      const now = el.currentTime, d = now - last; last = now;
      if (d > 0 && d < 2) { const v = (listened.get(id) || 0) + d; listened.set(id, v); if (v >= need) bump(id); }
    });
    el.addEventListener("seeked", () => { last = el.currentTime; });
  }
  function trackId(src) {
    const list = typeof tracks !== "undefined" ? tracks : []; if (!src || !window.MW || !MW.assetUrl) return "";
    const t = list.find((x) => x.assetId && src.indexOf(x.assetId) >= 0); return t ? "t:" + t.id : "";
  }
  function hook() {
    if (typeof media !== "undefined" && media && !media._mwPlays) { media._mwPlays = 1; watch(media, () => trackId(media.currentSrc || media.src), 30); }
    document.querySelectorAll("audio,video").forEach((el) => {
      if (el._mwPlays) return;
      const card = el.closest(".orig-card[data-o]");
      if (card) { el._mwPlays = 1; watch(el, () => "o:" + card.dataset.o, 5); return; }
      if (el.tagName === "AUDIO" && !el.closest(".post")) { el._mwPlays = 1; watch(el, () => trackId(el.currentSrc || el.src), 30); }
    });
  }
  setInterval(() => { hook(); paint(); }, 3000); setTimeout(hook, 800);
  const start = () => (window.MW && MW.sessionReady ? MW.sessionReady.then(() => { load(); setInterval(load, 5 * 60 * 1000); }) : setTimeout(start, 400));
  start();
})();
