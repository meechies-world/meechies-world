// Rough visitor location from Cloudflare (city level, no permission prompt). Used to show local radio and TV.
export async function onRequestGet({ request }) {
  const c = request.cf || {};
  return new Response(JSON.stringify({ city: c.city || "", region: c.region || "", regionCode: c.regionCode || "", country: c.country || "", lat: +c.latitude || null, lon: +c.longitude || null }), { headers: { "content-type": "application/json", "cache-control": "private, max-age=600" } });
}
