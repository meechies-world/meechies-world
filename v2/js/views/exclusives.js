/* ============================================================================
   v2 EXCLUSIVES VIEW (Phase 5) — the live Exclusives page: the
   hero, the exclusive drops grid and the members-only notes, all
   in the section's own markup (its styles ride inside it, as
   live). Static parity surface — the section carries no live
   data bindings on the live site either.
   ============================================================================ */

import { MARKUP } from "./exclusives-markup.js";

export function render(root, ctx) {
  root.innerHTML = MARKUP;
}
export function destroy() {}
