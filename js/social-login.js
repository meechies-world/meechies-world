/* "Continue with Google / Apple / X / Discord / ..." buttons on the sign-in screens.
 * Only shows the apps that are switched on in Supabase (Authentication > Providers),
 * so a new one appears here by itself as soon as it's set up. Facebook keeps its own button. */
(function () {
  "use strict";
  const LABEL = { google: ["Google", "#fff", "#1f1f1f"], apple: ["Apple", "#000", "#fff"], twitter: ["X", "#000", "#fff"], x: ["X", "#000", "#fff"], discord: ["Discord", "#5865f2", "#fff"],
    spotify: ["Spotify", "#1db954", "#000"], twitch: ["Twitch", "#9146ff", "#fff"], linkedin_oidc: ["LinkedIn", "#0a66c2", "#fff"], azure: ["Microsoft", "#2f2f2f", "#fff"],
    slack_oidc: ["Slack", "#4a154b", "#fff"], github: ["GitHub", "#24292f", "#fff"], gitlab: ["GitLab", "#fc6d26", "#fff"], zoom: ["Zoom", "#0b5cff", "#fff"], notion: ["Notion", "#fff", "#000"], kakao: ["Kakao", "#fee500", "#000"] };
  const css = document.createElement("style");
  css.textContent = `.mw-sso{display:grid;gap:8px;margin:8px 0}.mw-sso button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border-radius:999px;padding:11px 14px;font:700 15px var(--body,system-ui);cursor:pointer;border:1px solid #0003}
.mw-sso small{color:var(--muted,#bbb);text-align:center;font-size:12px}`;
  document.head.appendChild(css);

  async function providers() {
    try {
      const c = window.MW_CONFIG || {};
      const r = await fetch(c.SUPABASE_URL + "/auth/v1/settings", { headers: { apikey: c.SUPABASE_ANON_KEY } }).then((x) => x.json());
      return Object.entries(r.external || {}).filter(([k, v]) => v === true && LABEL[k]).map(([k]) => k);
    } catch (_) { return []; }
  }
  function go(p, msgEl) {
    if (!window.MW || !MW.sb) return;
    if (msgEl) msgEl.textContent = "Opening " + LABEL[p][0] + "…";
    MW.sb.auth.signInWithOAuth({ provider: p, options: { redirectTo: location.origin + "/" } }).then((r) => { if (r.error && msgEl) msgEl.textContent = r.error.message; });
  }
  function bar(list, msgEl) {
    const d = document.createElement("div"); d.className = "mw-sso";
    d.innerHTML = list.map((p) => { const [n, bg, fg] = LABEL[p]; return `<button type="button" data-sso="${p}" style="background:${bg};color:${fg}">Continue with ${n}</button>`; }).join("");
    d.addEventListener("click", (e) => { const b = e.target.closest("[data-sso]"); if (b) go(b.dataset.sso, msgEl); });
    return d;
  }
  async function init() {
    const list = await providers(); if (!list.length) return;
    const gfb = document.getElementById("gt-fb"); // members-only gate
    if (gfb && !document.querySelector("#gate .mw-sso")) gfb.after(bar(list, document.getElementById("gt-msg")));
    else { const gf = document.querySelector("#gate form"); if (gf && !document.querySelector("#gate .mw-sso")) gf.after(bar(list, document.getElementById("gt-msg"))); }
    const as = document.getElementById("auth-social"); // sign-in dialog
    if (as && !document.querySelector("#auth-dialog .mw-sso")) as.after(bar(list, document.getElementById("auth-msg")));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
