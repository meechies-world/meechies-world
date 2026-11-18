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
// QUEUECHECK (2026-11-03 20:57 ET): Malik: "Check the videos
// when they get qued and remove them if they not able to be
// played" — said minutes after the Guardian flagged a title IN
// his queue (KZL8Hitn9RA) as geo-blocked for US viewers while it
// occupied the channel. So the playability check now runs AT ADD
// TIME, in this door: a pick the shared scanner evidence convicts
// never enters the list (see queuePlayability below — the SAME
// strongCheck + verdict cache the /api/ytsearch relay's verify
// phase runs, imported from lib/ytverify.js; no second checker).
// A convicted add is refused with the same not_playable the
// can't-play list returns, and the refusal is recorded on the
// doc exactly like the at-turn self-remove (PR #642) records
// one — a removed[] entry { qid, yt, title, at, why: "couldn't
// play" } — so GET's lastRemoved paints "🗑 Removed — couldn't
// play: <title>" on the owner's next refresh. A REGION
// conviction is ban-class: the id also joins brain/ytblock,
// same as #642's removals. An INCONCLUSIVE check (bare
// UNPLAYABLE, bot wall, timeout) never refuses: the pick queues
// and the at-turn self-remove stays the backstop, unchanged.
// Plus a one-time SWEEP of the stored list (queueSweep below):
// items already sitting in tv/queue when this shipped are
// checked under the same standard, in bounded slices on the
// door's own traffic, and the convicted ones are removed with
// the same record. Every removal (at-add or sweep) is logged
// through handsLog to brain/selflog as kind "queue-remove" with
// when: "at-add" | "sweep" — the same log the keeper's Guardian
// queue-remove writes (action "tv.guardian.queue-remove").
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
import { makePlayability } from "../../../lib/ytverify.js";
import { handsLog } from "../../../lib/meechie-hands.js";

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

/* ---------- QUEUECHECK: the add-time playability check ----------
 * The verdict comes from lib/ytverify.js — the scanner's own
 * strongCheck code path, shared with the search relay, so a
 * video is judged here by exactly the evidence that
 * hides it in the owner's search results: region list without
 * the US, a country-block subreason, LOGIN_REQUIRED / age
 * wording, playableInEmbed === false, oEmbed 400/401/403/404,
 * gone/private wording. Anything else is inconclusive and the
 * pick QUEUES (unprovable = kept). The one net the door does
 * not re-run is the relay's Invidious gate-error pass: it needs
 * the relay's mirror pool, its convictions are age-class only,
 * and any age gate it alone would catch still faces the player
 * at its turn (the #642 self-remove) and the learned ban list. */
// This door's own playability judge, from the shared code path:
// the same strongCheck the relay's verify phase runs (each door
// keeps its own verdict-cache instance, as the relay always has).
const { strongCheck, cachedVerdict, cacheVerdict } = makePlayability();
const QC_CHECK_MS = 2500;

async function queuePlayability(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ""))) return { v: "", why: "" };
  const c = cachedVerdict(id);
  if (c) return { v: c.v, why: c.why || "" };
  let s = null;
  try { s = await strongCheck(id, QC_CHECK_MS); } catch (_) { s = null; }
  if (s && s.v) { cacheVerdict(id, s.v, s.why); return { v: s.v, why: s.why || "" }; }
  return { v: "", why: "" };
}

/* Generic doc read/write in writeQueue's canonical shape, for
 * the side doc this door now touches (brain/ytblock). */
async function readDocRow(env, path) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
    if (!row || !row.data) return null;
    const doc = JSON.parse(row.data);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch (_) { return null; }
}

async function writeDocRow(env, owner, path, coll, doc) {
  const data = JSON.stringify(doc);
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare(
    "update docs set data = ?, updated_at = ? where path = ?"
  ).bind(data, nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare(
      "insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)"
    ).bind(path, coll, owner, data, nowIso, nowIso).run();
  }
  await env.DB.prepare(
    "insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)"
  ).bind("docs", path, coll, null, null, Date.now()).run();
}

/* Ban-class (region) convictions join the shared ban list, the
 * same write the keeper's ban gate and #642's removals make. */
async function ytBlockAdd(env, owner, id) {
  try {
    const doc = (await readDocRow(env, "brain/ytblock")) || { ids: [] };
    const ids = Array.isArray(doc.ids) ? doc.ids.map(String) : [];
    if (ids.includes(id)) return;
    ids.push(id);
    await writeDocRow(env, owner, "brain/ytblock", "brain", { ...doc, ids });
  } catch (_) {}
}

/* The removal record — byte-for-byte the shape #642's at-turn
 * self-remove and the ban gate leave on this doc, so GET's
 * lastRemoved and the owner paint treat every removal alike. */
function removalEntry(qid, yt, title, now) {
  return { qid: String(qid || ""), yt: String(yt || ""), title: String(title || ""), at: now, why: "couldn't play" };
}
function withRemoval(doc, entry) {
  return { ...doc, removed: [...(Array.isArray(doc.removed) ? doc.removed : []), entry].slice(-10) };
}

/* Every queue-check removal is logged to brain/selflog through
 * handsLog — the same function, action and kind the keeper's
 * Guardian uses for its at-turn queue-remove (tvGuardLog in
 * station.js) — with `when` saying which door path fired. The
 * log must never break the door: handsLog swallows its own
 * errors, and this wrapper swallows the rest. */
async function queueRemoveLog(env, when, yt, title, why) {
  const kindWord = why === "region" ? "region-blocked for US viewers"
    : why === "age" ? "age-gated (sign-in required)"
    : why === "gone" ? "removed or private on YouTube"
    : "embed-blocked";
  try {
    await handsLog(env, {
      action: "tv.guardian.queue-remove",
      kind: "queue-remove",
      when,
      target: "tv/queue",
      yt: String(yt || ""),
      title: String(title || "").slice(0, 120),
      summary: (when === "at-add" ? "QUEUE CHECK (at add): " : "QUEUE CHECK (one-time sweep): ")
        + "owner-queue video \u201C" + String(title || yt || "").slice(0, 80) + "\u201D (" + String(yt || "") + ") was convicted "
        + kindWord + " by YouTube's own player evidence (the shared scanner standard, lib/ytverify.js) and "
        + (when === "at-add" ? "was refused at the queue door — it never entered the list" : "was removed from the stored queue")
        + " (reason recorded on tv/queue: couldn't play"
        + (why === "region" ? "; ban-class, so its video id joined brain/ytblock" : "")
        + "). Malik's order 2026-11-03 20:57 ET: check the videos when they get queued and remove them if they are not able to be played. A bare probe or an inconclusive check never removes — the at-turn self-remove (Guardian seats / ban gate) remains the backstop. Malik can re-add it any time; it is checked again on the way in.",
      by: "queue-door",
      role: "system",
    });
  } catch (_) {}
}

/* ---------- QUEUECHECK: the one-time sweep ----------
 * Guarded by the doc itself: checkSweepV is this build's sweep
 * generation; until it is stamped, the door's own traffic (the
 * owner box polls GET and posts its actions here) works through
 * the stored list BACKWARD from the tail in slices of
 * QC_SWEEP_SLICE, so no unprocessed index ever shifts under the
 * cursor: each slice checks the window [cursor-12, cursor),
 * removes the convicted from it, and the cursor lands on the
 * window's start. Checks run in waves of 4 — the scanner's
 * discipline (a wide stampede of player POSTs starves itself).
 * Items that don't convict stay untouched, in order. The sweep
 * writes only through writeQueue, and only when a slice moved
 * the cursor or removed something. */
const QC_SWEEP_V = 1;
const QC_SWEEP_SLICE = 12;

async function queueSweep(env, owner, doc, now) {
  if (!doc || (+doc.checkSweepV || 0) >= QC_SWEEP_V || !Array.isArray(doc.items)) return { doc, changed: false };
  const items = doc.items;
  let cursor = Number.isInteger(doc.qcSweepIx) ? doc.qcSweepIx : items.length;
  if (cursor > items.length) cursor = items.length;
  if (cursor <= 0) {
    const done = { ...doc, checkSweepV: QC_SWEEP_V };
    delete done.qcSweepIx;
    return { doc: done, changed: true };
  }
  const start = Math.max(0, cursor - QC_SWEEP_SLICE);
  const win = items.slice(start, cursor);
  const verdicts = new Array(win.length);
  for (let i = 0; i < win.length; i += 4) {
    const part = await Promise.all(win.slice(i, i + 4).map((r) => queuePlayability(String((r && r.yt) || ""))));
    part.forEach((v, k) => { verdicts[i + k] = v; });
  }
  const dead = [];
  win.forEach((r, k) => { if (verdicts[k] && verdicts[k].v === "bad") dead.push({ r, why: verdicts[k].why }); });
  if (!dead.length) {
    if (start === 0) {
      const done = { ...doc, checkSweepV: QC_SWEEP_V };
      delete done.qcSweepIx;
      return { doc: done, changed: true };
    }
    return { doc: { ...doc, qcSweepIx: start }, changed: true };
  }
  const deadSet = new Set(dead.map((d) => d.r));
  const keptWin = win.filter((r) => !deadSet.has(r));
  const entries = dead.map((d) => removalEntry(d.r && d.r.qid, d.r && d.r.yt, d.r && d.r.title, now));
  let out = { ...doc, items: [...items.slice(0, start), ...keptWin, ...items.slice(cursor)], updatedAt: now, by: "owner-queue" };
  for (const e of entries) out = withRemoval(out, e);
  if (!out.items.length) out.anchor = 0;
  if (start === 0) { out.checkSweepV = QC_SWEEP_V; delete out.qcSweepIx; }
  else out.qcSweepIx = start;
  for (const d of dead) {
    if (d.why === "region") await ytBlockAdd(env, owner, String(d.r.yt || ""));
    await queueRemoveLog(env, "sweep", String((d.r && d.r.yt) || ""), String((d.r && d.r.title) || ""), d.why);
  }
  return { doc: out, changed: true };
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

const MEM_TAKES = new Map();
function memTake(key, windowSec, max) {
  const now = Date.now(), from = now - windowSec * 1000;
  const list = (MEM_TAKES.get(key) || []).filter((t) => t > from);
  if (list.length >= max) { MEM_TAKES.set(key, list); return false; }
  list.push(now); MEM_TAKES.set(key, list);
  if (MEM_TAKES.size > 200) MEM_TAKES.clear();
  return true;
}

function publicItems(doc) {
  return (doc && Array.isArray(doc.items) ? doc.items : []).map((r) => ({ qid: String(r.qid || ""), yt: String(r.yt || ""), title: String(r.title || ""), dur: +r.dur || 0 }));
}

export async function onRequestGet({ request, env }) {
  const gate = await ownerOnly(request, env);
  if (gate.err) return gate.err;
  /* D1 WRITE FIX (owner, 2026-11-11 "find out why my cloudflare ran out"): this
     owner-only poll logged a row in the usage table on every call -- 1,982
     writes (plus their index entries) in one day from the owner box alone, a
     real share of the 100,000 daily write wall that locked sign-in. The gate
     above already limits the route to the owner, so the cap is now counted in
     memory per isolate: same 900/hour ceiling, zero database writes. */
  if (!memTake("tv-queue-get:" + gate.me.id, 3600, 900)) return json({ ok: false, error: "rate_limited" }, 429);
  let doc = await readQueue(env);
  // QUEUECHECK sweep: the owner box polls this GET, so the
  // one-time sweep of the stored list rides it (bounded slices;
  // a no-op once the doc carries the sweep stamp).
  if (doc && (+doc.progV || 0) >= TV_QUEUE_V) {
    const sw = await queueSweep(env, gate.me.id, doc, Date.now());
    if (sw.changed) { doc = sw.doc; try { await writeQueue(env, gate.me.id, doc); } catch (_) {} }
  }
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
  // QUEUECHECK sweep: one bounded slice over the stored list
  // before the action runs; the action's own write below
  // persists it (every action writes). A no-op once stamped.
  { const sw = await queueSweep(env, me.id, doc, now); doc = sw.doc; }

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
    // QUEUECHECK (2026-11-03 20:57 ET): the add-time playability
    // check — the shared scanner evidence (queuePlayability).
    // Convicted: the pick never enters the list. The refusal is
    // recorded on the doc exactly like an at-turn self-removal
    // (removed[] entry, so GET's lastRemoved paints why), a
    // region conviction also joins brain/ytblock, the removal
    // is logged (kind "queue-remove", when "at-add"), and the
    // answer is the same not_playable the can't-play list gives.
    // Inconclusive: the pick queues — the check NEVER refuses on
    // a bare probe, and the at-turn self-remove stays behind it.
    const verdict = await queuePlayability(yt);
    if (verdict.v === "bad") {
      const qid = now.toString(36) + Math.floor(Math.random() * 46656).toString(36);
      const entry = removalEntry(qid, yt, title, now);
      doc = { ...withRemoval(doc, entry), progV: TV_QUEUE_V, updatedAt: now, by: "owner-queue" };
      await writeQueue(env, me.id, doc);
      if (verdict.why === "region") await ytBlockAdd(env, me.id, yt);
      await queueRemoveLog(env, "at-add", yt, title, verdict.why);
      return json({ ok: false, error: "not_playable", removed: entry, lastRemoved: entry }, 422);
    }
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
