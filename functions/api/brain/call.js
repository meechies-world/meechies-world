/* /api/brain/call — the phone companion sync door (phone-answering build,
 * WEBSITE-CONNECTION.md §5). The companion acts as Malik under his own
 * site session; these docs are his private business records, so both verbs
 * are owner-only: no session gets a 401, a member session gets a 403 (the
 * same split as the ticket calls for; cf. the owner-only read /api/ai?log).
 *
 *   POST { kind: "call" | "text_draft" | "draft_status" | "digest",
 *          date: "YYYY-MM-DD", entry: {...} }
 *     Appends/merges the entry (by id) into brain/calls/<date> or
 *     brain/texts/<date> (coll "brain", owner = Malik uid). Every write is
 *     paired with its changes row — the house writeMember shape. This
 *     endpoint is the ONLY writer of these docs; the companion never goes
 *     through the generic /api/cf/rest door.
 *   GET ?date=YYYY-MM-DD
 *     Owner-only read of that day pair: { ok, calls, texts }. The booth
 *     Door panel reads it for today call messages; the companion reads it
 *     to reconcile its outbox after an offline stretch.
 *
 * Nothing here can send a call, text or post — summaries and drafts only. */
import { userFrom, isAdmin, take, json, uuid } from "../../../lib/cf.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIA = ["bixby_text", "voicemail", "missed"];
const DRAFT_STATUS = ["pending", "handed_off", "skipped", "expired"];
const DAY_CAP = 200; // entries per day doc — a phone day never gets near it

const clampStr = (v, n) => String(v == null ? "" : v).slice(0, n);
const clampInt = (v, lo, hi) => { const n = Math.round(+v || 0); return Math.min(hi, Math.max(lo, n)); };
const entryId = (e) => clampStr(e && e.id, 64) || uuid();

async function ownerOnly(request, env) {
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return { err: json({ ok: false, error: "sign_in" }, 401) };
  if (!(await isAdmin(env, me.id).catch(() => false))) return { err: json({ ok: false, error: "owner_only" }, 403) };
  return { me };
}

async function readDay(env, path) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
    if (row && row.data) { const d = JSON.parse(row.data); if (d && typeof d === "object") return d; }
  } catch (_) {}
  return null;
}

/* Same write shape as lib/brain-member.js writeMember: update the row,
 * insert if missing, and ALWAYS land the changes row with the doc write. */
async function writeDay(env, path, owner, doc) {
  const nowIso = new Date().toISOString();
  const data = JSON.stringify(doc);
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, "brain", owner, data, nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, "brain", null, null, Date.now()).run();
}

function cleanCall(e) {
  return {
    id: entryId(e),
    at: clampInt(e.at, 0, Date.now() + 864e5),
    fromName: clampStr(e.fromName, 80),
    fromNumber: clampStr(e.fromNumber, 32),
    via: VIA.includes(e.via) ? e.via : "missed",
    lane: clampStr(e.lane, 40),
    need: clampStr(e.need, 200),
    bestTime: clampStr(e.bestTime, 60),
    summary: clampStr(e.summary, 300),
  };
}

function cleanDraft(e) {
  return {
    id: entryId(e),
    at: clampInt(e.at, 0, Date.now() + 864e5),
    fromNumber: clampStr(e.fromNumber, 32),
    category: clampStr(e.category, 40),
    incoming: clampStr(e.incoming, 300),
    draft: clampStr(e.draft, 1000),
    status: DRAFT_STATUS.includes(e.status) ? e.status : "pending",
  };
}

function upsertById(list, entry) {
  const i = list.findIndex((x) => x && x.id === entry.id);
  if (i >= 0) list[i] = entry; else list.push(entry);
  return list.slice(-DAY_CAP);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const gate = await ownerOnly(request, env);
  if (gate.err) return gate.err;
  const me = gate.me;
  // 300 a day: generous for one phone, a wall against a runaway client
  if (!(await take(env, "brain-call:" + me.id, 86400, 300))) return json({ ok: false, error: "rate_limited" }, 429);
  let body = null;
  try { body = await request.json(); } catch (_) {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad_body" }, 400);
  const kind = String(body.kind || "");
  const date = String(body.date || "");
  if (!DATE_RE.test(date)) return json({ ok: false, error: "bad_date" }, 400);
  const entry = body.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return json({ ok: false, error: "bad_entry" }, 400);

  if (kind === "call") {
    const path = "brain/calls/" + date;
    const doc = (await readDay(env, path)) || { v: 1, date, calls: [], digest: { screened: 0, missed: 0, spamSilenced: 0 } };
    if (!Array.isArray(doc.calls)) doc.calls = [];
    const clean = cleanCall(entry);
    doc.calls = upsertById(doc.calls, clean);
    doc.v = 1; doc.date = date;
    await writeDay(env, path, me.id, doc);
    return json({ ok: true, id: clean.id });
  }

  if (kind === "text_draft") {
    const path = "brain/texts/" + date;
    const doc = (await readDay(env, path)) || { v: 1, date, drafts: [] };
    if (!Array.isArray(doc.drafts)) doc.drafts = [];
    const clean = cleanDraft(entry);
    doc.drafts = upsertById(doc.drafts, clean);
    doc.v = 1; doc.date = date;
    await writeDay(env, path, me.id, doc);
    return json({ ok: true, id: clean.id });
  }

  if (kind === "draft_status") {
    const status = String(entry.status || "");
    if (!DRAFT_STATUS.includes(status)) return json({ ok: false, error: "bad_status" }, 400);
    const id = clampStr(entry.id, 64);
    if (!id) return json({ ok: false, error: "bad_entry" }, 400);
    const path = "brain/texts/" + date;
    const doc = await readDay(env, path);
    if (!doc || !Array.isArray(doc.drafts)) return json({ ok: false, error: "not_found" }, 404);
    const d = doc.drafts.find((x) => x && x.id === id);
    if (!d) return json({ ok: false, error: "not_found" }, 404);
    d.status = status; // handed_off means Malik tapped send in his Messages app — never claim "sent" here
    await writeDay(env, path, me.id, doc);
    return json({ ok: true, id });
  }

  if (kind === "digest") {
    const path = "brain/calls/" + date;
    const doc = (await readDay(env, path)) || { v: 1, date, calls: [], digest: { screened: 0, missed: 0, spamSilenced: 0 } };
    if (!Array.isArray(doc.calls)) doc.calls = [];
    doc.digest = {
      screened: clampInt(entry.screened, 0, 100000),
      missed: clampInt(entry.missed, 0, 100000),
      spamSilenced: clampInt(entry.spamSilenced, 0, 100000),
    };
    doc.v = 1; doc.date = date;
    await writeDay(env, path, me.id, doc);
    return json({ ok: true, id: null });
  }

  return json({ ok: false, error: "bad_kind" }, 400);
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const gate = await ownerOnly(request, env);
  if (gate.err) return gate.err;
  const date = new URL(request.url).searchParams.get("date") || "";
  if (!DATE_RE.test(date)) return json({ ok: false, error: "bad_date" }, 400);
  const calls = await readDay(env, "brain/calls/" + date);
  const texts = await readDay(env, "brain/texts/" + date);
  return json({ ok: true, calls, texts });
}
