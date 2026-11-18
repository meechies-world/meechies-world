/* /m/<bucket>/<file> — free media relay.
 * Songs, videos and pictures live in the site's own Cloudflare storage (KV), fronted by the
 * Cloudflare cache (free, unlimited), so a stored file is read from KV only the first time a
 * Cloudflare location needs it. Supports seeking (Range). A path found in neither the cache
 * nor KV is a miss and gets a fast 404 here — the old relay to the retired outside storage
 * origin is gone, so dead media ids no longer burn a slow upstream trip before failing. */

export async function onRequest({ request, params, env }) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const path = (Array.isArray(params.path) ? params.path : [params.path || ""]).map(encodeURIComponent).join("/");
  if (!/^(assets|media)\/[^/]/.test(path) || path.includes("..")) return new Response("Not found", { status: 404 });

  const key = new URL(request.url); key.search = "";
  const range = request.headers.get("range");
  // single-range requests — video players ask for these constantly, and serving the exact
  // slice instead of re-streaming the whole file is what keeps playback from stalling
  let rng = null;
  if (range) { const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim()); if (m && (m[1] || m[2])) rng = { a: m[1], b: m[2] }; }
  const asKey = (withRange) => new Request(key.toString(), withRange && range ? { headers: { range } } : {});
  const cache = caches.default;

  let res = await cache.match(asKey(true));
  // new uploads live in Meechie's World's own free storage (Cloudflare KV)
  if (!res && env.MEDIA) {
    const raw = (Array.isArray(params.path) ? params.path : [params.path || ""]).join("/");
    if (rng) {
      // serve just the requested slice straight from KV — no full-file stream first
      const probe = await env.MEDIA.getWithMetadata(raw, { type: "stream", range: { offset: 0, length: 1 } }).catch(() => null);
      const total = probe && probe.metadata && probe.metadata.size;
      if (probe && total) {
        let start, end;
        if (rng.a === "") { const suf = Math.min(parseInt(rng.b, 10) || 0, total); start = total - suf; end = total - 1; }
        else { start = parseInt(rng.a, 10); end = rng.b === "" ? total - 1 : Math.min(parseInt(rng.b, 10), total - 1); }
        if (start >= total || start > end) return new Response("Range not satisfiable", { status: 416, headers: { "content-range": "bytes */" + total, "access-control-allow-origin": "*" } });
        const part = await env.MEDIA.getWithMetadata(raw, { type: "stream", range: { offset: start, length: end - start + 1 } }).catch(() => null);
        if (part && part.value) {
          const h = new Headers({ "content-type": (part.metadata && part.metadata.type) || (probe.metadata && probe.metadata.type) || "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "accept-ranges": "bytes", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) });
          if (request.method === "HEAD") return new Response(null, { status: 206, headers: h });
          return new Response(part.value, { status: 206, headers: h });
        }
      }
      // no stored size (older object) — fall through to the full-file path below
    }
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
  if (!res) return new Response("Not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
  if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
  return res;
}
