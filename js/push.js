/* Free phone notifications: members turn them on once, then get a notification when someone
 * messages them, even when Meechie's World is closed. iPhone: works after "Add to Home Screen" (iOS 16.4+). */
(function () {
  "use strict";
  const KEY = "BPnls3Sbq3c1oSaHwXsjglIB9kGQiaGu19QySLHMrqX0kpjEAbUd7OZYhi9ZYM8WwOCrOczZ3f1jn4GMUNmFQCQ";
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent), STANDALONE = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const key = () => { const s = KEY.replace(/-/g, "+").replace(/_/g, "/"), p = "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s + p), (c) => c.charCodeAt(0)); };

  async function turnOn() {
    if (!ME() || !DB()) { if (typeof openAuth === "function") openAuth("signin"); return false; }
    if (!ok) { say(IOS && !STANDALONE ? "On iPhone: tap Share ⬆️ then 'Add to Home Screen', open Meechie's World from there, then turn on notifications." : "This browser can't do notifications."); return false; }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { say("Notifications are blocked. Allow them in your browser settings."); return false; }
      const reg = await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key() });
      const j = sub.toJSON(); const mine = { endpoint: j.endpoint, keys: j.keys, at: Date.now() };
      let subs = []; try { const s = await DB().doc("push/" + ME()).get(); subs = (s.exists && s.data().subs) || []; } catch (_) {}
      subs = [mine, ...subs.filter((x) => x && x.endpoint !== mine.endpoint)].slice(0, 6);
      await DB().doc("push/" + ME()).set({ subs });
      try { localStorage.setItem("mw_push_on", "1"); } catch (_) {}
      say("🔔 Phone notifications are on"); hide(); return true;
    } catch (err) { say("Couldn't turn on notifications: " + (err.message || err)); return false; }
  }
  // after a message is sent, ping the other person's phone (messages.js calls this)
  window.MW_pushNotify = (to) => {
    try { const s = window.MW && MW.session && MW.session(); const t = s && s.access_token; if (!t || !to) return;
      fetch("/api/push", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify({ to }), keepalive: true }).catch(() => {}); } catch (_) {}
  };
  window.MW_push = { turnOn };

  // a small card asking once, after people are in and the welcome is over
  function hide() { document.getElementById("mw-push-ask")?.remove(); }
  function ask() {
    if (document.getElementById("mw-push-ask")) return;
    const c = document.createElement("div"); c.id = "mw-push-ask";
    c.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--tabbar,0px) + 150px + env(safe-area-inset-bottom,0px));z-index:9994;width:min(380px,calc(100vw - 24px));background:linear-gradient(180deg,#1f1a10,#13110c);border:1px solid var(--gold-lo,#8a6a2a);border-radius:16px;padding:14px;box-shadow:0 16px 40px rgba(0,0,0,.6);display:grid;gap:8px";
    c.innerHTML = `<b style="color:var(--gold-hi,#f0cf78)">🔔 Get notified on your phone</b><span style="color:var(--muted,#bbb);font-size:14px">Know right away when someone messages you, even when Meechie's World is closed. Free.${IOS && !STANDALONE ? " On iPhone, first tap Share ⬆️ → Add to Home Screen." : ""}</span><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost sm" type="button" data-pn="no">Not now</button><button class="btn sm" type="button" data-pn="yes">Turn on</button></div>`;
    c.addEventListener("click", (e) => { const b = e.target.closest("[data-pn]"); if (!b) return; if (b.dataset.pn === "yes") turnOn(); else { try { localStorage.setItem("mw_push_on", "later"); } catch (_) {} hide(); } });
    document.body.appendChild(c);
  }
  let n = 0;
  const t = setInterval(() => {
    if (++n > 200) return clearInterval(t);
    let st = null; try { st = localStorage.getItem("mw_push_on"); } catch (_) {}
    if (st || !ME() || typeof profileMe === "undefined" || !profileMe) return;
    if (ok && Notification.permission === "denied") return clearInterval(t);
    const en = document.getElementById("enter"); if (en && !en.hidden) return;
    if (document.getElementById("wv-box") || document.getElementById("mw-choices") || document.querySelector("dialog[open]")) return;
    if (window.MW_screenClear && !window.MW_screenClear("mw-push-ask")) return;
    clearInterval(t); setTimeout(ask, 4000);
  }, 3000);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-push-on]")) { e.preventDefault(); turnOn(); } });
})();
