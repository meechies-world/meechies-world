/* /api/tv/vote — MW TV viewer voting (Malik, 2026-11-03 19:11 ET:
 * "Make it so people can vote if they like what their watching",
 * plus 19:13 ET: "If 5 people vote no i want it to get skipped.")
 *
 *   GET  ?id=<program id>&start=<segment start ms>&g=<guest token>
 *     → { ok, mine, up, down, total, countsVisible } for ONE aired
 *       segment instance (key = program id + segment start, so a
 *       vote always lands on the program it was cast on).
 *   POST { id, start, vote: 1 | -1 | 0, g }
 *     vote 1 = 👍, -1 = 👎, 0 = clear. Tapping the other side
 *     changes the vote; the server adjusts the tallies. One vote
 *     per person per program instance, enforced HERE: members by
 *     session uid, guests by the device token the client keeps in
 *     localStorage ("mw-vid", the site's mw-* device-key pattern).
 *
 * Storage: ONE doc, tv/votes (coll "tv"):
 *   { v: 1, updatedAt,
 *     inst: { "<id>@<start>": { id, yt, title, up, down,
 *             voters: { "u:<uid>" | "g:<token>": 1 | -1 }, lastAt } },
 *     skips: [ { at, id, title, segStart, downs } ] }
 * The keeper (functions/api/station.js) reads the tallies every
 * tick: net likes weight the break-pool bag, and 5 distinct 👎 on
 * the CURRENT pool segment write a tv/skip request that the
 * keeper's single advance path executes (protected classes —
 * news, premiere, rerun, owner queue — never crowd-skipped; the
 * gate lives in the keeper, tvSkipGate).
 *
 * Display law (Malik's Meechie's Book like-count rule, extended to
 * TV by his standing law): totals under TV_VOTE_PUBLIC_MIN stay
 * hidden from the public; the OWNER always gets the true tally.
 * Malik can flip the threshold with one word — it is this one
 * constant, mirrored in the keeper's report.
 */
import { userFrom, isAdmin, take, json } from "../../../lib/cf.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
export const TV_VOTE_PUBLIC_MIN = 25;  // counts under this total stay hidden publicly
export const TV_CROWD_SKIP_DOWN = 5;   // Malik: "If 5 people vote no i want it to get skipped"
const INST_KEEP_MS = 30 * 86400e3;     // per-instance records prune after 30 days
const INST_CAP = 400;                  // hard cap on stored instances (oldest pruned first)
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const GUEST_RE = /^[A-Za-z0-9_-]{8,64}$/;

const clampStr = (v, n) => String(v == null ? "" : v).slice(0, n);

async function readDoc(env, path) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
    if (row && row.data) { const d = JSON.parse(row.data); if (d && typeof d === "object") return d; }
  } catch (_) {}
  return null;
}

/* Same write shape as functions/api/tv/insert.js writeInsert:
 * update the row, insert if missing, ALWAYS land the changes row. */
async function writeDocAs(env, owner, path, coll, doc) {
  const nowIso = new Date().toISOString();
  const data = JSON.stringify(doc);
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, owner, data, nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, coll, null, null, Date.now()).run();
}

/* Who is voting: a session wins (member, keyed by uid); otherwise
 * the guest device token. The owner flag rides along for the
 * tally display law. */
async function voterOf(request, env, guestTok) {
  const me = await userFrom(request, env).catch(() => null);
  if (me && me.id) {
    const owner = me.id === OWNER_ID && (await isAdmin(env, me.id).catch(() => false));
    return { key: "u:" + me.id, owner: !!owner, uid: me.id };
  }
  const g = clampStr(guestTok, 64);
  if (GUEST_RE.test(g)) return { key: "g:" + g, owner: false, uid: "" };
  return null;
}

export const tvVoteInstKey = (id, start) => id + "@" + start;

/* The vote math, pure and exported for the harness: apply one
 * voter's vote (1 | -1 | 0) to the doc's instance record, creating
 * it from meta on first touch. Counts move ONLY on a real change:
 * set, change-of-side (both tallies move), clear. Repeating the
 * same vote is a no-op — dedupe is structural, because the tally
 * is derived from the per-voter record, never incremented blind. */
export function applyVoteToDoc(doc, instKey, meta, voterKey, vote, now) {
  if (!doc.inst || typeof doc.inst !== "object") doc.inst = {};
  let rec = doc.inst[instKey];
  if (!rec) {
    rec = { id: meta.id, yt: meta.yt || "", title: meta.title || "", up: 0, down: 0, voters: {}, lastAt: now };
    doc.inst[instKey] = rec;
  }
  if (!rec.voters || typeof rec.voters !== "object") rec.voters = {};
  const prev = rec.voters[voterKey] === 1 ? 1 : rec.voters[voterKey] === -1 ? -1 : 0;
  if (prev !== vote) {
    if (prev === 1) rec.up = Math.max(0, rec.up - 1);
    if (prev === -1) rec.down = Math.max(0, rec.down - 1);
    if (vote === 1) rec.up += 1;
    if (vote === -1) rec.down += 1;
    if (vote === 0) delete rec.voters[voterKey]; else rec.voters[voterKey] = vote;
    rec.lastAt = now;
  }
  return rec;
}

/* What a caller may see: their own vote always; the counts only
 * when the total reached the public threshold OR the caller is
 * the owner (Malik's like-count law). Pure + exported for the
 * harness. */
export function voteViewFor(doc, instKey, voterKey, isOwner) {
  const rec = doc && doc.inst ? doc.inst[instKey] : null;
  const up = rec ? (rec.up | 0) : 0, down = rec ? (rec.down | 0) : 0;
  const total = up + down;
  const mine = rec && rec.voters && voterKey ? (rec.voters[voterKey] === 1 ? 1 : rec.voters[voterKey] === -1 ? -1 : 0) : 0;
  const visible = !!isOwner || total >= TV_VOTE_PUBLIC_MIN;
  return { mine, up: visible ? up : null, down: visible ? down : null, total: visible ? total : null, countsVisible: visible };
}

/* Keep the doc bounded: stale instances out, oldest first past
 * the cap. Runs on writes only. */
export function pruneVotes(doc, now) {
  if (!doc.inst) return doc;
  const keys = Object.keys(doc.inst);
  for (const k of keys) { const r = doc.inst[k]; if (!r || (now - (+r.lastAt || 0)) > INST_KEEP_MS) delete doc.inst[k]; }
  const left = Object.keys(doc.inst);
  if (left.length > INST_CAP) {
    left.sort((a, b) => (+doc.inst[a].lastAt || 0) - (+doc.inst[b].lastAt || 0));
    for (const k of left.slice(0, left.length - INST_CAP)) delete doc.inst[k];
  }
  if (Array.isArray(doc.skips) && doc.skips.length > 50) doc.skips = doc.skips.slice(-50);
  return doc;
}

const emptyVotes = () => ({ v: 1, inst: {}, skips: [], updatedAt: 0 });

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const u = new URL(request.url);
  const id = clampStr(u.searchParams.get("id") || "", 80);
  const start = Math.round(+u.searchParams.get("start") || 0);
  if (!ID_RE.test(id) || !(start > 0)) return json({ ok: false, error: "bad_key" }, 400);
  const voter = await voterOf(request, env, u.searchParams.get("g") || "");
  const doc = (await readDoc(env, "tv/votes")) || emptyVotes();
  const view = voteViewFor(doc, tvVoteInstKey(id, start), voter ? voter.key : "", voter ? voter.owner : false);
  return json({ ok: true, id, start, ...view });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  let body = null;
  try { body = await request.json(); } catch (_) {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad_body" }, 400);
  const id = clampStr(body.id || "", 80);
  const start = Math.round(+body.start || 0);
  const vote = body.vote === 1 ? 1 : body.vote === -1 ? -1 : body.vote === 0 ? 0 : null;
  if (!ID_RE.test(id) || !(start > 0) || vote === null) return json({ ok: false, error: "bad_vote" }, 400);
  const voter = await voterOf(request, env, body.g || "");
  if (!voter) return json({ ok: false, error: "no_voter" }, 400);
  if (!(await take(env, "tv-vote:" + voter.key, 3600, 240))) return json({ ok: false, error: "rate_limited" }, 429);
  // The segment must be a real aired instance: it has to be in
  // tv/now (the keeper keeps an hour behind and two ahead), and
  // its title/yt come from the segment itself, never the client.
  const nw = await readDoc(env, "tv/now");
  const seg = nw && Array.isArray(nw.segs) ? nw.segs.find((sg) => sg && sg.id === id && +sg.start === start) : null;
  if (!seg) return json({ ok: false, error: "not_on_air" }, 422);
  const now = Date.now();
  const doc = (await readDoc(env, "tv/votes")) || emptyVotes();
  const instKey = tvVoteInstKey(id, start);
  const rec = applyVoteToDoc(doc, instKey, { id, yt: seg.yt || "", title: seg.title || "" }, voter.key, vote, now);
  // Crowd-skip trigger (server-side, evaluated on the write): 5
  // DISTINCT voters down on the segment that is CURRENT right now
  // writes the tv/skip request. Distinct is structural — the down
  // tally counts per-voter records, so duplicates and side-changes
  // can never inflate it. The keeper's gate decides whether this
  // segment's class may be crowd-skipped at all (news / premiere /
  // rerun / owner queue are protected) and its single advance path
  // performs the cut; a request for a segment that has already
  // ended is stale on arrival and the keeper lets it lapse.
  let skip = "";
  const isCurrent = start <= now && now < start + (+seg.dur || 0) * 1000;
  if (isCurrent && rec.down >= TV_CROWD_SKIP_DOWN) {
    const prev = await readDoc(env, "tv/skip");
    const already = prev && !prev.consumedAt && +prev.segStart === start && prev.by === "crowd";
    if (!already) {
      await writeDocAs(env, voter.uid || "guest", "tv/skip", "tv", { at: now, segStart: start, id, title: seg.title || "", by: "crowd", downs: rec.down, updatedAt: now });
      if (!Array.isArray(doc.skips)) doc.skips = [];
      if (!doc.skips.some((s) => s && +s.segStart === start)) doc.skips.push({ at: now, id, title: seg.title || "", segStart: start, downs: rec.down });
    }
    skip = "requested";
  }
  pruneVotes(doc, now);
  doc.updatedAt = now;
  await writeDocAs(env, voter.uid || "guest", "tv/votes", "tv", doc);
  const view = voteViewFor(doc, instKey, voter.key, voter.owner);
  return json({ ok: true, id, start, ...view, skip });
}
