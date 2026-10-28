/* Meechie's World app installer — shared by the App Store (/apps/) and every
   app page (/radio-app/, /ai-app/, /book-app/, ...). One job: get the app
   ONTO the visitor's home screen (owner, 2026-10-27: "when people click to
   download my apps they just open, they don't go on their screen").
   The install button is always visible and always does something:
   - when the browser offers its real install prompt, the button fires it;
   - when it can't (iPhone, in-app browsers, or the prompt has not been
     offered yet), the button reveals the two-tap steps and highlights them.
   Registering the service worker here is part of installability — a page
   that never registers it can never offer an install. */
(function () {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
  var btn = document.getElementById("install-btn");
  if (!btn) return;
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone;
  if (standalone) { btn.hidden = true; return; }
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var deferred = null;
  var st = document.createElement("style");
  st.textContent = ".how-flash{animation:howflash 1.1s ease 2}@keyframes howflash{0%,100%{box-shadow:none}50%{box-shadow:0 0 0 3px #f0cf78}}";
  document.head.appendChild(st);
  function showSteps() {
    var h = document.getElementById(ios ? "how-ios" : "how-other") || document.getElementById("how-other") || document.getElementById("how-ios");
    if (h) { h.hidden = false; h.classList.remove("how-flash"); void h.offsetWidth; h.classList.add("how-flash"); try { h.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }
  }
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener("appinstalled", function () { btn.textContent = "✓ Installed — find it on your home screen"; btn.disabled = true; });
  btn.addEventListener("click", function () {
    if (deferred) {
      var p = deferred; deferred = null;
      p.prompt();
      p.userChoice.then(function (c) { if (c && c.outcome === "accepted") { btn.textContent = "✓ Installing… check your home screen"; btn.disabled = true; } else showSteps(); }).catch(function () {});
    } else showSteps();
  });
})();
