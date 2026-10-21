// Meechie's World Shopify store: reads the store's public product list and returns it for the website.
// No Shopify login or key needed. New products show up on the site by themselves. Cached for 10 minutes.
const STORE = "https://meechiesworldinc.myshopify.com";

const toItem = (p) => {
  const vs = Array.isArray(p.variants) ? p.variants : [];
  const prices = vs.map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
  const min = prices.length ? Math.min(...prices) : null;
  const img = (p.images && p.images[0] && p.images[0].src) || "";
  const digital = vs.length > 0 && vs.every((v) => v.requires_shipping === false);
  return {
    id: String(p.id),
    title: String(p.title || ""),
    img,
    price: min === null ? "" : (prices.some((n) => n !== min) ? "From $" : "$") + min.toFixed(2),
    url: STORE + "/products/" + encodeURIComponent(p.handle || ""),
    // One-click checkout for single-option products (like eBooks)
    buy: vs.length === 1 ? STORE + "/cart/" + vs[0].id + ":1" : "",
    digital,
    type: String(p.product_type || ""),
    // sizes / options, so a member can pick one when gifting the item
    variants: vs.filter((v) => v.available !== false).slice(0, 40).map((v) => ({ id: String(v.id), title: String(v.title || ""), price: v.price, ship: v.requires_shipping !== false })),
  };
};

export async function onRequestGet({ request }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/shopify?v=2", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const seen = new Map();
  for (let page = 1; page <= 4; page++) {
    const r = await fetch(STORE + "/products.json?limit=250&page=" + page, { headers: { "user-agent": "MeechiesWorldSite/1.0", accept: "application/json" } });
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    const list = (j && j.products) || [];
    for (const p of list) if (!seen.has(String(p.id))) seen.set(String(p.id), toItem(p));
    if (list.length < 250) break;
  }
  const body = JSON.stringify({ store: STORE, products: [...seen.values()], updated: Date.now() });
  const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  if (seen.size) await cache.put(key, res.clone());
  return res;
}
