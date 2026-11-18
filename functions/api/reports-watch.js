/* Meechie's World — the site watch's gated door to report bodies
 * (REPORTS LAW, owner directive 2026-10-30). Report bodies stay private:
 * they are served to the owner in his booth (/api/reports) and, through
 * this door, to Amani's site watch — never to anyone else.
 *
 * POST /api/reports-watch — the request must carry the header
 *   x-mw-reports-watch: <the REPORTS_WATCH_SECRET Pages secret>
 * The comparison is made between SHA-256 digests, never on raw values,
 * and the secret itself never appears in code or in any response.
 * While the secret is unset this door does not exist (404 for every
 * request); a missing or wrong header is a plain 403 denial. Setting
 * the secret is a dashboard step (Cloudflare Pages -> Settings ->
 * Environment variables -> REPORTS_WATCH_SECRET) — until it is set,
 * nothing about report privacy changes.
 *
 * Body (JSON, optional): {ids: [report paths]} returns exactly those
 * reports, in the order asked (unknown or non-report ids are skipped).
 * Without ids it returns the newest 50 stored reports.
 */

const HEADER = "x-mw-reports-watch";
const LIST_CAP = 300;
const DEFAULT_N = 50;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* ---------------- pure helpers (unit-tested by the build harness) -------- */

/* A report doc path is reports/<epochMs>-<rand6> (see buildId in
 * /api/report). The index and the handoff doc are not reports. */
export function isReportPath(p) {
  return typeof p === "string" && /^reports\/\d{10,}-[a-z0-9]{6}$/.test(p);
}

export function reportMs(id) {
  const m = /^reports\/(\d{10,})-/.exec(id || "");
  return m ? +m[1] : 0;
}

export function shapeReports(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !isReportPath(r.path)) continue;
    let d = r.data;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (_) { continue; } }
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    out.push(Object.assign({}, d, { id: r.path }));
  }
  out.sort((a, b) => reportMs(b.id) - reportMs(a.id));
  return out;
}

export async function digestHex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* Constant-work comparison over equal-length digest strings. */
export function sameDigest(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function watchSecretOk(given, secret) {
  if (!secret || !given) return false;
  const g = await digestHex(given), s = await digestHex(secret);
  return sameDigest(g, s);
}

/* ---------------- D1 ------------------------------------------------------ */

async function readDoc(env, path) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (_) { return null; }
}

async function scanReports(env) {
  const { results } = await env.DB.prepare("select path, data from docs where coll = ?").bind("reports").all();
  return shapeReports(results || []);
}

/* ---------------- handler ------------------------------------------------- */

export async function onRequestPost({ request, env }) {
  const secret = env && env.REPORTS_WATCH_SECRET;
  if (!secret) return json({ ok: false, error: "not_found" }, 404); // door stays shut until the secret exists
  const given = request.headers.get(HEADER) || "";
  if (!(await watchSecretOk(given, secret))) return json({ ok: false, error: "denied" }, 403);
  try {
    const body = await request.json().catch(() => null);
    const want = body && Array.isArray(body.ids) ? body.ids.filter(isReportPath).slice(0, LIST_CAP) : null;
    if (want) {
      const byId = {};
      const all = await scanReports(env);
      for (const r of all) byId[r.id] = r;
      const reports = [];
      for (const id of want) if (byId[id]) reports.push(byId[id]);
      return json({ ok: true, count: reports.length, reports: reports });
    }
    const reports = await scanReports(env);
    return json({ ok: true, count: reports.length, reports: reports.slice(0, DEFAULT_N) });
  } catch (_) {
    return json({ ok: false, error: "server" }, 500);
  }
}
