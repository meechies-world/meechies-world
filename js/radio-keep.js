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

  /* ---- external-interruption hold (owner, 2026-11-04): when the SYSTEM or another
   * app takes the phone's audio — his satellite radio, a call, another app grabbing
   * focus — the OS pauses this element. That pause is not the listener's tap, but it
   * is not the site's to undo either: the watchdog used to re-press play on any pause
   * with "want" still set, so the station kept cutting back in over the other app.
   * Now an unexplained pause latches extHold and heal() stands down until the
   * listener taps play in the page again (any real play of the radio clears it —
   * while the hold is latched, no automatic path in this file can produce one).
   * Pauses the page caused itself never latch it: the listener's own pause tap,
   * a video stepping the radio aside, the welcome video, a track rolling over. ---- */
  let extHold = false, inPagePauseAt = 0, pauseTimer = 0;

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
  document.addEventListener("play", (e) => { if (e.target && e.target.tagName === "AUDIO") { setWant(true); paintSession(); if (e.target.id === "audio") extHold = false; } }, true);
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("#pb-play,#tune-in,#en-mute,#pb-pause") : null;
    if (!t) return;
    inPagePauseAt = Date.now(); // a tap on the controls explains the pause/play that follows it
    setTimeout(() => { // read the state AFTER the engine handled the tap
      const a = mediaEl();
      if (playingNow() || (a && !a.paused)) setWant(true); else setWant(false);
    }, 80);
  }, true);
  setInterval(() => { if (playingNow()) { setWant(true); paintSession(); } }, 5000);

  /* ---- one sound at a time (owner's rule): ANY video or audio on the site with sound up
   * pauses the radio, and the radio comes back when it ends. Some players remembered to tell
   * the radio; the feed's never did — so this listens at the document level and speaks for
   * every player through the site's own step-aside switch (MW_videoSound). ---- */
  const loud = new Set();
  const isRadio = (t) => !t || t.id === "audio";
  const radioAudible = () => { const a = mediaEl(); return !!(a && !a.paused && ["radio", "library", "intro"].includes(musicMode() || "")); };
  function loudPlay(t) {
    if (isRadio(t) || loud.has(t)) return;
    loud.add(t);
    if (loud.size === 1 && radioAudible()) { try { window.MW_videoSound && MW_videoSound.start(); } catch (_) {} }
  }
  function loudDone(t) {
    if (!loud.delete(t)) return;
    if (!loud.size) { try { window.MW_videoSound && MW_videoSound.end(); } catch (_) {} } // engine restores in ~1.5s; the watchdog below backstops it
  }
  document.addEventListener("play", (e) => { const t = e.target; if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO") && !t.muted) loudPlay(t); }, true);
  document.addEventListener("pause", (e) => { loudDone(e.target); }, true);
  document.addEventListener("ended", (e) => { loudDone(e.target); }, true);
  document.addEventListener("volumechange", (e) => { const t = e.target; if (!t || (t.tagName !== "VIDEO" && t.tagName !== "AUDIO")) return; if (!t.paused && !t.muted) loudPlay(t); else loudDone(t); }, true);

  /* ---- latch the hold when the radio is paused from OUTSIDE the page ----
   * The pause is confirmed after a short beat: track rolls and source swaps are
   * playing again within milliseconds, and a video step-aside is still holding
   * the sound on purpose — neither is an interruption. What is left is a pause
   * nobody in this page asked for: the system or another app has the audio. */
  document.addEventListener("pause", (e) => {
    const t = e.target; if (!t || t.id !== "audio" || t.ended) return; // a track ending is continuity, not an interruption
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => {
      const a = mediaEl(); if (!a || !a.paused || extHold) return;
      if (Date.now() - inPagePauseAt < 2000) return;                    // the listener's own pause tap
      try { if (window.MW_videoSound && MW_videoSound.holding()) return; } catch (_) {} // a video has the sound on purpose
      if (window._welcomeOn) return;                                    // the welcome video gets its moment
      const m = musicMode(); if (m !== "radio" && m !== "library" && m !== "intro") return; // live/DJ rooms run their own audio
      if (!want()) return;                                               // the watchdog would not run anyway
      extHold = true;                                                    // stay paused until a play tap in the page
    }, 400);
  }, true);

  /* ---- the watchdog: if the music should be on but isn't, bring it back ---- */
  let lastTry = 0, fails = 0;
  function heal() {
    const w = want(); if (!w || Date.now() - w.t > 12 * 3600 * 1000) return;
    if (extHold) return;                                   // another app has the audio: only a play tap in the page brings the radio back
    if (fails > 5) return;                                   // the browser keeps refusing: stop fighting it
    if (Date.now() - lastTry < 9000) return;                 // at most one rescue per 9 seconds
    if (document.visibilityState !== "visible") return;      // background rules are the OS's; we heal on return
    if (document.documentElement.classList.contains("gated")) return;
    if (window._welcomeOn) return;                           // the welcome video gets its moment
    try { if (window.MW_videoSound && MW_videoSound.holding()) return; } catch (_) {} // a video has the sound on purpose
    let loudVideo = false;
    document.querySelectorAll("video,audio").forEach((v) => { if (!v.paused && !v.muted) loudVideo = true; });
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
      setTimeout(() => { lastTry = 0; heal(); const m = musicMode(); if (!extHold && !playingNow() && (m === null || m === "radio" || m === "intro")) { try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {} } }, 350);
    });
  }
})();
