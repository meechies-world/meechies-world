/* Outage mode (owner's rule): if the account system is down or blocked, the website still opens.
 * Visitors can look around (videos, books, shop, pages); only signed-in features and saved data wait.
 * Checks the sign-in service once on load (and again if a sign-in attempt fails to reach it).
 * While the notice is up it keeps re-checking, so a false alarm clears itself once sign-in answers again. */
(function () {
  "use strict";
  const c = window.MW_CONFIG || {};
  let shown = false;
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
    watchRecovery();
    try { console.warn("[MW] outage mode:", reason); } catch (_) {}
  }
  window.MW_guestMode = guest;
  async function healthy() {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch("/api/cf/health", { signal: ctl.signal, cache: "no-store" });
      const j = await r.json().catch(() => null);
      return !!(r.ok && j && j.ok === true);
    } catch (e) { return false; }
    finally { clearTimeout(t); }
  }
  let watchTimer = null, watchHits = 0;
  function recovered() {
    /* Sign-in answers again: take the notice down and hand the session back to the
       normal rules. The page itself is left exactly as the visitor has it — no gate
       yank mid-browse; full gating resumes on the next load, and the 30-minute
       sign-in wall reads MW_OUTAGE when it fires, so it works again from here. */
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    watchHits = 0;
    const b = document.getElementById("mw-outage"); if (b) b.remove();
    window.MW_OUTAGE = false; shown = false;
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
    if (await healthy()) return;
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
