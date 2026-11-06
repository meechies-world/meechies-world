/* Outage mode (owner's rule): if the account system is down or blocked, the website still opens.
 * Visitors can look around (videos, books, shop, pages); only signed-in features and saved data wait.
 * Checks the sign-in service once on load (and again if a sign-in attempt fails to reach it).
 * While the notice is up it keeps re-checking, so a false alarm clears itself once sign-in answers again.
 * Website-down poster (owner's order, 2026-11-03): while an outage is declared, the owner's
 * WEBSITE DOWN poster covers the screen full-size — his exact art, whole picture visible,
 * never cropped — instead of a stuck or broken screen. It is a visual layer only: it never
 * touches any player, so radio sounding on the device keeps sounding (the poster itself
 * tells people to tune in to the radio). No dismiss control: the recovery watch clears it
 * the moment the service answers again. The poster is a static file, so it still loads on
 * the nights the API layer is the thing that's down.
 * Lifeline coexistence (owner's law, 2026-11-04 ~00:13 EST: MW TV viewing and radio
 * listening must work with NO login and must NOT depend on the database): on exactly
 * those nights the lifelines carry the station from static files — TV from
 * /lifeline/tv-lineup.json (js/dj.js paints the #tw-lifeline label while it runs),
 * radio from /lifeline/radio-dayparts.json (js/app-core.js sets MW_LIFELINE_RADIO).
 * While either lifeline is live, the full-screen poster STANDS DOWN — the slim
 * #mw-outage banner still tells the truth up top, but the picture and the radio
 * controls stay reachable. If the lifeline stands down while the outage is still
 * declared, the poster comes back; when the service recovers, everything clears
 * exactly as before. The poster itself — art, wording, no-dismiss — is unchanged. */
(function () {
  "use strict";
  const c = window.MW_CONFIG || {};
  let shown = false;
  const DOWN_IMG = "/img/website-down.jpg";
  /* Is a lifeline carrying the station right now? Radio publishes its flag on
   * window; TV paints its label exactly while LL_TV.on (hidden = !on). Either
   * one live means the screen is NOT broken — it is the station, playing from
   * static files with no database — so the poster must not cover it. */
  function lifelineLive() {
    try {
      if (window.MW_LIFELINE_RADIO === true) return true;
      const lab = document.getElementById("tw-lifeline");
      if (lab && !lab.hidden) return true;
    } catch (_) {}
    return false;
  }
  // POSTER/STALL FIX 2026-11-06 (diagnosis §5, fixes 1+3): the outage probe
  // measures the sign-in/database path (/api/cf/health) — a path playback
  // never uses. A health transient must never paint the WEBSITE-DOWN poster
  // over a live program, so the poster is gated on the channel itself being
  // dead. channelPlaying() is true when a channel player is demonstrably
  // playing: the lifeline is carrying the station, or a mounted TV player
  // carries the .playing class (YT adds it on PLAYING and removes it only on
  // error; file video adds it on its playing event, also removed only on
  // error). The class is sticky after PLAYING — the right semantics here:
  // once the channel has demonstrably started, a health hiccup must not
  // paint over it. A truly dead site never mounts a player, so no .playing
  // exists and the poster still paints exactly as before.
  function channelPlaying() {
    try { if (lifelineLive()) return true; } catch (_) {}
    try {
      const el = document.querySelector(".tvchan iframe.playing, .tvchan video.playing");
      if (el) return true;
    } catch (_) {}
    return false;
  }
  // Last /api/cf/health outcome, kept so every guest() firing can say WHY
  // the probe thought the site was down (fix 3 instrumentation).
  let lastHealth = { ok: false, shape: "unknown", at: 0 };
  function mwOutageLog(reason) {
    const rec = { at: Date.now(), reason, healthy: lastHealth.ok, shape: lastHealth.shape, playing: channelPlaying() };
    try {
      window.MW_OUTAGE_LOG = window.MW_OUTAGE_LOG || [];
      window.MW_OUTAGE_LOG.push(rec);
      if (window.MW_OUTAGE_LOG.length > 20) window.MW_OUTAGE_LOG.splice(0, window.MW_OUTAGE_LOG.length - 20);
    } catch (_) {}
    try {
      const prev = JSON.parse(localStorage.getItem("mw-outage-log") || "[]");
      prev.push(rec);
      localStorage.setItem("mw-outage-log", JSON.stringify(prev.slice(-20)));
    } catch (_) {}
    // Best-effort Guardian marker: filed, never a death confirmation.
    // kind:"fault" + fkind:"outage-probe" + err:0 is recorded by the keeper
    // but cannot confirm a segment dead (a hard confirm needs fkind
    // file-error or a player err code, from >= 2 seats). Skipped when no
    // segment is laid (page-load probe failure) or the id/token fail the
    // endpoint's own shape checks.
    try {
      if (typeof window.MW_TV_SEG === "function") {
        const seg = window.MW_TV_SEG();
        if (seg && seg.id && +seg.start > 0 && /^[A-Za-z0-9_-]{1,80}$/.test(String(seg.id))) {
          let g = "";
          try {
            g = localStorage.getItem("mw-vid") || "";
            if (g.length < 8) { g = "v" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); localStorage.setItem("mw-vid", g); }
          } catch (_) {}
          if (/^[A-Za-z0-9_-]{8,64}$/.test(g)) {
            fetch("/api/tv/guardian", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "fault", id: String(seg.id), start: +seg.start, err: 0, fkind: "outage-probe", g }), keepalive: true }).catch(function () {});
          }
        }
      }
    } catch (_) {}
    try { console.warn("[MW outage]", rec); } catch (_) {}
  }
  let downWatch = null;
  function reconcileDown() {
    if (!shown) return;
    // Poster gate (fix 1): a demonstrably playing channel means the site is,
    // for the viewer, up — hide the poster; a false positive self-clears
    // within 2 s of playback resuming. `shown` stays true and the slim banner
    // stays up while sign-in is genuinely down; only the full-screen paint is
    // gated. (lifelineLive() is subsumed: channelPlaying() includes it.)
    if (channelPlaying()) { hideDown(); return; }
    if (!document.getElementById("mw-down")) paintDown();
  }
  function showDown() {
    // Poster gate (fix 1): never paint over a demonstrably playing channel.
    // The 2 s watcher still starts, exactly as before, so if the channel
    // later stops playing while sign-in is still down, the poster paints then.
    if (!channelPlaying()) paintDown();
    if (!downWatch) downWatch = setInterval(reconcileDown, 2000);
  }
  function paintDown() {
    const add = () => {
      if (document.getElementById("mw-down")) return;
      const o = document.createElement("div"); o.id = "mw-down"; o.setAttribute("role", "alertdialog"); o.setAttribute("aria-label", "Website down — we're currently upgrading the website");
      o.style.cssText = "position:fixed;inset:0;z-index:200000;background:#000;display:flex;align-items:center;justify-content:center";
      const im = document.createElement("img"); im.src = DOWN_IMG;
      im.alt = "WEBSITE DOWN — We're currently upgrading the website to bring you a better, faster, and more powerful experience! In the meantime, please tune in to our radio at MeechiesWorldInc.com. Sorry for the inconvenience!";
      im.style.cssText = "max-width:100vw;max-height:100vh;width:auto;height:auto;object-fit:contain;display:block";
      o.appendChild(im);
      document.body.appendChild(o);
    };
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
  }
  function hideDown() { const o = document.getElementById("mw-down"); if (o) o.remove(); }
  /* While the site is healthy, keep the poster on the device: the service worker's
   * image cache picks the file up from a plain image load, so on a later visit with
   * no signal at all the poster can still come up from the device copy. One load,
   * only when no copy is cached yet, and never on the outage path itself. */
  let downWarmed = false;
  function warmDown() {
    if (downWarmed) return; downWarmed = true;
    const pull = () => { try { const im = new Image(); im.src = DOWN_IMG; } catch (_) {} };
    try {
      if (window.caches && caches.match) caches.match(DOWN_IMG).then((hit) => { if (!hit) pull(); }, () => {});
      else pull();
    } catch (_) {}
  }
  function guest(reason) {
    if (shown) return; shown = true; window.MW_OUTAGE = reason || true;
    const html = document.documentElement; html.classList.remove("gated");
    const g = document.getElementById("gate"); if (g) g.hidden = true;
    const add = () => {
      if (document.getElementById("mw-outage")) return;
      const b = document.createElement("div"); b.id = "mw-outage"; b.setAttribute("role", "status");
      b.style.cssText = "position:relative;z-index:21;background:#2a2010;color:#f0cf78;border-bottom:1px solid #8a6a2a;font:600 13px/1.3 system-ui,sans-serif;padding:7px 38px 7px 12px;text-align:center";
      b.innerHTML = "⚠️ Sign-in is down for a bit. You can still look around; your saved stuff comes back once it's fixed. <button type='button' aria-label='Dismiss' style='position:absolute;right:6px;top:2px;background:none;border:0;color:#f0cf78;font-size:20px;cursor:pointer'>×</button>";
      b.querySelector("button").onclick = () => b.remove();
      document.body.insertBefore(b, document.body.firstChild); /* sits above the menu bar, never on top of it */
    };
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
    /* The full-screen poster is for a CONFIRMED outage only. probe() already confirmed it twice;
       the other doors (one sign-in error such as a 429 rate limit, one stray failed fetch) ask
       the health route first, so a single hiccup never blacks out the whole site. */
    if (reason === "auth check failed twice") { mwOutageLog(reason); showDown(); }
    else healthy().then((ok) => { mwOutageLog(reason); if (!ok && shown) showDown(); }, () => { mwOutageLog(reason); });
    watchRecovery();
  }
  window.MW_guestMode = guest;
  async function healthy() {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch("/api/cf/health", { signal: ctl.signal, cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok) { lastHealth = { ok: false, shape: "http-" + r.status, at: Date.now() }; return false; }
      const ok = !!(j && j.ok === true);
      lastHealth = { ok, shape: ok ? "ok" : "not-ok", at: Date.now() };
      return ok;
    } catch (e) {
      lastHealth = { ok: false, shape: (e && e.name === "AbortError") ? "timeout" : "thrown", at: Date.now() };
      return false;
    }
    finally { clearTimeout(t); }
  }
  let watchTimer = null, watchHits = 0;
  function recovered() {
    /* Sign-in answers again: take the notice down and hand the session back to the
       normal rules. The page itself is left exactly as the visitor has it — no gate
       yank mid-browse; full gating resumes on the next load, and the 30-minute
       sign-in wall reads MW_OUTAGE when it fires, so it works again from here. */
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (downWatch) { clearInterval(downWatch); downWatch = null; }
    watchHits = 0;
    const b = document.getElementById("mw-outage"); if (b) b.remove();
    hideDown();
    window.MW_OUTAGE = false; shown = false;
    warmDown();
    try { console.info("[MW] outage over: sign-in is answering again"); } catch (_) {}
  }
  function watchRecovery() {
    if (watchTimer) return;
    /* Same standard as declaring the outage: two healthy answers in a row,
       30s apart, before the notice clears — one lucky answer doesn't end it. */
    watchTimer = setInterval(async () => {
      if (await healthy()) { watchHits++; if (watchHits >= 2) recovered(); }
      else watchHits = 0;
    }, 30000);
  }
  async function probe() {
    if (c.BACKEND !== "cf") return;
    if (await healthy()) { warmDown(); return; }
    /* One failed probe is not an outage (verified 2026-10-29: the health route
       answers 200 {"ok":true}; a cold function, a slow network, an aborted
       fetch or a bot-blocked UA all fail once). Confirm with a second probe
       15s later before declaring sign-in down — a false "down" also lifts the
       30-minute sign-in wall for everyone, via MW_OUTAGE. */
    setTimeout(async () => { if (!(await healthy())) guest("auth check failed twice"); }, 15000);
  }
  probe();
  // a sign-in attempt that can't reach the service also opens the site in guest mode
  window.addEventListener("unhandledrejection", (e) => { const m = String((e.reason && (e.reason.message || e.reason)) || ""); if (/Failed to fetch|NetworkError|quota|restricted|402|503/i.test(m) && document.documentElement.classList.contains("gated")) guest("sign-in failed: " + m.slice(0, 80)); });
})();
