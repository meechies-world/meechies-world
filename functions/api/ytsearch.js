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
//
// Hardening (fix-ytsearch2, 2026-10-29): live probing showed the relay
// returning ok:false for some queries (music, test, usher) while the same
// upstream answered those exact queries directly with 20 results — from
// Cloudflare egress the single upstream is flaky per-request, and one
// 4s attempt read as total failure. The relay now retries up to 3 rounds
// over the pool (~600ms between rounds, 5s per try) and appends a static
// list of well-known Invidious hosts beyond the registry, so a thin or
// failed registry fetch still leaves real candidates.
const json = (o, age = 60) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=" + age } });
const SEED = "https://yt.chocolatemoo53.com"; // last-known-good mirror, tried first
// Well-known Invidious hosts kept as a static tail beyond the live registry:
// the registry is volatile and sometimes thin (2026-10-29: 10 listed, 1 with
// an API), and if the registry fetch itself fails these still give the relay
// somewhere to go. Server-side CORS is irrelevant, so any public API host
// qualifies. Dead entries cost one 5s try inside a round and are skipped.
const STATIC_HOSTS = [
  "https://inv.nadeko.net",
  "https://invidious.privacyredirect.com",
  "https://yt.artemislena.eu",
  "https://invidious.0011.lt",
  "https://inv.tux.pizza",
  "https://invidious.protokolla.fi",
  "https://invidious.perennialte.ch",
  "https://yewtu.be",
  "https://invidious.fdn.fr",
  "https://vid.puffyan.us",
];
const ROUNDS = 3; // full passes over the pool before giving up
const TRY_MS = 5000; // per-try timeout
const ROUND_PAUSE_MS = 600; // breather between rounds
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
  STATIC_HOSTS.forEach((h) => { if (!hosts.includes(h)) hosts.push(h); });
  poolCache = hosts; poolAt = Date.now();
  return hosts;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function tryHost(base, q, page) {
  const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(TRY_MS) } : {};
  const r = await fetch(base + "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&page=" + page, ctl);
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j)) return null;
  return j.filter((it) => it && it.videoId).map((it) => ({ id: it.videoId, title: it.title || "YouTube video", dur: it.lengthSeconds || 0 }));
}
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) return json({ ok: false, results: [] }, 0);
  const page = Math.min(10, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const hosts = await pool();
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) await sleep(ROUND_PAUSE_MS);
    for (const base of hosts) {
      try {
        const results = await tryHost(base, q, page);
        if (results) return json({ ok: true, results }, 120);
      } catch (_) {}
    }
  }
  return json({ ok: false, results: [] }, 0);
}
