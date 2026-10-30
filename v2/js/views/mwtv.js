/* ============================================================================
   v2 MW TV — the TV station's own fullscreen channel (MAP Law 1/2,
   Phase 2). The TV screen and nothing else: the same engine screen as
   every other surface, over the channel's own standby slate (the TV
   poster — Law 9, never swapped with the radio poster).

   Paint rules ported from the live tvApply/tvPaint/tvSlatePaint:
   - the slate speaks only from a real snapshot: a cold tab reads
     "TV: connecting…", never a false off-air;
   - the badge reads 🔴 LIVE for a share, ON AIR for the mix;
   - the sound button is the station's TUNE IN (the engine's one
     listening switch); Watch jumps to Watch the Setup; ⛶ fullscreens
     the channel shell.
   The guest wall already defers on this view (core, Law 10), and the
   mini never doubles up here (its onTV gate).
   ============================================================================ */

import { vmixTargets } from "../station.js";
import { getEngine } from "../engine.js";
import { mountMini } from "../mini.js";

const MARKUP = `
<div id="tw-shell">
  <div id="tw-stagebox">
    <div class="vstage" id="tw-stage">
      <div class="vslot" id="tw-vs1"></div>
      <div class="vslot" id="tw-vs2"></div>
      <div class="vstandby" id="tw-vstandby"><img class="tw-sb-art" src="/img/tv-poster.jpg" alt="" loading="eager" fetchpriority="high" decoding="async"><div class="tw-sb"><div class="tw-sb-logo">📺 MW TV</div><p>TV: connecting…</p></div></div>
      <div class="vchip" id="tw-vchip" hidden></div>
    </div>
  </div>
  <div id="tw-bar">
    <span class="tw-mark">📺 MW TV</span>
    <span id="tw-live" class="tw-live" hidden>🔴 LIVE</span>
    <span id="tw-what" class="tw-what"></span>
    <span class="tw-sp"></span>
    <button type="button" class="btn ghost sm" id="tw-sound">🔇 Radio off — tap for sound</button>
    <button type="button" class="btn ghost sm" id="tw-watch">👀 Watch the setup</button>
    <button type="button" class="btn ghost sm" id="tw-fs" aria-label="Full screen">⛶</button>
    <a class="btn ghost sm" href="#home" data-go="home">← Meechie's World</a>
  </div>
</div>`;

let unsubs = [];
let engineRef = null, scrRef = null, tvSig = "", twSlateSig = "";
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const engine = getEngine(ctx);
  engineRef = engine;
  const feed = engine.feed;
  mountMini(ctx);
  tvSig = ""; twSlateSig = "";
  const scr = engine.createScreen({
    kind: "tv",
    stageEl: root.querySelector("#tw-stage"),
    slotEls: [root.querySelector("#tw-vs1"), root.querySelector("#tw-vs2")],
    standbyEl: root.querySelector("#tw-vstandby"),
    chipEl: root.querySelector("#tw-vchip"),
    posterEl: null,
  });
  scrRef = scr;

  root.querySelector("#tw-sound").addEventListener("click", () => { engine.toggleListening(); tvSig = ""; tvPaint(root, engine, feed); });
  root.querySelector("#tw-watch").addEventListener("click", () => { engine.setListening(true); location.hash = "#watch"; });
  root.querySelector("#tw-fs").addEventListener("click", () => {
    const sh = root.querySelector("#tw-shell");
    try { if (document.fullscreenElement) document.exitFullscreen(); else if (sh && sh.requestFullscreen) sh.requestFullscreen(); } catch (_) {}
  });
  unsubs.push(engine.onListenChange(() => { tvSig = ""; }));

  engine.addSurface("tv", async () => {
    tvSlatePaint(root, feed);
    await engine.renderSurface(scr);
    // leaving any view pauses its <video> elements in the live shell —
    // if that caught the live stream on the way out, set it playing again
    const lv = root.querySelector("#tw-stage video.vslive");
    if (lv && lv.paused && (lv.srcObject || lv.currentSrc)) { try { const p = lv.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    tvPaint(root, engine, feed);
  });
}

export function destroy() {
  unsubs.forEach((u) => { try { u(); } catch (_) {} });
  unsubs = [];
  if (engineRef) { engineRef.removeSurface("tv"); engineRef.destroyScreen(scrRef); }
  engineRef = null; scrRef = null;
}

/* the live tvSlatePaint: the slate's words are earned only by a
   snapshot — connecting, off-air, or live-on-the-tables */
function tvSlatePaint(root, feed) {
  const p = root.querySelector("#tw-vstandby .tw-sb p"); if (!p) return;
  const S = feed.S;
  const txt = !feed.seen ? "TV: connecting…" : (!S.live && !(S.vstream || {}).on && !vmixTargets(S).length) ? "Meechie is off air — the radio is always on." : "🔴 Meechie is live on the tables — the video mix appears here the moment a music video plays.";
  if (txt !== twSlateSig) { twSlateSig = txt; p.textContent = txt; }
}

function tvPaint(root, engine, feed) {
  const S = feed.S;
  const vs = S.vstream || {};
  let mode = "", label = "";
  if (vs.on && vs.meeting && !vs.hidden) { mode = "live"; label = vs.kind === "cam" ? "Meechie — live camera" : "Meechie — live screen"; }
  else { const tg = vmixTargets(S); if (tg.length) { mode = "mix"; label = "The video mix" + (S[tg[0].k] && S[tg[0].k].title ? " — " + S[tg[0].k].title : ""); } }
  const sig = mode + "|" + label + "|" + (engine.listening ? 1 : 0);
  if (sig === tvSig) return; tvSig = sig;
  const bd = root.querySelector("#tw-live"), wt = root.querySelector("#tw-what"), sb = root.querySelector("#tw-sound");
  if (bd) { bd.hidden = !mode; bd.classList.toggle("mix", mode === "mix"); bd.textContent = mode === "live" ? "🔴 LIVE" : "ON AIR"; }
  if (wt) wt.textContent = label;
  if (sb) sb.textContent = engine.listening ? "🔊 Radio on — tap to mute" : "🔇 Radio off — tap for sound";
}
