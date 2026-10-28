/* "Continue with Google / Facebook" buttons on the sign-in screens.
 * Shows the providers switched on in the site's own backend settings
 * (/api/cf/auth/settings). Facebook keeps its own button. */
(function () {
  "use strict";
  const LABEL = { google: ["Google", "#fff", "#1f1f1f"], apple: ["Apple", "#000", "#fff"], twitter: ["X", "#000", "#fff"], x: ["X", "#000", "#fff"], discord: ["Discord", "#5865f2", "#fff"],
    spotify: ["Spotify", "#1db954", "#000"], twitch: ["Twitch", "#9146ff", "#fff"], linkedin_oidc: ["LinkedIn", "#0a66c2", "#fff"], azure: ["Microsoft", "#2f2f2f", "#fff"],
    slack_oidc: ["Slack", "#4a154b", "#fff"], github: ["GitHub", "#24292f", "#fff"], gitlab: ["GitLab", "#fc6d26", "#fff"], zoom: ["Zoom", "#0b5cff", "#fff"], notion: ["Notion", "#fff", "#000"], kakao: ["Kakao", "#fee500", "#000"] };
  const css = document.createElement("style");
  css.textContent = `.mw-sso{display:grid;gap:8px;margin:8px 0}.mw-sso button{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;border-radius:999px;padding:11px 14px;font:700 15px var(--body,system-ui);cursor:pointer;border:1px solid #0003}
.mw-sso small{color:var(--muted,#bbb);text-align:center;font-size:12px}`;
  document.head.appendChild(css);

  /* Meechie's World's own backend (Cloudflare): Google's official "Sign in with Google" button, no outside auth service needed */
  const CF = (window.MW_CONFIG || {}).BACKEND === "cf";
  let gid = null, gisLoading = null;
  function loadGIS() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (!gisLoading) gisLoading = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return gisLoading;
  }
  async function gisInit(msgEl) {
    await loadGIS();
    if (gisInit.done) return; gisInit.done = true;
    // full-page sign-in (no pop-up window): pop-ups are blocked in many phone browsers and in-app browsers
    google.accounts.id.initialize({ client_id: gid, ux_mode: "redirect", login_uri: location.origin + "/api/cf/auth/google-redirect", callback: async (resp) => {
      const m = msgEl || document.getElementById("auth-msg") || document.getElementById("gt-msg"); if (m) m.textContent = "Signing you in…";
      const r = await MW.sb.auth.signInWithIdToken({ provider: "google", token: resp.credential });
      if (r.error) { if (m) m.textContent = r.error.message; return; }
      location.reload();
    } });
  }
  window.MW_googleSignIn = () => { if (gid) gisInit().then(() => google.accounts.id.prompt()).catch(() => {}); };
  async function providers() {
    try { const r = await fetch("/api/cf/auth/settings").then((x) => x.json()); gid = r.google || null; return [...(gid ? ["google"] : []), ...(r.facebook ? ["facebook"] : [])]; } catch (_) { return []; }
  }
  function bar(list, msgEl) {
    const d = document.createElement("div"); d.className = "mw-sso";
    if (CF && list.includes("facebook")) {
      // Facebook: a full-page sign-in too (no pop-up)
      const fb = document.createElement("a"); fb.href = "/api/cf/auth/facebook"; fb.textContent = "Continue with Facebook";
      fb.style.cssText = "display:flex;align-items:center;justify-content:center;width:min(360px,100%);margin:0 auto;border-radius:999px;padding:11px 14px;font:700 15px var(--body,system-ui);background:#1877f2;color:#fff;text-decoration:none";
      d.appendChild(fb);
    }
    if (CF && gid) {
      const slot = document.createElement("div"); slot.style.cssText = "display:flex;justify-content:center;min-height:44px"; d.appendChild(slot);
      gisInit(msgEl).then(() => google.accounts.id.renderButton(slot, { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: Math.min(360, (slot.parentElement && slot.parentElement.clientWidth) || 320) })).catch(() => { slot.textContent = "Google sign-in couldn't load. Check your connection."; });
      return d;
    }
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
