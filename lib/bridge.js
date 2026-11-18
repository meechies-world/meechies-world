/* lib/bridge.js — the bridge address resolver (2026-11-13, the flip).
 *
 * The bridge upstream is Malik's own phone stack, reached through a
 * cloudflared quick tunnel whose URL changes on every tunnel restart.
 * Before this module, both consumers carried a compiled-in constant
 * (functions/api/bridge/cf/[[path]].js and the google-redirect bridge
 * inside functions/api/cf/[[path]].js), and the constant went stale
 * silently — the live site carried a dead address for two days in
 * November 2026 while the phone sat healthy at a new one.
 *
 * bridgeUpstream(origin) resolves the CURRENT address, in order:
 *   1. this isolate's memo of the last upstream that passed validation
 *      (5 minutes; a total failure is memoized for 60 s so an outage
 *      does not turn every call into a probe storm);
 *   2. the GitHub rendezvous — bridge-rendezvous.json on main, read
 *      via raw.githubusercontent.com (survives a D1 wall, a Pages
 *      outage, and Cloudflare entirely);
 *   3. the site's own static /lifeline/bridge.json (pure Pages CDN —
 *      _routes.json excludes /lifeline/* from Functions; no D1);
 *   4. the compiled-in FALLBACK below — the last known-good address,
 *      so a total rendezvous failure degrades to the pre-resolver
 *      behaviour, never worse.
 *
 * Every candidate is validated before use: the URL must match the
 * tunnel host shape, GET <url>/api/cf/health must answer {ok:true},
 * and GET <url>/api/cf/auth/settings must return the site's real
 * public Google client id (the same two checks the bridge drills have
 * always run by hand). First candidate that passes wins and is
 * memoized. A poisoned rendezvous can therefore at worst point the
 * bridge at a host that must impersonate the stack's health AND its
 * settings exactly — and every proxied call still lands on a handler
 * that enforces the same auth and write rules as the main backend.
 *
 * The rendezvous files are written by the phone-side publisher
 * (flip-build-2026-11-13/phone-kit) ONLY when the tunnel URL changes,
 * plus a 6-hour heartbeat: a handful of GitHub commits, ZERO D1
 * writes. This module never touches D1 at all — reads or writes —
 * so it costs nothing against the D1 write budget.
 *
 * A named tunnel (bridge.meechiesworldinc.com) later makes the
 * address permanent: its hostname joins the rendezvous list and
 * HOST_OK grows a second shape. Nothing else changes.
 */
const FALLBACK = "https://stretch-reservoir-forecast-ensures.trycloudflare.com";
const GOOGLE_ID = "429216763635-bfgt31qbolbj0ijh5b5ckqcfb63ftt9u.apps.googleusercontent.com";
const RAW_RENDEZVOUS = "https://raw.githubusercontent.com/meechies-world/meechies-world/main/bridge-rendezvous.json";
const HOST_OK = /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/;
const MEMO_MS = 5 * 60 * 1000;
const FAIL_MS = 60 * 1000;
let memo = null; // {url, until}

const shapeOk = (u) => typeof u === "string" && HOST_OK.test(u);

async function probe(url) {
  try {
    const h = await fetch(url + "/api/cf/health", { signal: AbortSignal.timeout(3000) });
    if (!h.ok) return false;
    const hj = await h.json().catch(() => null);
    if (!hj || hj.ok !== true) return false;
    const s = await fetch(url + "/api/cf/auth/settings", { signal: AbortSignal.timeout(3000) });
    if (!s.ok) return false;
    const sj = await s.json().catch(() => null);
    return !!sj && sj.google === GOOGLE_ID;
  } catch (_) {
    return false;
  }
}

async function fromRendezvous(which, origin) {
  try {
    const url = which === "raw" ? RAW_RENDEZVOUS : origin + "/lifeline/bridge.json";
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    const list = j && Array.isArray(j.upstreams) ? j.upstreams : [];
    return list.map((u) => u && u.url).filter(shapeOk);
  } catch (_) {
    return [];
  }
}

export async function bridgeUpstream(origin) {
  const now = Date.now();
  if (memo && now < memo.until) return memo.url;
  const candidates = [];
  for (const u of await fromRendezvous("raw")) candidates.push(u);
  if (origin) for (const u of await fromRendezvous("static", origin)) candidates.push(u);
  candidates.push(FALLBACK);
  for (const u of [...new Set(candidates)]) {
    if (await probe(u)) {
      memo = { url: u, until: now + MEMO_MS };
      return u;
    }
  }
  memo = { url: FALLBACK, until: now + FAIL_MS };
  return FALLBACK;
}

export const BRIDGE_FALLBACK = FALLBACK;
