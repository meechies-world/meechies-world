/* Keep the music playing (owner's rule): the station keeps playing while members browse the site,
 * keeps going with the tab in the background or the phone screen locked (Media Session below), and
 * if it ever gets knocked off — a video stepping it aside and not handing it back, a tab reload,
 * leaving and returning — it brings itself back, unless the listener stopped it themselves.
 * (A closed tab is still silence: no website can play from a page that no longer exists.) */
(function () {
  "use strict";
  const KEY = "mw-keep-playing";
  const want = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; } };
  const setWant = (on) => { try { if (on) localStorage.setItem(KEY, JSON.stringify({ t: Date.now() })); else localStorage.removeItem(KEY); } catch (_) {} };
  const el = (id) => document.getElementById(id);
  const titleNow = () => { const t = el("pb-title"); return t && t.textContent.trim() ? t.textContent.trim() : "Live Radio"; };
  const subNow = () => { const t = el("pb-sub"); return t && t.textContent.trim() ? t.textContent.trim() : "Meechie's World"; };
  const playingNow = () => { const b = el("pb-play"); return !!(b && b.getAttribute("aria-label") === "Pause"); }; // the player bar's own button says Pause while sound plays
  const mediaEl = () => el("audio");
  const musicMode = () => { try { return typeof mode === "string" ? mode : null; } catch (_) { return null; } };

  /* ---- Media Session: lock-screen / notification controls, and the OS treats this as real media ---- */
  function paintSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      const title = titleNow();
      if (!navigator.mediaSession.metadata || navigator.mediaSession.metadata.title !== title) {
        navigator.mediaSession.metadata = new MediaMetadata({ title, artist: subNow(), album: "Meechie's World", artwork: [{ src: "/img/icon-512.png", sizes: "512x512", type: "image/png" }] });
      }
      navigator.mediaSession.playbackState = playingNow() ? "playing" : "paused";
    } catch (_) {}
  }
  if ("mediaSession" in navigator) {
    const click = (id) => { const b = el(id); if (b) b.click(); };
    try {
      navigator.mediaSession.setActionHandler("play", () => { if (el("pb-play")) click("pb-play"); else if (typeof tuneIn === "function") tuneIn(); });
      navigator.mediaSession.setActionHandler("pause", () => click("pb-play"));
      navigator.mediaSession.setActionHandler("previoustrack", () => click("pb-prev"));
      navigator.mediaSession.setActionHandler("nexttrack", () => click("pb-next"));
    } catch (_) {}
    const t0 = el("pb-title"); if (t0) new MutationObserver(paintSession).observe(t0, { childList: true, characterData: true, subtree: true });
  }

  /* ---- "the listener wants music" = set by THEIR taps on the player controls, never by side effects.
   * A video stepping the radio aside, a crossfade, a live room — none of those clear it. ---- */
  document.addEventListener("play", (e) => { if (e.target && e.target.tagName === "AUDIO") { setWant(true); paintSession(); } }, true);
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("#pb-play,#tune-in,#en-mute,#pb-pause") : null;
    if (!t) return;
    setTimeout(() => { // read the state AFTER the engine handled the tap
      const a = mediaEl();
      if (playingNow() || (a && !a.paused)) setWant(true); else setWant(false);
    }, 80);
  }, true);
  setInterval(() => { if (playingNow()) { setWant(true); paintSession(); } }, 5000);

  /* ---- the watchdog: if the music should be on but isn't, bring it back ---- */
  let lastTry = 0, fails = 0;
  function heal() {
    const w = want(); if (!w || Date.now() - w.t > 12 * 3600 * 1000) return;
    if (fails > 5) return;                                   // the browser keeps refusing: stop fighting it
    if (Date.now() - lastTry < 9000) return;                 // at most one rescue per 9 seconds
    if (document.visibilityState !== "visible") return;      // background rules are the OS's; we heal on return
    if (document.documentElement.classList.contains("gated")) return;
    if (window._welcomeOn) return;                           // the welcome video gets its moment
    try { if (window.MW_videoSound && MW_videoSound.holding()) return; } catch (_) {} // a video has the sound on purpose
    let loudVideo = false;
    document.querySelectorAll("video").forEach((v) => { if (!v.paused && !v.muted) loudVideo = true; });
    if (loudVideo) return;
    const a = mediaEl(); if (!a) return;
    if (!a.paused) return;                                   // sound is flowing — nothing to heal
    const m = musicMode();
    if (m !== "radio" && m !== "library" && m !== "intro") return; // live/DJ rooms run their own audio
    lastTry = Date.now();
    try {
      if (m === "radio") { if (typeof tuneIn === "function") tuneIn(); }
      else { const p = a.play(); if (p && p.catch) p.catch(() => { fails++; }); }
    } catch (_) { fails++; }
  }
  setInterval(heal, 4000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(heal, 600); });

  /* ---- coming back to the site: first tap brings the music back (browsers require a tap before sound) ---- */
  const w0 = want();
  if (w0 && Date.now() - w0.t < 12 * 3600 * 1000) {
    document.addEventListener("pointerdown", function h() {
      document.removeEventListener("pointerdown", h);
      setTimeout(() => { lastTry = 0; heal(); const m = musicMode(); if (!playingNow() && (m === null || m === "radio" || m === "intro")) { try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {} } }, 350);
    });
  }
})();
