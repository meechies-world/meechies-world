/* The DJ brain's memory plumbing (PR-B1, 2026-10-29) — shared by the booth
 * event endpoint (functions/api/brain/event.js) and the station keeper
 * (functions/api/station.js), so both writers fold taste the exact same way.
 *
 * Two stores, both following house patterns:
 *   - brain_events: this feature's OWN D1 table (the ai_questions precedent:
 *     a high-volume private log lives in its own table and never rides the
 *     docs changes feed), created on first use and pruned on the write path
 *     to the newest 5,000 rows / 30 days, whichever is smaller.
 *   - brain/taste: ONE small docs doc (coll "brain", written with a changes
 *     row like every other doc) holding aggregated per-track and per-artist
 *     counters, folded at event time by the writers — no cron, no scan.
 *
 * Events are the station's music history (what played, ended, was skipped),
 * never chat content: members' ai_questions stay private under the rule
 * lib/brain.js already keeps, and nothing here reads them.
 *
 * The one consumption point is the keeper's library bag refill
 * (weightedBagOrder + tasteWeight below). The math is deliberately boring:
 * bounded, capped, and exactly neutral (weight 1) for anything the brain
 * has never seen, so an absent or empty profile makes the bag behave
 * statistically like the plain shuffle it replaces. */

const DAY = 864e5;
export const BRAIN_EVENTS_KEEP = 5000;
const TRACK_CAP = 400, ARTIST_CAP = 200; // taste doc caps: coldest evicted on each fold
const WEIGHT_MIN = 0.5, WEIGHT_MAX = 3; // no song or artist can ever dominate — or be buried
const TYPES = new Set(["play", "end", "skip", "stall", "load", "draw", "request", "battlepick"]);

const clampStr = (v, n) => String(v == null ? "" : v).slice(0, n);

/* The identity the decks and queue already use: a YouTube id for video
 * items, the library assetId for files. Library srcs are built FROM the
 * assetId (origin + "/m/assets/" + assetId), so the src tail IS the key —
 * the same key the keeper's bag uses, which is what lets a fold written
 * from a play land on the same entry a later refill reads. */
export function brainEventKey(raw) {
  raw = raw || {};
  const yt = clampStr(raw.yt, 40);
  if (/^[A-Za-z0-9_-]{6,20}$/.test(yt)) return yt;
  const key = clampStr(raw.key, 200);
  if (key && !/\s/.test(key)) return key;
  const m = /\/m\/assets\/([^?#]+)/.exec(clampStr(raw.src, 500));
  if (m) { try { return decodeURIComponent(m[1]).slice(0, 200); } catch (_) { return m[1].slice(0, 200); } }
  return "";
}

/* Validate + normalize one event from anywhere (an untrusted client batch
 * or the keeper's own starts). The actor is stamped by the CALLER from the
 * session — never taken from the body. Returns null for anything unusable. */
export function cleanBrainEvent(raw, actor) {
  if (!raw || typeof raw !== "object") return null;
  const type = clampStr(raw.type, 16);
  if (!TYPES.has(type)) return null;
  const now = Date.now();
  let at = +raw.at || 0;
  if (!(at > now - 7 * DAY && at < now + 5 * 60e3)) at = now;
  return {
    at,
    actor: clampStr(actor, 64) || "guest",
    type,
    key: brainEventKey(raw),
    title: clampStr(raw.title, 160),
    artist: clampStr(raw.artist, 80),
    deck: /^[A-D]$/.test(raw.deck || "") ? raw.deck : "",
    heard: Math.max(0, Math.min(86400, Math.round(+raw.heard || 0))),
    live: raw.live ? 1 : 0,
  };
}

/* ---------- the taste profile ---------- */

export function emptyTaste() { return { v: 1, updatedAt: 0, plays: 0, skips: 0, ends: 0, tracks: {}, artists: {} }; }

/* The blueprint score: ends are the strongest love, plays count, listening
 * time counts slowly, skips cost — and stalls barely count against a song
 * (a stall is the machine's fault, not the music's). */
export function tasteScore(c) {
  if (!c) return 0;
  return 2 * (+c.e || 0) + (+c.p || 0) + (+c.heard || 0) / 120 - 1.5 * (+c.s || 0) - 0.5 * (+c.st || 0);
}

/* Weight for one library track at bag-refill time. Track taste leads;
 * artist taste rides along at half strength; the sum is clamped to
 * [0.5, 3] so a capped favorite is favored at most 6:1 over a buried one.
 * Unknown track + unknown artist (or no profile at all) = exactly 1. */
export function tasteWeight(taste, key, artist) {
  if (!taste || typeof taste !== "object") return 1;
  const ts = tasteScore(taste.tracks && key ? taste.tracks[key] : null);
  const as = artist ? tasteScore(taste.artists ? taste.artists[artist] : null) : 0;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, 1 + ts + 0.5 * as));
}

function capMap(map, cap) {
  const keys = Object.keys(map || {});
  if (keys.length <= cap) return;
  keys.sort((a, b) => (tasteScore(map[b]) - tasteScore(map[a])) || ((map[b].lastAt || 0) - (map[a].lastAt || 0)));
  for (const k of keys.slice(cap)) delete map[k];
}

/* Fold a batch of cleaned events into the taste doc (mutates and returns
 * it). draw / load / request rows are history for the event log only —
 * they never move a weight; the play that follows a draw is what counts.
 * `dirty` is false when nothing moved, so callers can skip the doc write. */
export function foldEvents(taste, events) {
  const t = (taste && typeof taste === "object" && taste.tracks && typeof taste.tracks === "object" && taste.artists && typeof taste.artists === "object") ? taste : emptyTaste();
  let dirty = false;
  for (const ev of events || []) {
    if (!ev) continue;
    let moved = false;
    if (ev.type === "play") { t.plays = (+t.plays || 0) + 1; moved = true; }
    else if (ev.type === "end") { t.ends = (+t.ends || 0) + 1; moved = true; }
    else if (ev.type === "skip") { t.skips = (+t.skips || 0) + 1; moved = true; }
    const counted = moved || ev.type === "stall";
    if (ev.key && counted) {
      const tr = t.tracks[ev.key] || (t.tracks[ev.key] = { p: 0, e: 0, s: 0, st: 0, heard: 0, lastAt: 0, title: "", artist: "" });
      if (ev.type === "play") tr.p++;
      else if (ev.type === "end") { tr.e++; tr.heard += ev.heard || 0; }
      else if (ev.type === "skip") { tr.s++; tr.heard += ev.heard || 0; }
      else if (ev.type === "stall") tr.st++;
      if (ev.at > (tr.lastAt || 0)) tr.lastAt = ev.at;
      if (ev.title) tr.title = ev.title;
      if (ev.artist) tr.artist = ev.artist;
      moved = true;
    }
    if (ev.artist && (ev.type === "play" || ev.type === "end" || ev.type === "skip")) {
      const ar = t.artists[ev.artist] || (t.artists[ev.artist] = { p: 0, e: 0, s: 0 });
      if (ev.type === "play") ar.p++; else if (ev.type === "end") ar.e++; else ar.s++;
      moved = true;
    }
    if (moved) dirty = true;
  }
  if (dirty) { t.updatedAt = Date.now(); capMap(t.tracks, TRACK_CAP); capMap(t.artists, ARTIST_CAP); }
  return { taste: t, dirty };
}

/* The weighted shuffle (Efraimidis–Spirakis): each track draws a key
 * -ln(1-rand)/weight; ordering by key gives a weighted random permutation,
 * and drawing without replacement from it keeps the bag a true permutation
 * — every library track appears exactly once per bag; favorites just land
 * where they are drawn sooner. With every weight 1 the keys are iid
 * exponential and the order is a uniform random permutation, statistically
 * the shuffle the bag has always used. The keeper pops from the END of
 * S.bag, so the order comes back reversed: soonest draws sit at the end. */
export function weightedBagOrder(tracks, taste) {
  const keyed = (tracks || []).map((t) => ({ id: t.assetId, k: -Math.log(1 - Math.random()) / tasteWeight(taste, t.assetId, t.artist || "") }));
  keyed.sort((a, b) => b.k - a.k);
  return keyed.map((x) => x.id);
}

/* ---------- D1 stores ---------- */

export async function readTaste(env) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind("brain/taste").first();
    if (!row) return null;
    const t = JSON.parse(row.data);
    if (!t || typeof t !== "object" || !t.tracks || !t.artists) return null; // corrupt reads as absent: the bag falls back to a plain shuffle
    return t;
  } catch (_) { return null; }
}

/* Same write shape as the keeper's writeDoc: update the row, insert if it
 * was missing, and ALWAYS land the changes row — without it the booth
 * would never see the new taste over the sync feed. */
async function writeTaste(env, taste) {
  const nowIso = new Date().toISOString();
  const data = JSON.stringify(taste);
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, "brain/taste").run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind("brain/taste", "brain", null, data, nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", "brain/taste", "brain", null, null, Date.now()).run();
}

/* The single writer path: log the rows, prune the log, fold the taste.
 * Used by POST /api/brain/event (client batches) and by the keeper (its
 * own starts and consumed picks), so there is exactly one fold in the
 * world. A batch that moves no counter (draws only) writes no taste doc. */
export async function recordBrainEvents(env, events) {
  const evts = (events || []).filter(Boolean);
  if (!evts.length) return { inserted: 0, folded: false };
  await env.DB.prepare("create table if not exists brain_events (id integer primary key autoincrement, at integer, actor text, type text, key text, title text, artist text, deck text, heard integer, live integer)").run();
  await env.DB.batch(evts.map((e) => env.DB.prepare("insert into brain_events (at, actor, type, key, title, artist, deck, heard, live) values (?,?,?,?,?,?,?,?,?)").bind(e.at, e.actor, e.type, e.key, e.title, e.artist, e.deck, e.heard, e.live)));
  // prune on the write path, the logQuestion way: newest rows and 30 days, whichever is smaller
  await env.DB.prepare("delete from brain_events where id not in (select id from brain_events order by id desc limit " + BRAIN_EVENTS_KEEP + ")").run();
  await env.DB.prepare("delete from brain_events where at < ?").bind(Date.now() - 30 * DAY).run();
  const { taste, dirty } = foldEvents(await readTaste(env), evts);
  if (dirty) await writeTaste(env, taste);
  return { inserted: evts.length, folded: dirty };
}
