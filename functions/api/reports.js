/* Meechie's World — the owner's reports door (REPORTS LAW, owner directive
 * 2026-10-30: "Theres 28 reports and it wont let me read them i want to be
 * able to click that button and send my problems to you to fix them thats
 * law").
 *
 * POST /api/reports — owner session only, through the same admins-table
 * gate (userFrom + isAdmin) the generic docs door uses. It replaces the
 * booth panel's old read chain — one REST select for reports/index plus
 * one per report body — which failed the owner two ways:
 *   1. It saw only what reports/index lists. The index is maintained by
 *      /api/report as a read-modify-write, and auto-reports arrive in
 *      bursts (up to 5 per page session), so concurrent posts overwrite
 *      each other's index updates: report docs land in the store with no
 *      index entry and become invisible to the panel — to anyone.
 *   2. Every failure (no session, a session the server does not recognize
 *      as admin, a network miss on any of the 1 + N selects) collapsed
 *      into the same "private to the admin account" line, bodies
 *      unreachable, no hint why.
 * This door lists bodies by scanning the docs store itself
 * (coll = 'reports'), so what is stored is what the owner can read, in
 * one request, with a plain 403 when the session is not the owner's.
 * Nothing widens: the generic REST exclusion for the reports collection
 * is untouched, and report bodies are still served nowhere else.
 *
 * Actions (JSON body, session Bearer required):
 *   {action:"read"}    -> {ok, count, reports:[{id, ...body}], handoff}
 *   {action:"handoff"} -> writes reports/handoff {at, count, ids} with
 *                         the full current id set, plus the changes-feed
 *                         row every docs write carries — the row is the
 *                         site watch's trigger to pull these bodies
 *                         through the gated watch door (reports-watch.js)
 *                         and hand them to Amani to fix.
 */

import { userFrom, isAdmin } from "../../lib/cf.js";

const HANDOFF_PATH = "reports/handoff";
const LIST_CAP = 300; // mirrors the reports/index cap in /api/report

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* ---------------- pure helpers (unit-tested by the build harness) -------- */

/* A report doc path is reports/<epochMs>-<rand6> (see buildId in
 * /api/report). The index and the handoff doc live in the same collection
 * but are not reports. */
export function isReportPath(p) {
  return typeof p === "string" && /^reports\/\d{10,}-[a-z0-9]{6}$/.test(p);
}

export function reportMs(id) {
  const m = /^reports\/(\d{10,})-/.exec(id || "");
  return m ? +m[1] : 0;
}

/* Rows from the docs store -> report objects, newest first. Rows that do
 * not parse or are not report docs are dropped, never fatal. */
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

/* The handoff doc the watch consumes: when, how many, exactly which. */
export function buildHandoff(ids, at) {
  const list = (Array.isArray(ids) ? ids : []).filter(isReportPath).slice(0, LIST_CAP);
  return { at: at, count: list.length, ids: list };
}

/* ---------------- D1 (mirrors /api/report's writeDoc exactly) ----------- */

async function readDoc(env, path) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (_) { return null; }
}

async function scanReports(env) {
  const { results } = await env.DB.prepare("select path, data from docs where coll = ?").bind("reports").all();
  return shapeReports(results || []);
}

async function writeDoc(env, path, coll, data) {
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, null, JSON.stringify(data), nowIso, nowIso).run();
  }
  // clients (and the site watch) learn about doc changes from the changes
  // feed — without this row the handoff would sit in the table unseen
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, coll, null, null, Date.now()).run();
}

/* ---------------- handler ------------------------------------------------ */

export async function onRequestPost({ request, env }) {
  try {
    const me = await userFrom(request, env);
    if (!me || !(await isAdmin(env, me.id))) return json({ ok: false, error: "not_owner" }, 403);
    const body = await request.json().catch(() => null);
    const action = body && body.action;
    if (action === "read") {
      const reports = await scanReports(env);
      const handoff = await readDoc(env, HANDOFF_PATH);
      return json({ ok: true, count: reports.length, reports: reports.slice(0, LIST_CAP), handoff: handoff || null });
    }
    if (action === "handoff") {
      const reports = await scanReports(env);
      const doc = buildHandoff(reports.map((r) => r.id), Date.now());
      await writeDoc(env, HANDOFF_PATH, "reports", doc);
      return json({ ok: true, count: doc.count, handoff: doc });
    }
    return json({ ok: false, error: "bad_action" }, 400);
  } catch (_) {
    return json({ ok: false, error: "server" }, 500);
  }
}
