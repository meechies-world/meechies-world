/* ============================================================================
   v2 PROMOTE VIEW (Phase 5) — the live Promote page: the three
   campaign tiers (Spotlight $50 / Featured $150 / Takeover $400 —
   the pay buttons stay hidden: no payment links are configured
   anywhere on the live site either), and the campaign request
   form that builds the DM-ready message, the live Campaigns
   block from app-core. Markup is the live section's own.
   ============================================================================ */

import { MARKUP } from "./promote-markup.js";
import { toast } from "../commerce.js";

export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const $ = (s) => root.querySelector(s);
  root.querySelectorAll("[data-tier]").forEach((b) => b.addEventListener("click", () => { $("#c-tier").value = b.dataset.tier; $("#c-biz").focus(); }));
  $("#camp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = `Campaign request: ${$("#c-tier").value}\nBusiness: ${$("#c-biz").value.trim()}\nReach me: ${$("#c-contact").value.trim()}\nLink: ${$("#c-link").value.trim() || "none"}\nPromote: ${$("#c-goal").value.trim()}`;
    $("#inbox").textContent = msg; $("#owner-inbox").hidden = false;
    if (navigator.clipboard) navigator.clipboard.writeText(msg).then(() => toast("Copied. Paste it in a DM to us.")).catch(() => { const r = document.createRange(); r.selectNodeContents($("#inbox")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selected. Copy it and DM us."); });
    else { const r = document.createRange(); r.selectNodeContents($("#inbox")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selected. Copy it and DM us."); }
  });
}
export function destroy() {}
