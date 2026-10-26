// Look up a TikTok video link with TikTok's public oEmbed, so the site can play
// it and show its cover. GET /api/tiktok?url=<link>
//
// Two failure modes fixed 2026-10-26 (owner: "people try to hit the TikTok add
// button and it didn't work"):
//  1. oEmbed was called with a homemade user-agent ("MeechiesWorldSite/1.0"),
//     which TikTok silently refuses — every lookup came back with no title,
//     author or cover. A plain browser UA works.
//  2. The TikTok app's Share → Copy link hands out SHORT links (vm.tiktok.com,
//     vt.tiktok.com, tiktok.com/t/…) that carry no video id, and the old code
//     never followed them — the add simply failed for exactly the links most
//     people paste. Short links are now resolved (redirect, then the landing
//     page's canonical URL) before giving up.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": s === 200 ? "public, max-age=3600" : "no-store" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const idOf = (s) => (String(s || "").match(/\/(?:video|photo|v)\/(\d{8,25})/) || [])[1] || "";
const canonOf = (s) => (String(s || "").match(/https:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/\d{8,25}/) || [])[0] || "";
const embed = async (href) => {
  const r = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(href), { headers: { "user-agent": UA, accept: "application/json" } }).catch(() => null);
  return r && r.ok ? await r.json().catch(() => null) : null;
};
// oEmbed does not answer from this network at all (verified live 2026-10-26:
// full metadata direct, empty from the worker), so fall back to the video
// page's own embedded data — its caption, author and cover ride in the HTML.
const unesc = (s) => { try { return JSON.parse('"' + String(s).replace(/"/g, '\\"') + '"'); } catch (_) { return String(s || ""); } };
const scrape = async (href) => {
  const r = await fetch(href, { redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" } }).catch(() => null);
  if (!r || !r.ok) return null;
  const body = await r.text().catch(() => "");
  if (!body) return null;
  const desc = (body.match(/"desc":"((?:[^"\\]|\\.)*)"/) || [])[1] || "";
  const cover = (body.match(/"cover":"(https:(?:[^"\\]|\\.)*)"/) || [])[1] || (body.match(/"originCover":"(https:(?:[^"\\]|\\.)*)"/) || [])[1] || "";
  const uid = (body.match(/"uniqueId":"([\w.-]+)"/) || [])[1] || "";
  return { title: unesc(desc).slice(0, 100), author: uid.slice(0, 40), thumb: /^https:\/\//.test(unesc(cover)) ? unesc(cover) : "" };
};

export async function onRequestGet({ request }) {
  const link = new URL(request.url).searchParams.get("url") || "";
  let u;
  try { u = new URL(/^https?:/i.test(link) ? link : "https://" + link); } catch (_) { return json({ error: "bad_link" }, 400); }
  if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return json({ error: "not_tiktok" }, 400);
  let j = await embed(u.href);
  let id = j && /^\d{8,25}$/.test(String(j.embed_product_id || "")) ? String(j.embed_product_id) : idOf(u.pathname);
  if (!id) {
    // short share link: follow it to the canonical video URL
    const rr = await fetch(u.href, { redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" } }).catch(() => null);
    const fin = rr && rr.url ? rr.url : "";
    id = idOf(fin);
    let canon = canonOf(fin);
    if (!canon && rr) { const body = await rr.text().catch(() => ""); canon = canonOf(body); if (!id) id = idOf(body); }
    if (canon && !j) j = await embed(canon);
    if (!id && j && /^\d{8,25}$/.test(String(j.embed_product_id || ""))) id = String(j.embed_product_id);
  }
  if (!/^\d{8,25}$/.test(id || "")) return json({ error: "not_found" }, 404);
  let title = j ? String(j.title || "").slice(0, 100) : "", author = j ? String(j.author_unique_id || "").slice(0, 40) : "", thumb = j && /^https:\/\//.test(j.thumbnail_url || "") ? j.thumbnail_url : "";
  if (!title || !thumb) {
    // fetch follows redirects, so this reaches the canonical video page for
    // full links and short share links alike
    const s = await scrape(u.href).catch(() => null);
    if (s) { title = title || s.title; author = author || s.author; thumb = thumb || s.thumb; }
  }
  return json({ id, title, author, thumb });
}
