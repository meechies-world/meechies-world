/* ============================================================================
   v2 SERVICES VIEW (Phase 5) — the live #v-services section, verbatim:
   the eight-ways banner, the nine division cards, the legal note, the
   pay box, the Support card, and the Books strip (.books with the
   four book cards). The pay buttons stay exactly as live ships them
   today: hidden until payment links are configured (nothing in the
   live client paints them either — parity, verified this phase).
   ============================================================================ */

import { MARKUP } from "./services-markup.js";

export function render(root) { root.innerHTML = MARKUP; }
export function destroy() {}
