/* Outage mode (owner's rule): if the account system (Supabase) is down or blocked, the website still opens.
 * Visitors can look around (videos, books, shop, pages); only signed-in features and saved data wait.
 * Checks the sign-in service once on load (and again if a sign-in attempt fails to reach it). */
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
    try { console.warn("[MW] outage mode:", reason); } catch (_) {}
  }
  window.MW_guestMode = guest;
  async function probe() {
    if (!c.SUPABASE_URL) return;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    try {
      const r = await fetch(c.SUPABASE_URL + "/auth/v1/health", { headers: { apikey: c.SUPABASE_ANON_KEY || "" }, signal: ctl.signal, cache: "no-store" });
      if (!r.ok) guest("auth " + r.status);
    } catch (e) { guest("auth unreachable"); }
    clearTimeout(t);
  }
  probe();
  // a sign-in attempt that can't reach the service also opens the site in guest mode
  window.addEventListener("unhandledrejection", (e) => { const m = String((e.reason && (e.reason.message || e.reason)) || ""); if (/Failed to fetch|NetworkError|quota|restricted|402|503/i.test(m) && document.documentElement.classList.contains("gated")) guest("sign-in failed: " + m.slice(0, 80)); });
})();
