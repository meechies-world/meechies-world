// Booth YouTube search relay. GET /api/ytsearch?q=<query>&page=<n>
//   -> { ok: true, results: [{ id, title, dur }] } or { ok: false, results: [] }
//
// The booth used to search Invidious straight from the visitor's browser.
// That left the whole feature riding on whichever mirror the public registry
// still flagged as CORS-open — at times exactly one host — fetched
// cross-origin from the visitor's own network, so when that path died,
// search died for everyone (owner report 2026-10-29: "On youtube — it wont
// let me serch anything"). Server-side there is no CORS, so this function
// builds the candidate pool from every registry instance with an API and
// fans out over them from Cloudflare's network until one answers. The booth
// only ever talks to its own origin (see ytPage in js/dj.js, which still
// falls back to the old direct path if this function ever fails).
const json = (o, age = 60) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=" + age } });
const SEED = "https://yt.chocolatemoo53.com"; // last-known-good mirror, tried first
let poolCache = null, poolAt = 0;
async function pool() {
  if (poolCache && Date.now() - poolAt < 600000) return poolCache; // registry cached ~10 min
  const hosts = [SEED];
  try {
    const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : {};
    const r = await fetch("https://api.invidious.io/instances.json", ctl);
    const j = await r.json();
    if (Array.isArray(j)) j.forEach((pair) => { const info = pair && pair[1]; if (info && info.api && info.uri && !hosts.includes(info.uri)) hosts.push(info.uri); });
  } catch (_) {}
  poolCache = hosts; poolAt = Date.now();
  return hosts;
}
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) return json({ ok: false, results: [] }, 0);
  const page = Math.min(10, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const hosts = await pool();
  for (const base of hosts) {
    try {
      const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(4000) } : {};
      const r = await fetch(base + "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&page=" + page, ctl);
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j)) {
        const results = j.filter((it) => it && it.videoId).map((it) => ({ id: it.videoId, title: it.title || "YouTube video", dur: it.lengthSeconds || 0 }));
        return json({ ok: true, results }, 120);
      }
    } catch (_) {}
  }
  return json({ ok: false, results: [] }, 0);
}
