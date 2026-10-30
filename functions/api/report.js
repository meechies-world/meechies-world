/* Meechie's World — problem reports (owner directive, 2026-10-29: "Make it
 * so people can send reports or it auto reports so it gets fixed").
 *
 * POST /api/report — no auth: visitors must be able to report a broken page
 * even when sign-in itself is the thing that is broken. Abuse is bounded by
 * hard field caps, a body-size cap, the client-side auto-report cap, and the
 * reports/index cap below; the site monitor cron triages new entries.
 *
 * Storage follows the platform write law (same shape as station.js):
 * every report is its own doc at reports/<epochMs>-<rand6>, every docs write
 * also inserts a `changes` row, and an index doc at reports/index keeps the
 * newest 300 ids plus their sigs so server-side dedupe is ONE read of the
 * index (checking the last 50 sigs) — never a scan of report docs.
 * There is deliberately no GET: report bodies are read by the monitor cron
 * through the docs REST select, never exposed publicly.
 */

const KINDS = ["manual", "auto"];
const CATEGORIES = ["broken", "audio", "video", "bug", "other"];
const INDEX_PATH = "reports/index";
const INDEX_CAP = 300; // newest report ids kept in the index
const DEDUPE_WINDOW = 50; // sigs checked against the newest 50 index entries
const BODY_CAP = 16384; // hard reject above this many bytes
const STATE_CAP = 2048; // max JSON bytes for the client state snapshot

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* ---------------- pure helpers (unit-tested by the build harness) -------- */

export function capStr(v, n) {
  if (v == null) return "";
  return String(v).trim().slice(0, n);
}

/* The state snapshot must stay a small plain object; anything bigger or
 * stranger is replaced, never stored raw. */
export function cleanState(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  let s;
  try { s = JSON.stringify(v); } catch (_) { return {}; }
  if (typeof s !== "string") return {};
  if (s.length > STATE_CAP) return { note: "state too large" };
  return v;
}

/* Validate + normalize one report payload. Returns {ok:true, report} or
 * {ok:false, error}. kind is strict (400 on a bad kind); category falls
 * back to "other" per the endpoint contract. */
export function validateReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "bad_body" };
  if (!KINDS.includes(input.kind)) return { ok: false, error: "bad_kind" };
  const category = CATEGORIES.includes(input.category) ? input.category : "other";
  return {
    ok: true,
    report: {
      kind: input.kind,
      category,
      text: capStr(input.text, 500),
      page: capStr(input.page, 200),
      view: capStr(input.view, 100),
      ua: capStr(input.ua, 200),
      session: capStr(input.session, 64),
      sig: capStr(input.sig, 64),
      state: cleanState(input.state),
    },
  };
}

export function buildId(now, rand) {
  return "reports/" + now + "-" + rand;
}

/* Append one id (+ its sig) to the index, keeping only the newest
 * INDEX_CAP entries; sigs for evicted ids are dropped with them. */
export function pushIndex(ids, sigs, id, sig) {
  const nextIds = (Array.isArray(ids) ? ids.slice() : []).concat([id]);
  const nextSigs = Object.assign({}, sigs && typeof sigs === "object" ? sigs : {});
  if (sig) nextSigs[id] = sig;
  while (nextIds.length > INDEX_CAP) {
    const dropped = nextIds.shift();
    delete nextSigs[dropped];
  }
  return { ids: nextIds, sigs: nextSigs };
}

/* True when sig matches one of the newest DEDUPE_WINDOW index entries. */
export function sigInRecent(ids, sigs, sig) {
  if (!sig || !Array.isArray(ids) || !sigs || typeof sigs !== "object") return false;
  const recent = ids.slice(-DEDUPE_WINDOW);
  for (const id of recent) if (sigs[id] === sig) return true;
  return false;
}

/* ---------------- D1 (mirrors station.js writeDoc exactly) -------------- */

async function readDoc(env, path) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (_) { return null; }
}
async function writeDoc(env, path, coll, data) {
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, null, JSON.stringify(data), nowIso, nowIso).run();
  }
  // clients learn about doc changes from the changes feed — without this row the
  // new state would sit in the table unseen
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, coll, null, null, Date.now()).run();
}

function rand6() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] % 2176782336).toString(36).padStart(6, "0").slice(-6);
}

/* ---------------- handler ------------------------------------------------ */

export async function onRequestPost({ request, env }) {
  try {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > BODY_CAP) return json({ ok: false, error: "too_large" }, 400);
    const raw = await request.text();
    if (raw.length > BODY_CAP) return json({ ok: false, error: "too_large" }, 400);
    let input;
    try { input = JSON.parse(raw); } catch (_) { return json({ ok: false, error: "bad_json" }, 400); }
    const v = validateReport(input);
    if (!v.ok) return json({ ok: false, error: v.error }, 400);
    const report = v.report;

    const index = (await readDoc(env, INDEX_PATH)) || { ids: [], sigs: {} };
    if (report.sig && sigInRecent(index.ids, index.sigs, report.sig)) {
      return json({ ok: true, deduped: true });
    }

    const now = Date.now();
    const id = buildId(now, rand6());
    await writeDoc(env, id, "reports", Object.assign({}, report, { at: now }));
    const next = pushIndex(index.ids, index.sigs, id, report.sig);
    await writeDoc(env, INDEX_PATH, "reports", next);
    return json({ ok: true, id });
  } catch (_) {
    return json({ ok: false, error: "server" }, 500);
  }
}
