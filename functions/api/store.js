// Meechie's World store: reads the owner's public Printify pop-up stores and returns their products.
// The owner has two pop-up stores; both are merged so every product he sells shows on the site.
// The storefront grid page can lag behind publishing, so each store's sitemap is checked too and
// any product missing from the grid is read from its own product page. No Printify login or key
// needed. Results are cached for 10 minutes.
const STORES = ["https://meechiesworld-inc.printify.me", "https://meechies-world.printify.me"];

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const UA = { headers: { "user-agent": "MeechiesWorldSite/1.0" } };

function parseGrid(html, store) {
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

function parseProductPage(html, store, id) {
  const t = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (!t) return null;
  const img = html.match(/<meta property="og:image" content="([^"]+)"/);
  const p = html.match(/\$\s?([\d,]+\.\d{2})/);
  return { id: store + "/" + id, title: decode(t[1]), img: img ? decode(img[1]) : "", price: p ? "$" + p[1] : "", url: store + "/product/" + id };
}

async function storeProducts(store) {
  const byId = new Map();
  try {
    const r = await fetch(store + "/products", UA);
    if (r.ok) for (const it of parseGrid(await r.text(), store)) byId.set(it.id, it);
  } catch (_) { /* fall through to the sitemap */ }
  try {
    const r = await fetch(store + "/sitemap.xml", UA);
    if (r.ok) {
      const ids = [...new Set([...(await r.text()).matchAll(/\/product\/(\d+)/g)].map((m) => m[1]))];
      const missing = ids.filter((id) => !byId.has(store + "/" + id));
      for (let i = 0; i < missing.length; i += 6) {
        const batch = await Promise.all(missing.slice(i, i + 6).map(async (id) => {
          try {
            const pr = await fetch(store + "/product/" + id, UA);
            return pr.ok ? parseProductPage(await pr.text(), store, id) : null;
          } catch (_) { return null; }
        }));
        for (const it of batch) if (it) byId.set(it.id, it);
      }
    }
  } catch (_) { /* grid results still stand */ }
  return [...byId.values()];
}

export async function onRequestGet({ request }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/store?v=3", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const products = [];
  const seenIds = new Set();
  const earlierTitles = new Set();
  for (const store of STORES) {
    const mine = await storeProducts(store);
    for (const it of mine) {
      if (seenIds.has(it.id)) continue;
      // Same title already listed from an earlier store: keep the earlier store's listing.
      if (earlierTitles.has(it.title.trim().toLowerCase())) continue;
      seenIds.add(it.id);
      products.push(it);
    }
    for (const it of mine) earlierTitles.add(it.title.trim().toLowerCase());
  }
  const body = JSON.stringify({ store: STORES[0], stores: STORES, products, updated: Date.now() });
  const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  if (products.length) await cache.put(key, res.clone());
  return res;
}
