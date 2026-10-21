/* /m/<bucket>/<file> — free media relay.
 * Songs, videos and pictures live in Supabase storage, but Supabase's free plan only allows 5 GB of
 * downloads a month. This serves each file from Cloudflare's cache (free, unlimited), so Supabase is
 * only asked for a file the first time a Cloudflare location needs it. Supports seeking (Range). */
const ORIGIN = "https://yjouaysczttqbytksejq.supabase.co/storage/v1/object/public/";
const KEEP = ["content-type", "content-length", "etag", "last-modified"];

export async function onRequest({ request, params, env }) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const path = (Array.isArray(params.path) ? params.path : [params.path || ""]).map(encodeURIComponent).join("/");
  if (!/^(assets|media)\/[^/]/.test(path) || path.includes("..")) return new Response("Not found", { status: 404 });

  const key = new URL(request.url); key.search = "";
  const range = request.headers.get("range");
  const asKey = (withRange) => new Request(key.toString(), withRange && range ? { headers: { range } } : {});
  const cache = caches.default;

  let res = await cache.match(asKey(true));
  // new uploads live in Meechie's World's own free storage (Cloudflare KV)
  if (!res && env.MEDIA) {
    const raw = (Array.isArray(params.path) ? params.path : [params.path || ""]).join("/");
    const got = await env.MEDIA.getWithMetadata(raw, { type: "stream" });
    if (got && got.value) {
      const h = new Headers({ "content-type": (got.metadata && got.metadata.type) || "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" }); // members' files can't run code if opened directly
      if (got.metadata && got.metadata.size) h.set("content-length", String(got.metadata.size));
      const full = new Response(got.value, { status: 200, headers: h });
      try { await cache.put(asKey(false), full.clone()); if (range) res = await cache.match(asKey(true)); } catch (_) {}
      if (!res) res = full;
      if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
      return res;
    }
  }
  if (!res) {
    const up = await fetch(ORIGIN + path, { cf: { cacheEverything: true, cacheTtl: 31536000 } });
    if (!up.ok) return new Response(up.status === 404 || up.status === 400 ? "Not found" : "Unavailable", { status: up.status === 400 ? 404 : up.status });
    const h = new Headers();
    for (const k of KEEP) { const v = up.headers.get(k); if (v) h.set(k, v); }
    h.set("cache-control", "public, max-age=31536000, immutable");
    h.set("accept-ranges", "bytes");
    h.set("access-control-allow-origin", "*");
    const full = new Response(up.body, { status: 200, headers: h });
    try {
      await cache.put(asKey(false), full.clone());
      if (range) res = await cache.match(asKey(true));
    } catch (e) { /* cache refused; still serve the file */ }
    if (!res) res = full;
  }
  if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
  return res;
}
