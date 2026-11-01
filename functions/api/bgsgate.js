/* Background-sound stream gate. GET /api/bgsgate -> { live: boolean, at }
 *
 * The listener background-sound handoff (js/dj.js, BACKGROUND SOUND block)
 * may only start while the direct stream actually carries the station.
 * The stream (SHOUTcast DNAS at eu4.fastcast4u.com:6496, mount /stream)
 * carries the station only while the VM feeder pushes to it; with no
 * source connected, Centova AutoDJ holds the mount as a placeholder that
 * is NOT the station and must never reach a listener as if it were.
 *
 * The DNAS public statistics endpoint names the current source, and the
 * two states are cleanly separable (both observed on the live endpoint;
 * see ~/workspace/website/background-sound-2026-11-01/AUDIT.md):
 *   feeder pushing:  SERVERTITLE "Meechie's World Radio" (the feeder's
 *                    icy-name), SONGTITLE "" (it sends no titles)
 *   AutoDJ fallback: SERVERTITLE "FreeSHOUTCAST AutoDJ",
 *                    SONGTITLE "Unknown - WelcometoFreeshoutcast"
 * STREAMSTATUS is 1 in BOTH states (the AutoDJ counts as a source), so
 * the title fields are the signal. The status routes send no CORS
 * headers, so the check runs here, server-side; the browser only ever
 * sees this function's yes/no.
 *
 * FAIL CLOSED: any doubt — non-200, timeout, unparseable body, missing
 * fields, placeholder wording anywhere in the title/song — answers
 * live:false. Answers are cached for 15 s at the edge: the gate is read
 * at page-hide moments and on a slow tick while backgrounded, never on a
 * hot path. */
const STATS_URL = "http://eu4.fastcast4u.com:6496/statistics";
const FEEDER_TITLE = "Meechie's World Radio";

const json = (o) => new Response(JSON.stringify(o), {
  status: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=15" },
});

const decode = (s) => s
  .replace(/&apos;/g, "'").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const tag = (xml, name) => {
  const m = xml.match(new RegExp("<" + name + ">([^<]*)</" + name + ">"));
  return m ? decode(m[1]).trim() : "";
};

/* Pure decision, exported for the node-side fixture tests. */
export function gateDecision(xml) {
  if (!xml || typeof xml !== "string") return false;
  const status = tag(xml, "STREAMSTATUS");
  const title = tag(xml, "SERVERTITLE");
  const song = tag(xml, "SONGTITLE");
  if (status !== "1" || !title) return false;
  if (/freeshoutcast|autodj/i.test(title + " " + song)) return false;
  if (/welcometofreeshoutcast/i.test(song)) return false;
  return title === FEEDER_TITLE;
}

export async function onRequestGet() {
  const cacheKey = new Request("https://mw.internal/bgsgate/v1");
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  } catch (_) {}
  let live = false;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(STATS_URL, {
      signal: ctl.signal,
      headers: { "User-Agent": "MeechiesWorld-BGSGate/1.0" },
    });
    clearTimeout(to);
    if (r.ok) live = gateDecision(await r.text());
  } catch (_) { live = false; }
  const resp = json({ live, at: Date.now() });
  try { await caches.default.put(cacheKey, resp.clone()); } catch (_) {}
  return resp;
}
