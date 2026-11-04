// POST /api/tv/queue — MW TV OWNER QUEUE + SKIP (Malik, 2026-11-03
// 19:09 ET: "Make it so i can skip the movies on mw tv and que a
// list and if nothings qued you pick stuff").
//
// The second owner door on MW TV, beside /api/tv/insert: same
// owner gate, same embed gate (the /api/ytsearch relay verdict +
// the brain/ytblock learned-ban check), same evidence discipline.
// The owner builds a list here — add from the MW TV owner search
// results, remove, reorder — and stamps skip asks. The keeper
// (functions/api/station.js: tvTick / tvGen / tvAdvanceChannel)
// is the only writer of tv/now and the only consumer of this doc:
// it plays the list after the current piece, freezes it across
// the hard schedule (news windows, premiere, rerun, inserts,
// cadence) and retires an item only after it has actually aired.
// An empty list changes nothing — the keeper fills the channel
// from the cleared pool and the lineup, as it always has.
//
// QUEUEFIX (2026-11-03 late): the shipped writeQueue inserted
// the changes row with a column set that does not exist in the
// production changes table (ts/actor/kind/summary instead of
// tbl/path/coll/a/b/at), so EVERY write action — add, remove,
// move, clear, skip — threw inside the handler and the owner's
// browser got a 500: "The serch wont let me que the movies."
// The #634 endpoint harness stubbed the DB permissively and
// never saw it. writeQueue below now uses the canonical
// writeDoc shape (station.js / insert.js), ownerOnly calls
// isAdmin(env, me.id) awaited — the shipped call was swapped
// and un-awaited, passing only by a truthy-Promise accident —
// and the cap is 500, not 20 (Malik: "que more then one movie
// as many as i want"; a queue doc of 500 items is ~150KB of
// JSON, far inside the doc limits, and the keeper prunes it as
// items air). The relay gate is pin-only now — absence from a
// re-search no longer convicts (see relayGate for the live
// probe evidence); insert.js got the same gate fix.
//
// The doc (tv/queue): { progV: 1, items: [{ qid, yt, title, dur,
// at }], anchor, skipAt, updatedAt, by }.
//   anchor — when the list's window opens: stamped at the end of
//     the segment on air when the first item lands on an empty
//     list; the keeper re-anchors a list that never got to air.
//   skipAt — the owner's latest skip ask (ms). The keeper answers
//     it through tvAdvanceChannel and stamps the outcome into
//     tv/now (qSkipAt / qSkipNote), which GET surfaces below.
//
// The relay gate + ban gate below are copied from
// functions/api/tv/insert.js on purpose: the queue accepts
// exactly what the owner insert accepts — no new sourcing.
import { userFrom, isAdmin, take, json } from "../../../lib/cf.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
// MUST match station.js's TV_QUEUE_V: the keeper ignores a queue
// doc from another generation, the same contract as the insert's.
const TV_QUEUE_V = 1;
// The evidence line itself lives in station.js (TV_QUEUE_EVIDENCE):
// the keeper attaches it to every queued item it lays, exactly as
// the insert's evidence rides its doc.
const MAX_ITEMS = 500;

async function ownerOnly(request, env) {
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return { err: json({ ok: false, error: "sign_in" }, 401) };
  if (!(await isAdmin(env, me.id).catch(() => false)) || String(me.id) !== OWNER_ID) return { err: json({ ok: false, error: "owner_only" }, 403) };
  return { me };
}

async function ytBanned(env, id) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("brain/ytblock").first();
    if (!row || !row.data) return false;
    const doc = JSON.parse(row.data);
    return !!(doc && Array.isArray(doc.ids) && doc.ids.includes(id));
  } catch (_) { return false; }
}

/* Asks the site's own search relay (/api/ytsearch — the deployed
 * search route) about this exact video id under its title. The
 * answer is a PIN ONLY: when the id comes back, the relay's own
 * duration/title beat the client's copies. Absence NEVER
 * convicts (QUEUEFIX, 2026-11-03 late): the relay fans out over
 * rotating mirrors, so a re-search by title is a different
 * search on possibly a different mirror — live probing on
 * 2026-11-03 found 3 of 24 ordinary full-movie picks ABSENT
 * from their own title re-search minutes after the relay itself
 * served them, and every absence read to the owner as "pick
 * another" (Malik, 2026-11-03 19:57 ET: "It keeps telling me to
 * pick another"). The hard refusal is the learned-ban list
 * above — ids a real player already convicted. A pick that
 * truly cannot play is caught by the channel player's own
 * error path and joins that list: the designed learning loop.
 * Anything else (relay missing, network hiccup, empty scrape,
 * id absent) fails open and the pick proceeds unpinned. */
async function relayGate(request, id, title) {
  try {
    const u = new URL("/api/ytsearch", request.url);
    u.searchParams.set("q", title);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(u.toString(), { signal: ctl.signal, headers: { accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || j.ok === false || !Array.isArray(j.results) || !j.results.length) return null;
    const hit = j.results.find((x) => x && String(x.id) === id);
    if (!hit) return null;
    return { dur: +hit.dur || 0, title: String(hit.title || title || "YouTube video").slice(0, 200) };
  } catch (_) { return null; }
}

async function readQueue(env) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("tv/queue").first();
    if (!row || !row.data) return null;
    const doc = JSON.parse(row.data);
    return doc && typeof doc === "object" ? doc : null;
  } catch (_) { return null; }
}

/* The canonical doc-write shape — the same one station.js's
 * writeDoc and insert.js's writeInsert use: update, insert with
 * created_at when the row is new, and ALWAYS the changes row in
 * the production column set (tbl, path, coll, a, b, at), without
 * which open pages never learn the doc moved. */
async function writeQueue(env, owner, doc) {
  const data = JSON.stringify(doc);
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare(
    "update docs set data = ?, updated_at = ? where path = ?"
  ).bind(data, nowIso, "tv/queue").run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare(
      "insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)"
    ).bind("tv/queue", "tv", owner, data, nowIso, nowIso).run();
  }
  await env.DB.prepare(
    "insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)"
  ).bind("docs", "tv/queue", "tv", null, null, Date.now()).run();
}

/* When does the list's window open if it starts now? The end of
 * the segment currently on air — the list never cuts the piece
 * playing; it takes the channel when that piece ends. */
async function anchorFor(env) {
  const now = Date.now();
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("tv/now").first();
    if (row && row.data) {
      const nw = JSON.parse(row.data);
      if (nw && Array.isArray(nw.segs)) {
        const cur = nw.segs.find((s) => s && now >= +s.start && now < +s.start + (+s.dur || 0) * 1000);
        if (cur) return cur.start + Math.round(cur.dur * 1000);
      }
    }
  } catch (_) {}
  return now;
}

function publicItems(doc) {
  return (doc && Array.isArray(doc.items) ? doc.items : []).map((r) => ({ qid: String(r.qid || ""), yt: String(r.yt || ""), title: String(r.title || ""), dur: +r.dur || 0 }));
}

export async function onRequestGet({ request, env }) {
  const gate = await ownerOnly(request, env);
  if (gate.err) return gate.err;
  if (!(await take(env, "tv-queue-get:" + gate.me.id, 3600, 900))) return json({ ok: false, error: "rate_limited" }, 429);
  const doc = await readQueue(env);
  let skipNote = null;
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("tv/now").first();
    if (row && row.data) { const nw = JSON.parse(row.data); if (nw && nw.qSkipNote && Date.now() - nw.qSkipNote.at < 3600e3) skipNote = { at: nw.qSkipNote.at, note: String(nw.qSkipNote.note || "") }; }
  } catch (_) {}
  const lastRemoved = doc && Array.isArray(doc.removed) && doc.removed.length ? doc.removed[doc.removed.length - 1] : null;
  return json({ ok: true, items: doc && (+doc.progV || 0) >= TV_QUEUE_V ? publicItems(doc) : [], anchor: doc ? +doc.anchor || 0 : 0, skipNote, lastRemoved });
}

export async function onRequestPost({ request, env }) {
  const gate = await ownerOnly(request, env);
  if (gate.err) return gate.err;
  const me = gate.me;
  if (!(await take(env, "tv-queue:" + me.id, 3600, 300))) return json({ ok: false, error: "rate_limited" }, 429);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_body" }, 400);
  const action = String(body.action || "");
  const now = Date.now();
  let doc = await readQueue(env);
  if (!doc || (+doc.progV || 0) < TV_QUEUE_V || !Array.isArray(doc.items)) doc = { progV: TV_QUEUE_V, items: [], anchor: 0, skipAt: 0 };

  if (action === "skip") {
    doc = { ...doc, progV: TV_QUEUE_V, skipAt: now, updatedAt: now, by: "owner-queue" };
    await writeQueue(env, me.id, doc);
    return json({ ok: true, items: publicItems(doc), skipAt: now });
  }

  if (action === "add") {
    const yt = String(body.yt || "").trim();
    let title = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
    let dur = Math.round(+body.dur || 0);
    if (!/^[A-Za-z0-9_-]{11}$/.test(yt) || !title) return json({ ok: false, error: "bad_video" }, 400);
    if (doc.items.length >= MAX_ITEMS) return json({ ok: false, error: "queue_full" }, 422);
    if (await ytBanned(env, yt)) return json({ ok: false, error: "not_playable" }, 422);
    const gate2 = await relayGate(request, yt, title);
    if (gate2) { if (gate2.dur > 0) dur = gate2.dur; if (gate2.title) title = gate2.title; }
    // The duration range judges the EFFECTIVE duration — after
    // the relay pin — so a result the relay served with a zero
    // or garbled client-side runtime is rescued by the relay's
    // own number instead of refused.
    if (!(dur >= 15 && dur <= 21600)) return json({ ok: false, error: "bad_duration" }, 400);
    const qid = now.toString(36) + Math.floor(Math.random() * 46656).toString(36);
    const items = [...doc.items, { qid, yt, title, dur, at: now }];
    // First item on an empty list opens the window at the end of
    // the piece on air; appending to a live list keeps its anchor.
    const anchor = items.length === 1 || !(+doc.anchor > 0) ? await anchorFor(env) : +doc.anchor;
    doc = { ...doc, progV: TV_QUEUE_V, items, anchor, updatedAt: now, by: "owner-queue" };
    await writeQueue(env, me.id, doc);
    return json({ ok: true, items: publicItems(doc), qid, title, dur });
  }

  if (action === "remove") {
    const qid = String(body.qid || "");
    if (!qid) return json({ ok: false, error: "bad_item" }, 400);
    const items = doc.items.filter((r) => String(r && r.qid) !== qid);
    doc = { ...doc, progV: TV_QUEUE_V, items, anchor: items.length ? doc.anchor : 0, updatedAt: now, by: "owner-queue" };
    await writeQueue(env, me.id, doc);
    return json({ ok: true, items: publicItems(doc) });
  }

  if (action === "move") {
    const qid = String(body.qid || "");
    const dir = +body.dir < 0 ? -1 : 1;
    const ix = doc.items.findIndex((r) => String(r && r.qid) === qid);
    if (ix < 0) return json({ ok: false, error: "bad_item" }, 400);
    const jx = ix + dir;
    if (jx >= 0 && jx < doc.items.length) { const items = [...doc.items]; const tmp = items[ix]; items[ix] = items[jx]; items[jx] = tmp; doc = { ...doc, items }; }
    doc = { ...doc, progV: TV_QUEUE_V, updatedAt: now, by: "owner-queue" };
    await writeQueue(env, me.id, doc);
    return json({ ok: true, items: publicItems(doc) });
  }

  if (action === "clear") {
    doc = { ...doc, progV: TV_QUEUE_V, items: [], anchor: 0, updatedAt: now, by: "owner-queue" };
    await writeQueue(env, me.id, doc);
    return json({ ok: true, items: [] });
  }

  return json({ ok: false, error: "bad_action" }, 400);
}
