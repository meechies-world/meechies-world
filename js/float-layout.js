/* Phone layout helper (owner asked: "stuff in the way of each other with no way to move it").
 * 1) MW_screenClear(): pop-up cards wait their turn, so only one shows at a time.
 * 2) Floating buttons can be dragged anywhere: press and slide. Each one remembers its spot on this device,
 *    and a plain tap still works normally. window.MW_resetFloats() (or any [data-reset-floats] button) puts them back. */
(function () {
  "use strict";
  const CARDS = ["gl-perm", "ai-hi", "mw-install", "mw-appoffer", "mw-push-ask", "mw-choices", "wv-box", "pp", "ct-box"];
  window.MW_screenClear = function (self) {
    if (document.querySelector("dialog[open]")) return false;
    if (document.body && document.body.classList.contains("dj-on")) return false; /* the DJ tables are on: pop-up cards wait until the set is over (owner, 2026-10-26) */
    const en = document.getElementById("enter"); if (en && !en.hidden && getComputedStyle(en).display !== "none") return false;
    for (const id of CARDS) { if (id === self) continue; const el = document.getElementById(id); if (el && !el.hidden && getComputedStyle(el).display !== "none" && el.getClientRects().length) return false; /* offsetParent is always null for fixed cards */ }
    return true;
  };

  /* Pop-up spacing (owner, 2026-11-02, after a visitor said there were
   * still a lot of pop-ups: "limit all that, space them out more — only
   * pop up the things they need right away"). MW_screenClear alone only
   * stopped cards OVERLAPPING; they could still arrive back-to-back for
   * minutes. So every NON-ESSENTIAL auto card (install ask, section app
   * offer, AI hello, push ask, contact ask, Face ID offer) now claims
   * this one shared gate before it shows:
   *  - nothing non-essential in the first POP_QUIET_MS of a visit —
   *    let people land and look around first;
   *  - at least POP_GAP_MS between non-essential pop-ups, with the stamp
   *    kept on the device (localStorage), so the gap holds across pages
   *    and visits — never two in a row, never a pile-up;
   *  - the screen must also be clear (the rule above), and never in app
   *    mode (the standing rule — the consumers check it too).
   * ESSENTIAL surfaces never come here: the sign-in dialog and the
   * 30-minute guest wall, any dialog a tap asked for, the age/ID check,
   * the Face ID lock, the camera-permission ask, and the real-event
   * cards (a message arriving, the live-now banner). The first-visit
   * welcome chain keeps its own rules and only STAMPS the gate when it
   * starts (MW_popStamp), so nothing piles on behind it either.
   * Callers use it exactly like MW_screenClear: claim, or wait and retry
   * inside their own existing loops. A claim stamps immediately, so two
   * callers in the same tick can never both get through. */
  const POP_GAP_MS = 10 * 60 * 1000; // min gap between non-essential pop-ups
  const POP_QUIET_MS = 90 * 1000; // opening quiet window on every page load
  const popT0 = Date.now();
  const popRead = () => { try { return +localStorage.getItem("mw_pop_last") || 0; } catch (_) { return 0; } };
  window.MW_popStamp = function () { try { localStorage.setItem("mw_pop_last", String(Date.now())); } catch (_) {} };
  window.MW_popGate = function () {
    try { if (document.documentElement.classList.contains("appmode")) return false; } catch (_) {}
    if (Date.now() - popT0 < POP_QUIET_MS) return false;
    if (Date.now() - popRead() < POP_GAP_MS) return false;
    if (!window.MW_screenClear()) return false;
    window.MW_popStamp();
    return true;
  };

  const FLOATS = ["ai-fab", "mx-fab", "mw-fab", "vz-pill", "mw-show", "mw-show-pill"];
  const KEY = "mw_float_pos";
  let pos = {}; try { pos = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pos)); } catch (_) {} };
  if (pos["mx-heads"]) { delete pos["mx-heads"]; save(); } // chat heads are never draggable: a dragged stack parked itself over other UI and swallowed taps (owner bug report, 2026-10-25)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function place(el) {
    const p = pos[el.id]; if (!p) return;
    const w = el.offsetWidth || 50, h = el.offsetHeight || 50;
    const x = clamp(p.x * innerWidth, 4, innerWidth - w - 4), y = clamp(p.y * innerHeight, 4, innerHeight - h - 4);
    el.style.setProperty("left", x + "px", "important"); el.style.setProperty("top", y + "px", "important");
    el.style.setProperty("right", "auto", "important"); el.style.setProperty("bottom", "auto", "important");
    el.style.setProperty("transform", "none", "important");
  }
  function wire(el) {
    if (el.dataset.mwDrag) return; el.dataset.mwDrag = "1";
    el.style.touchAction = "none";
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false, pid = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // inside the video player only the frame edge / top strip drags, so its buttons and video still work
      if (el.id === "mw-show" && e.target.closest("button,video,a,input")) return;
      const r = el.getBoundingClientRect(); down = true; moved = false; pid = e.pointerId;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    });
    addEventListener("pointermove", (e) => {
      if (!down || e.pointerId !== pid) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 10) return;
      if (!moved) { moved = true; el.classList.add("mw-dragging"); }
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = clamp(ox + dx, 4, innerWidth - w - 4), y = clamp(oy + dy, 4, innerHeight - h - 4);
      el.style.setProperty("left", x + "px", "important"); el.style.setProperty("top", y + "px", "important");
      el.style.setProperty("right", "auto", "important"); el.style.setProperty("bottom", "auto", "important");
      el.style.setProperty("transform", "none", "important");
      e.preventDefault();
    }, { passive: false });
    const end = (e) => {
      if (!down || (e && e.pointerId !== pid)) return; down = false;
      if (!moved) return;
      el.classList.remove("mw-dragging");
      const r = el.getBoundingClientRect(); pos[el.id] = { x: r.left / innerWidth, y: r.top / innerHeight }; save();
      // swallow the click that follows a drag, so dragging doesn't also open the thing
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      el.addEventListener("click", stop, { capture: true, once: true }); setTimeout(() => el.removeEventListener("click", stop, true), 400);
    };
    addEventListener("pointerup", end); addEventListener("pointercancel", end);
    place(el);
  }
  function scan() { for (const id of FLOATS) { const el = document.getElementById(id); if (el) wire(el); } }
  window.MW_resetFloats = function () {
    pos = {}; save();
    for (const id of FLOATS) { const el = document.getElementById(id); if (el) ["left", "top", "right", "bottom", "transform"].forEach((k) => el.style.removeProperty(k)); }
  };
  const css = document.createElement("style");
  css.textContent = `.mw-dragging{opacity:.85;outline:2px dashed var(--gold-hi,#f0cf78);outline-offset:3px;transition:none!important;cursor:grabbing}
@media(max-width:600px){
  /* phones: keep the default spots from stacking on each other, above the bottom tab bar */
  #ai-fab{right:12px!important;bottom:calc(var(--tabbar,0px) + 12px + env(safe-area-inset-bottom,0px))}
  #mx-fab{bottom:calc(var(--tabbar,0px) + 64px + env(safe-area-inset-bottom,0px))}
  #mw-install{bottom:calc(var(--tabbar,0px) + 128px)!important}
}`;
  (document.head || document.documentElement).appendChild(css);
  const go = () => { scan(); new MutationObserver(scan).observe(document.body, { childList: true }); };
  if (document.body) go(); else document.addEventListener("DOMContentLoaded", go);
  addEventListener("resize", () => { for (const id of FLOATS) { const el = document.getElementById(id); if (el && pos[id]) place(el); } tidy(); });

  /* Tidy corners: the little floating buttons line up neatly in two stacks (left and right) above the
   * music player and the bottom tabs, so none of them ever sit on top of each other.
   * A button someone dragged to their own spot stays where they put it. */
  const STACKS = { right: ["ai-fab", "mx-fab"], left: ["mw-fab", "mw-show-pill", "vz-pill"] };
  const shown = (el) => { if (!el || el.hidden) return false; const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && el.offsetWidth > 0; };
  function tidy() {
    // "0 on now" adds nothing; only show the viewer count when someone is actually here
    const vz = document.getElementById("vz-pill");
    if (vz) { const zero = /(^|\D)0 on now/.test(vz.textContent || ""); vz.style.setProperty("display", zero ? "none" : "", zero ? "important" : ""); }
    let floor = 12;
    const tab = document.querySelector(".apptab"); if (shown(tab)) floor += tab.offsetHeight;
    const pb = document.querySelector(".player-bar"); if (shown(pb)) { const r = pb.getBoundingClientRect(); if (r.top < innerHeight) floor = Math.max(floor, innerHeight - r.top + 12); }
    for (const side of ["left", "right"]) {
      let y = floor;
      for (const id of STACKS[side]) {
        const el = document.getElementById(id); if (!shown(el) || pos[id] || el.classList.contains("mw-dragging")) continue;
        el.style.setProperty("bottom", y + "px", "important"); el.style.setProperty("top", "auto", "important");
        el.style.setProperty(side, (innerWidth < 600 ? 12 : 16) + "px", "important"); el.style.setProperty(side === "left" ? "right" : "left", "auto", "important");
        el.style.setProperty("transform", "none", "important");
        y += el.offsetHeight + 10;
      }
    }
  }
  window.MW_tidyFloats = tidy;
  setInterval(tidy, 1200); setTimeout(tidy, 300);
  const _reset = window.MW_resetFloats; window.MW_resetFloats = () => { _reset(); tidy(); };
  // "Reset buttons" link anywhere: <button data-reset-floats>
  document.addEventListener("click", (e) => { if (e.target.closest("[data-reset-floats]")) { e.preventDefault(); window.MW_resetFloats(); } });
})();
