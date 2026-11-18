/* /api/tv/insert — the MW TV owner search "play next" door
 * (Malik, 2026-11-02 ~20:56: "Make it so i can search what i want to
 * play on my tv channel" — owner-only search box, bottom right of
 * the TV screen; the UI half is the tw-search block in js/dj.js).
 *
 *   POST { yt, title, dur }   (owner session Bearer)
 *     Validates the pick through the same embed gate the channel
 *     trusts (the brain/ytblock learned-ban list, plus the
 *     /api/ytsearch relay as a duration pin — pin-only since the
 *     2026-11-03 QUEUEFIX, see relayGate), then REPLACES the
 *     tv/insert doc. The keeper (functions/api/station.js, PR #559)
 *     fires a fresh, unconsumed, cleared tv/insert at the next
 *     segment boundary — so the pick plays NEXT on MW TV for
 *     everyone watching, exactly once.
 *
 * Owner-only, same split as /api/brain/call: no session gets a 401,
 * a member session gets a 403, and the seat must be Malik himself
 * (OWNER_ID) — admins who are not the owner do not hold this door.
 * This endpoint is the only writer of tv/insert besides the
 * keeper's own seed; every write lands its changes row (the house
 * writeDay shape from functions/api/brain/call.js, coll "tv").
 *
 * Keeper contract (read from station.js before building — do not
 * improvise around it):
 *   - The keeper reseeds tv/insert whenever doc.progV < TV_INSERT_V,
 *     so the doc MUST carry progV: TV_INSERT_V (2 when the seed
 *     became a v2 playlist, 2026-11-02 late; 3 since the schedule
 *     build's Comedy Hour seed, PR #587 — this endpoint matches
 *     the keeper's current generation) or it is
 *     overwritten by the seed before it can ever fire. The doc
 *     itself stays the v1 top-level shape on purpose: with no
 *     startAt, the keeper's firing rule stamps the window at the
 *     end of the segment playing right now — "play next".
 *   - tvInsertItems drops any doc with consumedAt set, and tvCleared
 *     requires dur > 0, basis in TV_BASES and a NON-EMPTY evidence
 *     string — basis "embed" + the evidence line below are load
 *     bearing, not decoration.
 *   - A fresh `at` stamp is what makes the keeper fire the doc
 *     (it compares against the window stamped in tv/now); the
 *     consumed doc from an earlier order never blocks a fresh one.
 */
import { userFrom, isAdmin, take, json } from "../../../lib/cf.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
/* MUST match TV_INSERT_V in functions/api/station.js. If the keeper
 * ever bumps its insert generation, bump this in the same build. */
const TV_INSERT_V = 3;
const YT_RE = /^[A-Za-z0-9_-]{11}$/;
const EVIDENCE = "Owner pick from the MW TV owner search box (owner seat only, functions/api/tv/insert.js); passed the site embed gate at order time: /api/ytsearch age/embed relay (id-matched) plus the brain/ytblock learned-ban check";

const clampStr = (v, n) => String(v == null ? "" : v).slice(0, n);

async function ownerOnly(request, env) {
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return { err: json({ ok: false, error: "sign_in" }, 401) };
  if (!(await isAdmin(env, me.id).catch(() => false)) || me.id !== OWNER_ID) return { err: json({ ok: false, error: "owner_only" }, 403) };
  return { me };
}

/* The learned-ban half of the embed gate: brain/ytblock { ids: [...] }
 * holds every id a real player already convicted (see the header of
 * functions/api/ytsearch.js). A read failure resolves to "not banned"
 * (fail open, the same rule as the relay's own filter) — a broken
 * read must never lock the owner out of his own channel. */
async function ytBanned(env, yt) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("brain/ytblock").first();
    if (row && row.data) { const d = JSON.parse(row.data); if (d && Array.isArray(d.ids)) return d.ids.includes(yt); }
  } catch (_) {}
  return false;
}

/* The relay half of the embed gate, PIN-ONLY since the QUEUEFIX
 * (2026-11-03 late): ask the site's own /api/ytsearch for the
 * title, and when the picked id comes back in its playability-
 * filtered results, the relay's own duration pins the pick.
 * Absence NO LONGER convicts. The old rule — answers ok with
 * results and the id not among them, refuse the order — treated
 * a re-search as the same search, but the relay fans out over
 * rotating mirrors: a re-search by title is a different search
 * on possibly a different mirror. Live probing on 2026-11-03
 * found 3 of 24 ordinary full-movie picks absent from their own
 * title re-search minutes after the relay itself had served
 * them, and every absence read to the owner as "pick another"
 * (Malik, 2026-11-03 19:57 ET: "It keeps telling me to pick
 * another"). The hard refusal is the learned-ban list above —
 * ids a real player already convicted; a pick that truly
 * cannot play is caught by the channel player's own error path
 * and joins that list, the designed learning loop. The pick on
 * the owner's screen also came out of this same relay seconds
 * earlier, already playability-filtered there.
 * Returns the relay's own duration for the id when it answered
 * with the id present, 0 when it could not speak to it. */
async function relayGate(request, yt, title) {
  try {
    const u = new URL("/api/ytsearch", request.url);
    u.searchParams.set("q", title);
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(12000) });
    const j = await r.json().catch(() => null);
    if (j && j.ok && Array.isArray(j.results) && j.results.length) {
      const hit = j.results.find((x) => x && x.id === yt);
      if (hit) return Math.round(+hit.dur || 0);
    }
  } catch (_) {}
  return 0;
}

/* Same write shape as lib/brain-member.js writeMember via
 * functions/api/brain/call.js writeDay: update the row, insert if
 * missing, and ALWAYS land the changes row with the doc write. */
async function writeInsert(env, owner, doc) {
  const nowIso = new Date().toISOString();
  const data = JSON.stringify(doc);
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, "tv/insert").run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind("tv/insert", "tv", owner, data, nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", "tv/insert", "tv", null, null, Date.now()).run();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const gate = await ownerOnly(request, env);
  if (gate.err) return gate.err;
  const me = gate.me;
  // 60 an hour: generous for one owner programming his channel, a
  // wall against a runaway client.
  if (!(await take(env, "tv-insert:" + me.id, 3600, 60))) return json({ ok: false, error: "rate_limited" }, 429);
  let body = null;
  try { body = await request.json(); } catch (_) {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad_body" }, 400);
  const yt = String(body.yt || "");
  if (!YT_RE.test(yt)) return json({ ok: false, error: "bad_video" }, 400);
  const title = clampStr(body.title, 200).trim();
  if (!title) return json({ ok: false, error: "bad_title" }, 400);
  let dur = Math.round(+body.dur || 0);
  if (await ytBanned(env, yt)) return json({ ok: false, error: "blocked" }, 422);
  const relayDur = await relayGate(request, yt, title);
  if (relayDur >= 15 && relayDur <= 21600) dur = relayDur; // the relay's own pin beats the client's copy
  // The range judges the EFFECTIVE duration — after the relay
  // pin — so a zero/garbled client runtime is rescued by the
  // relay's own number instead of refused (QUEUEFIX).
  if (!(dur >= 15 && dur <= 21600)) return json({ ok: false, error: "bad_dur" }, 400);
  const now = Date.now();
  const doc = { progV: TV_INSERT_V, at: now, kind: "yt", yt, title, dur, basis: "embed", show: "MW TV", evidence: EVIDENCE, by: "owner-search", updatedAt: now };
  await writeInsert(env, me.id, doc);
  return json({ ok: true, yt, title, dur, at: now });
}
