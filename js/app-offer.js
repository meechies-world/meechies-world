/* "Get this section as its own app" (owner, 2026-10-27: "make everything a app they can download if they like just one section").
 * When someone spends about 40 seconds in a section that has its own app (Radio, Meechie's Book, Dating, Legal Help, Shop,
 * Live, Studio, TV, Games, Jobs, Books, Fans, Virtual World), a small card offers that app.
 * - One offer per visit at most, and the same app isn't offered again for 14 days ("Not now"), or ever ("Don't ask").
 * - Waits its turn behind other pop-ups (MW_screenClear) and never shows inside an app or the DJ pop-out.
 * The list of apps lives in js/app-list.js; each app has its own page at /<id>-app/ and they're all on /apps/. */
(function () {
  "use strict";
  if (window.MW_APP_OFFER) return; window.MW_APP_OFFER = true;
  const D = document, H = D.documentElement;
  const standalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
  if (standalone() || H.classList.contains("appmode") || /[?&]playdj=1|[?&]popdj=1/.test(location.search)) return;
  const LIST = () => window.MW_APP_LIST || [];
  const NEED = 40; // seconds in a section before we offer its app
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  let offeredThisVisit = false; try { offeredThisVisit = sessionStorage.getItem("mw_appoffer_done") === "1"; } catch (_) {}
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const css = D.createElement("style");
  css.textContent = `#mw-appoffer{position:fixed;left:12px;right:12px;bottom:calc(var(--tabbar,0px) + 12px + env(safe-area-inset-bottom,0px));z-index:9998;max-width:440px;margin:0 auto;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:center;padding:12px 14px;border-radius:18px;background:linear-gradient(180deg,rgba(28,22,12,.97),rgba(8,7,5,.98));box-shadow:inset 0 0 0 1.5px rgba(232,190,100,.7),0 16px 40px rgba(0,0,0,.6),0 0 24px rgba(255,190,70,.18);color:#f3ead2;font:500 14px/1.35 var(--body,system-ui);animation:mwAoIn .35s cubic-bezier(.2,.8,.2,1)}
@keyframes mwAoIn{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
#mw-appoffer img{grid-row:1 / span 2;width:54px;height:54px;border-radius:14px;object-fit:cover;box-shadow:0 0 0 1.5px #8a6d1f}
#mw-appoffer b{color:#ffe08a;font-size:15px}
#mw-appoffer small{color:#bfb497;font-size:12.5px}
#mw-appoffer .row{grid-column:1 / -1;display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
#mw-appoffer .get{flex:1;text-align:center;text-decoration:none;background:linear-gradient(180deg,#f0cf78,#c39a2e);color:#191204;font-weight:800;letter-spacing:.04em;padding:10px 12px;border-radius:12px;min-width:140px}
#mw-appoffer .no{background:none;border:1px solid rgba(214,170,74,.45);color:#e9d9a6;border-radius:12px;padding:9px 12px;font:600 13px var(--body,system-ui);cursor:pointer}
#mw-appoffer .all{color:#d9b65c;font-size:12.5px;width:100%;text-align:center;margin-top:2px}`;
  D.head.appendChild(css);

  function appFor(view) { return LIST().find((a) => a.views && a.views.includes(view)); }

  function offer(app) {
    if (D.getElementById("mw-appoffer")) return;
    if (window.MW_screenClear && !window.MW_screenClear("mw-appoffer")) return;
    offeredThisVisit = true; try { sessionStorage.setItem("mw_appoffer_done", "1"); } catch (_) {}
    const seen = get("mw_appoffer_seen", {}); seen[app.id] = Date.now(); put("mw_appoffer_seen", seen);
    const c = D.createElement("div"); c.id = "mw-appoffer"; c.setAttribute("role", "dialog"); c.setAttribute("aria-label", "Get the " + app.name + " app");
    c.innerHTML = `<img src="${E(app.icon)}" alt=""><b>Like this part? Get the ${E(app.name)} app</b><small>${E(app.line)}. Free, no app store. It lands on your home screen.</small>
<div class="row"><a class="get" href="${E(app.url)}">📲 Get the app</a><button class="no" type="button" data-ao="later">Not now</button><button class="no" type="button" data-ao="never">Don't ask</button><a class="all" href="/apps/">See all the Meechie's World apps</a></div>`;
    c.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ao]"); if (!b) return;
      if (b.dataset.ao === "never") put("mw_appoffer_never", true);
      c.remove();
    });
    D.body.appendChild(c);
    setTimeout(() => { if (c.isConnected && !c.matches(":hover")) c.remove(); }, 25000);
  }

  // count the seconds spent in each section (only while the page is on screen)
  setInterval(() => {
    if (D.hidden || offeredThisVisit || get("mw_appoffer_never", false)) return;
    const view = D.body && D.body.dataset.view; if (!view) return;
    const app = appFor(view); if (!app) return;
    const t = get("mw_appoffer_time", {}); t[app.id] = (t[app.id] || 0) + 5; put("mw_appoffer_time", t);
    const last = get("mw_appoffer_seen", {})[app.id] || 0;
    if (t[app.id] >= NEED && Date.now() - last > 14 * 864e5) offer(app);
  }, 5000);
  window.MW_offerApp = (id) => { const a = LIST().find((x) => x.id === id); if (a) offer(a); };
})();
