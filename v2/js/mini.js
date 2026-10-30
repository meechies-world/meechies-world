/* ============================================================================
   v2 MASTER MINI — the floating master screen (MAP §4.3 viewer).

   The mini is an engine consumer like every other screen — same
   renderer, same masking, same heal ladder — with the mini's own
   visibility gates on top, ported from the live miniApply WITH the
   #410 fixes built in from the start:

   - the render is DECOUPLED from the box visibility: renderScreen runs
     whenever there is a mix to mirror or a share is live, whatever the
     box is doing, so the play proof the gate demands can always be
     earned (a stepped-aside mini that stops receiving play/seek
     commands can never prove itself — that was the #410 trap);
   - the proof is DURABLE: the engine stamps miniOkVid at sample time
     the moment the featured slot is really playing (miniMarkOk), so a
     heal rebuild can never un-earn it;
   - the proof gate is BOUNDED (~20 s per video) and GRACED (18 s
     across a clean featured change): a permanently hidden mini with
     no error latch and no explicit gate is impossible;
   - the buffered step-aside is BOUNDED (~15 s per mask episode);
   - the intended gates, and only these, hide the box: session close
     (mw_mini_off), the stage in view (≥5 % — MAP §6 open decision,
     the live value), the booth on screen, the MW TV page, a latched
     player error for this video, or nothing to show.
   - the LIVE-SHARE POP-OUT: a viewer anywhere gets the mini carrying
     the share automatically once the greeting has passed and the feed
     is actually flowing — never for a hidden share; closing it
     dismisses THIS share only.

   The gate math lives in the pure miniStep/miniPost functions below —
     the harness drives them with fixtures; the controller is a thin
     shell over them. The camera square (his webcam stills, radio/
     camframe) rides inside the mini's stage exactly as on the live
     site: draggable, per-session hide keyed to the cam session stamp.
   ============================================================================ */

import { vmixTargets, vsBroadcast } from "./station.js";
import { getEngine } from "./engine.js";

/* ---------------- the pure gate (harness surface) ---------------- */
export function miniMarkOk(st, v) { if (v) { st.okVid = v; if (st.errVid === v) st.errVid = ""; } }

export function miniStep(st, inp) {
  /* video-change bookkeeping: an error latched against a previous
     video must not hide the new one; a clean change opens a proof
     grace for the new video and restarts the bounded-gate clock */
  if (inp.vid !== st.lastVid) {
    const prevErr = !!st.lastVid && st.errVid === st.lastVid;
    st.errVid = "";
    if (inp.vid && !prevErr) { st.graceVid = inp.vid; st.graceAt = inp.now; } else { st.graceVid = ""; st.graceAt = 0; }
    st.gateVid = ""; st.gateAt = 0; st.lastVid = inp.vid;
  }
  /* live's shareOn already excludes a hidden share — the mirror leg
     only ever sees the share when it is not hidden */
  const shareMir = !!(inp.shareOn && !inp.shareHidden);
  const shareShow = !!(shareMir && !inp.sessOff && !inp.stageInView && !inp.onTV && !inp.boothOn && inp.shareFlowing && inp.popReady);
  const show = ((inp.hasTargets || shareMir) && !inp.sessOff && !inp.stageInView && !inp.onTV && !inp.boothOn) || shareShow;
  let hidden = !show;
  /* the proof gate, bounded and graced (fix 3/4) */
  if (show && inp.vid && st.okVid !== inp.vid) {
    if (st.errVid === inp.vid) { hidden = true; st.gateVid = ""; st.gateAt = 0; }
    else if (inp.camOn) { st.gateVid = ""; st.gateAt = 0; }
    else if (st.graceVid === inp.vid && inp.now - st.graceAt < 18000) { st.gateVid = ""; st.gateAt = 0; }
    else { if (st.gateVid !== inp.vid) { st.gateVid = inp.vid; st.gateAt = inp.now; } if (inp.now - st.gateAt <= 20000) hidden = true; }
  } else { st.gateVid = ""; st.gateAt = 0; }
  /* THE #410 RULE: the render runs whenever there is a mix to mirror
     or a share is live — the gates above only ever set the box. */
  const render = inp.hasTargets || shareMir;
  return { show, hidden, render };
}

export function miniPost(st, inp) {
  /* post-render evidence + the bounded buffered step-aside (fix 5/6) */
  let hidden = inp.hidden;
  if (inp.bufMasked) {
    if (st.bufVid !== inp.vid || !st.bufAt) { st.bufVid = inp.vid; st.bufAt = inp.now; }
    if (inp.now - st.bufAt <= 15000) hidden = true;
    else if (inp.show && (st.okVid === inp.vid || inp.topSawPlay)) hidden = false;
  } else { st.bufVid = ""; st.bufAt = 0; }
  if (inp.vid) {
    if (inp.topErr) st.errVid = inp.vid;
    if (inp.topSawPlay || inp.topState1) { st.okVid = inp.vid; st.errVid = ""; }
  }
  return { hidden };
}

export const newMiniState = () => ({ lastVid: "", okVid: "", errVid: "", graceVid: "", graceAt: 0, gateVid: "", gateAt: 0, bufVid: "", bufAt: 0 });

/* ---------------- the controller ---------------- */
let mounted = null;
export function mountMini(ctx) {
  if (mounted) return mounted;
  const engine = getEngine(ctx);
  const feed = engine.feed;
  const st = newMiniState();

  let box = document.getElementById("dj-mini");
  if (!box) {
    box = document.createElement("div");
    box.id = "dj-mini"; box.hidden = true;
    box.innerHTML = "<div class='mn-bar'><span>📺 MASTER — LIVE VIDEO</span><button type='button' id='mn-close' aria-label='Hide the mini screen'>✕</button></div><div class='vstage'><div class='vslot' id='mn-vs1'></div><div class='vslot' id='mn-vs2'></div><div class='mw-camov' id='mw-camov' hidden><img id='mw-camov-img' alt='' draggable='false'><span class='mw-camov-tag'>📷 MEECHIE</span><button type='button' id='mw-camov-x' aria-label='Hide the camera square'>✕</button></div></div><div class='mn-grip' id='mn-grip' title='Drag to resize the screen'></div>";
    document.body.appendChild(box);
    box.querySelector("#mn-close").addEventListener("click", () => { try { sessionStorage.setItem("mw_mini_off", "1"); } catch (_) {} box.hidden = true; try { engine.dismissSharePop(); } catch (_) {} });
    /* draggable by its title bar — the spot is remembered per device;
       resizable by its corner grip — the size is NOT remembered
       across visits (owner, 2026-10-29), it opens at its regular
       size every visit and resizes freely within the visit */
    const mnBar = box.querySelector(".mn-bar");
    const mnPlace = (x, y) => { const w = box.offsetWidth || 208, h = box.offsetHeight || 140; x = Math.max(2, Math.min(Math.round(x), Math.max(2, innerWidth - w - 2))); y = Math.max(2, Math.min(Math.round(y), Math.max(2, innerHeight - h - 2))); box.style.left = x + "px"; box.style.top = y + "px"; box.style.right = "auto"; };
    try { const p = JSON.parse(localStorage.getItem("mw-mini-pos") || "null"); if (p && typeof p.x === "number" && typeof p.y === "number") mnPlace(p.x, p.y); } catch (_) {}
    const mnGrip = box.querySelector(".mn-grip");
    const mnMaxW = () => Math.max(140, Math.min(innerWidth, (innerHeight - 30) * 16 / 9));
    const mnSize = (w) => { w = Math.max(140, Math.min(Math.round(w), mnMaxW())); box.style.width = w + "px"; return w; };
    try { localStorage.removeItem("mw-mini-w"); } catch (_) {}
    if (mnGrip) mnGrip.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); const sx = e.clientX, sw = box.getBoundingClientRect().width; try { mnGrip.setPointerCapture(e.pointerId); } catch (_) {} const mv = (ev) => mnSize(sw + (ev.clientX - sx)); const up = () => { mnGrip.removeEventListener("pointermove", mv); mnGrip.removeEventListener("pointerup", up); mnGrip.removeEventListener("pointercancel", up); const r2 = box.getBoundingClientRect(); mnPlace(r2.left, r2.top); }; mnGrip.addEventListener("pointermove", mv); mnGrip.addEventListener("pointerup", up); mnGrip.addEventListener("pointercancel", up); });
    mnBar.addEventListener("pointerdown", (e) => { if (e.target.closest("#mn-close")) return; e.preventDefault(); const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; try { mnBar.setPointerCapture(e.pointerId); } catch (_) {} box.classList.add("mn-drag"); const mv = (ev) => mnPlace(ev.clientX - dx, ev.clientY - dy); const up = () => { mnBar.removeEventListener("pointermove", mv); mnBar.removeEventListener("pointerup", up); mnBar.removeEventListener("pointercancel", up); mn.classList.remove("mn-drag"); delete box.dataset.mnDock; try { const r2 = box.getBoundingClientRect(); localStorage.setItem("mw-mini-pos", JSON.stringify({ x: Math.round(r2.left), y: Math.round(r2.top) })); } catch (_) {} }; mnBar.addEventListener("pointermove", mv); mnBar.addEventListener("pointerup", up); mnBar.addEventListener("pointercancel", up); });
    addEventListener("resize", () => { const r = box.getBoundingClientRect(); if (!r.width) return; mnSize(r.width); mnPlace(r.left, r.top); });
  }

  const stageEl = box.querySelector(".vstage");
  const scr = engine.createScreen({
    kind: "mini", stageEl,
    slotEls: [box.querySelector("#mn-vs1"), box.querySelector("#mn-vs2")],
    standbyEl: null, chipEl: null, posterEl: null,
  });
  scr.onFeaturedPlay = (v) => miniMarkOk(st, v);

  /* ---- the camera square (live camOvSync port) ---- */
  let camFrameDoc = null, camOvFrameAt = 0, camLastPoll = 0;
  let camOvPos = { fx: 1, fy: 1 };
  try { const p = JSON.parse(localStorage.getItem("mw-camov-pos") || "null"); if (p && isFinite(+p.fx) && isFinite(+p.fy)) camOvPos = { fx: Math.min(1, Math.max(0, +p.fx)), fy: Math.min(1, Math.max(0, +p.fy)) }; } catch (_) {}
  let camOvDrag = null, camOvPlaceKey = "";
  function camOvPlace() {
    const ov = document.getElementById("mw-camov"); if (!ov || !ov.parentElement) return;
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
    const ov = document.getElementById("mw-camov"); if (!ov || ov._wired) return; ov._wired = true;
    const x = document.getElementById("mw-camov-x");
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
      const ov = document.getElementById("mw-camov"); if (!ov) return;
      camOvWire();
      const vc = feed.S.vcam || {};
      let hideFor = ""; try { hideFor = sessionStorage.getItem("mw-camov-hide") || ""; } catch (_) {}
      const fd = camFrameDoc || {};
      const fresh = !!vc.on && String(fd.at || 0) === String(vc.at || 0) && typeof fd.frame === "string" && fd.frame.indexOf("data:image/") === 0 && +fd.frameAt > 0 && (Date.now() - +fd.frameAt) <= 15000 && String(vc.at || 0) !== hideFor;
      if (!fresh) { ov.hidden = true; return; }
      if (camOvFrameAt !== +fd.frameAt) { const img = document.getElementById("mw-camov-img"); if (img) img.src = fd.frame; camOvFrameAt = +fd.frameAt; }
      ov.hidden = false;
      if (!camOvDrag) camOvPlace();
    } catch (_) {}
  }

  function stageInView() {
    const el = document.querySelector("#st-ytbox .vstage");
    if (!el || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    const iw = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const ih = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const area = r.width * r.height;
    return area > 0 && (iw * ih) / area >= 0.05;
  }

  engine.addSurface("mini", async () => {
    const S = feed.S;
    const tg = vmixTargets(S), top = tg.slice().sort((a, b) => b.op - a.op)[0];
    const vid = top ? (S[top.k] && S[top.k].yt) || "" : "";
    let sessOff = false; try { sessOff = !!sessionStorage.getItem("mw_mini_off"); } catch (_) {}
    const vsM = S.vstream || {};
    const view = (document.body && document.body.dataset && document.body.dataset.view) || "";
    const ov = document.getElementById("mw-camov");
    const res = miniStep(st, {
      vid, hasTargets: !!tg.length,
      shareOn: !!(vsM.on && vsM.meeting), shareHidden: !!vsM.hidden,
      sessOff, stageInView: stageInView(), onTV: view === "mwtv", boothOn: view === "dj",
      shareFlowing: engine.shareFlowing(), popReady: engine.popReady(),
      camOn: !!(ov && !ov.hidden), now: Date.now(),
    });
    box.hidden = res.hidden;
    camOvSync();
    if (S.vcam && S.vcam.on && Date.now() - camLastPoll > 2000) { camLastPoll = Date.now(); feed.readCamFrame().then((d) => { if (d) camFrameDoc = d; }).catch(() => {}); }
    if (!tg.length) scr.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
    if (!res.render) return;
    if (res.show) {
      // keep the mini clear of the bottom player bar (the bar is a
      // later surface; the lift applies whenever one is on the page)
      try { const pb = document.querySelector(".player-bar"); if (pb && document.body.classList.contains("has-player")) { const pr = pb.getBoundingClientRect(), mr = box.getBoundingClientRect(); if (pr.height > 0 && mr.bottom > pr.top - 4 && mr.left < pr.right && mr.right > pr.left) { box.style.top = Math.max(2, Math.round(pr.top - mr.height - 8)) + "px"; box.style.left = Math.round(mr.left) + "px"; box.style.right = "auto"; } } } catch (_) {}
      try {
        const docked = box.dataset.mnDock === "1";
        if (!box.style.left && innerWidth >= 1100 && view === "community") { const side = document.querySelector("#v-community .side, .view-community .side"); if (side) { const sr = side.getBoundingClientRect(), mr2 = box.getBoundingClientRect(); if (sr.width > 0 && mr2.right > sr.left - 8 && mr2.top < sr.bottom && mr2.bottom > sr.top) { box.style.left = Math.max(2, Math.round(sr.left - mr2.width - 12)) + "px"; box.style.right = "auto"; box.dataset.mnDock = "1"; } } }
        else if (docked && view !== "community") { box.style.left = ""; box.style.right = ""; delete box.dataset.mnDock; }
      } catch (_) {}
    }
    await engine.renderScreen(scr, true, 1, 1);
    const actM = scr.slots.filter((sl) => sl.deck && sl.p), topPM = top ? actM.find((sl) => sl.deck === top.k) : null;
    let topState1 = false;
    try { topState1 = actM.some((sl) => { try { return (sl.p.getPlayerState ? sl.p.getPlayerState() : sl.p._st) === 1; } catch (_) { return false; } }); } catch (_) {}
    const post = miniPost(st, {
      hidden: box.hidden, show: res.show, bufMasked: !!scr._bufK, vid,
      topSawPlay: !!(topPM && topPM._sawPlay), topState1,
      topErr: !!(topPM && topPM.p._err), now: Date.now(),
    });
    box.hidden = post.hidden;
  });

  mounted = { box, scr, state: st };
  return mounted;
}
