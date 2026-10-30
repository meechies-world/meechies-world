/* ============================================================================
   v2 MASTER BAND — the cemented in-flow master screen (MAP Law 1,
   in-flow band amendment + CEMENT LAW, owner 2026-10-30 12:46).

   This module is the old "mini" module, rebuilt for the cement law.
   The file keeps the mini.js name (the shell registry and the harness
   reference it) and the band screen keeps the engine kind "mini",
   but everything the floating mini / phone dock were is GONE:
   no JS-created box, no drag, no resize grip, no saved position, no
   session close (mw_mini_off), no proof gate, no stage-in-view
   step-aside, no buffered step-aside. Those were ~150 lines whose
   only job was deciding when a floating box may appear; a cemented
   band has no such decision to make.

   THE CEMENT RULES this module implements:
   - the band markup ships STATIC in v2/index.html (#dj-band >
     #dj-mini, slots #mn-vs1/#mn-vs2, the TV-poster slate
     #mn-vposter) — present from first paint, styled from first paint
     by css/shell.css. mountBand only BINDS it. If the markup is
     absent, the band is absent: this module never creates it late.
   - the band is present on EVERY view, at every width. Only the
     picture inside changes. Its idle slate is the TV poster
     (img/tv-poster.jpg — station art law: the radio poster belongs
     only to the radio stage) — never black.
   - NO close/hide control exists at any width.
   - suppression is structural only, and lives in css/shell.css as
     well as here: MW TV (the screen IS the page), the DJ booth view
     (its own master screen is built in), the Playground
     (html.popdj). The sign-in gate does not hide the band — the
     band is in place the instant the wall lifts.
   - SOUND: the band is the sounding master surface at every width
     whenever shown. The engine's one sounding ladder decides
     (MW TV > Watch > band > station stage); this module renders
     ONLY through that shared engine (renderSurface) — there is no
     second player system here or anywhere.
   - PLAYERS ONLY IN VISIBLE SURFACES (#443): on MW TV and the
     booth the band does not render at all; while Watch is open the
     band holds its poster slate and Watch's screen holds the only
     framed players (the live miniApply gate). On the Radio view the
     band AND the station stage both render, by design (the live
     lifecycle table) — the stage is the sounding fallback there.
   - the band's package rides along, unchanged in composition: a
     shop chip on the screen's left, the 🎤 request button over a
     promo chip on its right, the request wrap below — the chips
     painted from the same shop feed + promo rotation the stage
     rails use (js/rails.js RAIL_PROMOS + js/commerce.js
     loadShopFeed), and the request slot wired by rails.js
     mountRails with prefix "mn", exactly like the Radio stage
     ("st") and the Watch screen ("wb"). No new request code.
   - the camera square (his webcam stills, radio/camframe) rides
     inside the band's stage exactly as on the live site: draggable
     within the screen, per-session hide keyed to the cam session
     stamp. (The square's own ✕ hides the SQUARE, never the band.)

   The pure gate is bandStep below — the harness drives it with
   fixtures; the controller is a thin shell over it.
   ============================================================================ */

import { vmixTargets } from "./station.js";
import { getEngine } from "./engine.js";
import { mountRails, RAIL_PROMOS } from "./rails.js";
import { loadShopFeed, esc as E } from "./commerce.js";

/* ---------------- the pure gate (harness surface) ---------------- */
/* Inputs: hasTargets (a mix to mirror), shareOn/shareHidden (a live
   share, live's rule: hidden shares never mirror), onTV / boothOn /
   sandbox (the structural suppressions), watchOn (Watch's screen is
   the framed surface). Output: show = the band is present; render =
   the band's engine screen may hold players this tick. There is no
   hidden-but-rendering state anymore (#410's trap was a creature of
   the floating box) and no proof/buffer gate: masking and slate
   patience live in the engine's renderScreen, where they belong. */
export function bandStep(inp) {
  const shareMir = !!(inp.shareOn && !inp.shareHidden);
  const suppressed = !!(inp.onTV || inp.boothOn || inp.sandbox);
  const show = !suppressed;
  const render = show && !inp.watchOn && !!(inp.hasTargets || shareMir);
  return { show, hidden: !show, render, suppressed };
}

/* ---------------- the chips (live mnChipHTML / mnRailPaint) ------- */
function chipHTML(prods, promos, ix) {
  const p = prods && prods.length ? prods[ix % prods.length] : null;
  const pr = promos && promos.length ? promos[ix % promos.length] : null;
  const left = p ? `<a href="${E(p.url)}" target="_blank" rel="noopener">${p.img ? `<img src="${E(p.img)}" alt="" loading="lazy" decoding="async">` : ""}<span class="mn-chip-n">${E(p.title)}</span>${p.price ? `<span class="mn-chip-p2">${E(p.price)}</span>` : ""}</a>` : "";
  const promo = pr ? `<a href="${E(pr.href)}"><span class="mn-chip-t">${E(pr.tag)}</span><span class="mn-chip-n">${E(pr.text)}</span></a>` : "";
  return { left, promo, any: !!(p || pr) };
}

/* ---------------- the controller ---------------- */
let mounted = null;
export function mountBand(ctx) {
  if (mounted) return mounted;
  /* BIND, NEVER BUILD: the markup is the shell's (index.html). */
  const band = document.getElementById("dj-band");
  const box = document.getElementById("dj-mini");
  if (!band || !box) return null;
  const engine = getEngine(ctx);
  const feed = engine.feed;

  const sndBtn = box.querySelector("#mn-snd"), popBtn = box.querySelector("#mn-pop");
  const paintSnd = () => { if (sndBtn) sndBtn.textContent = engine.listening ? "🔊" : "🔇"; };
  if (sndBtn) sndBtn.addEventListener("click", () => { engine.setListening(!engine.listening); paintSnd(); });
  if (popBtn) popBtn.addEventListener("click", () => { location.hash = "#mwtv"; });
  engine.onListenChange(paintSnd);
  paintSnd();

  const scr = engine.createScreen({
    kind: "mini", stageEl: box.querySelector(".vstage"),
    slotEls: [box.querySelector("#mn-vs1"), box.querySelector("#mn-vs2")],
    standbyEl: null, chipEl: box.querySelector("#mn-vchip"), posterEl: box.querySelector("#mn-vposter"),
  });

  /* the request slot + shout banner + mystat, wired by the shared
     rails module (prefix "mn") — the same code the Radio stage and
     Watch screen use; the chips below are its miniature rails */
  mountRails(band, ctx, { prefix: "mn", getS: () => feed.S });

  /* ---- the chips: one rotating shop thumb at the screen's left,
     a promo chip under the 🎤 in the right column, cycling together
     every 12 s off the same inventory the stage rails rotate on.
     When neither exists, both chips fold and the screen takes the
     whole row (the live .mn-naked rule). ---- */
  let chipProds = null, chipIx = 0, chipSig = "";
  loadShopFeed().then((f) => { chipProds = (f || []).map((x) => ({ title: x.title, img: x.img, price: x.price, url: x.url })); chipPaint(); }).catch(() => { chipProds = []; });
  function chipPaint() {
    const l = box.querySelector("#mn-chip-l"), r = box.querySelector("#mn-chip-p");
    if (!l && !r) return;
    let annT = ""; try { const bar = document.getElementById("announce"), t = document.getElementById("announce-text"); if (bar && !bar.hidden && t && t.textContent.trim()) annT = t.textContent.trim().slice(0, 160); } catch (_) {}
    const promos = (annT ? [{ tag: "📣 FROM MEECHIE", text: annT, href: "#home" }] : []).concat(RAIL_PROMOS.map((x) => ({ tag: x.tag, text: String(x.html || "").replace(/<[^>]+>/g, ""), href: x.href })));
    const h = chipHTML(chipProds || [], promos, chipIx);
    const sig = chipIx + "|" + (chipProds ? chipProds.length : -1) + "|" + (annT ? "a" : "") + "|" + h.any;
    if (sig === chipSig) return; chipSig = sig;
    if (l) { l.innerHTML = h.left; l.hidden = !h.left; }
    if (r) { r.innerHTML = h.promo; r.hidden = !h.promo; }
    const row = box.querySelector(".mn-row"); if (row) row.classList.toggle("mn-naked", !h.any);
  }
  chipPaint();
  setInterval(() => { if (document.hidden) return; chipIx++; chipPaint(); }, 12000);

  /* ---- the camera square (live camOvSync port, unchanged) ---- */
  let camFrameDoc = null, camOvFrameAt = 0, camLastPoll = 0;
  let camOvPos = { fx: 1, fy: 1 };
  try { const p = JSON.parse(localStorage.getItem("mw-camov-pos") || "null"); if (p && isFinite(+p.fx) && isFinite(+p.fy)) camOvPos = { fx: Math.min(1, Math.max(0, +p.fx)), fy: Math.min(1, Math.max(0, +p.fy)) }; } catch (_) {}
  let camOvDrag = null, camOvPlaceKey = "";
  function camOvPlace() {
    const ov = box.querySelector("#mw-camov"); if (!ov || !ov.parentElement) return;
    const stg = ov.parentElement, pw = stg.clientWidth, ph = stg.clientHeight;
    if (!pw) return;
    const key = pw + "x" + ph + "|" + camOvPos.fx + "|" + camOvPos.fy + "|" + camOvFrameAt;
    if (key === camOvPlaceKey) return;
    const or2 = ov.getBoundingClientRect();
    if (!or2.width) return;
    camOvPlaceKey = key;
    ov.style.left = Math.round(camOvPos.fx * Math.max(0, pw - or2.width)) + "px";
    ov.style.top = Math.round(camOvPos.fy * Math.max(0, ph - or2.height)) + "px";
  }
  function camOvWire() {
    const ov = box.querySelector("#mw-camov"); if (!ov || ov._wired) return; ov._wired = true;
    const x = box.querySelector("#mw-camov-x");
    if (x) {
      x.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      x.addEventListener("click", (ev) => { ev.stopPropagation(); try { sessionStorage.setItem("mw-camov-hide", String((feed.S.vcam && feed.S.vcam.at) || 0)); } catch (_) {} ov.hidden = true; });
    }
    ov.addEventListener("pointerdown", (ev) => {
      const stg = ov.parentElement; if (!stg) return;
      const or2 = ov.getBoundingClientRect();
      camOvDrag = { id: ev.pointerId, dx: ev.clientX - or2.left, dy: ev.clientY - or2.top };
      try { ov.setPointerCapture(ev.pointerId); } catch (_) {}
      ev.preventDefault();
    });
    ov.addEventListener("pointermove", (ev) => {
      if (!camOvDrag || ev.pointerId !== camOvDrag.id) return;
      const stg = ov.parentElement; if (!stg) return;
      const sr = stg.getBoundingClientRect(), or2 = ov.getBoundingClientRect(), pw = stg.clientWidth, ph = stg.clientHeight;
      let nx = ev.clientX - (sr.left + stg.clientLeft) - camOvDrag.dx, ny = ev.clientY - (sr.top + stg.clientTop) - camOvDrag.dy;
      nx = Math.max(0, Math.min(nx, Math.max(0, pw - or2.width)));
      ny = Math.max(0, Math.min(ny, Math.max(0, ph - or2.height)));
      ov.style.left = Math.round(nx) + "px"; ov.style.top = Math.round(ny) + "px";
      camOvPos = { fx: pw - or2.width > 0 ? nx / (pw - or2.width) : 1, fy: ph - or2.height > 0 ? ny / (ph - or2.height) : 1 };
    });
    const end = (ev) => { if (camOvDrag && (!ev || ev.pointerId === camOvDrag.id)) { camOvDrag = null; try { localStorage.setItem("mw-camov-pos", JSON.stringify(camOvPos)); } catch (_) {} } };
    ov.addEventListener("pointerup", end);
    ov.addEventListener("pointercancel", () => end(null));
  }
  function camOvSync() {
    try {
      const ov = box.querySelector("#mw-camov"); if (!ov) return;
      camOvWire();
      const vc = feed.S.vcam || {};
      let hideFor = ""; try { hideFor = sessionStorage.getItem("mw-camov-hide") || ""; } catch (_) {}
      const fd = camFrameDoc || {};
      const fresh = !!vc.on && String(fd.at || 0) === String(vc.at || 0) && typeof fd.frame === "string" && fd.frame.indexOf("data:image/") === 0 && +fd.frameAt > 0 && (Date.now() - +fd.frameAt) <= 15000 && String(vc.at || 0) !== hideFor;
      if (!fresh) { ov.hidden = true; return; }
      if (camOvFrameAt !== +fd.frameAt) { const img = box.querySelector("#mw-camov-img"); if (img) img.src = fd.frame; camOvFrameAt = +fd.frameAt; }
      ov.hidden = false;
      if (!camOvDrag) camOvPlace();
    } catch (_) {}
  }

  engine.addSurface("mini", async () => {
    const S = feed.S;
    const tg = vmixTargets(S);
    const vsM = S.vstream || {};
    const view = (document.body && document.body.dataset && document.body.dataset.view) || "";
    const res = bandStep({
      hasTargets: !!tg.length,
      shareOn: !!(vsM.on && vsM.meeting), shareHidden: !!vsM.hidden,
      onTV: view === "mwtv", boothOn: view === "dj", watchOn: view === "watch",
      sandbox: document.documentElement.classList.contains("popdj"),
    });
    band.hidden = res.hidden;
    engine.setBandShown(res.show);
    if (res.suppressed) return;
    camOvSync();
    if (S.vcam && S.vcam.on && Date.now() - camLastPoll > 2000) { camLastPoll = Date.now(); feed.readCamFrame().then((d) => { if (d) camFrameDoc = d; }).catch(() => {}); }
    if (!tg.length) scr.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
    if (!res.render) return;
    /* the band renders ONLY through the shared engine's surface
       path: renderSurface asks soundingScreen() who sounds (the
       ladder: MW TV > Watch > band > stage) and mutes every other
       screen — the band sounds exactly when the ladder says so */
    await engine.renderSurface(scr);
  });

  mounted = { box, band, scr };
  return mounted;
}
