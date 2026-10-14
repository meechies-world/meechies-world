/* Face ID / fingerprint unlock.
 * After a member signs in on a phone or computer that has Face ID, Touch ID, a fingerprint reader or Windows Hello,
 * they're offered "Unlock with Face ID / fingerprint". From then on, when they come back to the site on that device,
 * it stays locked until they unlock it with their face or finger (or they choose to sign in with their password instead).
 * This uses the device's own passkey system (WebAuthn): the face or fingerprint never leaves the phone,
 * and Meechie's World never sees it. Each device is set up on its own. */
(function () {
  "use strict";
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { return null; } };
  const ss = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (_) { return null; } };
  const uid = () => { try { const s = window.MW && MW.session && MW.session(); return (s && s.user && s.user.id) || ""; } catch (_) { return ""; } };
  const KEY = (u) => "mw_bio_" + u;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const LOCK_AFTER = 10 * 60 * 1000; // re-lock after 10 minutes away from the site
  const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
  const label = isApple ? "Face ID / Touch ID" : "fingerprint / face unlock";

  const css = document.createElement("style");
  css.textContent = `
#bio-lock{position:fixed;inset:0;z-index:100050;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at 50% 35%,#221b10,#060504 70%)}
#bio-lock .in{width:min(380px,100%);display:grid;gap:14px;justify-items:center;text-align:center}
#bio-lock .em{width:96px;height:96px;filter:drop-shadow(0 0 20px rgba(212,168,67,.35))}
#bio-lock h3{margin:0;font:800 22px var(--display,Georgia,serif);color:var(--gold-hi,#f0cf78);letter-spacing:.04em}
#bio-lock p{margin:0;color:#b9ad97;font:15px/1.45 var(--body,system-ui)}
#bio-lock .go{display:inline-flex;gap:10px;align-items:center;justify-content:center;width:100%;font:800 17px var(--body,system-ui);padding:15px 18px;border-radius:999px;border:0;background:linear-gradient(180deg,#f0cf78,#c99a35);color:#0b0a08;cursor:pointer}
#bio-lock .alt{background:none;border:0;color:#b9ad97;text-decoration:underline;cursor:pointer;font:14px var(--body,system-ui)}
#bio-lock .msg{min-height:1.2em;color:#f0cf78;font-size:14px}
#bio-offer{position:fixed;left:50%;bottom:calc(var(--tabbar,0px) + 150px);transform:translateX(-50%);z-index:10020;width:min(420px,calc(100% - 24px));display:grid;gap:10px;background:#12100c;border:1px solid var(--gold,#d4a843);border-radius:16px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.6)}
#bio-offer b{font-size:16px}#bio-offer p{margin:0;color:var(--muted,#b9ad97);font-size:14px}
#bio-offer .row{display:flex;gap:8px;justify-content:flex-end}`;
  document.head.appendChild(css);

  const emblem = () => { const sym = document.querySelector("symbol#emblem"); return sym ? `<svg class="em" viewBox="${sym.getAttribute("viewBox") || "0 0 200 200"}" aria-hidden="true"><use href="#emblem"/></svg>` : ""; };
  const fingerIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 11v3a6 6 0 0 1-1.5 4"/><path d="M8 7.5A6 6 0 0 1 18 12v1"/><path d="M6 11a6 6 0 0 1 .5-2.4"/><path d="M9 21a10 10 0 0 0 2-6v-3a1 1 0 0 1 2 0v2"/><path d="M15 20a14 14 0 0 0 1-4"/><path d="M4 15v-3a8 8 0 0 1 14-5.3"/></svg>';

  /* ---------- the lock screen ---------- */
  function lock(u, cred) {
    if (document.getElementById("bio-lock")) return;
    const b = document.createElement("div"); b.id = "bio-lock"; b.setAttribute("role", "dialog"); b.setAttribute("aria-modal", "true"); b.setAttribute("aria-label", "Unlock Meechie's World");
    b.innerHTML = `<div class="in">${emblem()}<h3>Welcome back</h3><p>Unlock Meechie's World with ${label}.</p>
      <button type="button" class="go" id="bio-go">${fingerIcon}<span>Unlock</span></button><p class="msg" id="bio-msg" aria-live="polite"></p>
      <button type="button" class="alt" id="bio-pw">Sign in with my password instead</button></div>`;
    document.body.appendChild(b);
    document.documentElement.style.overflow = "hidden";
    const msg = b.querySelector("#bio-msg");
    const go = async () => {
      msg.textContent = "";
      try {
        const a = await navigator.credentials.get({ publicKey: { challenge: rand(32), allowCredentials: [{ type: "public-key", id: unb64(cred) }], userVerification: "required", timeout: 60000 } });
        if (!a) throw new Error("cancelled");
        ss("mw_bio_ok", String(Date.now())); b.remove(); document.documentElement.style.overflow = "";
      } catch (e) { msg.textContent = e && e.name === "NotAllowedError" ? "That didn't go through. Tap Unlock to try again." : "Couldn't unlock. Try again, or sign in with your password."; }
    };
    b.querySelector("#bio-go").addEventListener("click", go);
    b.querySelector("#bio-pw").addEventListener("click", () => { ls(KEY(u), null); try { window.MW && MW.signOut && MW.signOut(); } catch (_) {} b.remove(); document.documentElement.style.overflow = ""; });
  }

  /* ---------- offer to turn it on ---------- */
  async function offer(u) {
    if (ls(KEY(u)) || ls("mw_bio_no_" + u) || document.getElementById("bio-offer")) return;
    let ok = false; try { ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (_) {}
    if (!ok) return;
    const o = document.createElement("div"); o.id = "bio-offer"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Turn on " + label);
    o.innerHTML = `<b>🔐 Unlock with ${label}?</b><p>Next time you come back on this device, just use your face or finger instead of typing your password. Your face and fingerprint never leave your device.</p>
      <div class="row"><button type="button" class="btn ghost sm" id="bio-not">Not now</button><button type="button" class="btn sm" id="bio-yes">Turn on</button></div>`;
    document.body.appendChild(o);
    o.querySelector("#bio-not").addEventListener("click", () => { ls("mw_bio_no_" + u, "1"); o.remove(); });
    o.querySelector("#bio-yes").addEventListener("click", async () => {
      try {
        const name = (typeof members !== "undefined" && members[u] && members[u].handle) || "Member";
        const c = await navigator.credentials.create({ publicKey: {
          challenge: rand(32), rp: { name: "Meechie's World" },
          user: { id: new TextEncoder().encode(u).slice(0, 64), name: name, displayName: name },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
          timeout: 60000, attestation: "none" } });
        if (!c) throw new Error("cancelled");
        ls(KEY(u), b64(c.rawId)); ss("mw_bio_ok", String(Date.now())); o.remove();
        if (typeof toast === "function") toast("✅ " + label + " unlock is on for this device");
      } catch (e) { o.remove(); if (typeof toast === "function") toast("Couldn't turn it on. You can try again from Settings later."); }
    });
  }

  /* ---------- decide what to show ---------- */
  function check() {
    const u = uid(); if (!u) return;
    const cred = ls(KEY(u));
    const okAt = +(ss("mw_bio_ok") || 0), pw = +(ss("mw_bio_pw") || 0);
    if (cred && pw && Date.now() - pw < 3 * 60 * 1000) { ss("mw_bio_ok", String(Date.now())); return; } // just signed in with the password
    if (cred) { if (!okAt || Date.now() - okAt > LOCK_AFTER) lock(u, cred); }
    else setTimeout(() => offer(u), 20000); // offer after they've been in for a little while
  }
  // signing in with a password counts as unlocked
  document.addEventListener("submit", (e) => { if (e.target && e.target.querySelector && e.target.querySelector('input[type="password"]')) ss("mw_bio_pw", String(Date.now())); }, true);
  document.addEventListener("click", (e) => { const f = e.target.closest && e.target.closest("form, #gate, dialog"); if (f && f.querySelector && f.querySelector('input[type="password"]') && e.target.closest("button")) ss("mw_bio_pw", String(Date.now())); }, true);
  let away = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { away = Date.now(); const okAt = +(ss("mw_bio_ok") || 0); if (okAt) ss("mw_bio_ok", String(Math.max(okAt, away))); return; }
    if (away && Date.now() - away > LOCK_AFTER) { ss("mw_bio_ok", "0"); check(); }
  });
  window.MW_bioReset = () => { const u = uid(); if (u) { ls(KEY(u), null); ls("mw_bio_no_" + u, null); } };
  const start = () => (window.MW && MW.sessionReady ? MW.sessionReady.then(() => setTimeout(check, 300)) : setTimeout(start, 300));
  start();
})();
