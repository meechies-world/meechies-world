/* Shop sells more (owner, 2026-11-07 "Shop sells more").
 * - One search box + category chips (Books, Clothes, Home, Beauty, Kids & Pets, Accessories, Under $20) that filter both
 *   the merch grid and the Shopify grid. Chips only appear when they have products.
 * - Phones: products two to a row (was one big card per row, 100+ screens of scrolling), the gold "Shop now" is a
 *   full-width button, and the tall t-shirt banner moves below the first set of products so people see items first.
 * Works on top of the grids app-core.js paints; re-applies whenever they repaint. */
(function () {
  "use strict";
  if (window.MW_SHOP_PLUS) return; window.MW_SHOP_PLUS = true;
  const D = document, $ = (s, r) => (r || D).querySelector(s);
  const view = $("#v-shop"); if (!view) return;
  const grids = ["#shop-grid", "#shopify-grid"].map((s) => $(s)).filter(Boolean);
  if (!grids.length) return;

  const CATS = [
    ["books", "📚 Books", /\b(e-?books?|books?|pdf|biography|audiobook)\b/i],
    ["clothes", "👕 Clothes", /\b(t-?shirt|tee|shirt|hoodie|sweat\w*|jacket|parka|coat|swim\w*|yoga|legging\w*|dress|lingerie|panty|panties|bra|socks?|hat|cap|beanie|slippers?|shoes?|sneakers?|costume|pants|shorts|joggers?|tank|top|apparel|outfit|robe|pajama\w*)\b/i],
    ["home", "🏠 Home", /\b(blanket|quilt|pillow\w*|bath|comforter|clock|mug|cup|tumbler|towel|rug|mat|curtain|bedding|duvet|sheet|lamp|decor|candle|kitchen|poster|canvas)\b/i],
    ["beauty", "💅 Beauty", /\b(skin\w*|hair|beauty|nail|lash\w*|face|facial|massag\w*|serum|makeup|brush|wig|spa|curler|straightener)\b/i],
    ["kids", "🧸 Kids & Pets", /\b(baby|babies|kids?|toddler|toys?|ride-?on|stroller|pet|dog|puppy|cat|kitten)\b/i],
    ["acc", "👜 Accessories", /\b(wallet|phone case|case|umbrella|suitcase|luggage|bag|backpack|purse|car|keychain|watch|jewel\w*|chain|necklace|ring|bracelet|sunglasses)\b/i],
  ];
  const cardOf = (el) => el.closest(".prod-wrap") || el;
  const items = () => grids.flatMap((g) => [...g.querySelectorAll(".prod")]).map(cardOf);
  const textOf = (c) => ((c.querySelector("b") || {}).textContent || "") + " " + ((c.querySelector(".buy") || {}).textContent || "");
  const priceOf = (c) => { const m = ((c.querySelector(".pr") || {}).textContent || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN; };
  const inCat = (c, k) => {
    const t = textOf(c);
    if (k === "under20") { const p = priceOf(c); return p > 0 && p < 20; }
    if (k === "books" && /download/i.test(t)) return true;
    const cat = CATS.find((x) => x[0] === k); return !!(cat && cat[2].test(t));
  };

  let q = "", cat = "all";
  const css = D.createElement("style");
  css.textContent = `#sp-bar{margin:0 0 16px;padding:0}
#sp-bar .sp-s{display:flex;align-items:center;gap:8px;background:#0e0b07;border:1px solid rgba(214,170,74,.55);border-radius:14px;padding:0 12px}
#sp-bar .sp-s input{flex:1;min-width:0;background:none!important;border:0!important;box-shadow:none!important;outline:0;border-radius:0!important;margin:0!important;color:#f3ead2;font:500 16px var(--body,system-ui);padding:12px 0}
#sp-bar .sp-s button{background:none;border:0;color:#d9b65c;font-size:18px;cursor:pointer;padding:6px}
#sp-bar .sp-chips{display:flex;gap:8px;overflow-x:auto;padding:10px 2px 2px;scrollbar-width:none}
#sp-bar .sp-chips::-webkit-scrollbar{display:none}
#sp-bar .sp-chip{flex:none;border:1px solid rgba(214,170,74,.45);background:rgba(20,16,9,.9);color:#e9d9a6;border-radius:999px;padding:8px 14px;font:700 13.5px var(--body,system-ui);cursor:pointer;white-space:nowrap;min-height:38px}
#sp-bar .sp-chip[aria-pressed="true"]{background:linear-gradient(180deg,#f0cf78,#c39a2e);color:#191204;border-color:transparent}
#sp-bar .sp-n{color:#a79c7e;font-size:13px;margin:6px 2px 0}
#v-shop .sp-none{grid-column:1/-1;text-align:center;color:#bfb497;padding:22px 10px}
#v-shop .sp-hide{display:none!important}
@media (max-width:600px){
 #v-shop .shop-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}
 #v-shop .prod{padding:8px!important;gap:6px!important;border-radius:14px!important}
 #v-shop .prod img,#v-shop .prod-ph{border-radius:10px!important}
 #v-shop .prod-ph{font-size:13px!important;padding:8px!important}
 #v-shop .prod b{font-size:13px!important;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.5em}
 #v-shop .prod .pr{font-size:16px!important}
 #v-shop .prod .buy{display:block;background:linear-gradient(180deg,#f0cf78,#c39a2e);color:#191204!important;border-radius:10px;padding:10px 4px;font-size:13px!important;font-weight:800}
 #v-shop .prod-share{font-size:12px!important;padding:6px 4px!important}
 #v-shop .prod-wrap .sg-btn{font-size:11.5px;padding:8px 6px}
 #v-shop .lux-banner img{max-height:70vh;width:100%;object-fit:contain}
}`;
  D.head.appendChild(css);

  const bar = D.createElement("div"); bar.id = "sp-bar";
  bar.innerHTML = `<label class="sp-s"><span aria-hidden="true">🔎</span><input type="text" id="sp-q" placeholder="Search the shop: hoodie, book, blanket…" aria-label="Search the shop" autocomplete="off" enterkeyhint="search"><button type="button" id="sp-x" aria-label="Clear search" hidden>✕</button></label><div class="sp-chips" role="group" aria-label="Shop by category"></div><p class="sp-n" aria-live="polite"></p>`;
  const firstHead = $(".section-head", view);
  (firstHead || grids[0]).insertAdjacentElement(firstHead ? "afterend" : "beforebegin", bar);
  const chips = $(".sp-chips", bar), input = $("#sp-q", bar), clear = $("#sp-x", bar), count = $(".sp-n", bar);

  function buildChips(list) {
    const have = [["all", "All"]];
    for (const [k, label] of CATS) if (list.some((c) => inCat(c, k))) have.push([k, label]);
    if (list.some((c) => inCat(c, "under20"))) have.push(["under20", "💲 Under $20"]);
    if (!have.some((h) => h[0] === cat)) cat = "all";
    const sig = have.map((h) => h[0]).join();
    if (chips.dataset.sig === sig) { chips.querySelectorAll(".sp-chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === cat))); return; }
    chips.dataset.sig = sig;
    chips.innerHTML = have.map(([k, l]) => `<button type="button" class="sp-chip" data-k="${k}" aria-pressed="${k === cat}">${l}</button>`).join("");
  }

  let busy = false;
  function apply() {
    if (busy) return; busy = true;
    try {
      const list = items();
      bar.hidden = list.length < 4;
      buildChips(list);
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const c of list) {
        const t = textOf(c).toLowerCase();
        const ok = (cat === "all" || inCat(c, cat)) && words.every((w) => t.includes(w));
        c.classList.toggle("sp-hide", !ok); if (ok) shown++;
      }
      for (const g of grids) {
        const any = [...g.querySelectorAll(".prod")].some((p) => !cardOf(p).classList.contains("sp-hide"));
        let none = g.querySelector(".sp-none");
        const filtering = q || cat !== "all";
        if (filtering && !any && g.querySelector(".prod")) { if (!none) { none = D.createElement("div"); none.className = "sp-none"; g.appendChild(none); } const msg = "Nothing here matches. Try another word or tap All."; if (none.textContent !== msg) none.textContent = msg; }
        else if (none) none.remove();
      }
      count.textContent = (q || cat !== "all") ? `${shown} item${shown === 1 ? "" : "s"} match` : (list.length ? `${list.length} items in the shop` : "");
      clear.hidden = !q;
    } finally { busy = false; }
  }

  chips.addEventListener("click", (e) => { const b = e.target.closest(".sp-chip"); if (!b) return; cat = b.dataset.k; apply();  });
  let t = 0; input.addEventListener("input", () => { q = input.value.trim(); clearTimeout(t); t = setTimeout(apply, 120); });
  clear.addEventListener("click", () => { input.value = ""; q = ""; apply(); input.focus(); });

  // phones: products first, the tall banner after the first grid's "See the full store" button
  function moveBanner() {
    const ban = $(".lux-banner", view), after = $("#shop-all", view);
    if (!ban || !after || innerWidth > 600 || ban.dataset.moved) return;
    const host = after.parentElement; if (!host) return;
    host.insertAdjacentElement("afterend", ban); ban.dataset.moved = "1"; ban.style.marginTop = "24px";
  }

  let pend = 0;
  const mo = new MutationObserver(() => { if (busy) return; cancelAnimationFrame(pend); pend = requestAnimationFrame(apply); });
  grids.forEach((g) => mo.observe(g, { childList: true, subtree: true }));
  moveBanner(); apply();
  try { new MutationObserver(() => { if (!view.hidden) { moveBanner(); apply(); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] }); } catch (_) {}
})();
