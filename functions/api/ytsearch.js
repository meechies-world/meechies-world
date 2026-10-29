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
//
// Second family + hard budget (fix-ytsearch3, 2026-10-29): after ytsearch2
// the relay answered most queries, but failures stayed intermittent and
// QUERY-STICKY for minutes (drake failed 3 retries in a row while usher
// succeeded in the same minutes) — one upstream family, whatever its
// per-query mood, is still one point of failure, and a total failure
// burned far too long server-side (~158s for 3 doomed client retries).
// Two changes: (1) Piped API instances join as an INDEPENDENT second
// family, interleaved into the candidate order (Invidious seed, a Piped
// host, next Invidious, next Piped...) so a family-wide bad mood cannot
// starve the search; (2) the whole relay now runs against a hard ~10s
// deadline from request start — the booth client gives the relay ~8s
// before falling back to its direct path, so the relay must answer
// inside that window instead of grinding through every dead host.
const json = (o, age = 60) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=" + age } });
const SEED = "https://yt.chocolatemoo53.com"; // last-known-good mirror, tried first
// Well-known Invidious hosts kept as a static tail beyond the live registry:
// the registry is volatile and sometimes thin (2026-10-29: 10 listed, 1 with
// an API), and if the registry fetch itself fails these still give the relay
// somewhere to go. Server-side CORS is irrelevant, so any public API host
// qualifies. Dead entries cost one bounded try inside the deadline.
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
// Piped API hosts (second, independent upstream family; list per the
// TeamPiped public-instances doc, probed live 2026-10-29: private.coffee
// and ducks.party answered search with 20 results; kavin.rocks and
// adminforge.de were unhealthy at probe time but are the project's
// flagship hosts, kept as trailing maybes inside the deadline).
const PIPED_HOSTS = [
  "https://api.piped.private.coffee",
  "https://pipedapi.ducks.party",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
];
const ROUNDS = 3; // full passes over the pool before giving up
const TRY_MS = 4000; // per-try timeout (also capped by the deadline)
const ROUND_PAUSE_MS = 300; // breather between rounds
const DEADLINE_MS = 10000; // hard budget for the whole relay, from request start
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
function sig(ms) { return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {}; }
async function tryInv(base, q, page, ms) {
  const r = await fetch(base + "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&page=" + page, sig(ms));
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j)) return null;
  return j.filter((it) => it && it.videoId).map((it) => ({ id: it.videoId, title: it.title || "YouTube video", dur: it.lengthSeconds || 0 }));
}
async function tryPiped(base, q, page, ms) {
  // Piped search paginates with an opaque nextpage cursor, which a stateless
  // per-request relay cannot replay — so Piped serves page 1 only and deeper
  // pages fall to the Invidious family.
  if (page > 1) return null;
  const r = await fetch(base + "/search?q=" + encodeURIComponent(q) + "&filter=videos", sig(ms));
  if (!r.ok) return null;
  const j = await r.json();
  const items = j && Array.isArray(j.items) ? j.items : null;
  if (!items) return null;
  const out = [];
  for (const it of items) {
    if (!it || !it.url) continue;
    const m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(it.url);
    if (!m) continue;
    out.push({ id: m[1], title: it.title || "YouTube video", dur: it.duration > 0 ? it.duration : 0 });
  }
  return out;
}
// Interleave the two families so neither can starve the other:
// inv[0] (the seed), piped[0], inv[1], piped[1], ... then the tails.
function candidates(invHosts) {
  const out = [];
  const n = Math.max(invHosts.length, PIPED_HOSTS.length);
  for (let i = 0; i < n; i++) {
    if (i < invHosts.length) out.push({ fam: "inv", base: invHosts[i] });
    if (i < PIPED_HOSTS.length) out.push({ fam: "piped", base: PIPED_HOSTS[i] });
  }
  return out;
}
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) return json({ ok: false, results: [] }, 0);
  const page = Math.min(10, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const t0 = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - t0);
  const cands = candidates(await pool());
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) { if (left() <= 0) break; await sleep(Math.min(ROUND_PAUSE_MS, Math.max(0, left()))); }
    for (const c of cands) {
      const budget = left();
      if (budget <= 250) return json({ ok: false, results: [] }, 0); // out of time: stop starting tries
      try {
        const results = c.fam === "piped" ? await tryPiped(c.base, q, page, Math.min(TRY_MS, budget)) : await tryInv(c.base, q, page, Math.min(TRY_MS, budget));
        if (results) return json({ ok: true, results }, 120);
      } catch (_) {}
    }
  }
  return json({ ok: false, results: [] }, 0);
}
