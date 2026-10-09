/* Social layer: follow people, follower counts, member count + who's online at the top,
 * green "online" dots on avatars, followed people's posts first, message sounds + phone notifications,
 * an "Install the app" prompt, and quiet error reporting so problems get fixed. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  let follows = {}; // uid -> [ids they follow]
  window.MW_FOLLOWING = new Set(); window.MW_ONLINE = new Set();
  window.MW_FOLLOWERS = (id) => Object.values(follows).filter((l) => l.includes(id)).length;

  const css = document.createElement("style");
  css.textContent = `
#mw-stats{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;padding:6px 12px;font:700 12.5px var(--body);color:var(--muted);border-bottom:1px solid var(--line);background:#0d0b08}
#mw-stats b{color:var(--gold-hi)}#mw-stats .on{color:#4ade80}
.avatar{position:relative}.avatar.online::after{content:"";position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid #0b0a08}
.fl-btn{margin-left:6px}.fl-btn.on{background:transparent;border:1px solid var(--line);color:var(--muted)}
#mw-install{position:fixed;left:12px;right:12px;bottom:calc(var(--tabbar,0px) + 12px);z-index:10030;display:flex;align-items:center;gap:10px;background:#15130f;border:1px solid var(--gold);border-radius:16px;padding:12px;box-shadow:0 14px 40px rgba(0,0,0,.6);max-width:520px;margin:0 auto}
#mw-install img{width:44px;height:44px;border-radius:10px}#mw-install div{flex:1;min-width:0;font-size:14px}#mw-install b{display:block;color:var(--gold-hi)}`;
  document.head.appendChild(css);

  /* ---------- top bar: members, online, my followers ---------- */
  const bar = document.createElement("div"); bar.id = "mw-stats"; bar.setAttribute("aria-live", "polite");
  const header = document.querySelector("header.bar"); if (header) header.after(bar);
  let memberCount = 0;
  async function countMembers() {
    try { const { count } = await MW.sb.from("docs").select("path", { count: "exact", head: true }).eq("coll", "members"); if (typeof count === "number") memberCount = count; } catch (_) {}
    paintBar();
  }
  function paintBar() {
    const mine = ME() ? window.MW_FOLLOWERS(ME()) : 0, fol = window.MW_FOLLOWING.size;
    bar.innerHTML = `<span>👥 <b>${memberCount.toLocaleString()}</b> members</span><span class="on">● <b style="color:#4ade80">${window.MW_ONLINE.size}</b> online now</span>` + (ME() ? `<span>❤️ <b>${mine}</b> followers</span><span>➕ <b>${fol}</b> following</span>` : "");
  }

  /* ---------- follows ---------- */
  async function setFollowing(list) {
    const d = DB(); if (!d || !ME()) return;
    await d.doc("follows/" + ME()).set({ list: [...new Set(list)].slice(0, 5000) }).catch((e) => say(e.message || e.code));
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-follow]"); if (!b) return; e.preventDefault();
    if (typeof needMember === "function" && !needMember()) return;
    const id = b.dataset.follow; if (id === ME()) return;
    const s = new Set(window.MW_FOLLOWING); const was = s.has(id); was ? s.delete(id) : s.add(id);
    window.MW_FOLLOWING = s; paintFollowButtons(); paintBar();
    await setFollowing([...s]);
    say(was ? "Unfollowed" : "Following " + (typeof handleOf === "function" ? handleOf(id) : "them") + ". Their posts show first in your feed.");
    try { renderFeed(); } catch (_) {}
  });
  function paintFollowButtons() {
    document.querySelectorAll("[data-follow]").forEach((b) => { const on = window.MW_FOLLOWING.has(b.dataset.follow); b.classList.toggle("on", on); b.textContent = on ? "Following" : "＋ Follow"; });
  }

  /* ---------- online dots ---------- */
  function paintOnline() {
    try { if (typeof room !== "undefined" && room && room.peers) window.MW_ONLINE = new Set(room.peers().map((p) => p.by).filter(Boolean)); } catch (_) {}
    if (ME()) window.MW_ONLINE.add(ME());
    document.querySelectorAll(".avatar[data-uid]").forEach((a) => a.classList.toggle("online", window.MW_ONLINE.has(a.dataset.uid)));
    paintBar();
  }
  setInterval(paintOnline, 4000);
  new MutationObserver(() => { clearTimeout(paintOnline._t); paintOnline._t = setTimeout(() => { paintFollowButtons(); document.querySelectorAll(".avatar[data-uid]").forEach((a) => a.classList.toggle("online", window.MW_ONLINE.has(a.dataset.uid))); }, 150); }).observe(document.body, { childList: true, subtree: true });

  /* ---------- message sounds + notifications ---------- */
  let actx = null;
  function ding() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const t = actx.currentTime;
      [880, 1320].forEach((f, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; o.type = "sine"; g.gain.setValueAtTime(0.0001, t + i * 0.12); g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.12 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.3); o.connect(g).connect(actx.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.32); });
    } catch (_) {}
    try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (_) {}
  }
  window.MW_NOTIFY = (title, body) => {
    ding();
    try { if ("Notification" in window && Notification.permission === "granted" && document.hidden) { const n = new Notification(title, { body, icon: "/img/icon-192.png", badge: "/img/icon-192.png", tag: "mw-msg" }); n.onclick = () => { window.focus(); try { go("messages"); } catch (_) {} n.close(); }; } } catch (_) {}
  };
  // ask once, after the person does something (browsers require a tap first)
  document.addEventListener("click", () => { try { if ("Notification" in window && Notification.permission === "default" && ME() && !localStorage.getItem("mw_np")) { localStorage.setItem("mw_np", "1"); Notification.requestPermission(); } } catch (_) {} }, { once: true });

  /* ---------- install the app ---------- */
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; showInstall(); });
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  function showInstall() {
    if (standalone() || document.getElementById("mw-install")) return;
    try { if (+localStorage.getItem("mw_inst_skip") > Date.now()) return; } catch (_) {}
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
    if (!deferred && !ios) return;
    const d = document.createElement("div"); d.id = "mw-install";
    d.innerHTML = `<img src="/img/icon-192.png" alt=""><div><b>Get the Meechie's World app</b>${ios ? "Tap the Share button, then “Add to Home Screen”." : "Free. Opens full screen, right from your home screen."}</div>${ios ? "" : '<button class="btn sm" type="button" id="mw-inst-go">Install</button>'}<button class="act" type="button" id="mw-inst-x" aria-label="Not now">✕</button>`;
    document.body.appendChild(d);
    d.querySelector("#mw-inst-x").onclick = () => { d.remove(); try { localStorage.setItem("mw_inst_skip", Date.now() + 3 * 864e5); } catch (_) {} };
    const go2 = d.querySelector("#mw-inst-go"); if (go2) go2.onclick = async () => { d.remove(); if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch (_) {} deferred = null; } };
  }
  setTimeout(showInstall, 6000);
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

  /* ---------- quiet error reporting (the owner sees these and they get fixed) ---------- */
  let sent = 0;
  function report(msg, src) {
    if (sent > 5 || !msg || /ResizeObserver|Script error|extension|chrome-extension/i.test(msg + src)) return; sent++;
    const d = DB(); if (!d || !ME()) return;
    d.collection("errors").add({ msg: String(msg).slice(0, 300), src: String(src || "").slice(0, 200), page: location.hash, ua: navigator.userAgent.slice(0, 160), build: (document.querySelector('meta[name="mw-build"]') || {}).content || "", createdAt: Date.now() }).catch(() => {});
  }
  addEventListener("error", (e) => report(e.message, (e.filename || "") + ":" + (e.lineno || "")));
  addEventListener("unhandledrejection", (e) => report("promise: " + ((e.reason && e.reason.message) || e.reason), ""));

  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { countMembers(); return; }
    d.collection("follows").limit(5000).onSnapshot((s) => {
      follows = {}; s.docs.forEach((x) => { const l = x.data().list; follows[x.id] = Array.isArray(l) ? l.filter((i) => typeof i === "string") : []; });
      window.MW_FOLLOWING = new Set(follows[ME()] || []); paintFollowButtons(); paintBar();
      try { renderFeed(); } catch (_) {}
    }, () => {});
    countMembers(); setInterval(countMembers, 120000); paintOnline();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
