/* ============================================================================
   v2 LIVE VIEW (Phase 5) — the live Live page: the OBS streamer
   surface (js/obs.js, playback on the engine's attachHls) over
   the Go Live module (js/golive.js — camera lives, chat, gifts,
   battles). Markup is the live section's own.
   ============================================================================ */

import { MARKUP } from "./live-markup.js";
import { mountObs } from "../obs.js";
import { mountGolive } from "../golive.js";

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const a = mountObs(root, ctx); if (typeof a === "function") cleanup.push(a);
  const b = mountGolive(root, ctx); if (typeof b === "function") cleanup.push(b);
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
