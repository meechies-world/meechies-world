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
// Age / embed filter (fix-search-filter, 2026-10-29): the owner asked that
// booth search stop offering videos YouTube age-gates or embed-restricts —
// they cannot play in a deck and only bounce him to "Watch on YouTube".
// After a search answers, the top candidates are verified against video
// DETAIL endpoints and the gated ones are dropped before responding.
// What live probing (2026-10-29) actually established about the signals:
//   - Invidious GET /api/v1/videos/<id> on a healthy host returns either a
//     full video payload (has videoId + title) or an error object. For a
//     hard age-gated video the error is YouTube's own gate text ("This
//     helps protect our community. Learn more" — seen live for
//     PTFwQP86BRs, NIN "Closer (Director's Cut)"). That error text is the
//     BAD signal. Generic errors ("Companion is starting...", timeouts,
//     5xx) say nothing about the video and fail open.
//   - Invidious isFamilyFriendly is NOT usable: on the reachable pool it
//     read false for Baby Shark / Adele / Rick Astley and true for
//     explicit classics within the same hour — the value flips with
//     whichever companion backend answers. It never convicts here.
//   - Piped GET /streams/<id> full payload (has title) was a GOOD signal
//     only in the first cut: its failures are dominated by per-instance
//     bot walls (SignInConfirmNotBotException hit Adele and Baby Shark
//     minutes after the same hosts served Rick Astley fine), so a Piped
//     error never convicted. It no longer votes at all — see the
//     correction below.
//   A cached BAD verdict is the one exception to fail-open: a video once
//   confirmed gated stays dropped without a re-check. Anything the filter
//   misses is still caught in the decks — the first real player error
//   (101/150) blocklists the id on the device (js/dj.js mw-dj-ageskip),
//   and the booth search skips those ids too.
//
// Conviction rule corrected (fix-search-filter-2, 2026-10-29): the first
// cut let a full detail payload from ANY host acquit a video, on the
// theory that fetchable metadata means playable. Live testing disproved
// that within the hour: for PTFwQP86BRs the very seed host
// (yt.chocolatemoo53.com) first answered with the gate error and later
// served the full payload — companions rotate behind a host, so
// metadata availability is NOT embeddability, and that one payload
// permanently acquitted a gated video (the deployed relay returned it
// at position 1 for "nine inch nails closer"). The rule is now: an
// age-gate error from ANY checked Invidious host convicts, full stop;
// payloads are irrelevant to the verdict, and with no gate error
// anywhere the video is kept (fail open). Consequences baked in below:
//   - The verify phase checks the first FIVE pool Invidious hosts (was
//     three): conviction is probabilistic per check because of the
//     rotation, so more checks per video = higher conviction odds.
//   - Piped is out of the verify phase entirely: its payloads can no
//     longer acquit, so those calls were pure latency. Piped still
//     serves the search phase exactly as before.
//   - AGE_ERR no longer has a bare "sign in to confirm" branch: Piped's
//     bot-wall error literally reads "Sign in to confirm that you're
//     not a bot" — bot-wall language, not a gate. "Sign in to confirm
//     your age" still convicts via the "confirm your age" branch.
//
// Learned bans, shared by every device (fix-search-filter-3,
// 2026-10-29): the gate-error net above is real but probabilistic,
// and live testing proved it cannot be the only net — the deployed
// relay returned the canonical gated video (PTFwQP86BRs) in six
// straight searches for "nine inch nails closer". Diagnosis: the
// Invidious registry currently contributes ZERO api:true hosts, so
// the verify phase's five checks land on the static tail, where
// exactly one host (the seed) answers detail calls at all — and its
// companions were in a cooperative mood, serving the gated video's
// full payload with no gate error anywhere. Every other server-side
// signal was probed and ruled out with evidence: payload fields do
// not discriminate (isFamilyFriendly is inverted garbage — see
// above), oEmbed answers 200 for gated videos, Piped detail calls
// are bot-walled, and YouTube's own playability check from
// datacenter egress bot-walls NORMAL videos (Rick Astley read
// UNPLAYABLE, Adele LOGIN_REQUIRED). So conviction here is now
// two-layered: the probabilistic verify pre-check above PLUS a
// deterministic learned ban list. When a video actually errors in a
// deck (101/150), the booth records it on the device (js/dj.js
// ageMarkLocked) and posts it to POST /api/brain/block; the ids
// collect in the brain/ytblock doc, and filterPlayable below drops
// them for EVERYONE, permanently, no companion mood involved. The
// list only ever removes ids a real player already convicted; a
// read failure resolves to an empty list (fail open), never a
// broken search.
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
import { userFrom } from "../../lib/cf.js";
const json = (o, age = 60) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=" + age } });
// --- Setup-plan gate (owner directive 2026-10-30, the DJ setup ladder:
// 7 days free, then Tables $10/mo, +YouTube search $15, +Save sessions
// $20, DJ Video Package $35) ---
// Unmarked requests are untouched: Malik's booth, the kids app and the
// listener request path all search exactly as before. A request marked
// setup=1 is a signed-in member searching on their OWN tables (the
// Playground client sends the marker + their session bearer), and for
// them YouTube search is an entitlement, checked here against the
// member doc (members/<uid>: trial_started_at + setup_tier) — the same
// docs read bannedIds below already makes. Malik himself is never
// gated. No session, an expired trial and a tier under $15 all read
// the same verdict: { tier: true } and the client shows the plans card
// (it treats the flag as a hard stop, never a fallback trigger).
const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9"; // same constant station.js carries
const SETUP_TRIAL_MS = 7 * 24 * 3600 * 1000;
async function setupSearchEntitled(request, env) {
  const user = await userFrom(request, env).catch(() => null);
  if (!user) return false;
  if (user.id === OWNER_ID) return true;
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("members/" + user.id).first();
    if (!row) return false;
    const d = JSON.parse(row.data);
    const tier = +(d && d.setup_tier) || 0;
    if (tier >= 15) return true;
    const trialAt = +(d && d.trial_started_at) || 0;
    if (trialAt && Date.now() - trialAt < SETUP_TRIAL_MS) return true;
  } catch (_) {}
  return false;
}
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
// --- Age / embed verification (see the fix-search-filter note above) ---
// Verdict cache: id -> "bad" for gate-convicted ids only, insertion-
// ordered Map, FIFO-capped so a long-lived isolate cannot grow it
// without bound. Repeat searches for the same songs (the common case
// in a DJ booth) skip re-checking known-gated ids instantly. Kept
// videos are deliberately NOT cached: a payload-based "good" would
// acquit forever, and companions rotate (see the correction above).
const verdictCache = new Map();
const VERDICT_CAP = 500;
function cacheVerdict(id, v) {
  if (verdictCache.has(id)) verdictCache.delete(id);
  verdictCache.set(id, v);
  while (verdictCache.size > VERDICT_CAP) verdictCache.delete(verdictCache.keys().next().value);
}
// YouTube's age / safety gate as surfaced in an Invidious error object.
// Deliberately NO bare "sign in to confirm" branch: Piped's bot-wall
// error literally reads "Sign in to confirm that you're not a bot", and
// gate text must never be confusable with bot-wall language (conviction
// reads Invidious responses today, but the phrase stays out on
// principle). "Sign in to confirm your age" still matches, via the
// "confirm your age" branch. The second reason this rule is strict:
// companions rotate behind a host — yt.chocolatemoo53.com gate-errored
// PTFwQP86BRs and later served its full payload — so a payload must
// never acquit what a gate error convicted; metadata is not playable.
const AGE_ERR = /protect our community|confirm your age|age[\s-]?restrict/i;
async function checkInvDetail(base, id, ms) {
  try {
    const r = await fetch(base + "/api/v1/videos/" + encodeURIComponent(id), sig(ms));
    if (!r.ok) return "";
    const j = await r.json();
    // Only the gate error is reported. A full payload is NOT a "good"
    // verdict: it never acquits (see the correction note above).
    if (j && typeof j.error === "string" && AGE_ERR.test(j.error)) return "bad";
  } catch (_) {}
  return "";
}
// Resolve one candidate: true = keep, false = drop. An age-gate error
// from ANY checked Invidious host convicts, period — payloads served
// by other hosts do NOT acquit, because companions rotate behind a
// host and metadata availability is not embeddability
// (yt.chocolatemoo53.com gate-errored PTFwQP86BRs, then served its
// full payload minutes later, and the old acquittal rule shipped the
// gated video at position 1). Piped is not consulted here at all:
// under gate-wins its payloads cannot acquit, so the calls were pure
// latency. With no gate error anywhere the video is kept (fail open):
// timeouts, generic errors and dead hosts say nothing about the video.
// Cloudflare's free plan allows 50 outgoing fetches per request. The
// registry + search tries use a few, so the verify phase is held to
// VERIFY_TOP x VERIFY_HOSTS = 36: past the cap fetches throw, fail
// open, and the lower results were silently never checked.
const VERIFY_HOSTS = 3, VERIFY_TOP = 12;
async function verifyOne(id, invHosts, ms) {
  if (verdictCache.get(id) === "bad") return false;
  const checks = [];
  invHosts.slice(0, VERIFY_HOSTS).forEach((b) => checks.push(checkInvDetail(b, id, ms)));
  const vs = await Promise.all(checks);
  if (vs.includes("bad")) { cacheVerdict(id, "bad"); return false; }
  return true; // fail open
}
// --- Shared learned bans (fix-search-filter-3, see the header note) ---
// The brain/ytblock doc ({ ids: [...] }) holds every video id a real
// deck player has convicted (error 101/150), posted by the booth to
// POST /api/brain/block. Read with the same docs query station.js
// uses for radio/dj (select data from docs where path = ?), cached
// in-isolate for ~60s so the common path costs no query at all.
// ANY failure — no DB binding, no row yet, corrupt JSON, a thrown
// query — resolves to an empty set: the list can only ever remove
// known-bad ids, it can never break search.
let blockCache = null, blockAt = 0;
async function bannedIds(env) {
  if (blockCache && Date.now() - blockAt < 60000) return blockCache;
  let set = new Set();
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("brain/ytblock").first();
    if (row) {
      const d = JSON.parse(row.data);
      if (d && Array.isArray(d.ids)) for (const id of d.ids) if (typeof id === "string" && id) set.add(id);
    }
  } catch (_) { set = new Set(); }
  blockCache = set; blockAt = Date.now();
  return set;
}
// Verify the top ~15 candidates in parallel inside whatever is left of
// the hard deadline: per-call timeouts are sized so the whole phase ends
// before the deadline, and with too little time left the list goes back
// unverified rather than late (the booth client falls back at ~8s).
async function filterPlayable(results, invHosts, t0, env) {
  if (!results.length) return results;
  // Learned bans first (fix-3): deterministic, and they hold even
  // when no verify time is left — a banned id never reaches the
  // verify phase, so its budget goes to videos that are actually new.
  const banned = await bannedIds(env);
  let list = results;
  if (banned.size) {
    const kept = results.filter((it) => !banned.has(it.id));
    // The empty-list guard covers the bans too: if EVERY result is
    // banned, the unfiltered list still goes back (guard below).
    if (kept.length) list = kept;
  }
  const leftMs = DEADLINE_MS - (Date.now() - t0);
  if (leftMs < 800) return list;
  const ms = Math.max(400, Math.min(2500, leftMs - 300));
  const top = list.slice(0, VERIFY_TOP), rest = list.slice(VERIFY_TOP);
  const keep = await Promise.all(top.map((it) => verifyOne(it.id, invHosts, ms)));
  const out = top.filter((_, i) => keep[i]).concat(rest);
  // If filtering would empty the list entirely, return the unfiltered
  // list instead: a bad result beats a dead search.
  return out.length ? out : results;
}
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  if (!q) return json({ ok: false, results: [] }, 0);
  if (url.searchParams.get("setup") === "1" && !(await setupSearchEntitled(request, env))) return json({ ok: false, tier: true, need: 15, results: [] }, 0);
  const page = Math.min(10, Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const t0 = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - t0);
  const invHosts = await pool();
  const cands = candidates(invHosts);
  for (let round = 0; round < ROUNDS; round++) {
    if (round > 0) { if (left() <= 0) break; await sleep(Math.min(ROUND_PAUSE_MS, Math.max(0, left()))); }
    for (const c of cands) {
      const budget = left();
      if (budget <= 250) return json({ ok: false, results: [] }, 0); // out of time: stop starting tries
      try {
        const results = c.fam === "piped" ? await tryPiped(c.base, q, page, Math.min(TRY_MS, budget)) : await tryInv(c.base, q, page, Math.min(TRY_MS, budget));
        if (results) return json({ ok: true, results: await filterPlayable(results, invHosts, t0, env) }, 120);
      } catch (_) {}
    }
  }
  return json({ ok: false, results: [] }, 0);
}
