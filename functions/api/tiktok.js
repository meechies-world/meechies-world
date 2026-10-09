// Look up a TikTok video link (full or short vm./vt. link) with TikTok's public oEmbed,
// so the site can play it and show its cover. GET /api/tiktok?url=<link>
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": s === 200 ? "public, max-age=3600" : "no-store" } });

export async function onRequestGet({ request }) {
  const link = new URL(request.url).searchParams.get("url") || "";
  let u;
  try { u = new URL(/^https?:/i.test(link) ? link : "https://" + link); } catch (_) { return json({ error: "bad_link" }, 400); }
  if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return json({ error: "not_tiktok" }, 400);
  const r = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(u.href), { headers: { "user-agent": "Mozilla/5.0 MeechiesWorldSite/1.0", accept: "application/json" } }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  let id = j && String(j.embed_product_id || "");
  if (!/^\d{8,25}$/.test(id || "")) id = (u.pathname.match(/\/(?:video|photo|v)\/(\d{8,25})/) || [])[1] || "";
  if (!id) return json({ error: "not_found" }, 404);
  return json({
    id,
    title: j ? String(j.title || "").slice(0, 100) : "",
    author: j ? String(j.author_unique_id || "").slice(0, 40) : "",
    thumb: j && /^https:\/\//.test(j.thumbnail_url || "") ? j.thumbnail_url : "",
  });
}
