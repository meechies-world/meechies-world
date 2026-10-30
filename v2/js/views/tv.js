/* ============================================================================
   v2 TV VIEW (Phase 5) — Meechie's World Cinema: the live TV
   section (its markup carries its own mv-styles block, as live)
   with the ported cinema module (js/movies.js). The member
   Videos view is its own route (#videos), as live.
   ============================================================================ */

import { MARKUP } from "./tv-markup.js";
import { mountMovies } from "../movies.js";

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const stop = mountMovies(root, ctx);
  if (typeof stop === "function") cleanup.push(stop);
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
