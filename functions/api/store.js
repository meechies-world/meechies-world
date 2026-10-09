// Meechie's World store: reads the public Printify pop-up store and returns its products.
// No Printify login or key needed. Results are cached for 10 minutes.
const STORE = "https://meechiesworld-inc.printify.me";

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function parse(html) {
  const out = [];
  const re = /href="\/product\/(\d+)"><div[^>]*><img src="([^"]+)" alt="([^"]*)"/g;
  let m;
  const hits = [];
  while ((m = re.exec(html))) hits.push({ id: m[1], img: decode(m[2]), title: decode(m[3]), at: m.index });
  hits.forEach((h, i) => {
    const chunk = html.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : h.at + 4000);
    const p = chunk.match(/\$\s?([\d,]+\.\d{2})/);
    out.push({ id: h.id, title: h.title, img: h.img, price: p ? "$" + p[1] : "", url: STORE + "/product/" + h.id });
  });
  return out;
}

export async function onRequestGet({ request }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/store?v=1", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const seen = new Map();
  for (let page = 1; page <= 6; page++) {
    const r = await fetch(STORE + "/products" + (page > 1 ? "?page=" + page : ""), { headers: { "user-agent": "MeechiesWorldSite/1.0" } });
    if (!r.ok) break;
    const items = parse(await r.text());
    let added = 0;
    for (const it of items) if (!seen.has(it.id)) { seen.set(it.id, it); added++; }
    if (!added) break;
  }
  const body = JSON.stringify({ store: STORE, products: [...seen.values()], updated: Date.now() });
  const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  if (seen.size) await cache.put(key, res.clone());
  return res;
}
