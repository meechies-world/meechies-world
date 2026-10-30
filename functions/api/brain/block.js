/* Learned YouTube bans (fix-search-filter-3): when a video errors in
 * a deck (101/150 — age-gated or embed-blocked), the booth's
 * ageMarkLocked() already records the id on that device; this
 * endpoint is where the booth shares the verdict with the whole
 * site. The ids collect in the brain/ytblock doc, and the search
 * relay (functions/api/ytsearch.js) drops them from booth search
 * results for every device, deterministically — the learned half of
 * the two-layer conviction described in that file's header (the
 * probabilistic gate-error pre-check there still fires whenever the
 * upstream companions cooperate; this list needs no one's mood).
 *
 * Signed-in members only, copied from the brain event endpoint next
 * door: a stranger with no session gets a 401 and nothing is
 * written. The doc write is the house shape — the same
 * update-or-insert plus a changes row as the keeper's writeDoc in
 * station.js and the taste fold writer in lib/brain-taste.js —
 * because without the changes row the sync feed never sees the doc.
 * Idempotent by construction: re-posting an id that is already
 * banned changes nothing (not even a write) and still answers ok. */
import { userFrom, json } from "../../../lib/cf.js";

const BLOCK_PATH = "brain/ytblock";
const BLOCK_CAP = 1000; // FIFO: past this many bans, the oldest fall off
const ID_SHAPE = /^[A-Za-z0-9_-]{6,20}$/; // the YouTube id alphabet, plausible id lengths

async function readBlock(env) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(BLOCK_PATH).first();
  if (!row) return null;
  try {
    const d = JSON.parse(row.data);
    return d && Array.isArray(d.ids) ? { ids: d.ids.filter((x) => typeof x === "string") } : { ids: [] };
  } catch (_) { return { ids: [] }; }
}

/* Same write shape as writeDoc / writeTaste: update the row, insert
 * if it was missing, and ALWAYS land the changes row. */
async function writeBlock(env, doc) {
  const nowIso = new Date().toISOString();
  const data = JSON.stringify(doc);
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, BLOCK_PATH).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(BLOCK_PATH, "brain", null, data, nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", BLOCK_PATH, "brain", null, null, Date.now()).run();
}

/* Append one id to the ban doc: deduped, FIFO-capped. Returns true
 * when the doc actually changed (a fresh ban worth writing), false
 * when the id was already in and the post is a no-op. */
export function appendBlockId(doc, id) {
  if (doc.ids.includes(id)) return false;
  doc.ids.push(id);
  while (doc.ids.length > BLOCK_CAP) doc.ids.shift();
  return true;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return json({ ok: false, error: "sign_in" }, 401);
  let b = null; try { b = await request.json(); } catch (_) {}
  const id = b && typeof b.id === "string" ? b.id.trim() : "";
  if (!ID_SHAPE.test(id)) return json({ ok: false, error: "bad_id" }, 400);
  try {
    const doc = (await readBlock(env)) || { ids: [] };
    if (!appendBlockId(doc, id)) return json({ ok: true }); // already banned: nothing changes
    await writeBlock(env, doc);
    return json({ ok: true });
  } catch (_) {
    return json({ ok: false, error: "write_failed" }, 500);
  }
}
