/* Shared YouTube playability evidence — ONE code path, two doors.
 *
 * Extracted 2026-11-03 (queuecheck build) from functions/api/ytsearch.js,
 * where this machinery shipped as the mwtv-scan verify phase (PR #641,
 * Malik: "I want somthing to scan and remove what cant be played when
 * searching"). The MW TV queue door (functions/api/tv/queue.js) now
 * judges a video at ADD time by the same standard (Malik, 2026-11-03
 * 20:57 ET: "Check the videos when they get qued and remove them if
 * they not able to be played"), so the strong scan and the verdict
 * cache live here and both files import them — no second, divergent
 * checker. Each door instantiates its OWN cache via makePlayability()
 * below: the relay's instance semantics are unchanged from when the
 * cache lived inside ytsearch.js (one cache per door per isolate,
 * same TTLs). What is shared is the CODE PATH, which is the point —
 * the same evidence code judges a video at search time and at queue
 * time, so the two doors can never drift apart.
 *
 * THE EVIDENCE STANDARD (the Old Bodyguard lesson — see the ytsearch
 * header note for the full investigation): a video is convicted
 * ("bad") ONLY on affirmative evidence from YouTube's own systems —
 * the availability country list with the US absent, an explicit
 * country-block subreason, LOGIN_REQUIRED / age-gate wording,
 * playableInEmbed === false, oEmbed answering 400/401/403/404, or
 * gone/private/terminated wording. It is acquitted ("good") only
 * when the player says OK *and* oEmbed confirms. EVERYTHING else —
 * a bare UNPLAYABLE status, a bot wall, a timeout — is inconclusive
 * ({ v: "" }): never a conviction, never an acquittal, never cached.
 * Datacenter egress bot-walls normal videos (Rick Astley read
 * UNPLAYABLE with a "page needs to be reloaded" subreason), so a
 * bare status must never remove anything, anywhere this is used.
 */
function sig(ms) { return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {}; }

  /* One playability judge: the strong scan plus its verdict cache.
 * Returns { strongCheck, cachedVerdict, cacheVerdict } — the exact
 * trio the relay's verify phase has always used internally. */
export function makePlayability() {
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
  return { strongCheck, cachedVerdict, cacheVerdict };
}
