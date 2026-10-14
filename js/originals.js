/* Meechie's World Originals: Meechie's own AI promo videos.
 *  - The "Join us" video plays on the sign-up screen (before people log in).
 *  - The rest show as a swipeable row of vertical videos on Home and Videos ([data-originals]).
 * Videos stream from Supabase storage (so iPhones can play them); the site's own copies are the backup. */
(function () {
  const SB = "https://yjouaysczttqbytksejq.supabase.co/storage/v1/object/public/media/9c4f7de6-bd82-46f9-88af-7fac069fe0e9/";
  const JOIN = { src: SB + "e5046a81a8bc4c63b2de.mp4", local: "/media/promo/join-us.mp4", poster: "/media/promo/join-us.jpg" };
  const VIDS = [
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
@media (max-width:640px){.orig-row{grid-auto-columns:62vw}}`;
  document.head.appendChild(css);

  /* ---------- sign-up screen: the Join us video + thank you ---------- */
  const g = document.getElementById("gate");
  if (g) {
    const sub = g.querySelector(".gt-sub");
    const box = document.createElement("div"); box.className = "gt-welcome"; box.style.cssText = "display:grid;gap:12px";
    box.innerHTML = `<p class="gt-thanks">🙏 Thank you for coming to Meechie's World!</p>
      <div class="gt-vid">${vid(JOIN, 'autoplay muted loop id="gt-video" aria-label="Meechie\'s World: join us"')}<button type="button" class="gt-snd" id="gt-snd">🔇 Tap for sound</button></div>
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

  /* ---------- the Originals row (Home and Videos) ---------- */
  document.querySelectorAll("[data-originals]").forEach((row) => {
    row.innerHTML = VIDS.map((v, i) => `<div class="orig-card" data-o="${i}">${vid(v, 'muted loop')}<span class="snd">🔇 Tap for sound</span></div>`).join("");
    const cards = [...row.querySelectorAll(".orig-card")];
    let loud = false; // after a tap, the next videos keep their sound
    const stopAll = (except) => cards.forEach((c) => { if (c !== except) { const v = c.querySelector("video"); if (!v.paused) v.pause(); if (c.classList.contains("loud")) { c.classList.remove("loud"); v.muted = true; window.MW_videoSound?.end(); } } });
    function play(c, withSound) {
      stopAll(c); const v = c.querySelector("video");
      const s = withSound || loud || (window.MW_canSound && MW_canSound());
      v.muted = !s; c.classList.toggle("loud", s);
      if (s) window.MW_videoSound?.start();
      v.play().catch(() => { if (!v.muted) { v.muted = true; c.classList.remove("loud"); window.MW_videoSound?.end(); v.play().catch(() => {}); } });
    }
    const centered = () => { const r = row.getBoundingClientRect(); let best = null, bv = 0; cards.forEach((c) => { const b = c.getBoundingClientRect(); const vis = Math.min(b.right, r.right) - Math.max(b.left, r.left); if (vis > bv + 4) { bv = vis; best = c; } }); return best; };
    const shown = () => !row.closest(".view")?.hidden;
    new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && e.intersectionRatio >= 0.5 && shown()) { const c = centered(); if (c) play(c, false); } else stopAll(null); }), { threshold: [0, 0.5] }).observe(row);
    let t = 0; row.addEventListener("scroll", () => { clearTimeout(t); t = setTimeout(() => { const c = centered(); if (c && c.querySelector("video").paused && shown()) play(c, false); }, 220); }, { passive: true });
    row.addEventListener("click", (e) => { const c = e.target.closest(".orig-card"); if (!c) return; const v = c.querySelector("video");
      if (!c.classList.contains("loud")) { loud = true; play(c, true); } else if (v.paused) v.play().catch(() => {}); else { v.pause(); } });
    // leaving the page stops it
    const view = row.closest(".view"); if (view) new MutationObserver(() => { if (view.hidden) stopAll(null); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  });
})();
