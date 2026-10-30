/* ============================================================================
   v2 DIRECTORY VIEWS (Phase 5) — #liveradio and #livetv: the
   world directory cards from ./directory-cards.js (the ported
   live js/live.js). On the live site the cards ride inside the
   Radio and Videos pages; these routes are where the app-mode
   tabs land, so each card gets its page here — Live TV with its
   own stage in the Videos page's shape.
   ============================================================================ */

import { mountWorldRadio, mountLiveTv } from "./directory-cards.js";

let cleanup = [];
export function render(root, ctx) {
  if (ctx.view.id === "livetv") {
    root.innerHTML = `<div class="wrap"><div class="section-head"><div><p class="eyebrow">Free live TV</p><h2>Live TV</h2></div><p class="muted">Official free live streams: news from your city and the world, plus free movies.</p></div>
    <div class="yt-stage"><div class="yt-frame" id="yt-frame"><div class="yt-empty"><span>Live channels play here.</span></div></div><div class="yt-now" id="yt-now"></div></div>
    <div id="ltv-mount"></div></div>`;
    const stop = mountLiveTv(root, ctx);
    if (typeof stop === "function") cleanup.push(stop);
  } else {
    root.innerHTML = `<div class="wrap"><div class="section-head"><div><p class="eyebrow">Live from around the world</p><h2>Live Radio</h2></div><p class="muted">Real radio stations streaming live from everywhere. Tap one to listen.</p></div><div id="lvr-mount"></div></div>`;
    const stop = mountWorldRadio(root.querySelector("#lvr-mount"), ctx);
    if (typeof stop === "function") cleanup.push(stop);
  }
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
