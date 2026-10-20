/* Meechie's World Originals: Meechie's own AI promo videos.
 *  - Sign-up screen (before people log in): the grand-opening video.
 *  - Right after they log in and tap Enter: Meechie's welcome video, full screen with sound, then the welcome song.
 *  - Dating page: the dating video at the top.
 *  - Everything else (including "Join us") shows as a swipeable row on Home and Videos ([data-originals]).
 * Videos stream from Supabase storage (so iPhones can play them); the site's own copies are the backup. */
(function () {
  const SB = "/m/media/9c4f7de6-bd82-46f9-88af-7fac069fe0e9/";
  const SIGNUP = { src: SB + "8e5b60225eca435aa5a4.mp4", local: "/media/promo/signup.mp4", poster: "/media/promo/signup.jpg" };
  const WELCOME = { src: SB + "f17f7218dda844dfba65.mp4", local: "/media/promo/welcome.mp4", poster: "/media/promo/welcome.jpg" };
  const DATING = { src: SB + "78e447b06fb049edb036.mp4", local: "/media/promo/dating.mp4", poster: "/media/promo/dating.jpg" };
  const VIDS = [["e5046a81a8bc4c63b2de", "join-us"],
    ["c32d30b697824b44aa60", "mw-1"], ["0fb7db9bc08a4140ab11", "mw-2"], ["21545b26ee8b41b9aa83", "mw-3"], ["cd1c5c148ee4425196d8", "mw-4"],
    ["414400b86f194364986b", "mw-5"], ["3cd44e04305d45368ce7", "mw-6"], ["b53436a297bc4fd9a781", "mw-7"],
  ].map(([id, n]) => ({ src: SB + id + ".mp4", local: "/media/promo/" + n + ".mp4", poster: "/media/promo/" + n + ".jpg" }));
  const vid = (v, attrs) => `<video ${attrs} poster="${v.poster}" playsinline preload="metadata"><source src="${v.src}" type="video/mp4"><source src="${v.local}" type="video/mp4"></video>`;

  const css = document.createElement("style");
  css.textContent = `
#gate .gt-vid{position:relative;justify-self:center;width:min(250px,64vw);aspect-ratio:9/16;border-radius:18px;overflow:hidden;border:2px solid var(--gold);box-shadow:0 18px 50px rgba(0,0,0,.6),0 0 30px rgba(212,168,67,.25);background:#000}
#gate .gt-vid video{width:100%;height:100%;object-fit:cover;display:block}
#gate .gt-snd{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);border:1px solid var(--gold-hi);background:rgba(0,0,0,.72);color:#fff;font:700 13px var(--body);padding:8px 14px;border-radius:999px;cursor:pointer;white-space:nowrap}
#gate .gt-thanks{margin:0;font:600 17px/1.45 var(--body);color:var(--text)}
#gate .gt-free{display:inline-flex;align-items:center;gap:8px;justify-self:center;background:rgba(111,191,139,.12);border:1px solid #2f7d4a;color:#a6e3bb;border-radius:999px;padding:7px 14px;font:700 14px var(--body)}
.orig-wrap{position:relative;margin-top:14px}
.orig-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(170px,210px);gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px;scrollbar-width:none;overscroll-behavior-x:contain}
.orig-row::-webkit-scrollbar{display:none}
.orig-card{position:relative;aspect-ratio:9/16;border-radius:16px;overflow:hidden;border:1px solid var(--line);background:#000;scroll-snap-align:start;cursor:pointer}
.orig-card video{width:100%;height:100%;object-fit:cover;display:block}
.orig-card .snd{position:absolute;top:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;border:1px solid var(--gold,#d4a843);border-radius:999px;padding:6px 12px;font:600 12px var(--body);white-space:nowrap;pointer-events:none}
.orig-card.loud .snd{display:none}
@media (max-width:640px){.orig-row{grid-auto-columns:62vw}}
.orig-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:44px;height:44px;border-radius:50%;border:1px solid var(--gold,#d4a843);background:rgba(0,0,0,.72);color:var(--gold-hi,#f0cf78);font:800 26px/1 var(--body,system-ui);display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.5)}
.orig-nav:hover{background:rgba(212,168,67,.25)}.orig-nav.prev{left:-6px}.orig-nav.next{right:-6px}
.orig-card .num{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.7);color:#fff;border-radius:999px;padding:3px 9px;font:700 11px var(--body);pointer-events:none}
#wv-box{position:fixed;inset:0;z-index:100001;background:#000;display:grid;place-items:center}
#wv-box video{width:100%;height:100%;max-width:min(100vw,calc(100vh*9/16));object-fit:contain;background:#000}
#wv-box .skip{position:absolute;right:16px;top:calc(env(safe-area-inset-top,0px) + 16px);border:1px solid var(--gold-hi,#f0cf78);background:rgba(0,0,0,.6);color:#fff;font:700 14px var(--body,system-ui);padding:9px 16px;border-radius:999px;cursor:pointer}
#wv-box .cap{position:absolute;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);text-align:center;color:var(--gold-hi,#f0cf78);font:800 15px var(--body,system-ui);letter-spacing:.06em;text-shadow:0 2px 8px #000;pointer-events:none}
#wv-box .snd{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:1px solid var(--gold-hi,#f0cf78);background:rgba(0,0,0,.72);color:#fff;font:700 15px var(--body,system-ui);padding:12px 20px;border-radius:999px;cursor:pointer}
.dt-vid{position:relative;width:min(300px,78vw);aspect-ratio:9/16;margin:0 auto 22px;border-radius:18px;overflow:hidden;border:2px solid var(--gold);box-shadow:0 18px 50px rgba(0,0,0,.55);background:#000;cursor:pointer}
.dt-vid video{width:100%;height:100%;object-fit:cover;display:block}
.dt-vid .snd{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);background:rgba(0,0,0,.72);color:#fff;border:1px solid var(--gold-hi);border-radius:999px;padding:7px 13px;font:700 13px var(--body);white-space:nowrap;pointer-events:none}
.dt-vid.loud .snd{display:none}`;
  document.head.appendChild(css);

  /* ---------- sign-up screen: the Join us video + thank you ---------- */
  const g = document.getElementById("gate");
  if (g) {
    const sub = g.querySelector(".gt-sub");
    const box = document.createElement("div"); box.className = "gt-welcome"; box.style.cssText = "display:grid;gap:12px";
    box.innerHTML = `<p class="gt-thanks">🙏 Thank you for coming to Meechie's World!</p>
      <div class="gt-vid">${vid(SIGNUP, 'autoplay muted loop id="gt-video" aria-label="Meechie\'s World grand opening"')}<button type="button" class="gt-snd" id="gt-snd">🔇 Tap for sound</button></div>
      <span class="gt-free">✅ Creating your account is 100% free. No card needed.</span>`;
    if (sub) sub.after(box);
    const v = box.querySelector("video"), b = box.querySelector("#gt-snd");
    const sound = (on) => { v.muted = !on; b.textContent = on ? "🔊 Sound on" : "🔇 Tap for sound"; if (on) v.play().catch(() => {}); };
    b.addEventListener("click", (e) => { e.stopPropagation(); sound(v.muted); });
    v.addEventListener("click", () => sound(v.muted));
    // only play while the sign-up screen is showing
    new MutationObserver(() => { if (g.hidden) { v.pause(); } }).observe(g, { attributes: true, attributeFilter: ["hidden"] });
    if (g.hidden) v.removeAttribute("autoplay"); else v.play().catch(() => {});
  }

  /* ---------- right after login: Meechie's welcome video (full screen, then the welcome song) ---------- */
  window.MW_welcome = function (done) {
    let finished = false;
    const fin = () => { if (finished) return; finished = true; try { v.pause(); } catch (_) {} b.remove(); done && done(); };
    const b = document.createElement("div"); b.id = "wv-box"; b.setAttribute("role", "dialog"); b.setAttribute("aria-label", "Welcome to Meechie's World");
    b.innerHTML = vid(WELCOME, 'autoplay playsinline') + '<button type="button" class="skip">Skip ›</button><div class="cap">WELCOME TO MEECHIE\'S WORLD</div>';
    document.body.appendChild(b);
    const v = b.querySelector("video");
    v.addEventListener("ended", fin); v.addEventListener("error", () => setTimeout(fin, 400));
    b.querySelector(".skip").addEventListener("click", fin);
    // the Enter tap counts as permission for sound; if the phone still blocks it, play muted with a "tap for sound" button
    v.play().catch(() => { v.muted = true; v.play().catch(fin);
      const s = document.createElement("button"); s.type = "button"; s.className = "snd"; s.textContent = "🔊 Tap for sound"; b.appendChild(s);
      s.addEventListener("click", () => { v.muted = false; v.currentTime = 0; v.play().catch(() => {}); s.remove(); }); });
    setTimeout(() => { if (!finished && v.paused && v.currentTime === 0) fin(); }, 9000); // never get stuck if it can't load
  };

  /* ---------- Dating page: the dating video at the top ---------- */
  const dt = document.getElementById("dt-root");
  if (dt) {
    const w = document.createElement("div"); w.className = "dt-vid"; w.innerHTML = vid(DATING, 'muted loop aria-label="Meechie\'s World Dating"') + '<span class="snd">🔇 Tap for sound</span>';
    dt.before(w);
    const v = w.querySelector("video"), view = w.closest(".view");
    const sound = (on) => { v.muted = !on; w.classList.toggle("loud", on); if (on) { window.MW_videoSound?.start(); v.play().catch(() => {}); } else window.MW_videoSound?.end(); };
    w.addEventListener("click", () => sound(v.muted));
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && view && !view.hidden) { if (window.MW_canSound && MW_canSound() && v.muted) sound(true); v.play().catch(() => { if (!v.muted) { sound(false); v.play().catch(() => {}); } }); } else { v.pause(); if (!v.muted) sound(false); } }), { threshold: 0.5 }).observe(w);
    if (view) new MutationObserver(() => { if (view.hidden) { v.pause(); if (!v.muted) sound(false); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ---------- the Originals row (Home and Videos) ---------- */
  document.querySelectorAll("[data-originals]").forEach((row) => {
    row.innerHTML = VIDS.map((v, i) => `<div class="orig-card" data-o="${i}">${vid(v, 'muted')}<span class="snd">🔇 Tap for sound</span><span class="num">${i + 1} / ${VIDS.length}</span></div>`).join("");
    const cards = [...row.querySelectorAll(".orig-card")];
    let loud = false; // after a tap, the next videos keep their sound
    const stopAll = (except) => cards.forEach((c) => { if (c !== except) { const v = c.querySelector("video"); if (!v.paused) v.pause(); if (c.classList.contains("loud")) { c.classList.remove("loud"); v.muted = true; window.MW_videoSound?.end(); } } });
    function play(c, withSound, fromStart) {
      stopAll(c); const v = c.querySelector("video");
      if (fromStart) { try { v.currentTime = 0; } catch (_) {} }
      const s = withSound || loud || (window.MW_canSound && MW_canSound());
      v.muted = !s; c.classList.toggle("loud", s);
      if (s) window.MW_videoSound?.start();
      v.play().catch(() => { if (!v.muted) { v.muted = true; c.classList.remove("loud"); window.MW_videoSound?.end(); v.play().catch(() => {}); } });
    }
    let auto = 0; // ignore the scroll handler while we move the row ourselves
    function goTo(i, withSound) {
      const c = cards[(i + cards.length) % cards.length];
      auto = Date.now();
      row.scrollTo({ left: c.offsetLeft - row.offsetLeft - (row.clientWidth - c.offsetWidth) / 2, behavior: "smooth" });
      play(c, withSound, true);
    }
    const idx = (c) => cards.indexOf(c);
    const current = () => cards.find((c) => !c.querySelector("video").paused) || centered();
    const centered = () => { const r = row.getBoundingClientRect(); let best = null, bv = 0; cards.forEach((c) => { const b = c.getBoundingClientRect(); const vis = Math.min(b.right, r.right) - Math.max(b.left, r.left); if (vis > bv + 4) { bv = vis; best = c; } }); return best; };
    const shown = () => !row.closest(".view")?.hidden;
    // when one video ends, the next one plays (after the last, it goes back to the first)
    cards.forEach((c, i) => c.querySelector("video").addEventListener("ended", () => { if (shown()) goTo(i + 1, c.classList.contains("loud")); }));
    // ‹ › buttons
    const wrap = row.closest(".orig-wrap");
    if (wrap) {
      wrap.insertAdjacentHTML("beforeend", '<button type="button" class="orig-nav prev" aria-label="Previous video">‹</button><button type="button" class="orig-nav next" aria-label="Next video">›</button>');
      wrap.querySelector(".orig-nav.prev").addEventListener("click", (e) => { e.stopPropagation(); const c = current(); goTo((c ? idx(c) : 0) - 1, true); loud = true; });
      wrap.querySelector(".orig-nav.next").addEventListener("click", (e) => { e.stopPropagation(); const c = current(); goTo((c ? idx(c) : -1) + 1, true); loud = true; });
    }
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && e.intersectionRatio >= 0.5 && shown()) { const c = centered(); if (c && c.querySelector("video").paused) play(c, false); } else stopAll(null); }), { threshold: [0, 0.5] }).observe(row);
    let t = 0; row.addEventListener("scroll", () => { clearTimeout(t); t = setTimeout(() => { if (Date.now() - auto < 1200) return; const c = centered(); if (c && c.querySelector("video").paused && shown()) play(c, false); }, 220); }, { passive: true });
    row.addEventListener("click", (e) => { const c = e.target.closest(".orig-card"); if (!c) return; const v = c.querySelector("video");
      if (!c.classList.contains("loud")) { loud = true; play(c, true); } else if (v.paused) v.play().catch(() => {}); else { v.pause(); } });
    // leaving the page stops it
    const view = row.closest(".view"); if (view) new MutationObserver(() => { if (view.hidden) stopAll(null); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  });
})();
