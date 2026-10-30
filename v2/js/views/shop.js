/* ============================================================================
   v2 SHOP VIEW (Phase 5) — the store, assembled exactly as the live
   site assembles it (Phase 1a, MAP correction C1): the Printify merch
   grid FIRST (/api/store — the two pop-up storefronts merged
   server-side), then the Shopify grid (/api/shopify), with the union
   rule from commerce.js (normalized-title suppression, earlier feed
   wins) applied across the two lists. Markup, card shape and copy are
   the live view's own (index.html #v-shop + app-core loadShop /
   loadShopify); the union is computed once in commerce.shopUnion and
   split back into the live two-grid layout for rendering.
   ============================================================================ */

import { loadShopFeed, esc } from "../commerce.js";
import { createShopGifts } from "../shopgift.js";

const MARKUP = `
<div class="wrap">
  <div class="lux-banner"><img src="/img/lux/shirt-promo.webp" alt="Meechies World Inc t-shirt: More than clothing, it's a movement. Premium quality, durable comfort, built for dreamers, limited supply." loading="lazy" width="800" height="1421"></div>
  <div class="section-head">
    <div><p class="eyebrow">Official merch</p><h2>Meechie's World Merch</h2></div>
    <p class="muted">Bold. Fearless. Unapologetic. Every piece is printed on demand and shipped to you. Tap a product to see sizes and order.</p>
  </div>
  <div class="shop-grid" id="shop-grid"><div class="empty">Loading the latest drop...</div></div>
  <div style="display:flex;justify-content:center;margin-top:28px"><a class="btn" id="shop-all" href="https://meechiesworld-inc.printify.me/products" target="_blank" rel="noopener">See the full store →</a></div>
  <p class="muted center-p" style="font-size:13px;margin-top:14px">Checkout, payment, and shipping are handled securely by our print partner, Printify.</p>
  <div class="section-head" style="margin-top:56px">
    <div><p class="eyebrow">Books, fashion &amp; more</p><h2>Meechie's World Store</h2></div>
    <p class="muted">eBooks download right after you pay. Tap any item to see details and check out securely with Shopify.</p>
  </div>
  <div class="shop-grid" id="shopify-grid"><div class="empty">Loading the store...</div></div>
  <div style="display:flex;justify-content:center;margin-top:28px"><a class="btn" href="https://meechiesworldinc.myshopify.com/collections/all" target="_blank" rel="noopener">See the full store →</a></div>
  <p class="muted center-p" style="font-size:13px;margin-top:14px">Checkout and payment are handled securely by Shopify.</p>
</div>`;

/* the live card, verbatim (app-core loadShop / loadShopify) */
function card(p) {
  const href = p.source === "shopify" && p.digital && p.buy ? p.buy : p.url;
  const buy = p.source === "shopify" && p.digital ? "Buy &amp; download →" : "Shop now →";
  return `<div class="prod"><a class="prod-a" href="${esc(href)}" target="_blank" rel="noopener">${p.img ? `<img src="${esc(p.img)}" alt="${esc(p.title)}" loading="lazy">` : (p.source === "shopify" ? `<div class="prod-ph">${esc(p.title)}</div>` : "")}<b>${esc(p.title)}</b>${p.price ? `<span class="pr">${esc(p.price)}</span>` : ""}<span class="buy">${buy}</span></a><button type="button" class="prod-share" data-pshare data-title="${esc(p.title)}" data-price="${esc(p.price || "")}" data-url="${esc(p.url)}">↗ Share this</button></div>`;
}

let loaded = false;
let cleanups = [];
export function destroy() { cleanups.forEach((f) => { try { f(); } catch (_) {} }); cleanups = []; }
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pshare]");
    if (!b) return;
    const text = `${b.dataset.title}${b.dataset.price ? " — " + b.dataset.price : ""} at Meechie's World: ${b.dataset.url}`;
    if (navigator.share) navigator.share({ title: b.dataset.title, text, url: b.dataset.url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { b.textContent = "✓ Link copied"; setTimeout(() => { b.textContent = "↗ Share this"; }, 1600); }).catch(() => {});
  });
  if (loaded) return;
  loaded = true;
  loadShopFeed().then((union) => {
    const grid = root.querySelector("#shop-grid"), sgrid = root.querySelector("#shopify-grid");
    if (!grid) return;
    const merch = union.filter((p) => p.source === "printify");
    const store = union.filter((p) => p.source === "shopify");
    grid.innerHTML = merch.length ? merch.map(card).join("") : '<div class="empty">Our latest drop is in the store. Tap the button below to shop.</div>';
    sgrid.innerHTML = store.length ? store.map(card).join("") : '<div class="empty">Tap the button below to see everything in the store.</div>';
    /* shop gifts (js/shopgift.js): 🎁 Gift this on every store
       item + the owner's gift-orders button after the grid */
    try { const sg = createShopGifts(ctx); sg.decorate(sgrid, store); cleanups.push(() => sg.destroy()); } catch (_) {}
  });
}
/* destroy merged below */
