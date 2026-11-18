/* Meechie's World app installer — shared by the App Store (/apps/) and every
   app page (/radio-app/, /ai-app/, /book-app/, ...). One job: get the app
   ONTO the visitor's home screen with the app's own icon (owner, 2026-10-27:
   "when people click to download my apps they just open, they don't go on
   their screen"; 2026-10-28: "the install button still doesn't work" and
   "the icon they're installing is on the download thing they see").
   How it works now:
   - Every app page carries a tiny head script that captures the browser's
     install offer (beforeinstallprompt) the moment it fires, so the offer
     is never missed because this file loaded a second too late.
   - Tapping Install fires the real install dialog — the one that shows the
     app's icon from the page's manifest — whenever the browser has offered
     it. If the offer has not arrived yet, the tap waits a few seconds for
     it before falling back to the two-tap steps.
   - Inside another app's built-in browser (Facebook, Messenger, Instagram,
     TikTok...) installs are impossible, so the tap says so plainly and
     offers an "Open in Chrome" jump on Android.
   - When the app is already on the phone, the button says so instead of
     looking broken.
   Registering the service worker here is part of installability — a page
   that never registers it can never offer an install. */
(function () {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
  var btn = document.getElementById("install-btn");
  if (!btn) return;
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
  if (standalone) { btn.hidden = true; return; }
  var ua = navigator.userAgent || "";
  var ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var inApp = /FBAN|FBAV|FB_IAB|Instagram|Messenger|Snapchat|musical_ly|TikTok|; wv\)|GSA\//i.test(ua);
  var man = document.querySelector('link[rel="manifest"]');
  var ikey = "mw_inst_" + (man ? man.getAttribute("href") : "main");
  var deferred = window.__mwBIP || null;
  window.__mwBIP = null;
  var st = document.createElement("style");
  st.textContent = ".how-flash{animation:howflash 1.1s ease 2}@keyframes howflash{0%,100%{box-shadow:none}50%{box-shadow:0 0 0 3px #f0cf78}}";
  document.head.appendChild(st);
  function showSteps() {
    var h = document.getElementById(ios ? "how-ios" : "how-other") || document.getElementById("how-other") || document.getElementById("how-ios");
    if (h) { h.hidden = false; h.classList.remove("how-flash"); void h.offsetWidth; h.classList.add("how-flash"); try { h.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }
  }
  function note(html) {
    var h = document.getElementById("how-other") || document.getElementById("how-ios");
    if (h) { h.innerHTML = html; h.hidden = false; try { h.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }
  }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; try { localStorage.removeItem(ikey); } catch (_) {} if (!btn.disabled) btn.textContent = btn.getAttribute("data-label") || btn.textContent; });
  window.addEventListener("appinstalled", function () { try { localStorage.setItem(ikey, "1"); } catch (_) {} btn.textContent = "✓ Installed — find it on your home screen"; btn.disabled = true; });
  try { if (localStorage.getItem(ikey)) { btn.setAttribute("data-label", btn.textContent); btn.textContent = "✓ Installed — it's on your home screen"; } } catch (_) {}
  function firePrompt() {
    var p = deferred; deferred = null;
    p.prompt();
    p.userChoice.then(function (c) {
      if (c && c.outcome === "accepted") { btn.textContent = "✓ Installing… check your home screen"; btn.disabled = true; }
      else showSteps();
    }).catch(function () { showSteps(); });
  }
  btn.addEventListener("click", function () {
    if (deferred) { firePrompt(); return; }
    if (inApp) {
      var url = location.href.replace(/^https?:\/\//, "");
      note("<b>You're inside another app's browser</b> — installs can't happen in here. " + (ios
        ? "Tap the <b>•••</b> or <b>Share</b> menu and choose <b>“Open in Safari,”</b> then tap Install there."
        : "Open this page in <b>Chrome</b>, then tap Install: <a href=\"intent://" + url + "#Intent;scheme=https;package=com.android.chrome;end\" style=\"color:#f0cf78;font-weight:700\">Open in Chrome →</a>"));
      return;
    }
    /* The browser's install offer often lands a second or two after the
       page — give it a short window before falling back to the steps. */
    var old = btn.textContent; btn.disabled = true; btn.textContent = "⏳ Getting your install ready…";
    var waited = 0;
    var iv = setInterval(function () {
      waited += 250;
      if (deferred) { clearInterval(iv); btn.disabled = false; btn.textContent = old; firePrompt(); }
      else if (waited >= 3000) { clearInterval(iv); btn.disabled = false; btn.textContent = old; showSteps(); }
    }, 250);
  });
})();
