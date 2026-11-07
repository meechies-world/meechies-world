/* Sign-up easier (owner, 2026-11-07 "Sign-up easier").
 * 1. A 👁 button on the password box so people can check what they typed.
 * 2. Making an account is step 1; joining Meechie's Book (a name + a photo) is step 2, and nobody was told.
 *    Right after "Create my account" works, this takes the new person straight to that form, glowing gold,
 *    with a short "one last step" note, and the cursor in the name box. Once per sign-up; never in app mode pop-ups
 *    (it's a page move the person just asked for by signing up, not a pop-up). */
(function () {
  "use strict";
  if (window.MW_JOIN_PLUS) return; window.MW_JOIN_PLUS = true;
  const D = document, $ = (s) => D.querySelector(s);
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch (_) {} } };

  const css = D.createElement("style");
  css.textContent = `#auth-dialog .jp-pw{position:relative}
#auth-dialog .jp-pw input{padding-right:52px!important}
#auth-dialog .jp-eye{position:absolute;right:6px;bottom:6px;width:40px;height:34px;border:0;border-radius:10px;background:rgba(214,170,74,.14);color:#f0cf78;font-size:17px;cursor:pointer}
#join-form.jp-glow{box-shadow:0 0 0 2px #f0cf78,0 0 34px rgba(255,200,90,.45)!important;border-radius:16px;animation:jpPulse 1.6s ease-in-out 3}
@keyframes jpPulse{50%{box-shadow:0 0 0 2px #ffe08a,0 0 54px rgba(255,200,90,.7)}}
#jp-step{grid-column:1/-1;margin:0 0 12px;padding:12px 14px;border-radius:14px;background:linear-gradient(180deg,rgba(40,30,12,.95),rgba(14,11,6,.95));box-shadow:inset 0 0 0 1px rgba(232,190,100,.6);color:#f3ead2;font:500 15px/1.45 var(--body,system-ui)}
#jp-step b{color:#ffe08a;display:block;font-size:16px;margin-bottom:2px}`;
  D.head.appendChild(css);

  // 1. show / hide password
  function eye() {
    const pw = $("#auth-pass"); if (!pw || pw.dataset.jp) return; pw.dataset.jp = "1";
    const f = pw.closest(".field"); if (!f) return; f.classList.add("jp-pw");
    const b = D.createElement("button"); b.type = "button"; b.className = "jp-eye"; b.setAttribute("aria-label", "Show password"); b.textContent = "👁";
    b.addEventListener("click", () => { const show = pw.type === "password"; pw.type = show ? "text" : "password"; b.setAttribute("aria-label", show ? "Hide password" : "Show password"); b.textContent = show ? "🙈" : "👁"; pw.focus(); });
    f.appendChild(b);
  }
  eye();
  const dlg = $("#auth-dialog");
  if (dlg) {
    // remember that this was a sign-up (not a sign-in) when the form is sent
    dlg.addEventListener("submit", () => { const t = ($("#auth-go") || {}).textContent || ""; if (/create/i.test(t)) { ss.set("mw_jp_new", String(Date.now())); watch(); } else ss.del("mw_jp_new"); const pw = $("#auth-pass"); if (pw) pw.type = "password"; }, true);
  }

  // 2. after the account is made, go to the last step
  const signedIn = () => { try { return !!(window.MW && MW.session && MW.session() && MW.session().user); } catch (_) { return false; } };
  const isMember = () => { try { return typeof profileMe !== "undefined" && !!profileMe; } catch (_) { return false; } };
  let t = 0;
  function watch() { if (!t) t = setInterval(tick, 700); }
  function stop() { clearInterval(t); t = 0; }
  function tick() {
    const at = +ss.get("mw_jp_new") || 0;
    if (!at) return stop();
    if (Date.now() - at > 10 * 60 * 1000) { ss.del("mw_jp_new"); return stop(); }
    if (!signedIn()) return;
    if (dlg && dlg.open) return; // still on the sign-up box (e.g. "check your email")
    if (isMember()) { ss.del("mw_jp_new"); return stop(); }
    const form = $("#join-form"); if (!form || typeof go !== "function") return;
    ss.del("mw_jp_new"); stop();
    go("community");
    setTimeout(() => {
      if (!$("#jp-step")) {
        const n = D.createElement("div"); n.id = "jp-step"; n.setAttribute("role", "status");
        n.innerHTML = "<b>You're in! One last step 👑</b>Pick your name and add a photo so people know it's you. Then you can post, chat and add friends.";
        form.prepend(n);
      }
      form.classList.add("jp-glow");
      try { form.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) { form.scrollIntoView(); }
      const h = $("#j-handle"); if (h) setTimeout(() => { try { h.focus({ preventScroll: true }); } catch (_) {} }, 600);
      setTimeout(() => form.classList.remove("jp-glow"), 6000);
    }, 400);
  }
  if (ss.get("mw_jp_new")) watch(); // came back after confirming email in this tab
})();
