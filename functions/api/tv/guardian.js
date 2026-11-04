/* /api/tv/guardian — MW TV GUARDIAN intake (Malik, 2026-11-03
 * 19:51 ET: "put a bot that watches the tv chanel for meechie to
 * fix it"; 19:56 ET: "Give meechie eyes" + the quality mandate:
 * MW TV must be THE BEST CHANNEL IN THE WORLD — zero tolerance
 * for dead air, dead titles, stuck or looping segments).
 *
 * This endpoint is the Guardian's mailbox. Three doors:
 *
 *   POST { kind: "fault", id, start, err, fkind, g }
 *     A seat that is actually watching MW TV reports that the
 *     segment on air hit a hard player error (the dj.js channel
 *     surface files these itself when its YouTube/file player
 *     errors; the Guardian's own watcher seat files them too).
 *     Reports land in the tv/guardian doc keyed by segment
 *     instance (id + start, the vote system's keying), one record
 *     per seat — dedupe is structural, per-seat, never blind
 *     increments. THE KEEPER is the only hand: it reads this doc
 *     every tick, and when a segment is CONFIRMED unplayable
 *     (≥ TV_GUARD_CONFIRM_SEATS distinct seats with hard errors)
 *     it acts under the rails in station.js (tvGuardianPass):
 *     advance only unprotected classes through tvAdvanceChannel,
 *     quarantine a title on its 2nd confirmed-dead airing.
 *     Nothing in this file advances, holds or bans anything.
 *
 *   POST { kind: "eyes", id, start, src, read: {...}, g }
 *     MEECHIE EYES: a vision read of one sampled frame of what
 *     actually aired, filed by the Guardian cron's watcher seat
 *     (a screenshot of the real viewer view) or by the cron's
 *     ffmpeg sampling of the station's OWN produced media
 *     (src "ffmpeg"). Fields are bounded plain-text observations
 *     — setting, people, wardrobe, exact on-screen text, colors,
 *     objects, visible faults. The keeper folds them into
 *     brain/tvwatch where Meechie's nightly self-review maintains
 *     the channel LOOK-BOOK. Honest limits: these are sampled
 *     snapshots filed by a watcher, not continuous video
 *     comprehension, and they are stored labelled unverified
 *     observations (seg must be a real laid instance in tv/now).
 *
 *   GET → the owner reads the whole Guardian state (faults,
 *     strikes, eyes queue, log tail, health counters). Owner only.
 *
 * Storage: ONE doc, tv/guardian (coll "tv"):
 *   { v: 1, updatedAt,
 *     faults: { "<id>@<start>": { id, yt, title, seats:
 *               { "u:<uid>" | "g:<token>": { err, fkind, at } },
 *               firstAt, lastAt } },
 *     strikes: { "<yt>": { title, segs: [<start>...], at } },
 *     eyes: [ { at, segKey, id, title, src, read } ],
 *     log: [ { at, kind, ... } ],
 *     health: { advances, quarantines, refusals, holes,
 *               lastFaultAt, lastAdvanceAt, lastQuarantineAt } }
 */
import { userFrom, isAdmin, take, json } from "../../../lib/cf.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
export const TV_GUARD_CONFIRM_SEATS = 2;   // distinct seats with hard errors = CONFIRMED unplayable
export const TV_GUARD_HARD_ERRS = [100, 101, 150, 5]; // YT: not found / embed forbidden (101+150) / HTML5 error
const FAULT_KEEP_MS = 6 * 3600e3;          // fault records prune 6h after last report
const FAULT_CAP = 120;                     // hard cap on stored fault instances
const EYES_CAP = 60;                       // pending eyes reads the keeper folds into brain/tvwatch
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

/* Same write shape as functions/api/tv/vote.js writeDocAs:
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

/* Who is reporting: a session wins (member, keyed by uid);
 * otherwise the guest device token (the "mw-vid" pattern the
 * vote endpoint uses). The Guardian's watcher seats are guests. */
async function seatOf(request, env, guestTok) {
  const me = await userFrom(request, env).catch(() => null);
  if (me && me.id) {
    const owner = me.id === OWNER_ID && (await isAdmin(env, me.id).catch(() => false));
    return { key: "u:" + me.id, owner: !!owner, uid: me.id };
  }
  const g = clampStr(guestTok, 64);
  if (GUEST_RE.test(g)) return { key: "g:" + g, owner: false, uid: "" };
  return null;
}

export const emptyGuardian = () => ({ v: 1, faults: {}, strikes: {}, eyes: [], log: [], health: { advances: 0, quarantines: 0, refusals: 0, holes: 0, lastFaultAt: 0, lastAdvanceAt: 0, lastQuarantineAt: 0 }, updatedAt: 0 });

/* Is this report a HARD error — the class that can confirm a
 * segment unplayable? YouTube embed errors 101/150 (embedding
 * disabled / geo-blocked owner restrictions surface as these),
 * 100 (video not found / removed / private) and 5 (HTML5 player
 * failure) are deterministic: every seat gets them. File-player
 * errors count too (a missing/dead media file fails everywhere).
 * Anything else (generic/unknown codes) is recorded but never
 * confirms — one viewer's network is not the channel's fault. */
export function tvGuardHardReport(rep) {
  if (!rep) return false;
  if (rep.fkind === "file-error") return true;
  return TV_GUARD_HARD_ERRS.includes(+rep.err || 0);
}

/* Distinct seats with HARD reports on one fault record — the
 * confirmation count the keeper acts on. Pure + exported for
 * the harness. */
export function tvGuardHardSeats(faultRec) {
  if (!faultRec || !faultRec.seats || typeof faultRec.seats !== "object") return 0;
  let n = 0;
  for (const k of Object.keys(faultRec.seats)) if (tvGuardHardReport(faultRec.seats[k])) n++;
  return n;
}

/* Apply one seat's fault report to the doc. Structural dedupe:
 * one record per seat per instance; a repeat from the same seat
 * refreshes its own record, never double-counts. Pure +
 * exported for the harness. */
export function applyFaultToDoc(doc, instKey, meta, seatKey, rep, now) {
  if (!doc.faults || typeof doc.faults !== "object") doc.faults = {};
  let rec = doc.faults[instKey];
  if (!rec) {
    rec = { id: meta.id, yt: meta.yt || "", title: meta.title || "", seats: {}, firstAt: now, lastAt: now };
    doc.faults[instKey] = rec;
  }
  if (!rec.seats || typeof rec.seats !== "object") rec.seats = {};
  rec.seats[seatKey] = { err: +rep.err || 0, fkind: clampStr(rep.fkind || "", 20), at: now };
  rec.lastAt = now;
  if (!doc.health || typeof doc.health !== "object") doc.health = emptyGuardian().health;
  doc.health.lastFaultAt = now;
  return rec;
}

/* Bounded eyes read: six plain-text observation fields, each
 * capped; anything missing becomes "". A read with NO content
 * at all is refused — an empty description is an invented one
 * waiting to happen; a failed vision read must be logged as a
 * miss by the filer, never filed blank. */
export function cleanEyesRead(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = (v) => clampStr(v == null ? "" : String(v).replace(/\s+/g, " ").trim(), 220);
  const read = {
    setting: f(raw.setting), people: f(raw.people), wardrobe: f(raw.wardrobe),
    screenText: f(raw.screenText), colors: f(raw.colors), objects: f(raw.objects),
    faults: f(raw.faults),
  };
  return Object.values(read).some((s) => s.length >= 3) ? read : null;
}

/* Keep the doc bounded: stale faults out, oldest first past the
 * cap, eyes queue and log trimmed. Runs on writes only. */
export function pruneGuardian(doc, now) {
  if (doc.faults && typeof doc.faults === "object") {
    const keys = Object.keys(doc.faults);
    for (const k of keys) { const r = doc.faults[k]; if (!r || (now - (+r.lastAt || 0)) > FAULT_KEEP_MS) delete doc.faults[k]; }
    const left = Object.keys(doc.faults);
    if (left.length > FAULT_CAP) {
      left.sort((a, b) => (+doc.faults[a].lastAt || 0) - (+doc.faults[b].lastAt || 0));
      for (const k of left.slice(0, left.length - FAULT_CAP)) delete doc.faults[k];
    }
  }
  if (Array.isArray(doc.eyes) && doc.eyes.length > EYES_CAP) doc.eyes = doc.eyes.slice(-EYES_CAP);
  if (Array.isArray(doc.log) && doc.log.length > 120) doc.log = doc.log.slice(-120);
  return doc;
}

/* The segment instance must be real: laid in tv/now (the keeper
 * keeps the recent past and ~2h ahead). Title/yt always come
 * from the segment itself, never the client. Faults must name
 * the segment on air NOW or the one that just ended (a player
 * error can surface a breath late); eyes reads may also name a
 * segment that ended within the last 30 minutes or airs within
 * the laid horizon (a frame sampled off own media ahead of its
 * quarter mark belongs to that instance). */
function segInNow(nw, id, start) {
  if (!nw || !Array.isArray(nw.segs)) return null;
  return nw.segs.find((sg) => sg && sg.id === id && +sg.start === start) || null;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const seat = await seatOf(request, env, "");
  if (!seat || !seat.owner) return json({ ok: false, error: "owner_only" }, 403);
  const doc = (await readDoc(env, "tv/guardian")) || emptyGuardian();
  return json({ ok: true, guardian: doc });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  let body = null;
  try { body = await request.json(); } catch (_) {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "bad_body" }, 400);
  const kind = body.kind === "eyes" ? "eyes" : body.kind === "fault" ? "fault" : "";
  const id = clampStr(body.id || "", 80);
  const start = Math.round(+body.start || 0);
  if (!kind || !ID_RE.test(id) || !(start > 0)) return json({ ok: false, error: "bad_report" }, 400);
  const seat = await seatOf(request, env, body.g || "");
  if (!seat) return json({ ok: false, error: "no_seat" }, 400);
  if (!(await take(env, "tv-guard:" + kind + ":" + seat.key, 3600, kind === "eyes" ? 40 : 120))) return json({ ok: false, error: "rate_limited" }, 429);
  const now = Date.now();
  const nw = await readDoc(env, "tv/now");
  const seg = segInNow(nw, id, start);
  if (!seg) return json({ ok: false, error: "not_on_air" }, 422);
  const segEnd = start + (+seg.dur || 0) * 1000;
  const doc = (await readDoc(env, "tv/guardian")) || emptyGuardian();
  const instKey = id + "@" + start;
  if (kind === "fault") {
    const isCurrent = start <= now && now < segEnd;
    const justEnded = now >= segEnd && now - segEnd < 120e3;
    if (!isCurrent && !justEnded) return json({ ok: false, error: "not_current" }, 422);
    const rec = applyFaultToDoc(doc, instKey, { id, yt: seg.yt || "", title: seg.title || "" }, seat.key, { err: body.err, fkind: body.fkind }, now);
    pruneGuardian(doc, now);
    doc.updatedAt = now;
    await writeDocAs(env, seat.uid || "guest", "tv/guardian", "tv", doc);
    return json({ ok: true, kind, id, start, hardSeats: tvGuardHardSeats(rec), confirmAt: TV_GUARD_CONFIRM_SEATS });
  }
  // eyes
  if (segEnd < now - 30 * 60e3) return json({ ok: false, error: "segment_gone" }, 422);
  const read = cleanEyesRead(body.read);
  if (!read) return json({ ok: false, error: "empty_read" }, 400);
  if (!Array.isArray(doc.eyes)) doc.eyes = [];
  doc.eyes.push({ at: now, segKey: instKey, id, title: seg.title || "", src: body.src === "ffmpeg" ? "ffmpeg" : "seat", read });
  pruneGuardian(doc, now);
  doc.updatedAt = now;
  await writeDocAs(env, seat.uid || "guest", "tv/guardian", "tv", doc);
  return json({ ok: true, kind, id, start, queued: doc.eyes.length });
}
