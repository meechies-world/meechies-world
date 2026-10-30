/* ============================================================================
   v2 STUDIO VIEW (Phase 5) — the live Studio view: the Beatmaker
   (js/beatmaker.js) over the Beatlab (js/beatlab.js), both ported
   from the live files with their behavior intact. Markup is the
   live section's own.
   ============================================================================ */

import { MARKUP } from "./studio-markup.js";
import { mountBeatmaker } from "../beatmaker.js";
import { mountBeatlab } from "../beatlab.js";

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const a = mountBeatmaker(root, ctx); if (typeof a === "function") cleanup.push(a);
  const b = mountBeatlab(root, ctx); if (typeof b === "function") cleanup.push(b);
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
