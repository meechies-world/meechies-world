// Meechie's World store: reads the owner's public Printify pop-up stores and returns their products.
// The owner has two pop-up stores; both are merged so every product he sells shows on the site.
// No Printify login or key needed. Results are cached for 10 minutes.
const STORES = ["https://meechiesworld-inc.printify.me", "https://meechies-world.printify.me"];

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function parse(html, store) {
  const out = [];
  const re = /href="\/product\/(\d+)"><div[^>]*><img src="([^"]+)" alt="([^"]*)"/g;
  let m;
  const hits = [];
  while ((m = re.exec(html))) hits.push({ id: m[1], img: decode(m[2]), title: decode(m[3]), at: m.index });
  hits.forEach((h, i) => {
    const chunk = html.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : h.at + 4000);
    const p = chunk.match(/\$\s?([\d,]+\.\d{2})/);
    out.push({ id: store + "/" + h.id, title: h.title, img: h.img, price: p ? "$" + p[1] : "", url: store + "/product/" + h.id });
  });
  return out;
}

export async function onRequestGet({ request }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/store?v=2", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const products = [];
  const seenIds = new Set();
  const earlierTitles = new Set();
  for (const store of STORES) {
    try {
      const r = await fetch(store + "/products", { headers: { "user-agent": "MeechiesWorldSite/1.0" } });
      if (!r.ok) continue;
      const mine = parse(await r.text(), store);
      for (const it of mine) {
        if (seenIds.has(it.id)) continue;
        // Same title already listed from an earlier store: keep the earlier store's listing.
        if (earlierTitles.has(it.title.trim().toLowerCase())) continue;
        seenIds.add(it.id);
        products.push(it);
      }
      for (const it of mine) earlierTitles.add(it.title.trim().toLowerCase());
    } catch (_) { /* one store being down must not empty the shop */ }
  }
  const body = JSON.stringify({ store: STORES[0], stores: STORES, products, updated: Date.now() });
  const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  if (products.length) await cache.put(key, res.clone());
  return res;
}
