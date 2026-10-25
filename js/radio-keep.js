/* Keep the music playing (owner's rule): the station keeps playing while members browse the site,
 * keeps going with the tab in the background or the phone screen locked (Media Session below), and
 * when someone leaves and comes back, the music picks back up on their first tap — unless they
 * pressed pause/stop themselves. (A closed tab is silence: no website can play from a page that
 * no longer exists — that part needs an app, not a web page.) */
(function () {
  "use strict";
  const KEY = "mw-keep-playing";
  const want = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; } };
  const setWant = (on) => { try { if (on) localStorage.setItem(KEY, JSON.stringify({ t: Date.now() })); else localStorage.removeItem(KEY); } catch (_) {} };
  const el = (id) => document.getElementById(id);
  const titleNow = () => { const t = el("pb-title"); return t && t.textContent.trim() ? t.textContent.trim() : "Live Radio"; };
  const subNow = () => { const t = el("pb-sub"); return t && t.textContent.trim() ? t.textContent.trim() : "Meechie's World"; };
  const playingNow = () => { const b = el("pb-play"); return !!(b && b.getAttribute("aria-label") === "Pause"); }; // the player bar's own button says Pause while sound is playing

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

  /* ---- remember "the music was on" (any mode), reconciled against the player bar itself ---- */
  document.addEventListener("play", (e) => { if (e.target && e.target.tagName === "AUDIO") { setWant(true); paintSession(); } }, true);
  document.addEventListener("pause", (e) => { if (e.target && e.target.tagName === "AUDIO" && !playingNow()) setWant(false); }, true);
  setInterval(() => { if (playingNow()) { setWant(true); paintSession(); } }, 5000);

  /* ---- coming back: first tap brings the music back (browsers require a tap before sound) ---- */
  const w = want();
  if (w && Date.now() - w.t < 12 * 3600 * 1000) {
    document.addEventListener("pointerdown", function h() {
      document.removeEventListener("pointerdown", h);
      setTimeout(() => {
        if (playingNow()) return;
        const a = el("audio");
        if (a && !a.paused && !a.ended) return;
        try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {}
      }, 350);
    });
  }
})();
