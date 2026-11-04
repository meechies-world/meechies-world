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
//
// Strong playability scan (mwtv-scan, 2026-11-03): Malik, the same
// evening as the queuefix: "I want somthing to scan and remove what
// cant be played when searching." The verify phase this file shipped
// with convicted ONLY on an Invidious age-gate error — it had no
// region check at all, and the dead-movie investigation that evening
// proved what that misses: _Tu_SAqNinU ("THE OLD BODYGUARD", an
// aggregator upload) sat at position 1 of this relay's own results
// for "the old bodyguard full movie" while its uploader blocks the
// US outright — and oEmbed answers 200 for it, so an oEmbed-only
// gate cannot catch it either. The scan in verifyOne below therefore
// asks YouTube's own player API (WEB client) for the DATA fields
// that discriminate, plus oEmbed for the embed verdict, and convicts
// ONLY on affirmative evidence:
//   - microformat availableCountries present and US absent -> region
//   - an explicit blocker subreason (country block, copyright
//     country block) -> region; removed / private / terminated /
//     copyright text -> gone
//   - LOGIN_REQUIRED or UNPLAYABLE carrying age text ("confirm
//     your age") -> age gate
//   - playableInEmbed === false, or oEmbed answering 400/401/403/404
//     (401 is YouTube's embed-disabled answer, 404 gone/private)
//     -> embed
// A video is acquitted ("good") only when the player says OK *and*
// oEmbed confirms — two of YouTube's own systems agreeing — and even
// then the verdict is cached for just 2h (bad verdicts 6h), never
// forever. EVERYTHING else is inconclusive and the video is KEPT:
// the dead-movie report's probe caveat is law here — playback status
// from datacenter egress bot-walls normal videos (Rick Astley read
// UNPLAYABLE with a "page needs to be reloaded" subreason), so a
// bare status NEVER convicts; bot/reload text matches no conviction
// pattern above, by construction. Inconclusive videos still face
// the Invidious gate-error net below exactly as before (any host's
// age-gate error convicts), and the learned brain/ytblock bans
// still run first. The response now carries "hidden": how many
// results the bans + scan removed from THIS page, so the MW TV
// owner box can say "N hidden — can't play here" under its results.
// Per-page scan stats (checked / removed / inconclusive) are
// console-logged so over- and under-removal stay visible.
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
// Verdict cache: id -> { v, why, at }, insertion-ordered Map, FIFO-
// capped so a long-lived isolate cannot grow it without bound.
// Verdicts now EXPIRE (mwtv-scan): a "bad" verdict holds 6h, a "good"
// verdict 2h — long enough that repeat searches for the same songs
// (the common case in a DJ booth) skip re-checking, short enough
// that a video whose region/embed state changes is re-judged the
// same day. Only evidence-backed verdicts are cached at all: a
// "good" requires the strong scan's two-system acquittal (below);
// a video the scan could not judge is kept but NEVER cached good —
// the old rule survives for it (an unproven keep must not acquit
// forever, and companions rotate; see the correction above).
const verdictCache = new Map();
const VERDICT_CAP = 1000;
const BAD_TTL_MS = 6 * 3600 * 1000, GOOD_TTL_MS = 2 * 3600 * 1000;
function cacheVerdict(id, v, why) {
  if (verdictCache.has(id)) verdictCache.delete(id);
  verdictCache.set(id, { v, why: why || "", at: Date.now() });
  while (verdictCache.size > VERDICT_CAP) verdictCache.delete(verdictCache.keys().next().value);
}
function cachedVerdict(id) {
  const e = verdictCache.get(id);
  if (!e) return null;
  if (Date.now() - e.at > (e.v === "bad" ? BAD_TTL_MS : GOOD_TTL_MS)) { verdictCache.delete(id); return null; }
  return e;
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
// --- Strong playability scan (mwtv-scan; see the header note) ---
// The public WEB-client key youtube.com's own pages ship; the player
// endpoint it unlocks is the same one the dead-movie investigation
// used to convict _Tu_SAqNinU from this VM.
const YT_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW";
const YT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// Conviction text classes, matched against the playabilityStatus
// JSON so reason and error-screen subreason are both covered. These
// name a concrete state of the VIDEO (its region list, its age
// gate, its removal) — never a state of the PROBE. Bot-wall and
// reload text ("Sign in to confirm you're not a bot", "The page
// needs to be reloaded") matches none of them, by construction.
const REGION_TEXT = /not made this video available in your country|not available in your country|not available in your region|blocked in your country|has blocked it in your country/i;
const AGE_TEXT = /confirm your age|age[\s-]?restrict/i;
const GONE_TEXT = /removed by the uploader|this video has been removed|account associated with this video has been terminated|blocked it on copyright|video is private/i;
// One candidate against YouTube's own systems. Returns
// { v: "bad", why } on affirmative can't-play evidence,
// { v: "good" } when the player says OK and oEmbed confirms, and
// { v: "" } when the evidence is inconclusive (bot wall, generic
// UNPLAYABLE, timeout, unparseable) — inconclusive is never a
// conviction and never an acquittal.
async function strongCheck(id, ms) {
  let j = null;
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + YT_KEY, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": YT_UA },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240726.00.00", hl: "en", gl: "US" } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
      ...sig(ms),
    });
    if (r && r.ok) j = await r.json().catch(() => null);
  } catch (_) {}
  let acquit = false;
  if (j && typeof j === "object") {
    const ps = j.playabilityStatus || {};
    const mf = (j.microformat && j.microformat.playerMicroformatRenderer) || {};
    const ac = mf.availableCountries;
    const text = JSON.stringify(ps);
    // The region list is a data field of the video itself: US absent
    // convicts even inside an otherwise bot-walled response (the
    // Old Bodyguard response was exactly that shape).
    if (Array.isArray(ac) && ac.length && !ac.includes("US")) return { v: "bad", why: "region" };
    if (REGION_TEXT.test(text)) return { v: "bad", why: "region" };
    if (ps.playableInEmbed === false) return { v: "bad", why: "embed" };
    if (AGE_TEXT.test(text) && (ps.status === "LOGIN_REQUIRED" || ps.status === "UNPLAYABLE")) return { v: "bad", why: "age" };
    if (GONE_TEXT.test(text)) return { v: "bad", why: "gone" };
    if (ps.status === "OK") acquit = true;
  }
  // oEmbed is the embed authority: 401 = embedding disabled by the
  // owner, 404 = gone or private, 400/403 = YouTube refusing the
  // embed record. A real HTTP answer in that set convicts even when
  // the player call failed outright; a 200 confirms embeddability
  // but never acquits region/age on its own (it answered 200 for
  // the geo-blocked Old Bodyguard). Timeouts and 5xx say nothing.
  let oe = 0;
  try {
    const r = await fetch("https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id) + "&format=json", { headers: { "user-agent": YT_UA }, ...sig(Math.min(ms, 1200)) });
    oe = r ? r.status : 0;
  } catch (_) {}
  if (oe === 400 || oe === 401 || oe === 403 || oe === 404) return { v: "bad", why: "embed" };
  if (acquit && oe === 200) return { v: "good", why: "player" };
  return { v: "", why: "" };
}
// Resolve one candidate: { keep, inc } — inc marks an inconclusive
// scan (kept, but proven neither way; counted for the scan stats).
// Order: verdict cache, then the strong scan, then — only for the
// inconclusive — the Invidious gate-error net with its shipped rule
// intact (an age-gate error from ANY checked host convicts, period;
// payloads never acquit — companions rotate, see the correction
// above; Piped is not consulted, its payloads cannot acquit either).
// A strong-scan acquittal does NOT face the Invidious net: YouTube's
// own player + oEmbed agreeing outranks a companion's mood, and a
// stale gate error convicting a player-confirmed video would be
// over-removal — the failure mode this scan exists to avoid.
// Fetch budget: Cloudflare's free plan allows 50 outgoing fetches
// per request. The strong scan costs at most 2 per video and ends
// most checks there; only inconclusive videos spend the further
// VERIFY_HOSTS detail calls, so a page's verify phase stays inside
// the cap in practice — and past the cap fetches throw, fail open,
// and the video is kept, exactly as before. The phase also runs in
// waves of VERIFY_WAVE (see filterPlayable): a 12-wide stampede of
// player POSTs demonstrably starves itself (every call timing out
// at 1.6s from this VM while sequential calls answer in ~300ms),
// where waves of 4 finish the dozen in ~2s with room to spare.
const VERIFY_HOSTS = 3, VERIFY_TOP = 12, VERIFY_WAVE = 4;
async function verifyOne(id, invHosts, t0) {
  const c = cachedVerdict(id);
  if (c) return { keep: c.v !== "bad", inc: false };
  const leftA = DEADLINE_MS - (Date.now() - t0);
  const s = await strongCheck(id, Math.max(250, Math.min(2200, Math.floor(leftA / 2))));
  if (s.v === "bad") { cacheVerdict(id, "bad", s.why); return { keep: false, inc: false }; }
  if (s.v === "good") { cacheVerdict(id, "good", s.why); return { keep: true, inc: false }; }
  const leftB = DEADLINE_MS - (Date.now() - t0);
  if (leftB >= 900) {
    const ms = Math.max(250, Math.min(2200, leftB - 300));
    const checks = [];
    invHosts.slice(0, VERIFY_HOSTS).forEach((b) => checks.push(checkInvDetail(b, id, ms)));
    const vs = await Promise.all(checks);
    if (vs.includes("bad")) { cacheVerdict(id, "bad", "age-inv"); return { keep: false, inc: false }; }
  }
  return { keep: true, inc: true }; // fail open, unproven — never cached good
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
// Verify the top candidates in parallel inside whatever is left of
// the hard deadline: per-call timeouts are sized so the whole phase ends
// before the deadline, and with too little time left the list goes back
// unverified rather than late (the booth client falls back at ~8s).
// Returns { list, hidden }: hidden counts what the bans + scan took
// out of THIS page, for the owner box's "N hidden — can't play here"
// line. When the empty-list guard fires nothing was actually taken
// from the owner, so hidden honestly reads 0 there.
async function filterPlayable(results, invHosts, t0, env) {
  if (!results.length) return { list: results, hidden: 0 };
  // Learned bans first (fix-3): deterministic, and they hold even
  // when no verify time is left — a banned id never reaches the
  // verify phase, so its budget goes to videos that are actually new.
  const banned = await bannedIds(env);
  let list = results, hidden = 0;
  if (banned.size) {
    const kept = results.filter((it) => !banned.has(it.id));
    // The empty-list guard covers the bans too: if EVERY result is
    // banned, the unfiltered list still goes back (guard below).
    if (kept.length) { hidden = results.length - kept.length; list = kept; }
  }
  const leftMs = DEADLINE_MS - (Date.now() - t0);
  if (leftMs < 800) return { list, hidden };
  const top = list.slice(0, VERIFY_TOP), rest = list.slice(VERIFY_TOP);
  // Waves, not a stampede (see the budget note at verifyOne): the
  // clock is re-read between waves, and if the deadline closes in,
  // the remaining candidates go back unproven-kept rather than late.
  const vs = new Array(top.length);
  for (let i = 0; i < top.length; i += VERIFY_WAVE) {
    if (DEADLINE_MS - (Date.now() - t0) < 700) { for (let k = i; k < top.length; k++) vs[k] = { keep: true, inc: true }; break; }
    const part = await Promise.all(top.slice(i, i + VERIFY_WAVE).map((it) => verifyOne(it.id, invHosts, t0)));
    part.forEach((v, k) => { vs[i + k] = v; });
  }
  const out = top.filter((_, i) => vs[i].keep).concat(rest);
  const removed = top.length - (out.length - rest.length);
  const inc = vs.reduce((n, x) => n + (x.inc ? 1 : 0), 0);
  try { console.log("ytsearch-scan checked=" + top.length + " removed=" + removed + " inconclusive=" + inc + " banned=" + hidden); } catch (_) {}
  // If filtering would empty the list entirely, return the unfiltered
  // list instead: a bad result beats a dead search.
  if (!out.length) return { list: results, hidden: 0 };
  return { list: out, hidden: hidden + removed };
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
        if (results) { const fp = await filterPlayable(results, invHosts, t0, env); return json({ ok: true, results: fp.list, hidden: fp.hidden }, 120); }
      } catch (_) {}
    }
  }
  return json({ ok: false, results: [] }, 0);
}
