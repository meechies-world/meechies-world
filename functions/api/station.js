/* Meechie's World Radio — the 24/7 station keeper.
 *
 * The DJ booth (js/dj.js) owns the tables while it is open: every booth save stamps
 * S.boothAt, and this keeper stands down while that stamp is fresh, so Malik can take
 * control of the decks at any moment just by opening the booth. The moment the booth
 * closes, the keeper runs the Auto-DJ rotation itself — writing the exact same
 * radio/dj state the booth writes — so the tables stay live around the clock and
 * anyone who tunes in lands mid-song, like real radio.
 *
 * GET /api/station — called by listener clients every few seconds. Advances the
 * rotation when a track reaches its crossfade point, fast-forwarding through any
 * gap where nobody was listening. Writes are rare: only on an advance, or a light
 * updatedAt touch so clients keep reading the station as live. */
import { userFrom, isAdmin } from "../../lib/cf.js";
import * as HANDS from "../../lib/meechie-hands.js";
import { encrypt, vapid } from "./push.js";
import { cleanBrainEvent, recordBrainEvents, readTaste, tasteScore, weightedBagOrder } from "../../lib/brain-taste.js";
import { tvGuardHardSeats, TV_GUARD_CONFIRM_SEATS } from "./tv/guardian.js";

const XF = 5; // crossfade lead in seconds: the next song starts this long before the current one ends, so the two are audibly playing together with no pause (Malik, 2026-10-28: widened from 3.5; the booth lead in dj.js matches)
const BOOTH_FRESH = 90000; // booth heartbeat window — while it's fresh the TABLES own the radio, the keeper never touches a deck
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* D1 READ FIX (2026-11-03): tonight the free-tier daily row-read
 * limit died under the site's own read pattern — every station ping
 * re-read the same read-mostly TV docs from D1, several of them two
 * or three times in one tick, and the whole track library on every
 * keeper pass. The docs on DOC_MEMO_PATHS are programming state the
 * tick lays from snapshot-style, so readDoc serves them from a
 * short in-isolate memo (4s): the memo keeps the raw stored JSON
 * and every hit re-parses it, so callers still get a fresh object
 * they may mutate exactly as before. writeDoc refreshes the memo
 * in the same breath, so this isolate always reads its own writes.
 * A write from another door can take up to the memo window to
 * reach a warm isolate's tick — never that door's own response —
 * and the doors whose freshness IS an owner action stay unmemoized
 * and are read from D1 on every pass, exactly as before:
 * radio/dj (the booth's live state), tv/queue, tv/skip and
 * brain/commands (see the drain memo below). */
const DOC_MEMO_TTL = 4000;
const PRESENCE_TTL = 15000; // presence reads shared for 15 s per isolate (D1 read fix, 2026-11-08)
const presenceMemo = { at: 0, counts: null };
const DOC_MEMO_PATHS = new Set(["tv/channel", "tv/breakpool", "tv/premiere", "tv/rerun", "tv/familytime", "tv/comedyhour", "tv/movieblock", "tv/insert", "tv/news", "tv/localupdate", "tv/anchor", "tv/charnews", "tv/quarternews", "tv/votes", "tv/guardian", "tv/now", "brain/ytblock", "brain/tvwatch", "station/schedule", "station/rqplaylist"]);
const docMemo = new Map(); // path -> { at, raw } — raw is the stored JSON string, or null
const rqMemo = { at: 0, rows: null }; // D1 READ FIX: listener-request rows, shared by the harvest + takePick (loader above onRequestGet)
const libMemo = { at: 0, lib: null, byAsset: null, ver: -1 }; // D1 READ FIX: the parsed track library (loader above onRequestGet); ver = the site/tracks-version stamp it was built from (F3)
async function readDoc(env, path) {
  if (DOC_MEMO_PATHS.has(path)) {
    const m = docMemo.get(path);
    if (m && Date.now() - m.at < DOC_MEMO_TTL) {
      if (m.raw === null) return null;
      try { return JSON.parse(m.raw); } catch (_) { return null; }
    }
    const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
    docMemo.set(path, { at: Date.now(), raw: row ? row.data : null });
    if (!row) return null;
    try { return JSON.parse(row.data); } catch (_) { return null; }
  }
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (_) { return null; }
}
async function writeDoc(env, path, coll, data) {
  /* SETTINGS CLEANUP (2026-11-03): PR #600's reverted TV-as-radio merge
     persisted an inert radioSrc key in the radio/dj doc; nothing has read
     it since the #603 revert. Strip it here — the site's own write path —
     so the stored doc is clean from the next keeper write on. Same shape
     as the vcam.frame precedent in dj.js mergeState. */
  if (path === "radio/dj" && data && typeof data === "object") delete data.radioSrc;
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, null, JSON.stringify(data), nowIso, nowIso).run();
  }
  // clients learn about doc changes from the changes feed — without this row the
  // new state would sit in the table unseen
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, coll, null, null, Date.now()).run();
  /* D1 READ FIX: this isolate reads its own writes — refresh the
     doc memo with the bytes just written, and drop the cached
     request rows when a request doc lands through this door. */
  if (DOC_MEMO_PATHS.has(path)) docMemo.set(path, { at: Date.now(), raw: JSON.stringify(data) });
  if (coll === "requests") rqMemo.at = 0;
}

/* Pings-table schema, run ONCE per isolate (P1, 2026-11-01): the schema
 * statements used to run on every station ping from every tab — pure D1
 * overhead multiplied by the whole audience, forever. The table and its
 * columns exist in production; the first request a cold isolate serves
 * still creates them if missing, exactly as before. A failed pass is not
 * cached, so the next request retries — matching the old per-request
 * behaviour on the error path too. Zero behaviour change. */
let pingsSchemaP = null;
function ensurePingsSchema(env) {
  if (!pingsSchemaP) {
    pingsSchemaP = (async () => {
      await env.DB.prepare("create table if not exists pings (cid text primary key, at integer, listening integer)").run();
      try { await env.DB.prepare("alter table pings add column uid text").run(); } catch (_) {}
      try { await env.DB.prepare("alter table pings add column name text").run(); } catch (_) {}
      try { await env.DB.prepare("alter table pings add column first integer").run(); } catch (_) {}
      /* D1 READ FIX: the ping path's five per-ping queries filter on
         at / uid, which had no index — each one scanned the whole
         pings table on every 12s ping from every tab. Indexed, they
         touch only the live window's rows. */
      try { await env.DB.prepare("create index if not exists pings_at on pings(at)").run(); } catch (_) {}
      try { await env.DB.prepare("create index if not exists pings_uid on pings(uid, at)").run(); } catch (_) {}
    })();
    pingsSchemaP.catch(() => { pingsSchemaP = null; });
  }
  return pingsSchemaP;
}

/* LISTENER REQUESTS PLAYLIST (2026-10-30, owner: requests are SAVED
 * into a playlist that shuffles itself back into the rotation — "Im
 * building this to be automated on my side"). Every accepted song
 * request is folded ONCE into the station/rqplaylist doc: dedupe by
 * video id (or file src / archive id), requester + time kept, repeat
 * requests bump the count. Caps: 200 records (newest kept), 400
 * folded pick paths remembered. Three folders, one helper: the guest
 * door at acceptance, the keeper at consumption (takePick), and a
 * throttled harvest in the station tick that folds any pick still
 * waiting in the line (member picks land in the same collection
 * through the DB facade, so the harvest is what catches those the
 * moment they are placed — no owner action anywhere). The booth
 * reads the doc like the schedule doc and shows it in Playlists as
 * "Listener Requests" with Load / Add / schedule, like any playlist. */
const RQPL_PATH = "station/rqplaylist", RQPL_CAP = 200, RQPL_SEEN = 400;
let rqHvAt = 0;
let tvTickAt = 0; // D1 READ FIX: per-isolate tvTick throttle stamp (see the call site in onRequestGet)
/* F6-MITIGATED (Malik, 2026-11-07 19:02 ET: "Slow any thing down
 * thats going to shut down my cloudflare"): the FULL tvTick pass —
 * it re-reads ~21 docs and re-lays a ~2h window, and every decision
 * it carries (news windows, quarter cadence, spot cadence, lays) is
 * minute-scale — now runs at most once per TV_TICK_FULL_MS per
 * isolate instead of on the old 5s gate. The actions that must stay
 * fast (owner skip on tv/queue.skipAt, crowd skip on tv/skip,
 * Guardian confirmations on tv/guardian) are watched by
 * tvLightPending on the old 5s gate: those doors are single-doc
 * reads (tv/queue + tv/skip deliberately unmemoized, tv/guardian a
 * single memoized doc), and when one carries an unanswered action
 * the light check pulls the FULL tick forward immediately — a skip
 * or a confirmed-dead cut is still answered within ~5s, by the
 * exact same tick code as before, never a second implementation.
 * Nothing viewer-visible waits on the slower full cadence: the
 * window is laid ~2h ahead, and the radio news fire window is
 * 5 minutes wide at each quarter head. */
const TV_TICK_FULL_MS = 60000;
let tvLightAt = 0; // per-isolate light-check throttle stamp (5s gate)
let tvLightSkipAt = 0; // newest tv/queue.skipAt this isolate has already pulled a tick for
let tvLightCrowdAt = 0; // tv/skip filing stamp this isolate last pulled a tick for
let tvLightGuardKey = ""; // last guardian fault key+hard-seat count this isolate pulled a tick for
let tvLightEyesKey = ""; // last guardian eyes-batch tail this isolate pulled a tick for
let selfRevCheckAt = 0; // SELF-REVIEW: per-isolate check throttle for the daily pass in the GET handler
const rqKeyOf = (d) => (d && d.yt ? "yt:" + d.yt : d && d.src ? "s:" + d.src : d && d.iaId ? "ia:" + d.iaId : "");
async function rqRecOf(d) {
  const rec = { k: rqKeyOf(d), yt: /^[A-Za-z0-9_-]{11}$/.test(String(d.yt || "")) ? String(d.yt) : "", src: String(d.src || ""), iaId: String(d.iaId || ""), title: String(d.title || "").slice(0, 120), cover: String(d.cover || "").slice(0, 300), dur: Math.max(0, Math.min(3600, +d.dur || 0)), by: String(d.by || (d.guest ? "Guest" : "")).slice(0, 40), at: +d.at || Date.now(), n: 1 };
  if (rec.src.includes("supabase.co")) rec.src = "";
  if (!rec.src && rec.iaId) { // resolve now so the record plays everywhere (booth playlists included), not just in the keeper lane
    try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(rec.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) { rec.src = "https://archive.org/download/" + encodeURIComponent(rec.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"); if (!rec.dur) rec.dur = Math.round(+f.length || 0); } } catch (_) {}
  }
  if (rec.yt && !rec.cover) rec.cover = "https://i.ytimg.com/vi/" + rec.yt + "/hqdefault.jpg";
  return (rec.yt || rec.src || rec.iaId) ? rec : null;
}
async function rqPlaylistAdd(env, entries) {
  const fresh = [];
  for (const e of entries || []) { if (e && e.d && e.d.kind === "pick" && rqKeyOf(e.d)) fresh.push(e); }
  if (!fresh.length) return;
  const doc = (await readDoc(env, RQPL_PATH)) || { name: "Listener Requests", items: [], seen: [] };
  const list = Array.isArray(doc.items) ? doc.items : [];
  const seen = Array.isArray(doc.seen) ? doc.seen : [];
  const byK = new Map(list.map((r) => [r.k, r]));
  let dirty = false;
  for (const e of fresh) {
    if (e.path && seen.includes(e.path)) continue;
    if (e.path) { seen.push(e.path); dirty = true; }
    const k = rqKeyOf(e.d), ex = byK.get(k);
    if (ex) { ex.n = (ex.n || 1) + 1; if (e.d.by) ex.by = String(e.d.by).slice(0, 40); ex.at = +e.d.at || ex.at || Date.now(); }
    else { const rec = await rqRecOf(e.d); if (rec) { list.unshift(rec); byK.set(k, rec); } }
  }
  if (dirty) { doc.name = "Listener Requests"; doc.items = list.slice(0, RQPL_CAP); doc.seen = seen.slice(-RQPL_SEEN); doc.updatedAt = Date.now(); await writeDoc(env, RQPL_PATH, "station", doc); }
}

/* AIDJ-BEGIN */
/* AI DJ (PR-C1, 2026-10-30 — owner direction: "Make my ai robot auto pick
 * my youtube songs ive serched enough for it to know what i want"): when
 * Malik has been away from the booth a long while and his own queue has
 * played out, the keeper digs for NEW YouTube music in his taste and
 * stocks it in a dedicated slot, S.aiQ, which nextItem serves after
 * listener picks, the schedule and his queue, ahead of the frozen
 * pool/library rotation it exists to refresh. Queries are templates over
 * the brain/taste profile plus the lane seeds of the current
 * brain/dayparts block — counting and string work only, ZERO AI model
 * calls. Search runs through the same /api/ytsearch relay the booth
 * uses, as an internal self-call, so every candidate arrives already
 * age/embed filtered and clear of the shared brain/ytblock ban list —
 * exactly what his own search would have shown him. The whole pass is
 * failure-silent: any error ends it with the station exactly as it was.
 * Design: website/site-brain/AI-DJ.md. */
const AIDJ_AWAY = 30 * 60e3; // booth stale this long = he is really away (the deliberate-pause horizon, the longest owner-intent window in this file)
const AIDJ_THROTTLE = 10 * 60e3; // at most one pass per 10 minutes, stamped on attempts and not just successes
const AIDJ_MAX = 4; // bounded stock: at most 4 unplayed AI picks may exist at any moment
const AIDJ_STOCK_MAX = 1; // the pass tops up only when the AI stock ahead of the rotation is this low
const AIDJ_DAY = 864e5; // AI stock older than 24h expires unplayed; event dedupe looks back over the same window

/* Dayparts are DATA: a brain/dayparts doc ({blocks:[{start,end,name,
 * seeds}]}) wins whenever it exists and is well formed, so the daily
 * program can be re-tuned without a code ship. Until that doc exists,
 * the fallback below is the owner spec of 2026-11-03 transcribed as-is
 * (his hours, his lanes; supersedes the 2026-10-29 grid): 21:00–06:00
 * trap love-making, 06:00–12:00 weed-smoking wake-up (his words:
 * "Mornin — is the weed songs"), 12:00–21:00 mixed — old school, pop,
 * country, rock and EDM. Each block is one line: re-tune in place. */
function aiDjDefaultDayparts() {
  return [
    { start: "21:00", end: "06:00", name: "traplove", seeds: ["trap love songs mix", "trap music mix", "female rappers mix", "sexy r&b slow jams", "r&b love songs mix"] },
    { start: "06:00", end: "12:00", name: "weed", seeds: ["weed smoking music mix", "wake and bake music mix", "stoner music mix", "chill hip hop mix"] },
    { start: "12:00", end: "21:00", name: "mixed", seeds: ["old school hip hop mix", "pop hits mix", "country hits mix", "rock hits mix", "edm mix"] },
  ];
}
function aiDjValidBlocks(doc) {
  if (!doc || !Array.isArray(doc.blocks) || !doc.blocks.length) return null;
  const hmOk = (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
  const out = [];
  for (const b of doc.blocks) {
    if (!b || !hmOk(b.start) || !hmOk(b.end)) return null;
    const seeds = (Array.isArray(b.seeds) ? b.seeds : []).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 60));
    if (!seeds.length) return null;
    out.push({ start: String(b.start), end: String(b.end), name: String(b.name || "").slice(0, 24), seeds });
  }
  return out.length ? out : null;
}
function aiDjEasternMinutes(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const gp = (t) => +(parts.find((x) => x.type === t) || {}).value || 0;
  return (gp("hour") % 24) * 60 + gp("minute");
}
function aiDjBlockAt(blocks, ms) {
  const nowMin = aiDjEasternMinutes(ms);
  const hm = (s) => { const p = String(s).split(":"); return (+p[0] || 0) * 60 + (+p[1] || 0); };
  for (const b of blocks || []) {
    const a = hm(b.start), e = hm(b.end);
    if (a === e) return b; // a block spanning the whole day
    if (e > a ? (nowMin >= a && nowMin < e) : (nowMin >= a || nowMin < e)) return b; // the night block wraps past midnight
  }
  return null;
}
/* The run gates that protect the owner, checked before any mutation:
 * the kill switch, the station actually being his live Auto-DJ, a
 * respected deliberate pause, the booth long stale, and the throttle.
 * Placement in the tick already inherits live/autodj/pause (the tick
 * returns earlier on each), but the pass re-tests every gate itself so
 * it can never fall through a fresh booth on a breaker tick. */
function aiDjGateCore(S, now) {
  if (!S || typeof S !== "object") return "nostate";
  if (S.aiDj === false) return "kill"; // owner kill switch (the booth toggle lands in PR-C2); default is on
  if (!S.live) return "notlive";
  if (!S.autodj) return "noautodj";
  if (S.pausedAt && now - S.pausedAt < 30 * 60e3) return "paused"; // a pause he chose is never second-guessed
  if (!(now - (+S.boothAt || 0) > AIDJ_AWAY)) return "booth"; // he is at (or recently left) the tables: the AI adds nothing
  if (!(now - (+S.aiDjAt || 0) > AIDJ_THROTTLE)) return "throttle";
  return "";
}
/* The stock gates, checked after the throttle stamp and stale-stock
 * expiry: his queue still has songs = the AI waits; enough AI stock
 * already waiting = the AI waits. */
function aiDjGateStock(S) {
  if (Array.isArray(S.queue) && S.queue.length) return "queue";
  if (Array.isArray(S.aiQ) && S.aiQ.length > AIDJ_STOCK_MAX) return "stocked";
  return "";
}
/* Anchor artists, best first: the taste profile artist scores lead,
 * and only artists he actually leans toward — a zero or negative score
 * is music he skips, never an anchor. With no usable profile, the
 * library artist fields carry the pass (frequency order). No anchor
 * anywhere and no lane seeds means the pass does nothing: the AI never
 * wanders genres on its own. */
function aiDjAnchors(taste, lib, scoreFn) {
  const out = [];
  const okName = (n) => typeof n === "string" && n.trim().length >= 2 && n.trim().length <= 48;
  if (taste && taste.artists && typeof taste.artists === "object") {
    const rows = [];
    for (const name of Object.keys(taste.artists)) {
      if (!okName(name)) continue;
      const c = taste.artists[name] || {};
      const sc = scoreFn ? scoreFn(c) : 0;
      if (sc > 0) rows.push({ name: name.trim(), sc, p: +c.p || 0 });
    }
    rows.sort((a, b) => (b.sc - a.sc) || (b.p - a.p) || (a.name < b.name ? -1 : 1));
    for (const r of rows) out.push(r.name);
  }
  if (!out.length && Array.isArray(lib)) {
    const freq = new Map();
    for (const t of lib) { const a = t && t.artist ? String(t.artist).trim() : ""; if (okName(a)) freq.set(a, (freq.get(a) || 0) + 1); }
    const rows = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    for (const [name] of rows) out.push(name);
  }
  return out.slice(0, 12);
}
/* Up to 3 searches per pass, rotating by the pass index so successive
 * passes walk the anchors and lane seeds instead of hammering the same
 * ones: the current daypart lane seed leads (it is the program for this
 * hour), then taste anchors in the shapes Malik types into the booth
 * search himself. With no anchors, the block lane seeds alone carry the
 * pass — the lanes are the owner declared taste, never generic fare. */
function aiDjQueries(taste, lib, block, passIx, scoreFn) {
  const anchors = aiDjAnchors(taste, lib, scoreFn);
  const seeds = block && Array.isArray(block.seeds) ? block.seeds.filter((s) => typeof s === "string" && s.trim()) : [];
  const rot = (arr, i) => arr.length ? arr[(((passIx + i) % arr.length) + arr.length) % arr.length] : null;
  const templates = [(a) => a, (a) => a + " live", (a) => a + " mix"];
  const qs = [];
  if (seeds.length) { const s = rot(seeds, 0); qs.push({ q: s, anchor: "" }); }
  for (let i = 0; qs.length < 3; i++) {
    const a = rot(anchors, i);
    if (a) { qs.push({ q: templates[(((passIx + i) % 3) + 3) % 3](a), anchor: a }); continue; }
    const s = rot(seeds, i + 1);
    if (s && !qs.some((x) => x.q === s)) { qs.push({ q: s, anchor: "" }); continue; }
    break;
  }
  return qs.slice(0, 3);
}
const aiDjNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/* Survivor hygiene: known song-length durations only (the relay filters
 * already ran upstream of this list; the pass applies its own screen
 * too), nothing that is already anywhere in the station world, and
 * results whose title names their anchor artist ranked first. */
function aiDjSurvivors(merged, ctx) {
  const seen = new Set(), out = [];
  for (const r of merged || []) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const dur = +r.dur || 0;
    if (dur < 45 || dur > 1200) continue; // fragments and hour-long mixes never stock the unattended station (and a stocked video must carry a known duration)
    if (ctx.bannedIds && ctx.bannedIds.has(r.id)) continue;
    const nt = aiDjNorm(r.title);
    if (nt && ctx.logTitles && ctx.logTitles.has(nt)) continue;
    if (nt && ctx.libTitles && ctx.libTitles.has(nt)) continue;
    out.push({ id: r.id, title: r.title, dur, q: r.q || "", anchor: r.anchor || "", boost: r.anchor && nt && nt.includes(aiDjNorm(r.anchor)) ? 1 : 0 });
  }
  return out.filter((x) => x.boost).concat(out.filter((x) => !x.boost)).slice(0, Math.max(0, ctx.cap | 0));
}
async function aiDjSearch(deps, q) {
  try {
    const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(6500) } : {};
    const r = await deps.fetchFn(deps.origin + "/api/ytsearch?q=" + encodeURIComponent(q) + "&page=1", ctl);
    const j = await r.json();
    if (j && j.ok && Array.isArray(j.results)) return j.results.filter((x) => x && x.id).map((x) => ({ id: String(x.id), title: String(x.title || "").slice(0, 120), dur: +x.dur || 0 }));
  } catch (_) {}
  return [];
}
/* The pass itself. It mutates only S.aiQ and S.aiDjAt on the shared doc
 * and returns { changed, events, note }: the caller folds `changed` into
 * the write the tick was already going to make (the pass writes nothing
 * of its own) and hands the events to the tick brain flush. Every stock
 * pick is logged as a brain_events row with actor "aidj" before it can
 * ever play — nothing the AI queues is anonymous. The shipped B1 schema
 * has no "queue" event type and no source column, so the row uses the
 * canonical "draw" type (Auto-DJ chose it next; history-only in the
 * taste fold, so a stock action never moves a weight — the play that
 * follows is what counts) with the attribution carried in actor. */
async function aiDjPass(deps, S, now) {
  let gate = aiDjGateCore(S, now);
  /* HANDS: a commanded stock (deps.force, from the keeper's hands drain
   * — Malik told Meechie to dig NOW) bypasses only the two waiting
   * gates, "booth" and "throttle"; the drain has already applied its
   * own stricter booth stand-down, and kill / notlive / noautodj /
   * paused still refuse absolutely. */
  if (gate && deps && deps.force && (gate === "booth" || gate === "throttle")) gate = "";
  if (gate) return { changed: false, events: [], note: gate };
  const prevAt = +S.aiDjAt || 0;
  S.aiDjAt = now; // stamped on every attempt, so a dead relay is not retried on the next 12s ping
  let changed = true;
  if (Array.isArray(S.aiQ)) { // expire stale stock before topping up: current taste, not last month leftovers
    const keep = S.aiQ.filter((it) => it && now - (+it.at || 0) < AIDJ_DAY);
    if (keep.length !== S.aiQ.length) S.aiQ = keep;
  }
  const sg = aiDjGateStock(S);
  /* HANDS: a commanded pass may top up past the "stocked" wait (the
   * survivors cap still bounds the AI line at AIDJ_MAX), but Malik's
   * own queue ("queue") always still wins — forced or not. */
  if (sg && !(deps && deps.force && sg === "stocked")) return { changed, events: [], note: sg };
  if (!Array.isArray(S.aiQ)) S.aiQ = [];
  let taste = null;
  try { taste = await deps.readTaste(deps.env); } catch (_) {}
  let blocks = aiDjDefaultDayparts();
  try { const doc = await deps.readDoc(deps.env, "brain/dayparts"); const valid = aiDjValidBlocks(doc); if (valid) blocks = valid; } catch (_) {}
  const block = aiDjBlockAt(blocks, now);
  const passIx = Math.floor(prevAt / AIDJ_THROTTLE);
  const queries = aiDjQueries(taste, deps.lib, block, passIx, deps.tasteScore);
  if (!queries.length) return { changed, events: [], note: "noanchor" };
  const lists = await Promise.all(queries.map((x) => aiDjSearch(deps, x.q)));
  const merged = [], seenQ = new Set();
  lists.forEach((list, i) => { for (const r of list) { if (seenQ.has(r.id)) continue; seenQ.add(r.id); merged.push({ id: r.id, title: r.title, dur: r.dur, q: queries[i].q, anchor: queries[i].anchor }); } });
  const bannedIds = new Set();
  const addId = (v) => { if (v) bannedIds.add(String(v)); };
  for (const it of S.aiQ) addId(it && it.yt);
  if (Array.isArray(S.queue)) for (const it of S.queue) addId(it && it.yt);
  if (Array.isArray(S.schedQ)) for (const it of S.schedQ) addId(it && it.yt);
  for (const k of ["A", "B", "C", "D"]) addId(S[k] && S[k].yt);
  try { // anything the station played, ended, skipped or stalled on in the last 24h is never re-queued
    const rows = await deps.env.DB.prepare("select key from brain_events where at > ? and type in ('play','end','skip','stall')").bind(now - AIDJ_DAY).all();
    for (const r of (rows.results || [])) addId(r && r.key);
  } catch (_) {}
  const logTitles = new Set((S.log || []).map((x) => aiDjNorm(x && x.t)));
  const libTitles = new Set((deps.lib || []).map((t) => aiDjNorm(t && t.title)));
  const survivors = aiDjSurvivors(merged, { bannedIds, logTitles, libTitles, cap: AIDJ_MAX - S.aiQ.length });
  // Seed bookkeeping for the daily self-review: how each search phrase
  // did on this pass (results back, picks landed). Best-effort.
  try { await selfSeedNote(deps.env, queries.map((x, i) => ({ q: x.q, returned: (lists[i] || []).length, landed: survivors.reduce((n, s) => n + (s.q === x.q ? 1 : 0), 0) }))); } catch (_) {}
  const events = [];
  for (const sv of survivors) {
    S.aiQ.push({ yt: sv.id, title: String(sv.title || "").slice(0, 120), cover: "", dur: sv.dur, ai: 1, q: sv.q, at: now });
    const ev = deps.cleanBrainEvent ? deps.cleanBrainEvent({ type: "draw", yt: sv.id, title: sv.title || "", artist: sv.anchor || "", at: now, live: !!S.live }, "aidj") : null;
    if (ev) events.push(ev);
  }
  return { changed: true, events, note: "stocked " + survivors.length };
}
/* AIDJ-END */

/* WEBMIX-BEGIN — THE COLLABORATION WEB IN THE MAIN STATION MIX
 * (owner, 2026-11-08: "Mix them into the main station with my music",
 * plus the all-in ruling the same day: VEVO / label-channel artists
 * count, with the basis recorded per artist in the pool report).
 *
 * The web: Deen Squad + ASAP Preach and everyone they make music
 * with, out three hops — 115 artists / 872 tracks / 47.7 hours, every
 * track verified to the house standard (official artist channel,
 * official VEVO, or — for Bizzle — the artist's official label
 * channel; oEmbed-verified; family-clean screen; the 7 flagged
 * tracks never entered the pool). The pool is DATA, not code: it
 * lives in the static /lifeline/radio-web-pool.json (the
 * channel-pools.json pattern), so this lane reads ZERO D1 rows —
 * the keeper fetches the asset through its own origin and memoizes
 * it per isolate. Any failure (asset missing, disabled, malformed)
 * closes the lane and the rotation falls through to the Archive
 * pool / his bag exactly as before: a web failure can never stall
 * or silence the station.
 *
 * Where it plays: the rotation tail only, in the "world" half of
 * the mixAlt alternation, and only inside the mixed daypart
 * (12:00–21:00 ET — the owner daypart law transcribed in
 * aiDjDefaultDayparts). Listener picks, the schedule, Malik's own
 * queue, AI stock, spots and the requests lane all keep their
 * priority ahead of the tail, untouched. Overnight trap and the
 * morning wake-up stay exactly as they were — this lane never
 * fires outside the mixed block.
 *
 * Inside the web half, the draw is a hop-weighted no-repeat bag
 * (S.webBag: an Efraimidis–Spirakis permutation of the pool, the
 * rqWeightedOrder construction): seeds + hop 1 weigh 2x hop 2 and
 * hop 3 weighs half of hop 2, so the closest circles surface first
 * while the whole web still cycles without repeats. A per-artist
 * cap (2 plays per rolling hour, S.webPlays) keeps any single act
 * from taking over his station. Tracks already on a deck, in a
 * queue, or in the station log are skipped for the cycle. Every
 * web item rides the deck as a plain video item with a known
 * duration — the same shape the queue / AI-stock branches already
 * serve — so a failed embed is bounded by its duration and the
 * rotation rolls on with no dead air. */
const WEB_POOL_URL = "/lifeline/radio-web-pool.json";
const WEB_POOL_TTL = 10 * 60e3; // static asset: re-read at most once per 10 min per isolate
const WEB_MIX_START = 12 * 60, WEB_MIX_END = 21 * 60; // ET minutes — the mixed daypart (owner law)
const WEB_HOP_W = [4, 4, 2, 1]; // hop weights: seeds + hop 1 at 2x hop 2; hop 3 at half of hop 2
const WEB_ARTIST_CAP = 2; // max plays per web artist per rolling hour
const WEB_CAP_WINDOW = 3600e3;
const WEB_DUR_MIN = 45, WEB_DUR_MAX = 1200; // the unattended band (aiDjSurvivors precedent)
const webMemo = { at: 0, failAt: 0, v: 0, entries: null };
function webMixActive(now) { const m = aiDjEasternMinutes(now); return m >= WEB_MIX_START && m < WEB_MIX_END; }
function webWeightedOrder(entries, rand) {
  const rnd = typeof rand === "function" ? rand : Math.random;
  return (Array.isArray(entries) ? entries : []).map((e, i) => ({ i, k: -Math.log(1 - rnd()) / (WEB_HOP_W[Math.max(0, Math.min(3, +e.hop || 0))]) })).sort((a, b) => a.k - b.k).map((x) => x.i);
}
async function webLoadPool(origin, fetchFn, now) {
  if (webMemo.entries && now - webMemo.at < WEB_POOL_TTL) return webMemo;
  if (!webMemo.entries && webMemo.failAt && now - webMemo.failAt < WEB_POOL_TTL) return webMemo;
  try {
    const r = await fetchFn(String(origin || "") + WEB_POOL_URL, { cache: "no-store" });
    if (!r || !r.ok) throw new Error("web pool fetch");
    const j = await r.json();
    if (!j || j.enabled === false || !Array.isArray(j.artists)) throw new Error("web pool shape");
    const entries = [];
    for (const a of j.artists) {
      if (!a || typeof a.name !== "string" || !a.name) continue;
      const hop = Math.max(0, Math.min(3, +a.hop || 0));
      for (const t of (Array.isArray(a.tracks) ? a.tracks : [])) {
        if (!t || !/^[A-Za-z0-9_-]{11}$/.test(String(t.yt || ""))) continue;
        const dur = +t.dur || 0;
        if (dur < WEB_DUR_MIN || dur > WEB_DUR_MAX) continue;
        entries.push({ yt: String(t.yt), title: String(t.title || "").slice(0, 120), dur, artist: a.name, hop });
      }
    }
    webMemo.at = now; webMemo.v = +j.v || 0; webMemo.entries = entries.length ? entries : null;
    if (!webMemo.entries) webMemo.failAt = now;
  } catch (_) { if (!webMemo.entries) webMemo.failAt = now; }
  return webMemo;
}
/* One web draw for the rotation tail. Mutates only S.webBag /
 * S.webBagV / S.webPlays on the shared doc (the tick's own write
 * carries them, exactly like S.bag and S.rqBag); returns the deck
 * item or null — null always means "fall through to the lanes that
 * were there before", never an error worth surfacing. */
async function webLaneItem(deps, S, now) {
  const memo = await webLoadPool(deps && deps.origin, deps && deps.fetchFn, now);
  const entries = memo.entries;
  if (!entries || !entries.length) return null;
  const plays = (Array.isArray(S.webPlays) ? S.webPlays : []).filter((p) => p && now - (+p.at || 0) < WEB_CAP_WINDOW);
  const countOf = (a) => plays.reduce((n, p) => n + (p.a === a ? 1 : 0), 0);
  const banned = new Set();
  const addId = (v) => { if (v) banned.add(String(v)); };
  for (const k of ["A", "B", "C", "D"]) addId(S[k] && S[k].yt);
  if (Array.isArray(S.queue)) for (const it of S.queue) addId(it && it.yt);
  if (Array.isArray(S.aiQ)) for (const it of S.aiQ) addId(it && it.yt);
  if (Array.isArray(S.schedQ)) for (const it of S.schedQ) addId(it && it.yt);
  const logTitles = new Set((S.log || []).map((x) => aiDjNorm(x && x.t)));
  let bag = Array.isArray(S.webBag) ? S.webBag.filter((i) => entries[+i]) : [];
  if (S.webBagV !== memo.v || !bag.length) bag = webWeightedOrder(entries, deps && deps.rand);
  S.webBagV = memo.v;
  const defer = [];
  let picked = null;
  while (bag.length) {
    const ix = bag.shift();
    const e = entries[ix];
    if (!e) continue;
    if (banned.has(e.yt)) continue; // on a deck or in a queue already: skip for this cycle
    const nt = aiDjNorm(e.title);
    if (nt && logTitles.has(nt)) continue; // just played (the station log): skip for this cycle
    if (countOf(e.artist) >= WEB_ARTIST_CAP) { defer.push(ix); continue; } // capped: back of the bag, later draws retry
    picked = e; break;
  }
  S.webBag = bag.concat(defer);
  S.webPlays = plays;
  if (!picked) return null;
  S.webPlays = plays.concat([{ a: picked.artist, at: now }]);
  return { src: "", yt: picked.yt, title: picked.title, cover: "https://i.ytimg.com/vi/" + picked.yt + "/hqdefault.jpg", dur: picked.dur };
}
/* WEBMIX-END */

/* SELF-REVIEW-BEGIN — MEECHIE'S SELF-UPGRADE LOOP (Malik, 2026-11-03:
 * "I want him to be able to upgrade himself").
 *
 * Once a day, in the quiet hours (03:10–04:50 America/New_York), Meechie
 * reviews his own last day on the station — plays, completions, skips,
 * listener requests, and what became of the picks the Auto-DJ stocked —
 * and improves his JUDGMENT DATA: the brain/taste counters behind his
 * weights, the seed rotation inside the daypart blocks, and the saved
 * requests playlist. Every change is written to brain/selflog with a
 * before/after and a reason, so the owner can always read what Meechie
 * changed about himself and why. Self-upgrades are never silent.
 *
 * THE BOUNDARY, IN CODE: this loop tunes data, never code. When the
 * review spots something only a code change can fix, it files a
 * proposal in brain/proposals (what + why) for Amani to review and ship
 * through the normal PR flow — Meechie may NOT rewrite his own code,
 * and nothing in this block can reach a code path.
 *
 * HARD RAILS (asserted by the harness, not just promised here):
 *  - writes go ONLY through selfWrite(), whose allowlist is brain/taste,
 *    brain/dayparts, brain/seedstats, brain/selflog, brain/proposals
 *    and station/rqplaylist (prune/decay only). The booth doc, Malik's
 *    queues, money/entitlement docs and every tv/* doc are unreachable.
 *  - the daypart CLOCK is Malik's law: seed edits rebuild each block
 *    with its start/end/name copied verbatim, and the result must pass
 *    aiDjValidBlocks with an identical clock before it is written.
 *  - taste counters move at most +1 per track per review, at most 8
 *    tracks per direction, and the weights themselves stay inside the
 *    lib's [0.5, 3] clamp by construction.
 *  - owner supremacy: the AI-DJ kill switch (radio/dj aiDj === false)
 *    stands the review down too; the playability filter still gates
 *    every pick the tuned data ever produces (this loop stocks nothing
 *    itself — it only sharpens what the existing passes already do).
 *  - free tier only: brain_events + docs reads and doc writes on the
 *    existing D1 — no model calls, no new infrastructure. */
const SELF_QUIET_START = 3 * 60 + 10; // 03:10 ET
const SELF_QUIET_END = 4 * 60 + 50; // 04:50 ET
const SELF_DAY = 864e5;
const SELF_WRITE_OK = { "brain/taste": "brain", "brain/dayparts": "brain", "brain/seedstats": "brain", "brain/selflog": "brain", "brain/proposals": "brain", "station/rqplaylist": "station" };
const SELF_TASTE_MAX = 8; // tracks adjusted per direction per review
const SELF_SEED_MIN_PASSES = 8; // a seed needs this much evidence before it can be retired
/* The ONLY write door for the self-review. Anything outside the
 * allowlist throws, so a future edit cannot quietly widen the loop's
 * reach — the harness asserts every write in a run lands in this set. */
async function selfWrite(deps, path, data) {
  const coll = SELF_WRITE_OK[path];
  if (!coll) throw new Error("self-review write outside allowlist: " + path);
  return deps.writeDoc(deps.env, path, coll, data);
}
function selfEtParts(now) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
    const g = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : ""; };
    return { day: g("year") + "-" + g("month") + "-" + g("day"), minutes: (+g("hour") || 0) * 60 + (+g("minute") || 0) };
  } catch (_) { return { day: "", minutes: -1 }; }
}
/* Seed bookkeeping (brain/seedstats): per search phrase, how many
 * Auto-DJ passes ran it, how many results came back, how many picks
 * landed in aiQ, and how many of those actually played. Written
 * directly on the docs table WITHOUT a changes-feed row — keeper-
 * internal counters, the same precedent as brain_events. Best-effort:
 * stats may never break a pass or a tick. */
async function selfSeedNote(env, rows, playedQs) {
  if (!env || !env.DB) return;
  let doc = null;
  try {
    if (typeof readDoc === "function") doc = await readDoc(env, "brain/seedstats");
    if (!doc) { const r = await env.DB.prepare("select data from docs where path = 'brain/seedstats'").first(); if (r && r.data) doc = JSON.parse(r.data); }
  } catch (_) {}
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = { v: 1, seeds: {} };
  if (!doc.seeds || typeof doc.seeds !== "object" || Array.isArray(doc.seeds)) doc.seeds = {};
  const now = Date.now();
  const bump = (q) => { const k = String(q || "").slice(0, 80); if (!k) return null; const s = doc.seeds[k] || (doc.seeds[k] = { passes: 0, returned: 0, landed: 0, played: 0, firstAt: now, lastAt: 0 }); s.lastAt = now; return s; };
  if (Array.isArray(rows)) for (const r of rows) { const s = r && bump(r.q); if (s) { s.passes += 1; s.returned += Math.max(0, +r.returned || 0); s.landed += Math.max(0, +r.landed || 0); } }
  if (Array.isArray(playedQs)) for (const q of playedQs) { const s = bump(q); if (s) s.played += 1; }
  const keys = Object.keys(doc.seeds);
  if (keys.length > 80) { keys.sort((a, b) => (doc.seeds[a].lastAt || 0) - (doc.seeds[b].lastAt || 0)); for (const k of keys.slice(0, keys.length - 80)) delete doc.seeds[k]; }
  doc.updatedAt = now;
  // Persist through the station's own writeDoc (the docs table's full
  // column shape — path, coll, owner, data, created_at, updated_at —
  // is carried there; a hand-rolled insert in the lib's shorter shape
  // silently failed on this table, found live 2026-11-03). Raw SQL in
  // the same full shape remains only as a fallback for extracted-code
  // harnesses where writeDoc is out of scope.
  try { if (typeof writeDoc === "function") { await writeDoc(env, "brain/seedstats", "brain", doc); return; } } catch (_) {}
  try {
    const data = JSON.stringify(doc), iso = new Date(now).toISOString();
    const u = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, iso, "brain/seedstats").run();
    if (!u || !u.meta || !u.meta.changes) await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind("brain/seedstats", "brain", null, data, iso, iso).run();
  } catch (_) {}
}
/* The requests-playlist weighting the loop maintains: an item asked for
 * n times weighs 1 + min(2, log2(n)) — a song three people asked for
 * surfaces about twice as fast as a one-off, and the draw stays a
 * no-repeat permutation (Efraimidis–Spirakis, the same construction as
 * the keeper's weightedBagOrder), so every saved request still plays
 * each cycle; weight only changes WHO COMES UP SOONER. Pure + exported
 * for the harness; the requests lane refills its bag through here. */
function rqWeightOf(n) { return 1 + Math.min(2, Math.log2(Math.max(1, +n || 1))); }
function rqWeightedOrder(items, rand) {
  const rnd = typeof rand === "function" ? rand : Math.random;
  return (Array.isArray(items) ? items : []).map((r) => ({ k: r.k, t: -Math.log(1 - rnd()) / rqWeightOf(r && r.n) })).sort((a, b) => a.t - b.t).map((x) => x.k);
}
/* The daily self-review. deps = { env, readDoc, writeDoc, readTaste,
 * tasteScore, aiDjValidBlocks, aiDjDefaultDayparts }; S is the station
 * doc, READ-ONLY here (kill switch + queue lengths for the summary) —
 * the pass never mutates or writes it. Returns a small status object;
 * the caller ignores it. Fully self-gating; first sight establishes the
 * baseline (the what-Meechie-knows readout) as selflog entry #1. */
async function selfReviewPass(deps, S, now) {
  const et = selfEtParts(now);
  let selflog = null;
  try { selflog = await deps.readDoc(deps.env, "brain/selflog"); } catch (_) {}
  if (!selflog || !Array.isArray(selflog.entries)) {
    // BASELINE: no selflog yet — establish the loop's own docs and put
    // the readout summary in as the first entry. The baseline runs at
    // any hour (it changes no judgment data — it only records what
    // Meechie knows today) and stamps the day, so the first true review
    // is the next quiet window.
    let taste = null; try { taste = await deps.readTaste(deps.env); } catch (_) {}
    let blocks = deps.aiDjDefaultDayparts(), daySrc = "code fallback (no brain/dayparts doc)";
    try { const doc = await deps.readDoc(deps.env, "brain/dayparts"); const valid = deps.aiDjValidBlocks(doc); if (valid) { blocks = valid; daySrc = "brain/dayparts doc"; } } catch (_) {}
    let ban = 0; try { const b = await deps.readDoc(deps.env, "brain/ytblock"); if (b && Array.isArray(b.ids)) ban = b.ids.length; } catch (_) {}
    let rq = null; try { rq = await deps.readDoc(deps.env, "station/rqplaylist"); } catch (_) {}
    let topName = "", topScore = 0, anchors = 0;
    if (taste && taste.artists) for (const [name, c] of Object.entries(taste.artists)) { const sc = deps.tasteScore(c); if (sc > 0) anchors++; if (sc > topScore) { topScore = sc; topName = name; } }
    const summary = "Baseline — what Meechie knows today: taste has folded " + (taste ? taste.plays || 0 : 0) + " plays, " + (taste ? taste.ends || 0 : 0) + " completions, " + (taste ? taste.skips || 0 : 0) + " skips across " + (taste ? Object.keys(taste.tracks || {}).length : 0) + " tracks and " + (taste ? Object.keys(taste.artists || {}).length : 0) + " artists; strongest artist " + (topName || "none yet") + " (score " + topScore.toFixed(1) + "); " + anchors + " artists score above zero and can anchor picks; ban list holds " + ban + " video ids; dayparts run from the " + daySrc + " (" + blocks.map((b) => b.name).join(" / ") + "); requests playlist " + (rq && Array.isArray(rq.items) && rq.items.length ? "holds " + rq.items.length + " saved requests" : "has not been created yet — no song requests folded in so far") + "; station at baseline: Malik's queue " + (S && Array.isArray(S.queue) ? S.queue.length : 0) + " songs, AI stock " + (S && Array.isArray(S.aiQ) ? S.aiQ.length : 0) + ".";
    const doc = { v: 1, createdAt: now, lastRunDay: et.day, lastRunAt: now, entries: [{ at: now, kind: "baseline", summary, changes: [], notes: ["Self-upgrade loop established. From here the daily review tunes judgment data only — taste counters, daypart seeds, requests-playlist hygiene — and files code ideas as proposals in brain/proposals for Amani's review. Meechie never edits his own code."] }] };
    await selfWrite(deps, "brain/selflog", doc);
    try { const p = await deps.readDoc(deps.env, "brain/proposals"); if (!p) await selfWrite(deps, "brain/proposals", { v: 1, items: [] }); } catch (_) {}
    try { const st = await deps.readDoc(deps.env, "brain/seedstats"); if (!st) await selfSeedNote(deps.env, []); } catch (_) {}
    return { ran: "baseline" };
  }
  // Seedstats repair: the first shipped baseline's raw-SQL insert could
  // not create this doc on the live table shape (see selfSeedNote) — if
  // it is still missing, establish it now. Empty counters are
  // bookkeeping, not a judgment change, so this is not gated on the
  // quiet window; once the doc exists this costs one read per check.
  try { const st0 = await deps.readDoc(deps.env, "brain/seedstats"); if (!st0) await selfSeedNote(deps.env, []); } catch (_) {}
  // Regular review gates: quiet hours, once per ET day, and the owner's
  // kill switch stands Meechie down entirely.
  if (S && S.aiDj === false) return { ran: false, note: "kill switch" };
  if (et.minutes < SELF_QUIET_START || et.minutes > SELF_QUIET_END) return { ran: false, note: "outside quiet hours" };
  if (selflog.lastRunDay === et.day) return { ran: false, note: "already ran today" };
  const changes = [], notes = [];
  const metrics = { plays24: 0, ends24: 0, skips24: 0, requests24: 0, plays7: 0, skips7: 0, draws7: 0, drawnPlayed7: 0 };
  let key7 = new Map();
  try {
    const c24 = await deps.env.DB.prepare("select type, count(*) as c from brain_events where at > ? group by type").bind(now - SELF_DAY).all();
    for (const r of (c24.results || [])) { if (r.type === "play") metrics.plays24 = +r.c || 0; else if (r.type === "end") metrics.ends24 = +r.c || 0; else if (r.type === "skip") metrics.skips24 = +r.c || 0; else if (r.type === "request") metrics.requests24 = +r.c || 0; }
    const k7 = await deps.env.DB.prepare("select key, type, count(*) as c from brain_events where at > ? and key != '' group by key, type").bind(now - 7 * SELF_DAY).all();
    for (const r of (k7.results || [])) { if (!r.key) continue; const m = key7.get(r.key) || { p: 0, e: 0, s: 0 }; if (r.type === "play") { m.p += +r.c || 0; metrics.plays7 += +r.c || 0; } else if (r.type === "end") m.e += +r.c || 0; else if (r.type === "skip") { m.s += +r.c || 0; metrics.skips7 += +r.c || 0; } key7.set(r.key, m); }
    const d7 = await deps.env.DB.prepare("select count(*) as c from brain_events where at > ? and actor = 'aidj' and type = 'draw'").bind(now - 7 * SELF_DAY).all();
    metrics.draws7 = +(((d7.results || [])[0] || {}).c) || 0;
    const drawn = await deps.env.DB.prepare("select distinct key from brain_events where at > ? and actor = 'aidj' and type = 'draw' and key != ''").bind(now - 7 * SELF_DAY).all();
    for (const r of (drawn.results || [])) { const m = key7.get(r.key); if (m && m.p > 0) metrics.drawnPlayed7++; }
    } catch (_) { notes.push("Station activity read failed this run — judgment changes limited to playlist hygiene."); }
  // 3b) TV WATCH (Guardian, 2026-11-03): what the channel aired and
  // how the room met it — completions, skips, crowd kills, Guardian
  // interventions — plus the Eyes LOOK-BOOK digest (sampled-frame
  // vision reads of what actually aired). Read-only here: the
  // keeper writes brain/tvwatch; this review cites it in metrics,
  // notes and proposals. TV evidence never widens the write
  // allowlist and never touches the daypart clock.
  let tvAgg = null; const tvCands = [];
  try {
    const tw = await deps.readDoc(deps.env, "brain/tvwatch");
    if (tw && tw.days && typeof tw.days === "object") {
      const agg = { aired: 0, completed: 0, ownerSkip: 0, crowdSkip: 0, guardian: 0, cut: 0, cutWindow: 0, byId: {} };
      const dayKeys = Object.keys(tw.days).sort().slice(-7);
      for (const dk of dayKeys) {
        const d = tw.days[dk]; if (!d) continue;
        for (const f of ["aired", "completed", "ownerSkip", "crowdSkip", "guardian", "cut", "cutWindow"]) agg[f] += +d[f] || 0;
        for (const [id, b] of Object.entries(d.byId || {})) {
          const t = agg.byId[id] || (agg.byId[id] = { title: (b && b.title) || id, aired: 0, completed: 0, kills: 0, up: 0, down: 0 });
          t.aired += +b.aired || 0; t.completed += +b.completed || 0; t.kills += +b.kills || 0; t.up += +b.up || 0; t.down += +b.down || 0;
        }
      }
      if (agg.aired > 0) {
        tvAgg = agg;
        metrics.tv = { aired7: agg.aired, completed7: agg.completed, crowdKills7: agg.crowdSkip, guardianAdv7: agg.guardian, ownerSkips7: agg.ownerSkip };
        const pct = Math.round(100 * agg.completed / Math.max(1, agg.aired));
        notes.push("TV: last 7 days MW TV aired " + agg.aired + " recorded programs; " + agg.completed + " ran to completion (" + pct + "%), the crowd killed " + agg.crowdSkip + ", the Guardian advanced " + agg.guardian + " confirmed-dead picks and Malik skipped " + agg.ownerSkip + " himself.");
        const loved = Object.entries(agg.byId).map(([id, b]) => ({ id, ...b })).filter((b) => b.aired >= 2 && b.completed >= 2).sort((a, b2) => (b2.completed / Math.max(1, b2.aired)) - (a.completed / Math.max(1, a.aired)) || b2.completed - a.completed).slice(0, 3);
        for (const b of loved) notes.push("TV loved: “" + String(b.title).slice(0, 60) + "” finished " + b.completed + " of " + b.aired + " airings (votes +" + b.up + "/−" + b.down + ").");
        const killed = Object.entries(agg.byId).map(([id, b]) => ({ id, ...b })).filter((b) => b.kills >= 2).sort((a, b2) => b2.kills - a.kills).slice(0, 3);
        for (const b of killed) { notes.push("TV killed: “" + String(b.title).slice(0, 60) + "” was crowd-killed or Guardian-advanced " + b.kills + " times across " + b.aired + " airings."); tvCands.push({ id: "tv-repeat-kill-" + b.id, title: "MW TV keeps losing “" + String(b.title).slice(0, 50) + "”", why: "In the last 7 days this title aired " + b.aired + " times and was crowd-skipped or Guardian-advanced as unplayable " + b.kills + " times (brain/tvwatch). The Guardian quarantines a video only after 2 confirmed-dead airings; repeated CROWD kills are a taste verdict, not a fault — a human should decide whether it leaves the pool or the crowd is wrong." }); }
        const stars = Object.entries(agg.byId).map(([id, b]) => ({ id, ...b })).filter((b) => b.aired >= 3 && b.completed / Math.max(1, b.aired) >= 0.8 && (b.up - b.down) > 0 && !loved.some((l) => l.id === b.id)).slice(0, 1);
        for (const b of stars) tvCands.push({ id: "tv-crowd-star-" + b.id, title: "MW TV crowd star: “" + String(b.title).slice(0, 50) + "”", why: "brain/tvwatch: " + b.aired + " airings in 7 days, " + b.completed + " completions, net votes +" + (b.up - b.down) + ". Vote weighting already lifts it in the bag; featuring it (a named slot, a promo) is a human programming call." });
      } else notes.push("TV: brain/tvwatch exists but no program records yet — the Guardian's watch records are still gathering.");
      if (tw && Array.isArray(tw.eyes) && tw.eyes.length) {
        const latest = tw.eyes.slice(-3).reverse();
        for (const e of latest) { const r = (e && e.read) || {}; notes.push("Eyes (sampled frame, " + (e.src || "seat") + "): “" + String((e && e.title) || "").slice(0, 50) + "” — " + String(r.setting || "—").slice(0, 90) + (r.screenText ? "; on-screen text: “" + String(r.screenText).slice(0, 80) + "”" : "") + (r.faults ? "; visible fault noted: " + String(r.faults).slice(0, 80) : "") + "."); }
      }
    } else notes.push("TV: no brain/tvwatch doc yet — the Guardian's first watch records land as programs roll off the air.");
  } catch (_) { notes.push("TV: brain/tvwatch read failed this run — TV evidence skipped, nothing else affected."); }
  // 1) TASTE SHARPENING — bounded counter nudges from the trailing 7
  // days: a track the room keeps skipping earns one more skip on its
  // record; a track that keeps playing to the end earns one more end.
  // The fold's weights are clamped in the lib, so a nudge can sharpen a
  // preference but never run away with it.
  let taste = null; try { taste = await deps.readTaste(deps.env); } catch (_) {}
  let tasteDirty = false;
  if (taste && taste.tracks) {
    let skipN = 0, endN = 0;
    for (const [key, m] of key7) {
      const tr = taste.tracks[key]; if (!tr) continue;
      const ar = tr.artist && taste.artists ? taste.artists[tr.artist] : null;
      if (skipN < SELF_TASTE_MAX && m.p >= 3 && m.e === 0 && m.s * 2 >= m.p) { const before = +tr.s || 0; tr.s = before + 1; if (ar) ar.s = (+ar.s || 0) + 1; changes.push("taste: \"" + String(tr.title || key).slice(0, 60) + "\" skips " + before + " → " + tr.s + " (last 7d: " + m.p + " plays, " + m.s + " skips, 0 completions)"); skipN++; tasteDirty = true; continue; }
      if (endN < SELF_TASTE_MAX && m.e >= 3 && m.s === 0) { const before = +tr.e || 0; tr.e = before + 1; if (ar) ar.e = (+ar.e || 0) + 1; changes.push("taste: \"" + String(tr.title || key).slice(0, 60) + "\" completions " + before + " → " + tr.e + " (last 7d: " + m.e + " full plays, 0 skips)"); endN++; tasteDirty = true; }
    }
    if (tasteDirty) { taste.updatedAt = now; await selfWrite(deps, "brain/taste", taste); }
    else notes.push("Taste: no track crossed the sharpen thresholds in the last 7 days — weights unchanged.");
  } else notes.push("Taste: no brain/taste doc yet — nothing to sharpen.");
  // 2) DAYPART SEED ROTATION — inside the blocks only; hours and names
  // are copied verbatim and re-validated before any write.
  let seedDocDirty = false, retiredThisRun = [];
  let seedstats = null; try { seedstats = await deps.readDoc(deps.env, "brain/seedstats"); } catch (_) {}
  const stats = seedstats && seedstats.seeds && typeof seedstats.seeds === "object" ? seedstats.seeds : {};
  let blocks = deps.aiDjDefaultDayparts(), hadDoc = false;
  try { const doc = await deps.readDoc(deps.env, "brain/dayparts"); const valid = deps.aiDjValidBlocks(doc); if (valid) { blocks = valid; hadDoc = true; } } catch (_) {}
  let anchors = [];
  if (taste && taste.artists) anchors = Object.entries(taste.artists).map(([name, c]) => ({ name, sc: deps.tasteScore(c) })).filter((a) => a.sc > 0).sort((a, b) => b.sc - a.sc || (a.name < b.name ? -1 : 1));
  const FALLBACK_SEED = { traplove: "trap soul mix", weed: "chill rap mix", mixed: "throwback hits mix" };
  const newBlocks = blocks.map((b) => ({ start: b.start, end: b.end, name: b.name, seeds: b.seeds.slice() }));
  let totalPasses = 0; for (const s of Object.values(stats)) totalPasses += +s.passes || 0;
  if (totalPasses < SELF_SEED_MIN_PASSES) notes.push("Seeds: still gathering evidence (" + totalPasses + " Auto-DJ passes recorded) — no seed changes yet.");
  else for (let bi = 0; bi < newBlocks.length; bi++) {
    const b = newBlocks[bi];
    // retire at most one dead seed per block per review
    const dry = b.seeds.map((q) => ({ q, s: stats[q] || null })).filter((x) => x.s && (+x.s.passes || 0) >= SELF_SEED_MIN_PASSES && (+x.s.landed || 0) === 0);
    const weak = b.seeds.map((q) => ({ q, s: stats[q] || null })).filter((x) => x.s && (+x.s.passes || 0) >= SELF_SEED_MIN_PASSES && (+x.s.landed || 0) >= 3 && (+x.s.played || 0) === 0);
    const victim = dry[0] || weak[0] || null;
    if (victim && b.seeds.length > 2) {
      const inBlock = (cand) => b.seeds.some((q) => aiDjNorm(q).includes(aiDjNorm(cand)) || aiDjNorm(cand).includes(aiDjNorm(q)));
      let repl = "";
      for (const a of anchors) { const cand = (a.name + " mix").slice(0, 60); if (cand !== victim.q && !inBlock(a.name)) { repl = cand; break; } }
      if (!repl) { const fb = FALLBACK_SEED[b.name] || "new music mix"; if (fb !== victim.q && !b.seeds.includes(fb)) repl = fb; }
      if (repl) { b.seeds[b.seeds.indexOf(victim.q)] = repl; seedDocDirty = true; retiredThisRun.push({ block: b.name, seed: victim.q }); changes.push("seeds[" + b.name + "]: retired \"" + victim.q + "\" (" + (+victim.s.passes || 0) + " passes, " + (+victim.s.landed || 0) + " landed, " + (+victim.s.played || 0) + " played) → \"" + repl + "\""); }
      else notes.push("Seeds[" + b.name + "]: \"" + victim.q + "\" is dead but no fresh replacement is available — left in place.");
    }
    // promotion: best-yield seed first (stable; unrated seeds keep place)
    const rated = b.seeds.filter((q) => stats[q] && (+stats[q].played || 0) > 0);
    if (rated.length >= 2) {
      const sorted = b.seeds.slice().sort((x, y) => ((+((stats[y] || {}).played) || 0) - (+((stats[x] || {}).played) || 0)));
      if (sorted.join("\n") !== b.seeds.join("\n")) { b.seeds = sorted; seedDocDirty = true; changes.push("seeds[" + b.name + "]: reordered best-yield first — \"" + sorted[0] + "\" now leads (" + (+((stats[sorted[0]] || {}).played) || 0) + " plays from Auto-DJ stock)"); }
    }
  }
  if (seedDocDirty) {
    const v = deps.aiDjValidBlocks({ blocks: newBlocks });
    const clockOk = !!v && v.length === blocks.length && v.every((b, i) => b.start === blocks[i].start && b.end === blocks[i].end && b.name === blocks[i].name);
    if (clockOk) { await selfWrite(deps, "brain/dayparts", { blocks: v, updatedAt: now, by: "meechie-self" }); if (!hadDoc) notes.push("brain/dayparts doc created from the live program so future seed rotations have a document to tune — hours and names identical to the code fallback."); }
    else { notes.push("Seeds: rebuilt dayparts failed clock validation — seed changes aborted, nothing written."); seedDocDirty = false; }
  }
  // 3) REQUESTS PLAYLIST HYGIENE — prune what can never legally play
  // (ban-listed ids) and decay stale repeat counts so last month's
  // requests stop outweighing this week's. The weighting itself lives
  // in rqWeightedOrder, used by the lane at refill.
  let rq = null; try { rq = await deps.readDoc(deps.env, "station/rqplaylist"); } catch (_) {}
  if (rq && Array.isArray(rq.items) && rq.items.length) {
    let banIds = new Set(); try { const bdoc = await deps.readDoc(deps.env, "brain/ytblock"); if (bdoc && Array.isArray(bdoc.ids)) banIds = new Set(bdoc.ids.map(String)); } catch (_) {}
    const before = rq.items.length;
    const pruned = rq.items.filter((r) => r && r.yt && banIds.has(String(r.yt)));
    if (pruned.length) { rq.items = rq.items.filter((r) => !(r && r.yt && banIds.has(String(r.yt)))); for (const r of pruned) changes.push("requests: pruned \"" + String(r.title || r.yt).slice(0, 60) + "\" — its video is on the ban list and can never play"); }
    let decayed = 0;
    for (const r of rq.items) { if (r && +r.at > 0 && now - +r.at > 14 * SELF_DAY && (+r.n || 1) > 1) { const beforeN = +r.n; r.n = Math.max(1, Math.ceil(beforeN / 2)); decayed++; if (decayed <= 3) changes.push("requests: \"" + String(r.title || r.k).slice(0, 60) + "\" repeat count " + beforeN + " → " + r.n + " (no fresh requests in 14+ days)"); } }
    if (decayed > 3) changes.push("requests: repeat counts decayed on " + decayed + " stale items (halved, floor 1)");
    if (pruned.length || decayed) { rq.updatedAt = now; await selfWrite(deps, "station/rqplaylist", rq); }
    else notes.push("Requests: playlist of " + before + " items is clean — nothing banned, nothing stale.");
  } else notes.push("Requests: no saved requests playlist yet — nothing to tune.");
  // 4) PROPOSALS — patterns data can't fix become documents for Amani.
  // One per review, never a duplicate inside 7 days. Meechie files
  // these; he does not act on them. Code is changed by people, through
  // pull requests — that boundary is the design, not a limitation.
  try {
    let props = await deps.readDoc(deps.env, "brain/proposals");
    if (!props || !Array.isArray(props.items)) props = { v: 1, items: [] };
    const recent = (id) => props.items.some((p) => p && p.id === id && now - (+p.at || 0) < 7 * SELF_DAY);
    const cands = [];
    for (const r of retiredThisRun) { const prev = selflog.entries.some((e) => e && now - (+e.at || 0) < 7 * SELF_DAY && Array.isArray(e.changes) && e.changes.some((c) => String(c).includes("seeds[" + r.block + "]") && String(c).includes("retired"))); if (prev) cands.push({ id: "dry-lane-" + r.block, title: "Lane '" + r.block + "' keeps eating dead seeds", why: "A seed in this block was retired for returning nothing in two reviews inside a week (latest: \"" + r.seed + "\"). The seed well for this lane is running dry — a code-level look at new sources or search shapes for the lane would beat more seed swaps." }); }
    if (metrics.plays7 >= 100 && metrics.skips7 * 20 >= metrics.plays7 * 7) cands.push({ id: "high-skip-rate", title: "Station skip rate is high", why: "Last 7 days: " + metrics.skips7 + " skips on " + metrics.plays7 + " plays (≥35%). Taste nudges alone won't fix a rate like that — worth a human look at lane mixes and pool sources." });
    if (taste && Object.keys(taste.tracks || {}).length >= 395) cands.push({ id: "taste-at-cap", title: "Taste profile is at its cap", why: "brain/taste holds " + Object.keys(taste.tracks || {}).length + " of 400 tracks; the fold evicts the coldest on every write. If the cap should grow, that's a code change in lib/brain-taste.js." });
    if (taste && anchors.length === 0) cands.push({ id: "no-taste-anchors", title: "No positive taste anchors", why: "No artist currently scores above zero, so Auto-DJ picks fall back to library frequency. If that persists, the anchor rule itself may need a human look." });
    for (const c of tvCands) cands.push(c);
    const fresh = cands.find((c) => !recent(c.id));
    if (fresh) { props.items.push({ at: now, id: fresh.id, title: fresh.title, why: fresh.why, status: "open" }); props.items = props.items.slice(-20); await selfWrite(deps, "brain/proposals", props); changes.push("proposal filed: \"" + fresh.title + "\" (brain/proposals — for Amani's review; Meechie does not edit his own code)"); }
  } catch (_) {}
  const summary = "Daily self-review: last 24h " + metrics.plays24 + " plays, " + metrics.ends24 + " completions, " + metrics.skips24 + " skips, " + metrics.requests24 + " requests; Auto-DJ stocked picks that went on to play: " + metrics.drawnPlayed7 + " of the distinct videos drawn in 7d." + (tvAgg ? " MW TV: " + tvAgg.aired + " programs aired in 7d, " + Math.round(100 * tvAgg.completed / Math.max(1, tvAgg.aired)) + "% ran to completion, " + (tvAgg.crowdSkip + tvAgg.guardian) + " killed by crowd/Guardian, " + tvAgg.ownerSkip + " owner skips." : "") + " " + changes.length + " change(s) made, all logged below.";
  selflog.entries.push({ at: now, kind: "review", summary, changes, notes, metrics });
  selflog.entries = selflog.entries.slice(-90);
  selflog.lastRunDay = et.day; selflog.lastRunAt = now;
  await selfWrite(deps, "brain/selflog", selflog);
  return { ran: "review", changes: changes.length };
}
/* SELF-REVIEW-END */
/* HANDS-BEGIN — MEECHIE'S HANDS: the keeper-side drain (Malik,
 * 2026-11-03: "I want him to be able to touch the tv and radio or do
 * anything you can do to his site"). The shared core — control doc,
 * log, queue, authority, immediate actions — lives in
 * lib/meechie-hands.js. What lives HERE is only what must run inside
 * the keeper's timeline: commands queued from chat / the POST door
 * (brain/commands) execute on this tick, through the keeper's own
 * mechanisms, under the keeper's own rules:
 *  - OWNER SUPREMACY: a fresh booth (BOOTH_FRESH) stands every radio
 *    command down, silently, until the booth goes stale or the
 *    command's window (HANDS_CMD_TTL) closes and it resolves as
 *    expired. TV commands never wait for the booth (the wall).
 *  - KILL SWITCH: brain/control.hands === false refuses everything.
 *  - THE WALL BOTH WAYS: radio commands mutate only S (radio/dj) and
 *    read tv/quarternews read-only for the news decision; the one TV
 *    command (tv.skip) writes only tv/now.
 *  - EVERY OUTCOME IS LOGGED to brain/selflog (actor "Meechie").
 * The drain never throws: a hands failure can never hurt the station. */
let handsCtlMemo = { at: 0, ctl: null };
async function handsCtlCached(env, now) {
  if (handsCtlMemo.ctl && now - handsCtlMemo.at < 30000) return handsCtlMemo.ctl;
  const ctl = await HANDS.handsControl(env);
  handsCtlMemo = { at: now, ctl };
  return ctl;
}

/* First tick after the hands ship, with no control doc yet: Meechie
 * introduces himself on the Book (the one harmless live action of the
 * rollout — a badged announcement Malik can delete), the control doc
 * is born with the kill switch ON (hands live), and the moment is
 * logged. Runs at most once: the control doc's existence is the flag. */
async function handsActivate(env) {
  await HANDS.handsSetControl(env, { hands: true, aiHold: false, announced: true }, "system");
  try {
    const a = await HANDS.handsAnnounce(env, "🤖 Hey everybody — Meechie AI here. Malik gave me hands on the site: I can run the radio, MW TV and the Show Studio desk for him, and post here as myself, badged as the AI. Every move I make is logged where he can read it. Global, not local. — Meechie AI");
    await HANDS.handsLog(env, { action: "hands.online", target: "posts/" + a.id, summary: "Meechie's hands went live under Malik's 2026-11-03 order. Activation announcement posted to the Book (badged, deletable). Kill switch: brain/control + the booth BRAIN panel.", by: "system", role: "owner" });
  } catch (_) {}
}

/* D1 READ FIX: the commands-doc memo for the drain below. The
 * drain runs twice per station ping and used to read brain/control
 * + brain/commands from D1 both times; in the common case (nothing
 * queued) a warm memo now answers with zero D1 reads. */
let handsCmdMemo = { at: 0, doc: null };
let handsCtlSeen = false; // this isolate has confirmed the control doc exists at least once

/* K = { S, now, tvOnly, deps, startDeckItem, cur, brainEvts }.
 * Returns { changed, cur } for the tick to fold in. */
async function handsDrain(env, K) {
  const S = K.S, now = K.now;
  let changed = false, cur = K.cur || null;
  try {
    /* D1 READ FIX: commands first, through the memo (deep-copied —
       the drain mutates the doc). Nothing queued + control already
       seen on this isolate = return before the control read. The
       kill switch is still read fresh from D1 on every drain that
       has work, and a cold isolate runs the original control +
       activation path below, unchanged. */
    let doc;
    if (handsCmdMemo.doc && now - handsCmdMemo.at < DOC_MEMO_TTL) doc = JSON.parse(JSON.stringify(handsCmdMemo.doc));
    else { doc = await HANDS.handsCommandsRead(env); handsCmdMemo = { at: now, doc: JSON.parse(JSON.stringify(doc || { items: [] })) }; }
    const items = Array.isArray(doc.items) ? doc.items : [];
    if (!items.some((c) => c && c.status === "queued")) {
      if (handsCtlSeen) return { changed, cur };
      const ctl0 = await HANDS.handsControl(env);
      if (!ctl0.exists) { await handsActivate(env); handsCmdMemo.at = 0; return { changed, cur }; }
      handsCtlSeen = true;
      return { changed, cur };
    }
    let ctl = await HANDS.handsControl(env);
    if (!ctl.exists) { await handsActivate(env); ctl = await HANDS.handsControl(env); }
    handsCtlSeen = true;
    const boothFresh = !!(S.boothAt && now - S.boothAt < BOOTH_FRESH);
    let dirty = false;
    for (const cmd of items) {
      if (!cmd || cmd.status !== "queued") continue;
      const isRadio = String(cmd.action || "").startsWith("radio.");
      const isTvSkip = cmd.action === "tv.skip";
      if (K.tvOnly && !isTvSkip) continue;
      const age = now - (+cmd.at || 0);
      const finish = (status, result) => { cmd.status = status; cmd.doneAt = now; cmd.result = String(result || "").slice(0, 300); dirty = true; };
      const logIt = (summary, refusedFlag) => HANDS.handsLog(env, { action: cmd.action, target: "brain/commands/" + cmd.id, summary, refused: !!refusedFlag, by: cmd.by || "", uid: cmd.uid || "", role: cmd.role || "owner" });
      if (!ctl.hands) { finish("refused", "kill switch OFF"); await logIt("Refused: the kill switch is OFF — nothing Meechie does goes through.", true); continue; }
      if (age > HANDS.HANDS_CMD_TTL) { finish("expired", "stood down — window passed"); await logIt("Stood down: the command aged out before the keeper could run it (booth busy or station quiet). Nothing was touched.", true); continue; }
      if (!K.tvOnly && isRadio && boothFresh) continue; // owner supremacy: stands down silently until the booth goes stale
      try {
        if (cmd.action === "radio.stock") {
          if (ctl.aiHold) { finish("refused", "AI stocking on hold"); await logIt("Refused: AI stocking is on hold.", true); continue; }
          const r = await aiDjPass({ ...(K.deps || {}), force: true }, S, now);
          if (r && r.changed) changed = true;
          if (r && r.events && r.events.length && Array.isArray(K.brainEvts)) K.brainEvts.push(...r.events);
          finish("done", "pass: " + (r ? r.note : "?"));
          await logIt("Stocked the AI queue on command — pass result: " + (r ? r.note : "unknown") + ". The AI line now holds " + (Array.isArray(S.aiQ) ? S.aiQ.length : 0) + " pick(s), all inside the daypart grid and the playability gate.");
        } else if (cmd.action === "radio.skipAi") {
          if (!Array.isArray(S.aiQ) || !S.aiQ.length) { finish("done", "AI queue already empty"); await logIt("Skip asked, but the AI queue was already empty — nothing removed."); continue; }
          let ix = 0; const want = cmd.args && (cmd.args.yt || cmd.args.title);
          if (want) { const f = S.aiQ.findIndex((it) => it && (String(it.yt) === String(want) || String(it.title || "").toLowerCase().includes(String(want).toLowerCase()))); if (f >= 0) ix = f; }
          const gone = S.aiQ.splice(ix, 1)[0]; changed = true;
          finish("done", "removed: " + (gone && (gone.title || gone.yt)));
          await logIt("Removed an AI pick from the queue: “" + String((gone && (gone.title || gone.yt)) || "").slice(0, 80) + "”. " + S.aiQ.length + " AI pick(s) remain. Malik's own queue was not touched.");
        } else if (cmd.action === "radio.pickNext") {
          const q = String((cmd.args && cmd.args.query) || "").trim();
          if (!q) { finish("refused", "nothing named"); await logIt("Refused: pick-next with nothing named.", true); continue; }
          const rows = await aiDjSearch(K.deps || {}, q);
          const banned = new Set(); const addId = (v) => { if (v) banned.add(String(v)); };
          if (Array.isArray(S.aiQ)) for (const it of S.aiQ) addId(it && it.yt);
          if (Array.isArray(S.queue)) for (const it of S.queue) addId(it && it.yt);
          if (Array.isArray(S.schedQ)) for (const it of S.schedQ) addId(it && it.yt);
          for (const k of ["A", "B", "C", "D"]) addId(S[k] && S[k].yt);
          try { const blk = await readDoc(env, "brain/ytblock"); for (const id of (blk && blk.ids) || []) addId(id); } catch (_) {}
          const hit = rows.find((r) => r && r.id && +r.dur > 0 && !banned.has(String(r.id)));
          if (!hit) { finish("done", "nothing playable found"); await logIt("Pick-next for “" + q.slice(0, 60) + "”: the embed gate returned nothing new and playable, so the line is unchanged."); continue; }
          if (!Array.isArray(S.aiQ)) S.aiQ = [];
          S.aiQ.unshift({ yt: hit.id, title: String(hit.title || "").slice(0, 120), cover: "", dur: hit.dur, ai: 1, q, at: now, via: "hands" });
          if (S.aiQ.length > 8) S.aiQ.length = 8;
          changed = true;
          finish("done", "first in AI line: " + hit.title);
          await logIt("Put “" + String(hit.title || "").slice(0, 80) + "” first in the AI line (asked: “" + q.slice(0, 60) + "”) — it plays right behind Malik's queue and listener picks, never over them.");
        } else if (cmd.action === "radio.newsNow") {
          /* tvRadioDecision's checks, minus ONLY the 5-minute window:
             Malik's order is that Meechie may fire the piece early or
             late inside its freshness window. Freshness, quarter match,
             already-fired and station-live checks all still bind. The
             interrupt itself is the rotation block's own move, copied
             exactly: park honestly, start on the free deck, stamp. */
          const qDoc = await readDoc(env, "tv/quarternews");
          const cur2 = qDoc && qDoc.current;
          let why = "";
          if (!qDoc || qDoc.on === false || !cur2 || !cur2.radioUrl || !(+cur2.radioDur > 0)) why = "no quarter piece exists";
          else {
            const qStart = Math.floor(now / TV_AD_EVERY_MS) * TV_AD_EVERY_MS;
            const et = tvEtParts(now);
            const qKey = et.dayKey + "T" + et.hour + ":" + String(Math.floor(et.minute / 15) * 15).padStart(2, "0");
            if (+cur2.forQuarter !== qStart) why = "the newest piece belongs to a different quarter";
            else if (+cur2.producedAt > now) why = "the piece is stamped in the future";
            else if (now - +cur2.producedAt > TV_QUARTER_FRESH_MS) why = "the piece is past its freshness window — stale news never airs";
            else if (S.newsHour === qKey) why = "this quarter's piece already aired";
            else if (!S.live || !S.autodj || S.pausedAt) why = "the station isn't in live Auto-DJ right now";
            else if (!cur || !K.startDeckItem) why = "no deck is turning to cut from";
            else {
              const other = cur === "A" ? "B" : "A";
              if (S[cur].playing && !S[other].playing && now - (S[cur].start || now) > 10000) {
                S[cur].playing = false; S[cur].pos = Math.max(0, Math.min(+S[cur].dur || 0, (now - (S[cur].start || now)) / 1000));
                K.startDeckItem(other, { src: String(cur2.radioUrl), title: "📰 Meechie's World News", dur: Math.min(600, Math.max(5, Math.round(+cur2.radioDur))) }, now);
                S.xf = 0.5; S.newsHour = qKey; changed = true; cur = other;
                finish("done", "news fired on deck " + other);
                await logIt("Fired this quarter's fresh news piece on the radio on command (" + qKey + ") — cut in on deck " + other + ", the playing song parked honestly where it stopped.");
                continue;
              }
              why = "the decks weren't in a safe spot to cut this second — the normal top-of-quarter window still takes it";
            }
          }
          finish("done", "not fired: " + why);
          await logIt("News-now asked; not fired: " + why + ".");
        } else if (isTvSkip) {
          const nw = await readDoc(env, "tv/now");
          if (!nw || !Array.isArray(nw.segs) || !nw.segs.length) { finish("refused", "channel is dark"); await logIt("Refused: the TV channel is dark — there is no segment to skip.", true); continue; }
          const seg = nw.segs.find((s) => s && now >= +s.start && now < +s.start + (+s.dur || 0) * 1000);
          if (!seg) { finish("refused", "nothing on air this second"); await logIt("Refused: no TV segment is on air this second.", true); continue; }
          if (seg.k !== "prog" && seg.k !== "house") { finish("refused", "programmed window"); await logIt("Refused: what's on TV is a programmed window (“" + seg.k + "”) — premieres, news and inserts are Malik's programming, not skippable.", true); continue; }
          const chan = await readDoc(env, "tv/channel");
          const chanItems = chan && Array.isArray(chan.items) ? chan.items : [];
          const ix = chanItems.findIndex((it) => it && it.id === seg.id);
          if (ix < 0) { finish("refused", "movie chain"); await logIt("Refused: the current piece rides the movie chain, which runs wall-clock — there is no lineup cursor to advance inside it.", true); continue; }
          const cut = Math.max(0.1, Math.round((now - +seg.start) / 100) / 10);
          const keptSegs = [];
          for (const s of nw.segs) { if (s === seg) keptSegs.push({ ...s, dur: cut }); else if (+s.start >= now) { /* the rest of the laid window goes; the keeper re-lays from the new cursor */ } else keptSegs.push(s); }
          nw.segs = keptSegs;
          nw.cursor = { at: now, ix: (ix + 1) % Math.max(1, chanItems.length), off: 0, run: ((nw.cursor && +nw.cursor.run) || 0) + 1 };
          nw.handsSkip = { at: now, id: seg.id };
          nw.genAt = now; nw.updatedAt = now;
          await writeDoc(env, "tv/now", "tv", nw);
          finish("done", "skipped: " + (seg.title || seg.id));
          await logIt("Skipped the TV segment “" + String(seg.title || seg.id).slice(0, 80) + "” — the lineup cursor advanced one piece; the keeper re-lays from there. The radio was not touched.");
        } else { finish("refused", "unknown action"); await logIt("Refused: unknown action “" + String(cmd.action) + "”.", true); }
      } catch (e) {
        finish("refused", "error: " + String((e && e.message) || e).slice(0, 120));
        await logIt("Failed mid-action: " + String((e && e.message) || e).slice(0, 160) + " — the station kept its state.", true);
      }
    }
    if (dirty) { try { await HANDS.handsCommandsWrite(env, doc); handsCmdMemo = { at: now, doc: JSON.parse(JSON.stringify(doc)) }; } catch (_) {} }
  } catch (_) {}
  return { changed, cur };
}
/* HANDS-END */

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const BELL_WINDOW = 120000; // at most one doorbell push per two minutes
/* The DOORBELL (owner, 2026-10-29): when the presence block below spots a
 * genuine new arrival, ring the owner's phones with a Web Push. The
 * subscriptions live in docs (coll "pushsubs"), written only by
 * /api/push/subscribe after it checks the owner session. The VAPID private
 * half never leaves the Pages secrets: VAPID_PRIVATE_KEY if it is ever set,
 * otherwise the VAPID_PRIVATE the message notifications already use — one
 * keypair serves the whole site (its public half is in js/push.js), because
 * a browser registration holds ONE push subscription and two keypairs
 * would make the doorbell and the message notifications fight over it.
 * The two-minute window is claimed in the site/doorbell doc BEFORE
 * sending, so a burst of arrivals lands as one ring; arrivals inside the
 * window are covered by the in-site cards and the 10-minute phone alert.
 * A subscription the push service reports gone (404/410) is pruned with
 * its changes row. Everything here is best-effort: the caller wraps the
 * call, and no failure in this function may ever break the station ping. */
async function doorbell(env, name, online, now) {
  const d = env.VAPID_PRIVATE_KEY || env.VAPID_PRIVATE;
  if (!d) return;
  const rows = await env.DB.prepare("select path, data from docs where coll = 'pushsubs'").all();
  const subs = [];
  for (const r of (rows.results || [])) { try { const s = JSON.parse(r.data); if (s && /^https:\/\//.test(s.endpoint || "") && s.keys && s.keys.p256dh && s.keys.auth) subs.push({ path: r.path, endpoint: s.endpoint, keys: s.keys }); } catch (_) {} }
  if (!subs.length) return; // nobody to ring yet: leave the window unstamped
  const state = await readDoc(env, "site/doorbell");
  if (state && now - (+state.last || 0) < BELL_WINDOW) return;
  await writeDoc(env, "site/doorbell", "site", { last: now });
  const data = { title: "🚪 Meechie's World", body: name + " just came in — " + Math.max(1, online || 1) + " on now", url: "/", tag: "doorbell" };
  await Promise.all(subs.map(async (s) => {
    try {
      const body = await encrypt(JSON.stringify(data), s.keys.p256dh, s.keys.auth);
      const r = await fetch(s.endpoint, { method: "POST", headers: { authorization: await vapid(s.endpoint, d), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" }, body, signal: AbortSignal.timeout(6000) });
      if (r.status === 404 || r.status === 410) {
        await env.DB.prepare("delete from docs where path = ?").bind(s.path).run();
        await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", s.path, "pushsubs", null, null, Date.now()).run();
      }
    } catch (_) {}
  }));
}

/* MWVMIXRESCUE-BEGIN */
/* VMIX RESCUE (mwVmixRescue, 2026-10-29): the second deliberate keeper
 * exception, sibling to the ghost-share switch below. The keeper already
 * rescues the AUDIO when the booth goes stale (it drives A/B itself), but
 * it never touched vmix, and it does not drive C/D — so when a booth tab
 * wedged mid-set with the master screen featuring a C/D deck it had left
 * flagged playing at pos 0, MW TV sat on that corpse forever: every viewer
 * surface follows vmix, and the honest screen slate rightly refuses to
 * fake a picture for a deck that is not producing one. This pass runs
 * only inside the stale-booth authority: booth fresh, a deliberate pause
 * stamped, or the station off, and it never acts. A featured deck counts
 * DEAD when it is not playing at all, when its timeline has run past the
 * end of the track without parking, when its published position has sat
 * at 0 with a known duration for the full zero grace, or when its
 * published position has not moved across observations. Published
 * position is posOf — the start anchor while playing, the pos snapshot
 * otherwise, the same math every client uses — never the raw pos field
 * alone: a keeper-driven deck legitimately sits at snapshot 0 for its
 * whole song while its anchored position advances, and only the
 * anchored reading separates it from a corpse whose position froze at 0.
 * Another deck counts HEALTHY only when its effective position is
 * genuinely advancing across observations and still inside its track.
 * Dead featured plus healthy deck: vmix re-points at the healthy deck
 * (b cleared, t reset, rescueAt stamped) through the normal writeDoc
 * path, so the booth mirrors, Watch, MW TV and the station stage all
 * follow the living deck at once. No healthy deck: hands off — the
 * rotation below creates one, and a later tick rescues. Mode is not a
 * gate: in auto or any owner-set mode the same stale + dead + healthy
 * test applies, because while the booth is stale there is no owner
 * present whose screen choice a dead picture could be honoring.
 * Observations live in an in-isolate map: a first sight (fresh isolate
 * included) is only ever unknown, never a verdict, so an isolate restart
 * can delay a rescue by one grace window but can never cause one. */
const MW_VMIX_OBS = new Map();
const VMIX_ZERO_GRACE = 45000; // a featured deck whose published position sits at 0 this long while the booth is stale is a corpse, not a slow start
const VMIX_FREEZE_GAP = 10000; // the effective position must fail to move across at least this long an observation gap before frozen counts
function mwVmixRescue(S, now, obs) {
  if (!S || !S.live) return "";
  if (S.pausedAt) { obs.clear(); return ""; } // a deliberate pause is his choice: the TV slate is correct then
  if (!S.vmix || typeof S.vmix !== "object") return "";
  if (S.boothAt && now - S.boothAt < BOOTH_FRESH) return ""; // booth present: his screen choices are law
  const vm = S.vmix;
  const eff = (k) => { const dk = S[k]; if (!dk) return 0; return dk.playing ? (+dk.start > 0 ? Math.max(0, (now - +dk.start) / 1000) : (+dk.pos || 0)) : (+dk.pos || 0); };
  // observe every deck first: dead and healthy are both judged across
  // ticks, and a first sight is only ever unknown, never a verdict
  const seen = {};
  for (const k of ["A", "B", "C", "D"]) {
    const dk = S[k] || {};
    const prev = obs.get(k);
    const cur = { eff: eff(k), at: now, playing: !!dk.playing, zeroSince: 0 };
    if (dk.playing && cur.eff <= 0.05 && +dk.dur > 0) cur.zeroSince = (prev && prev.playing && prev.eff <= 0.05 && prev.zeroSince) ? prev.zeroSince : now;
    seen[k] = { cur, prev };
    obs.set(k, cur);
  }
  const healthy = (k) => {
    const dk = S[k]; if (!dk || !dk.playing) return false;
    const s = seen[k];
    if (!s.prev || !s.prev.playing) return false;
    if (s.cur.eff - s.prev.eff < 1) return false; // genuinely advancing, not jitter
    if (+dk.dur > 0 && s.cur.eff > +dk.dur + 5) return false; // past its end is a corpse, not a healthy deck
    return true;
  };
  const dead = (k) => {
    const dk = S[k]; if (!dk) return true;
    if (!dk.playing) return true; // a stopped deck on the master screen while the station plays elsewhere
    const s = seen[k];
    const dur = +dk.dur || 0;
    if (dur > 0 && s.cur.eff > dur + 30) return true; // timeline ran past the end and never parked
    if (dur > 0 && s.cur.eff <= 0.05 && s.cur.zeroSince && now - s.cur.zeroSince >= VMIX_ZERO_GRACE) return true; // published position sat at zero past the grace window
    // frozen across observations — mid-track, or at zero with no known
    // duration (the grace rule above needs a duration, so a zero-frozen
    // deck without one is judged here instead; zero with a duration is
    // governed by the grace alone, so a slow start is never rushed)
    if (s.prev && s.prev.playing && now - s.prev.at >= VMIX_FREEZE_GAP && s.cur.eff - s.prev.eff < 0.5 && (s.cur.eff > 0.05 || !(dur > 0))) return true;
    return false;
  };
  const a = String(vm.a || ""), b = String(vm.b || "");
  const t = +vm.t || 0;
  if (b && t > 0 && t < 1) return ""; // mid-transition: never yank the screen mid-fade
  const featured = [];
  if (a) featured.push(a);
  if (b && t >= 1 && b !== a) featured.push(b);
  if (featured.some((k) => !dead(k))) return ""; // a living deck is on the screen: hands off
  const target = ["A", "B", "C", "D"].find((k) => !featured.includes(k) && healthy(k));
  if (!target) return "";
  vm.a = target; vm.b = ""; vm.t = 0; vm.at = now; vm.rescueAt = now;
  return target;
}
/* MWVMIXRESCUE-END */

/* MWTV-BEGIN */
/* MW TV — THE PROGRAMMED CHANNEL (Stage 1, 2026-11-01 — Malik: "Let's
 * start my own TV channel" + "Make sure everything's legal").
 * Spec: website/mwtv-channel/SPEC.md (channel) + NEWS-BLOCK.md (news).
 *
 * The keeper is the channel's program director. It lays the ordered
 * lineup (tv/channel) out on one timeline as SEGMENTS in tv/now —
 * programs, music-video breaks drawn from tv/breakpool's shuffle bag,
 * and the hourly :50-:00 news window — and every viewer derives "what
 * is on now, and how far in" from those segment stamps, the same trick
 * posOf() performs for the decks. The channel lives entirely in tv/*
 * docs: this tick reads radio/dj (precedence + the news gate) but the
 * channel never writes it; the radio news break below is a DECISION
 * returned to the rotation section of the same tick, which is the only
 * place keeper code may start a deck.
 *
 * LEGALITY GATE (hard, SPEC §1.7): an item airs only with a complete
 * rights record on it (rights.basis + rights.evidence) and a known
 * duration. Anything else is skipped at generation and held at the
 * boundary re-check. The starter cycle seeded here is fully cleared:
 * Malik's own video plus Internet Archive items whose metadata
 * carries an explicit public-domain / CC0 license mark, read at seed
 * time and quoted in each item's evidence. Embeds never carry
 * simulcast: true; own + PD/CC items do (SPEC §12.2).
 *
 * NEWS (NEWS-BLOCK.md): the :50-:00 window is stamped as a segment of
 * kind "news"; what fills it is resolved at air time from tv/news
 * (fresh edition, else the previous edition once, else a music-video
 * block) — that resolution is client-side; the keeper stamps windows.
 * Since v11 the keeper stamps the window ONLY when a fresh edition
 * exists for it (TV_NEWS_FRESH_MS, judged at the window start) and
 * never over the Family Time span — a window with nothing fresh to
 * serve is not stamped at all, so no client can fill it with a
 * stale edition.
 * The RADIO interrupt is decided by tvRadioDecision: every quarter
 * hour (Malik, 2026-11-03: news+traffic on the radio every 15
 * minutes), a fresh edition (<= 2h old — the NEWS-BLOCK freshness
 * law — with a radio cut) fires; anything missing or stale skips
 * silently and the music never breaks. A due fire falls through the
 * booth stand-down like the breakers do — Malik's standing rule is
 * that the break cuts in even during his own live booth sets, so
 * there is no booth exception. */
const TV_CHAIN_SEC = 720;          // short programs chain until a run reaches 12 min, then a break (SPEC §2.1)
const TV_PROGRAM_V = 22;              // lineup generation: tvSeedChannel/tvSeedPool carry progV; tvTick reseeds any stored lineup older than this (v2 = the 2026-11-02 music-video network — PD classics retired; v3 = the MY EMPIRE premiere commercial joins the break pool; v4 = the Uniontown Local Update break spot joins the pool, held by age from tv/localupdate; v5 = the MY EMPIRE done-by-10 commercial joins the break pool; v6 = the MY EMPIRE every-day-at-8 commercial joins the break pool; v7 = the MY EMPIRE show-spot pool grows (v2 + the three 2026-11-03 spots join the break pool) and the 15-minute rail draws the whole show-spot pool in seeded random rotation, radio spots join the Auto-DJ rotation — Malik, 2026-11-03: play the show commercials randomly, on MW TV and on the radio; v8 = the 2026-11-03 schedule build: stand-up comedy features, TV One Unsung full episodes, Opry Live and WildBrain family clusters join the cycle; v9 = the 5-minute news+traffic update rail (tvUpdSpans) retired (Malik, 2026-11-03 ~14:57: 'no more interruptions every 5 minutes') — the quarter-hour cadence (commercial + chained fresh update) is the only news interruption on the channel; the bump forces the one-time re-lay that clears rail hits already laid in tv/now; v10 = the quarter-freshness build (Malik, 2026-11-03 ~14:54: 'new news every time — 60 seconds of it every 15 minutes with my commercials'): the cadence chains only THIS quarter's fresh update — the character-hosted clip when produced inside the freshness window (TV_QUARTER_FRESH_MS), else the produced quarter piece from tv/quarternews, else nothing; the hourly edition's local update no longer chains at quarters and its radio cut no longer feeds the radio hit — the radio hit plays the quarter piece's own radio cut; the bump forces the re-lay that clears chains laid under the old rules; v11 = the news freshness + Family Time build (Malik, 2026-11-04 ~21:37: "Fix my news" / "8 oclock is supposed to be a kids family movie"): the :50 news window is laid ONLY when tv/news holds an edition produced within TV_NEWS_FRESH_MS before the window start — a stale edition is never laid, the program chain flows through the window instead — and a news window overlapping the Family Time window is never laid at all (Family Time is a hard window; the :50 news no longer passes over the family movie); the bump forces the one-time re-lay that clears stale-edition news windows and news segments inside the Family Time span already laid in tv/now); v12 = the ASAP Preach build (Malik, 2026-11-05 ~08:34 ET: "I want asap preach s music to get shuffled on my tv station"): 20 verified music videos from ASAP Preach's official YouTube channel (@OfficialASAPPreach, channel UCDG6YLw_vMVDRXKErys6EJQ) join the break pool as ordinary cleared auto-picks (kind break, lane "gospel") — YouTube oEmbed HTTP 200 with the artist's own channel as author on every id, each duration pinned from the actual upload via the channel grid and the site embed-gate relay in exact agreement (build record: website/asap-preach-tv-2026-11-05/PROGRESS.md); the bump reseeds tv/breakpool so the new items enter the shuffle bag; v13 = the Deen Squad build (Malik, 2026-11-05 ~11:03 ET: "And deen squad" / "Music videos"): 24 verified music videos from Deen Squad's official YouTube channel (@deensquadmusic, channel UCh6MhPyvzCNz_VF5q9UcV1A) join the break pool as ordinary cleared auto-picks (kind break, lane "faith") — YouTube oEmbed HTTP 200 with the artist's own channel as author on every id, each duration pinned from the actual upload via the channel grid and the site embed-gate relay in exact agreement (build record: website/deen-squad-tv-2026-11-05/PROGRESS.md); the bump reseeds tv/breakpool so the new items enter the shuffle bag; v14 = the ONLY build (Malik, 2026-11-05 12:25 ET: "I only want my 2 cartoons comercials and asap preech videos on my tv channel along with deen squad" — scope confirmed B, shuffle only): the auto-picked fill narrows to ASAP Preach + Deen Squad + the MY EMPIRE house show spots — the cycle seed gains the 44 gospel/faith videos as fill program items (fill: true), tvFillOk gates the chain walk, tvCyclePos and the break bag, and tvMovieState stands the movie chain down as fill (its seed stays: Family Time eligibility reads the shared seeds, which are NOT narrowed — tvFamilyEligible output is unchanged); the scheduled blocks (news window + quarter cadence, anchor, cartoon, Comedy Hour insert, Family Time, premiere/rerun, owner queue) are untouched; the bump reseeds tv/channel + tv/breakpool and re-lays tv/now under the narrowed fill (build record: website/only-lineup-2026-11-05/PROGRESS.md); v15 = the fill mix build (Malik, 2026-11-05 ~14:33 ET: "Wheres asap preach i dont see his videos shuffled into mwtv" — then ~14:38 ET: "And shuffle in my cartoons as well" / "All 3 asap deen and my cartoons"): the v14 membership was right but the ORDER played like blocks — the fill videos sat in the cycle seed as one ASAP Preach run followed by one Deen Squad run and the chain walk plays the seed in order, so ASAP Preach played straight through, then Deen Squad played alone for the better part of an hour. tvSeedChannel now weaves the fill into one shuffled cycle: the 44 ASAP Preach / Deen Squad videos interleave proportionally (each artist's videos keep their seeded order inside the weave; Deen Squad carries four more videos than ASAP Preach, so an extra Deen Squad video lands every so often and no artist plays more than two in a row), and Malik's two barbershop cartoons join the fill as WHOLE EPISODES — the same four files the hourly slot plays (tvCartoonItems), seeded here as fill and dealt into the weave as single units: Part 1 then Part 2 back-to-back, never split, each episode exactly once per pass, the two episodes landing half a cycle apart. The hourly cartoon block is NOT changed: it still plays on its own pinned span every hour (Episode 1, one show commercial, Episode 2, one more commercial), the span still cuts whatever fill is playing — a fill cartoon included — and the fill resumes from its exact offset after the span, exactly like every other fill program. Membership otherwise unchanged: the same 51-id fill set plus the 4 cartoon parts, every other seed item and every scheduled block exactly as before; the bump reseeds tv/channel and re-lays tv/now in the new mixed order (build record: website/fill-interleave-2026-11-05/PROGRESS.md); v16 = the Islamic programming build (Malik, 2026-11-05 ~18:00 ET: "Every friday at 1 i want a kutbah from mufti menk to play and i want the adan to play when its time to pray i want it to be a beautiful recitation. Also i want random islamic shorts to play randomly and find more muslin rap like deen squad and mix that in as well" — picks decided by Malik 2026-11-05 ~19:31 ET): (i) a Friday 13:00 ET KHUTBAH hard window (tvKhutbahWin, rotation doc tv/khutbah) carrying one of 10 verified Mufti Menk Jumu'ah sermons from his OFFICIAL channel @muftimenkofficial in rotation — a true hard window like Family Time: it preempts fill, the break bag, the ad cadence and the owner queue (which freezes and resumes), the hourly cartoon block slides past it as a unit, the :50 news gate refuses any window overlapping it, and it is protected from crowd-skip AND Guardian cuts (owner skip still cuts one Friday's instance, qCut.khutbah); (ii) the ADHAN at the five daily prayer times for Uniontown, PA (ISNA / Aladhan method 2, precomputed daily into the producer-owned doc tv/adhan for today AND tomorrow — a stale or missing day means NO adhan that day, never a guessed time): Malik's picked voice, Mishary Rashid Alafasy — the standard cut (HekbKqYc8Qk) at Dhuhr/Asr/Maghrib/Isha and the Fajr cut (BUQFIszAxnM, carrying 'prayer is better than sleep') at Fajr; the adhan CUTS at the exact prayer minute through fill, the break bag, the cadence and the owner queue (split/resume — nothing is lost), and SLIDES to the end of a cartoon span, an anchor edition, a laid :50 news window, the premiere/rerun and Family Time (Maghrib slides past the movie); the Friday Dhuhr adhan is SUPPRESSED under Jumu'ah (the khutbah is the observance); protected from crowd-skip and Guardian cuts, owner skip can cut one prayer (qCut.adhan, stamped by day+prayer so one cut never suppresses the next); (iii) 25 verified ISLAMIC SHORTS (Mufti Menk x8, Yaqeen Institute x7, Bayyinah x6, Deen Squad x4 — official channels only, oEmbed-verified) join the break pool in a new lane "shorts" admitted by tvFillOk — brief vertical interludes in the break bag only, never program items; the bag never deals two shorts back-to-back, and the 4 Deen Squad behind-the-scenes clips carry sparse:true (Malik: they play "sometimes") — a sparse short enters only every third bag, so it is clearly rarer than the other 21; (iv) 48 more MUSLIM RAP videos join Deen Squad in the faith lane — Native Deen 10, Essam 12, Khalil Ismail 7 (the strict verified set) plus Muslim Belal 12 and Ilyas Mao 7 (Malik, 2026-11-05 ~19:31 ET: Belal and Ilyas are "in") — every id an official-channel upload, oEmbed-verified with the artist's own channel as author, durations pinned from the actual uploads; like Deen Squad they join BOTH the break pool (kind break, lane "faith") and the cycle seed as fill:true program items, so the v15 weave re-deals them into the mixed fill by artist. The seeds are otherwise untouched and Family Time eligibility is unchanged (exactly Johnny Test + Giving Thanks); the bump reseeds tv/channel + tv/breakpool, seeds tv/khutbah, and re-lays tv/now (build record: website/islamic-programming-2026-11-05/PROGRESS.md); v17 = the Ep1 cartoon replacement build (Malik, 2026-11-05 ~19:33 ET: "Replace all copies of episode one of south park in meechies world and put this one in make sure you format it for best speed and quality"): Episode 1 of the barbershop cartoon is REPLACED by the new cut Malik sent — the hourly slot items (tvCartoonItems) and the v15 fill whole-episode unit now point at the new files media/barbershop-cartoon-v2-p1.mp4 and media/barbershop-cartoon-v2-p2.mp4, durations pinned on the keeper's 0.1 s lay grid as 301.3 / 301.3 (measured 301.233 / 301.216 — the pins MUST sit on the grid and clear the slot chain walk's float edge: with off-grid or 301.2/301.2 pins the walker's cumulative subtraction leaves a ~1e-13 s residue at a part boundary, re-selects the finished part with ~0 s remaining and bails to the span end, silently dropping the rest of the block from every span — proven by boundary simulation + harness lays; 301.3/301.3 is the closest grid pair that clears every boundary for every entry point and every in-slot commercial pick (full sweep in the build harness); the walker fragility itself is a pre-existing keeper defect, flagged in the build record, NOT fixed here); the same build renames the Episode 1 viewer titles (Malik, 2026-11-05 ~22:02 ET: "The cartoons name is SOUTH PARK IN MEECHIES WORLD"): the old Ep1 titles ('The Barbershop Cartoon — Part 1 of 2' / 'Part 2 of 2') become 'South Park in Meechie's World — Episode 1, Part 1 of 2' / 'Part 2 of 2', matching Episode 2's format, in the slot items and the fill unit alike — the two different names alternating on a single span were watcher fault 16's mid-program title flicker; this rename is titles only, ids unchanged; the item ids are UNCHANGED (cartoon-barbershop-p1/p2) so fault keys, pins and history carry over; the OLD part files media/barbershop-cartoon-p1.mp4 and media/barbershop-cartoon-p2.mp4 are deleted from the repo in the same change — no copy of the old Episode 1 remains anywhere on the channel; Episode 2 and every other seed item are untouched; the bump reseeds tv/channel + tv/breakpool and re-lays tv/now at the new durations (build record: website/cartoon-ep1-replace-2026-11-05/PROGRESS.md); v18 = the collaborators build (Malik, 2026-11-05 ~22:24 ET: "I want you to add every bodys music video that makes music with asap preach and deen squad into my music shuffle"): every artist with a credited musical collaboration with ASAP Preach or with Deen Squad joins the shuffle with their own official-channel music videos — 165 videos from 18 ASAP Preach collaborators in the gospel lane (Brother Bo 18, Big Yeet 7, Adrion Butler 6, REDEEMED 9, Jysa BP 7, Blizz 7, Kamban 7, Bryann T 10, Tyson James 20, Brett Raio 6, Justo Chalaire 5, Kurtis Hoppie 6, SYL noiZ 4, #HERO 14, Nicky Gracious 12, Marquese Saenz 6, REZUM 13, Nino Salas 8) and 45 videos from 5 Deen Squad-side acts in the faith lane (Jae Deen 6, Karter Zaher 12, KHXLED 7, Waheeb Nasan 11, Lil Baliil 9; Jae Deen and Karter Zaher are Deen Squad's own members, counted on their verified solo channels) — 210 videos total, each an upload on the artist's own official channel (handle canonical and channel title in agreement; per-video YouTube oEmbed HTTP 200 with the artist's own channel as author; "- Topic" auto channels and squatters excluded), each passed the site embed gate (/api/ytsearch) on a title search, and each duration double-pinned in exact agreement (channel grid vs the embed-gate relay; the relay vs the video's own watch page for the few uploads not on a channel grid). Like the v16 rap set they join BOTH the break pool (kind break, lane "gospel"/"faith") and the cycle seed as fill:true program items, so the v15 weave re-deals them into the mixed fill by artist; tvFillOk itself is UNCHANGED — the new break items ride the two lanes it already admits and the new program items ride fill:true. Same-song uploads mirrored on two collaborators' channels are carried once (kept on one artist's set, held on the other's), and no item already in the pool is duplicated. The seeds are otherwise untouched and Family Time eligibility is unchanged (exactly Johnny Test + Giving Thanks); the bump reseeds tv/channel + tv/breakpool and re-lays tv/now (build record: website/collaborators-tv-2026-11-05/PROGRESS.md); v19 = the adhan voice swap (Malik, 2026-11-06 08:18 ET — his tap: B, use the Mufti Menk channel live Makkah recordings): the pinned adhan pair changes from Alafasy to the live Makkah athaan recordings on the official channel of Mufti Menk (@muftimenkofficial) — standard cut aZ5RxRFBu-8 (217 s, the live Maghrib athaan at the door of the Kaabah) for Dhuhr/Asr/Maghrib/Isha, Fajr cut tagIhATHfPs (185 s, the live Fajr athaan from Makkah) at Fajr; oEmbed author "Mufti Menk" verified 2026-11-06 and both durations double-pinned from the actual uploads; Malik picked these knowing their edge cleanliness cannot be transcript-proven (no captions exist) — his word is the authorization; nothing else in the lineup changes; the bump reseeds tv/channel + tv/breakpool and re-lays tv/now so the new pair takes effect (build record: website/adhan-menk-swap-2026-11-06/PROGRESS.md); v20 = the Episodes 3 + 4 build (Malik, 2026-11-06 17:10 ET: "Put episode 3 and 4 in the tv line up" — the two files he sent at 17:13-17:15 ET): Episodes 3 (the record-deal story) and 4 (the talent-show story) of South Park in Meechie's World join the FILL as whole episodes exactly as Episodes 1 and 2 did in v15 — the same items the hourly slot plays (tvCartoonItems: same ids, files, titles and durations), seeded here as fill so the weave deals each episode into the shuffle as ONE unit (Part 1 then Part 2 back-to-back, never split), each episode exactly once per pass, the episodes dividing the cycle between them; membership otherwise unchanged — every other seed item and every scheduled block exactly as before; the bump reseeds tv/channel and re-lays tv/now with the two new episodes in the weave (build record: website/episodes-34-2026-11-06/PROGRESS.md); v21 = the three MW TV commercial spots join the break pool (Malik, 2026-11-06 16:55 EST: 'Play this randomly every other hour on mwtv as a comercials' — spot-trump-grillz, spot-trump-president, spot-bandz; TV_PROGRAM_V bumped 20 to 21 because the fill seed changed (build record: website/commercials-2026-11-06/PROGRESS.md); v22 = the Comedy Hour build (Fix #2B, 2026-11-08 — fault 115): the recurring nightly 19:00-20:00 ET COMEDY HOUR hard window is built at last (Malik's standing order, 2026-11-03: the 7 PM hour is the Comedy Hour — until now only the one-shot Tue 2026-11-03 tvSeedInsert ever carried it, so the hour played standing fill): tvComedyResolve locks a nightly chain from the comedy pool (the v8 block "comedy" specials) into the new keeper-owned rotation doc tv/comedyhour, and tvGen lays it as a clock-pinned hard window with Family Time's discipline — it preempts the anchor, the ad cadence, the cartoon block, the insert, the owner queue and the fill (which freeze/resume), ends sharp at 20:00 where Family Time takes the channel, and the :50 news window keeps precedence over it the insert way (comedy caps at the window start; a fresh edition lays, else the hour plays wall-to-wall); segments carry cmd:1, crowd/Guardian cuts are refused, the owner skip cuts one night's instance (qCut.comedy); the bump reseeds tv/channel + tv/breakpool and re-lays tv/now with the window live
const TV_PREM_V = 1;                 // MY EMPIRE premiere slot doc generation (tv/premiere)
const TV_RERUN_V = 1;                // MY EMPIRE 10 PM rerun slot doc generation (tv/rerun)
const TV_MOVIE_V = 6;                // post-premiere movie block doc generation (tv/movieblock) (v3 = the 2026-11-03 pool expansion: the new-pool sweep's verified titles join the chain — see tvSeedMovieBlock; v4 = PR #704's single-title strike of Sugar Daddy Killer, superseded before merge; v5 = the B build, 2026-11-06: the Movie Night pool is removed on Malik's order (scope B) — the seed keeps only mov-giving-thanks, held solely as a Family Time eligibility source, see tvSeedMovieBlock; v6 = Giving Thanks struck from Family Time on Malik's order (2026-11-06 20:32 EST: "Take it out") — a watcher deep seat found the 8 PM Family Time block airing Giving Thanks (yt 8-ngS-WjqJw), an adult drama (profanity, sexual innuendo, a choking scene), in the younger-teens block; the movieblock seed now carries no items and Family Time eligibility is exactly {Johnny Test})
const TV_INSERT_V = 3;               // one-shot owner-ordered insert doc generation (tv/insert) (v2 = short playlist with an ordered startAt and a hard endBy; v3 = tonight's Comedy Hour Thanksgiving movie, 2026-11-03)
const TV_CARTOON_V = 5;              // hourly cartoon slot (Malik, 2026-11-05: his barbershop cartoon airs on MW TV once every hour, right after scheduled programming, AS IS) — two file parts form ONE logical piece, laid back-to-back with no gap inside a wall-clock span computed by tvCartoonSpans; v1 = the rules in the tvCartoonSpans header; v2 = Episode 2 joins the slot (Malik, 2026-11-05 ~10:57: "Thats south park in meechies world episode 2 put iton after my other cartoon one after another looped in with my comercials") — each slot now plays Episode 1's pair, one of Malik's own show commercials, Episode 2's pair, one more commercial (tvCartoonSeq), and the media gate requires all FOUR episode files; v3 = the 2026-11-05 sequence fix: a pinned span whose head has since been covered by a hard window laid over it re-slides AS A UNIT to the window's end (it is never amputated — the 12:00 failure, below in tvCartoonSpans), and re-lay cuts never land inside a span (tvCartoonCutGuard); v4 = Squishy Saga S1E1 joins the slot (Malik, 2026-11-06 15:09 ET: "Put om mwtv 8 min to every hour" — his ~8-minute cartoon, the read confirmed by his "Go" at 15:11): the episode rides in tvCartoonItems as a third whole episode — two file parts split at the C/D block boundary (media/squishy-saga-s1e1-p1.mp4 / -p2.mp4, encoded to the channel's ABR file standard) — and follows Episode 2's pair and the second commercial in tvCartoonSeq; the media gate now requires all SIX episode files before the slot lights (the v2 all-files discipline, unchanged), so this build must not go live before both Squishy files are on the site (media first, code second — the v2 precedent); TV_PROGRAM_V is NOT bumped: the fill seed is untouched and Squishy does not join the fill in this build (build record: website/squishy-mwtv-2026-11-06/PROGRESS.md); v5 = Episodes 3 + 4 join the slot (Malik, 2026-11-06 17:10 ET: "Put episode 3 and 4 in the tv line up" — files sent 17:13-17:15 ET): Episodes 3 and 4 of South Park in Meechie's World ride in tvCartoonItems as whole episodes in series order between Episode 2 and Squishy Saga — two file parts each, split on the ~10 s segment boundary nearest the act midpoint and encoded to the channel's ABR file standard (media/spmw-ep3-p1.mp4 / -p2.mp4, media/spmw-ep4-p1.mp4 / -p2.mp4) — and tvCartoonSeq now deals one of Malik's show commercials after EACH of the four South Park episodes (tvAdPick occurrences 4k..4k+3 of the slot's hour in the seeded block shuffle — the same pure function of the hour, widened from two picks to four because the block now carries four episode breaks; a stored pre-v5 item set, 4 or 6 items, still lays its exact v4 shape through the legacy branch below, picks included); the media gate now requires all TEN episode files before the slot lights (the v2 all-files discipline, unchanged), so this build must not go live before all four new files are on the site (media first, code second — the v2 precedent); the block is now roughly 48-50 minutes: it still lays after the :50 news window, still slides as ONE unit past hard windows and still drops rather than amputating when it cannot fit — at this length some hours' blocks drop under the 10-minute stacking guard or a hard window's slide, which is the standing law, not a defect (fit math in the build record); TV_PROGRAM_V IS bumped (19 to 20) in this build because Episodes 3 and 4 also join the fill as whole episodes (the v15 mechanism) — unlike v4, where Squishy stayed out of the fill and the seed stood untouched (build record: website/episodes-34-2026-11-06/PROGRESS.md)
/* The episodes themselves (owner media, kind file — the ban gate
 * scans YouTube ids and never sees these, the self-remove proof
 * needs player errors this slot's own media gate prevents, and
 * tvCartoonLive holds the slot dark until all ten files actually
 * exist on the site — v4 adds the Squishy Saga pair to the gate,
 * v5 the Episode 3 and 4 pairs). Durations ride the keeper's 0.1 s grid
 * (probed 299.27 / 292.79 and 301.07 / 301.45; the Episode 3 parts'
 * containers measure 301.000 / 301.908 and Episode 4's 301.077 /
 * 301.882) so the span's
 * wall-clock chain hands each part to the next at offset 0. */
function tvCartoonItems(now) {
  const mk = () => ({ basis: "own", evidence: "Malik's own barbershop cartoon — sent by him on 2026-11-05 with his order to air it on MW TV once every hour, right after scheduled programming, as-is; owner media file hosted on the site itself", clearedBy: "owner", at: now, simulcast: true });
  const mk2 = () => ({ basis: "own", evidence: "Malik's own cartoon — Episode 2 of South Park in Meechie's World (the DJ battle), sent by him on 2026-11-05 with his order to air it right after Episode 1, back-to-back, looped in with his commercials; owner media file hosted on the site itself", clearedBy: "owner", at: now, simulcast: true });
  const mk3 = () => ({ basis: "own", evidence: "Malik's own anime — Squishy Saga S1E1 'The Fall', produced by his own crew from his own catalog and delivered to him finished on 2026-11-06; his order the same day ('Put om mwtv 8 min to every hour', read confirmed by his 'Go') puts it on MW TV once every hour in the cartoon block; owner media file hosted on the site itself", clearedBy: "owner", at: now, simulcast: true });
  const mk4 = () => ({ basis: "own", evidence: "Malik's own cartoon — Episode 3 of South Park in Meechie's World (the record-deal story), sent by him on 2026-11-06 with his order to put Episodes 3 and 4 in the TV lineup; owner media file hosted on the site itself", clearedBy: "owner", at: now, simulcast: true });
  const mk5 = () => ({ basis: "own", evidence: "Malik's own cartoon — Episode 4 of South Park in Meechie's World (the talent-show story), sent by him on 2026-11-06 with his order to put Episodes 3 and 4 in the TV lineup; owner media file hosted on the site itself", clearedBy: "owner", at: now, simulcast: true });
  return [
    { id: "cartoon-barbershop-p1", kind: "show", src: "file", yt: "", url: "/media/barbershop-cartoon-v2-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 1, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.3, rights: mk() },
    { id: "cartoon-barbershop-p2", kind: "show", src: "file", yt: "", url: "/media/barbershop-cartoon-v2-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 1, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.3, rights: mk() },
    { id: "cartoon-djbattle-p1", kind: "show", src: "file", yt: "", url: "/media/dj-battle-cartoon-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 2, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.1, rights: mk2() },
    { id: "cartoon-djbattle-p2", kind: "show", src: "file", yt: "", url: "/media/dj-battle-cartoon-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 2, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.5, rights: mk2() },
    { id: "cartoon-spmw-ep3-p1", kind: "show", src: "file", yt: "", url: "/media/spmw-ep3-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 3, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.0, rights: mk4() },
    { id: "cartoon-spmw-ep3-p2", kind: "show", src: "file", yt: "", url: "/media/spmw-ep3-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 3, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.9, rights: mk4() },
    { id: "cartoon-spmw-ep4-p1", kind: "show", src: "file", yt: "", url: "/media/spmw-ep4-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 4, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.1, rights: mk5() },
    { id: "cartoon-spmw-ep4-p2", kind: "show", src: "file", yt: "", url: "/media/spmw-ep4-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 4, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.9, rights: mk5() },
    { id: "cartoon-squishy-p1", kind: "show", src: "file", yt: "", url: "/media/squishy-saga-s1e1-p1.mp4", iaId: "", title: "Squishy Saga — Episode 1: The Fall, Part 1 of 2", show: "Squishy Saga", dur: 236.6, rights: mk3() },
    { id: "cartoon-squishy-p2", kind: "show", src: "file", yt: "", url: "/media/squishy-saga-s1e1-p2.mp4", iaId: "", title: "Squishy Saga — Episode 1: The Fall, Part 2 of 2", show: "Squishy Saga", dur: 206.3, rights: mk3() },
  ];
}
/* The in-slot commercial pool: Malik's OWN show spots only — the
 * house items of the break pool under TV_SHOW_SPOT_IDS, resolved
 * exactly as the ad cadence resolves them (tvAdCadItems' house
 * loop), so a spot whose file is not on the site yet is already
 * held out by the tick's spot gate (tvCleared drops held items)
 * and joins by itself once uploaded. Paid sponsor spots are NOT
 * drawn into the cartoon block: Malik's order was "looped in with
 * MY commercials", and sponsors were never promised this slot. */
function tvCartoonSpots(pool) {
  const items = [];
  for (const id of TV_SHOW_SPOT_IDS) {
    const it = ((pool && pool.items) || []).find((x) => x.id === id);
    if (it && tvCleared(it)) items.push(it);
  }
  return items;
}
/* The full sequence ONE hourly slot plays (Malik, 2026-11-05
 * ~10:57: Episode 2 goes "after my other cartoon one after
 * another looped in with my comercials"): Episode 1's pair, ONE
 * show commercial, Episode 2's pair, ONE more show commercial —
 * then the interrupted program resumes. Which spots fill the two
 * breaks is the cadence rail's own seeded block shuffle
 * (tvAdPick) keyed on the slot's hour — occurrences 2k and 2k+1
 * of hour k — a pure function of the hour, so every keeper pass
 * lays the same sequence for the same slot with no state to
 * store, while the spots still rotate hour to hour like
 * everywhere else on the channel. With no cleared spot in the
 * pool the sequence is just the two episodes back-to-back —
 * never dead air, never a foreign commercial. Since v4 the
 * slot can carry further whole episodes past Episode 2
 * (Squishy Saga): they follow the second commercial in item
 * order, back-to-back, and the two commercials keep their
 * 2k / 2k+1 occurrences — the picks around the first two
 * episodes are exactly what they were before v4. Since v5
 * (Episodes 3 + 4 in the slot) the sequence deals one show
 * commercial after EACH of the four South Park episodes —
 * occurrences 4k..4k+3 of the slot's hour — and Squishy Saga
 * closes the block with no commercial after it; a stored
 * pre-v5 item set (4 or 6 items) keeps its exact v4 shape
 * and its 2k / 2k+1 picks through the legacy branch. */
function tvCartoonSeq(crt, hourMs) {
  const items = (crt && crt.items) || [];
  const spots = (crt && crt.spots) || [];
  if (items.length < 4 || !spots.length) return items.slice();
  const k = Math.round((+hourMs || 0) / 3600e3);
  if (items.length <= 6) { const a = tvAdPick(spots, 2 * k), b = tvAdPick(spots, 2 * k + 1); return [items[0], items[1], a, items[2], items[3], b, ...items.slice(4)].filter(Boolean); }
  const pairs = [];
  for (let i = 0; i + 1 < items.length; i += 2) pairs.push([items[i], items[i + 1]]);
  if (items.length % 2) pairs.push([items[items.length - 1]]);
  const out = [];
  pairs.forEach((pr, pi) => { out.push(...pr); if (pi < pairs.length - 1) out.push(tvAdPick(spots, 4 * k + pi)); });
  return out.filter(Boolean);
}
function tvCartoonSeqTotal(crt, hourMs) {
  return tvCartoonSeq(crt, hourMs).reduce((x, it) => x + (+it.dur || 0), 0);
}
const TV_MOVIE_FALLBACK_MIN = 15;    // when the premiere slot airs nothing, the movie block starts this many minutes after the slot start (20:15 ET)
const TV_PREM_PROBE_MS = 600e3;
/* The zone anti-bot rule 403s UA-less requests ("AI bots and scrapers are not
 * allowed"), and keeper media probes leave from the server with no browser UA —
 * so every file-backed update probed dead and never aired (found live
 * 2026-11-03: luProbe ok:false twice on a URL browsers read as 206). The
 * keeper verifying its OWN media presents as a browser; verdicts also become
 * independent of which client happened to trigger the tick. */
const TV_PROBE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";      // premiere slot file-existence probes are cached this long in tv/now
/* Media existence for lineup file items. Own media (/m/<bucket>/<file>) is
 * checked directly in the project's KV store (the same binding the /m relay
 * serves from): an HTTP probe of our own zone from the server is answered
 * 403 by the zone anti-bot rule no matter what UA it carries (PR #580's
 * header fix proved insufficient live — luProbe still ok:false), so
 * file-backed states could never air. Non-/m URLs keep the browser-UA
 * 1-byte range probe. */
async function tvMediaExists(env, origin, url) {
  try {
    const m = /^\/m\/(.+)$/.exec(url || "");
    if (m && env && env.MEDIA) {
      const probe = await env.MEDIA.getWithMetadata(m[1], { type: "stream", range: { offset: 0, length: 1 } }).catch(() => null);
      if (probe && probe.value) { try { await probe.value.cancel(); } catch (_) {} return true; }
      return false;
    }
    const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : {};
    const r = await fetch(origin + url, { headers: { Range: "bytes=0-0", "User-Agent": TV_PROBE_UA, Accept: "*/*" }, ...ctl });
    return r.status === 200 || r.status === 206;
  } catch (_) { return false; }
}
const TV_NEWS_STALE = 2 * 3600e3;  // an edition older than 2 hours may not air as news (NEWS-BLOCK)
const TV_NEWS_FRESH_MS = 70 * 60e3; // :50-window LAY gate (Malik, 2026-11-04 ~21:37: "Fix my news"): the keeper stamps the hourly news window ONLY when tv/news' current edition was produced within this span before the window start. The producer's hourly run lands ~:36-:50 for the :50 window, so a fresh edition is minutes old; the previous hour's edition is ~70+ minutes old at the next window and is NEVER laid. No fresh edition = no news segment at all — the program chain flows through the window (silence by design; a stale edition never airs as news). The client resolver's own staleness cap (js/dj.js TV_NEWS_STALE_C) is set to the same span, so an already-laid window can never be filled with a staler edition either.
/* The :50 news window's lay decision, judged at the window's
 * start: chan._newsEd is the tv/news current-edition stamp tvTick
 * attached ({ at } or null). An edition stamped after the window
 * start (beyond a 60 s clock-skew allowance) is not this window's
 * edition either. */
function tvNewsFreshFor(chan, winStart) {
  const ed = chan && chan._newsEd;
  if (!ed || !(+ed.at > 0)) return false;
  if (+ed.at > winStart + 60000) return false;
  return winStart - (+ed.at) < TV_NEWS_FRESH_MS;
}
/* A news window that overlaps the Family Time window is never
 * laid (Malik, 2026-11-04 ~21:37: "8 oclock is supposed to be a
 * kids family movie"): Family Time is a hard window — owner skip
 * aside, nothing cuts the movie, and that now includes the :50
 * news window, which used to pass over the span it covered. The
 * resulting rule, exactly: inside the Family Time window the
 * family movie plays wall-to-wall; the :50 news window inside
 * that span does not exist on the channel that night. News
 * windows outside the family span are untouched. */
function tvNewsOverlapsFamily(win, fam) {
  if (!win || !fam) return false;
  const fw = tvFamilyWin(win.start, fam);
  if (!fw) return false;
  return fw.start < win.end && win.start < fw.end;
}
/* NEWS WINDOW REFILL (2026-11-05): the lay above is a one-time
 * decision — tvGen stamps the window only when a gate-fresh edition
 * exists AT LAY TIME, and the laid lineup is never revisited, so an
 * edition that lands after its window opens can never air: the
 * 14:50 ET window on 2026-11-05 stayed program-filled even though a
 * gate-fresh edition (produced 14:40:54) sat in tv/news from
 * 14:52:30 — the freshness gate was never the problem, the missing
 * refill was. This is the refill, in the tick's re-lay-cut
 * discipline (tvCharCut, exactly like the anchor / character /
 * cadence cuts): when the CURRENT window's span does not already
 * carry this window's news from the next segment boundary, and
 * tv/news NOW holds an edition that passes the EXISTING lay gate
 * (tvNewsFreshFor — judged for this window, unmodified), cut the
 * laid timeline at that boundary so this tick's generation re-lays
 * the rest of the window as news. The rules, exactly:
 *   - the gate is the gate: a stale edition never refills, a
 *     missing edition leaves the window as laid (silence by
 *     design), and an owner-cut window is never refilled;
 *   - Family Time precedence is unchanged (tvNewsOverlapsFamily);
 *   - the segment on air is never cut mid-play — the cut lands on
 *     the NEXT segment boundary inside the window, and not inside
 *     a cartoon span (tvCartoonCutGuard);
 *   - at most ONE refill per window — the tick stamps the refill
 *     in tv/now (newsRefill) and passes the stamped window back in
 *     as refilledWin on later ticks;
 *   - a span that already carries this window's news from the
 *     next boundary is never touched.
 * qCutNews is the owner-cut stamp for THIS window as of tick start
 * (nw.qCut.news — chan._qCut attaches later in the tick; a same-
 * tick owner cut is applied by the advancer itself and the gate
 * check in tvGen still refuses the re-lay). Returns
 * { segs, cursor, win, to } on a cut, else null. */
function tvNewsRefillCut(chan, segs, cursor, now, qCutNews, refilledWin, cartoonSpans) {
  if (!chan || !Array.isArray(segs) || !cursor) return null;
  const win = tvNewsWin(now);
  if (!win.inside) return null;
  if (qCutNews === win.start) return null;
  if (refilledWin === win.start) return null;
  if (!tvNewsFreshFor(chan, win.start)) return null;
  if (tvNewsOverlapsFamily(win, chan._family)) return null;
  const cur = tvSegAt(segs, now);
  if (!cur) return null;
  const B = cur.start + (+cur.dur || 0) * 1000;
  if (!(B > now) || B >= win.end) return null;
  const atB = segs.find((sg) => sg && sg.start === B);
  if (atB && atB.k === "news" && atB.edWin === win.start) return null;
  const cutAt = tvCartoonCutGuard(cartoonSpans, B);
  if (!(cutAt > now) || cutAt >= win.end) return null;
  const cut = tvCharCut(chan, segs, cursor, cutAt);
  if (!cut) return null;
  return { segs: cut.segs, cursor: cut.cursor, win: win.start, to: cutAt };
}
const TV_LOCAL_HOLD_MS = 70 * 60e3; // Uniontown Local Update break spot: held out of rotation once the producer stamp (tv/localupdate) is older than this — the producer refreshes hourly, so a spot lives at most ~65 min on air and coverage stays continuous
const TV_ANCHOR_SLOTS = [0, 360, 720, 1080]; // MY EMPIRE anchor news editions: fixed daily slots, minutes ET (12:00 AM, 6:00 AM, 12:00 PM, 6:00 PM)
const TV_ANCHOR_FRESH_MS = 6 * 3600e3; // an anchor edition airs only at its own slot and only when produced within the 6h before that slot (productions run ~30 min ahead of each slot)
const TV_NEWS_LEN = 600;           // the TV news window: :50-:00, ten minutes
const TV_AD_EVERY_MS = 900e3;
const TV_QUARTER_FRESH_MS = 20 * 60e3;  // quarter-update freshness window (Malik, 2026-11-03 ~14:54: "new news every time"): a quarter-hour break may only chain an update produced FOR that quarter within the last 20 minutes (the character clip obeys the same window); no fresh piece = commercial only, never a replay      // MY EMPIRE ad cadence (Malik, 2026-11-02 ~21:05: "my tv show comercial every 15 min"): the show commercial plays on this fixed cadence — see tvAdCadItems/tvAdWin
/* MY EMPIRE show spots (Malik, 2026-11-03: "play them randomly,
 * even on the radio"): the full show-spot pool. On MW TV these are
 * house items in tv/breakpool — drawn by the break bag like every
 * break, and on the 15-minute cadence rail by the seeded block
 * shuffle in tvAdPick. On the radio the same spots play as audio
 * (RADIO_SPOTS below), served through nextItem at song boundaries
 * on a light cadence. A spot only ever airs while its media
 * actually exists on the site: tvSpotGate probes the newest pool
 * files and every radio cut (verdicts cached in tv/now as
 * spotProbe) and holds a pooled spot — or skips a radio pick —
 * whose file is missing, so this keeper can land ahead of a media
 * upload and each spot joins rotation by itself once its file is
 * in place, with no further code change. */
const TV_SHOW_SPOT_IDS = ["brk-my-empire-ad", "brk-my-empire-v2", "brk-my-empire-by10", "brk-my-empire-8oclock", "brk-my-empire-shop", "brk-my-empire-family", "brk-my-empire-12", "brk-spot-trump-grillz", "brk-spot-trump-president", "brk-spot-bandz"];
const TV_SPOT_GATE_IDS = ["brk-my-empire-v2", "brk-my-empire-shop", "brk-my-empire-family", "brk-my-empire-12", "brk-spot-trump-grillz", "brk-spot-trump-president", "brk-spot-bandz"]; // pooled spots whose files were not on the site when this landed (v1 / done-by-10 / 8-o-clock files were verified live at their seed times and are not gated); the three 2026-11-06 commercial clips are gated the same way — their files upload to main before this merges, and each joins by itself once its file is live
const RADIO_SPOT_EVERY_MS = 900e3;   // radio show spots: at most one at a song boundary per ~15 min of Auto-DJ rotation (the station's light-touch break cadence — no other radio break pattern exists)
const RADIO_SPOTS = [
  { id: "spot-v1", src: "/media/my-empire-commercial.mp3", title: "MY EMPIRE — Show Commercial", dur: 42.3 },
  { id: "spot-v2", src: "/media/my-empire-commercial-v2.mp3", title: "MY EMPIRE — The Don (Show Commercial)", dur: 42.2 },
  { id: "spot-by10", src: "/media/my-empire-by10.mp3", title: "MY EMPIRE — Done by 10 Tonight", dur: 14.5 },
  { id: "spot-8oclock", src: "/media/my-empire-8oclock.mp3", title: "MY EMPIRE — Every Day at 8, Rerun at 10", dur: 14.5 },
  { id: "spot-shop", src: "/media/my-empire-shop-station-family.mp3", title: "MY EMPIRE — The Shop, The Station, The Family", dur: 10 },
  { id: "spot-family", src: "/media/my-empire-family-foundation.mp3", title: "MY EMPIRE — Family Is the Foundation", dur: 10 },
  { id: "spot-12", src: "/media/my-empire-12-shirts.mp3", title: "MY EMPIRE — 12 Shirts, Zero Excuses", dur: 10 }
];
const TV_RELAY_GRID_MS = 300e3;    // re-lay cut grid ONLY (tvTick cadence-chain re-lay): when a new edition/character update lands, laid segments are cut at the next grid point so the quarter cadence re-lays with the new state chained. This is NOT an airing cadence — the 5-minute update rail that used this grid was retired 2026-11-03 (Malik: "no more interruptions every 5 minutes")
const TV_HORIZON = 2 * 3600e3;     // segments are generated this far ahead of now
const TV_KEEP = 3600e3;            // aired segments are kept this long behind now
const TV_BASES = ["own", "embed", "pd", "cc", "grant", "submission"];

/* tvEtParts is called tens of thousands of times by a single tick
 * that has to re-lay the segment window (measured 41-52k calls: the
 * span/window math re-checks every candidate start against every
 * window). It used to construct two Intl.DateTimeFormat objects per
 * call, and that construction cost ~93% of the tick's CPU — a re-lay
 * tick burned ~20-45s of CPU, the worker was killed (error 1102)
 * before tv/now could be written, and every following poll retried
 * the identical re-lay forever (the 2026-11-03 station outage).
 * The formatters are now built once (kept on the function itself,
 * so the function stays self-contained) and results are memoized
 * per ET minute: ET offsets are whole hours, so hour/minute/dayKey
 * are constant within a UTC minute bucket (the same whole-hour
 * offset arithmetic tvNewsWin already relies on). Outputs are
 * identical; callers only read the fields. */
function tvEtParts(ms) {
  const F = tvEtParts._f || (tvEtParts._f = {
    hm: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }),
    wd: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }),
    day: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }),
    memo: new Map(),
  });
  const bucket = Math.floor(ms / 60000);
  let v = F.memo.get(bucket);
  if (!v) {
    const parts = F.hm.formatToParts(new Date(ms));
    const gp = (t) => +(parts.find((x) => x.type === t) || {}).value || 0;
    v = { hour: gp("hour") % 24, minute: gp("minute"), dayKey: F.day.format(new Date(ms)), weekday: F.wd.format(new Date(ms)) };
    if (F.memo.size > 512) F.memo.clear();
    F.memo.set(bucket, v);
  }
  return v;
}
/* The news window containing ms (inside: true) or the next one. ET
 * offsets are whole hours, so ms % 60000 is the seconds-into-minute
 * reading on the ET clock too; the window edges land exactly. */
function tvNewsWin(ms) {
  const et = tvEtParts(ms), sec = Math.floor((ms % 60000) / 1000);
  if (et.minute >= 50) { const start = ms - ((et.minute - 50) * 60 + sec) * 1000; return { start, end: start + TV_NEWS_LEN * 1000, inside: true }; }
  const start = ms + ((50 - et.minute) * 60 - sec) * 1000;
  return { start, end: start + TV_NEWS_LEN * 1000, inside: false };
}
function tvCleared(it) {
  if (!it || it.held) return false;
  if (!(+it.dur > 0)) return false;
  const r = it.rights || {};
  if (!TV_BASES.includes(r.basis) || !String(r.evidence || "").trim()) return false;
  if (it.src === "yt") return /^[A-Za-z0-9_-]{11}$/.test(String(it.yt || ""));
  if (it.src === "ia" || it.src === "file") return !!String(it.url || "");
  return false;
}
/* THE ONLY FILL GATE (v14 — Malik, 2026-11-05 12:25 ET: "I only
 * want my 2 cartoons comercials and asap preech videos on my tv
 * channel along with deen squad"; scope confirmed B — the shuffle
 * only, the scheduled blocks stay): an item may be laid by an
 * AUTO-PICKED FILL path — the program chain (tvGen's cycle walk
 * and its cold-start twin tvCyclePos), the break bag (tvDrawBreak),
 * and formerly the movie chain (stood down in tvMovieState) — only
 * when it is one of:
 *   - a cycle program item seeded as fill (fill: true — the 44
 *     ASAP Preach / Deen Squad videos carried in tvSeedChannel),
 *   - one of Malik's MY EMPIRE house show commercials
 *     (TV_SHOW_SPOT_IDS, resolved from the break pool),
 *   - a break-bag item in the gospel lane (ASAP Preach) or the
 *     faith lane (Deen Squad).
 * v16 amendment (Malik, 2026-11-05 ~18:00 ET — the Islamic
 * programming order, by its own author, on the record, exactly
 * the way v13 layered "faith" onto v12's "gospel"): the faith
 * lane now also carries the 48 new Muslim rap videos (Native
 * Deen, Essam, Khalil Ismail, Muslim Belal, Ilyas Mao — the
 * same uploads ride the cycle as fill: true program items), and
 * a fourth class joins the BAG only: break items in the new
 * "shorts" lane (25 verified Islamic shorts — brief vertical
 * interludes, never program items, never in the cycle seed).
 * v18 amendment (Malik, 2026-11-05 ~22:24 ET — the
 * collaborators order, same layering as v16's): the gospel
 * and faith lanes now also carry the verified official-
 * channel music videos of every credited ASAP Preach /
 * Deen Squad collaborator (the same uploads ride the cycle
 * as fill: true program items), so the gate's text below
 * reads: a break-bag item in the gospel lane (ASAP Preach
 * and his collaborators) or the faith lane (Deen Squad,
 * its members' solo channels and their collaborators).
 * Everything else — every other artist, the Movie Night titles,
 * the stand-up specials, Malik's own anthem video, the local-update
 * break spot, paid sponsor spots — is out of fill. The gate binds
 * ONLY the fill draws: the seeds keep every item (Family Time
 * eligibility reads the shared tv/channel + tv/movieblock seeds
 * and is unchanged), and the scheduled paths never consult it —
 * news, anchor, cartoon, the Comedy Hour insert, Family Time,
 * premiere/rerun, the owner queue and the ad-cadence rail
 * (tvAdCadItems, which keeps its house spots + sponsors) all run
 * exactly as before. */
const TV_FILL_ONLY = true;
function tvFillOk(it) {
  if (!it) return false;
  if (it.fill === true) return true;
  if (TV_SHOW_SPOT_IDS.includes(it.id)) return true;
  return it.kind === "break" && (it.lane === "gospel" || it.lane === "faith" || it.lane === "shorts");
}
/* SHARED BAN GATE AT LAY TIME (2026-11-03 — the Old Bodyguard fix):
 * brain/ytblock is the channel's shared ban list, but before tonight
 * it bound only PICK time (the search / queue / insert doors and the
 * Auto-DJ stocker check it) and ONE lay path (tvRecheckNext, and
 * only for the next CYCLE item). Every other source the keeper lays
 * — the stored movie chain, a stored owner insert and its stamped
 * window, the owner queue, the break pool, the premiere / rerun
 * chains — was filtered by tvCleared alone, and tvCleared reads the
 * item's RECORD, not the ban: an item carrying a complete-looking
 * rights record laid even with its video on the ban list. That is
 * how "_Tu_SAqNinU" ("THE OLD BODYGUARD", an aggregator upload US
 * viewers cannot play — 239 countries in its region list, the US
 * not among them; NOT cleared, no recorded legal basis) occupied
 * the channel on 2026-11-03: it is in no code seed, so it rode a
 * stored doc past a gate that never asked the list. The Guardian
 * (MWTV-GUARDIAN-BEGIN) watches for exactly this and logs it, but
 * its hands stop at protected classes — an owner insert or queue
 * segment is never guardian-cut — and it never edits the source
 * docs, so a banned title in a stored doc just gets re-laid every
 * tick. This gate is the doc-level half the Guardian waits on: it
 * runs once per tick, right after the lineup docs load, seeds the
 * confirmed id into brain/ytblock through the keeper's own write
 * path (so the pick doors, which read the DOC, refuse it too —
 * the Guardian's watchlist alone is code-side), strips every
 * banned yt out of every doc the keeper lays from (writing the
 * cleaned doc back through the same path, so the purge is
 * permanent, not per-tick), and the tick then cuts any banned
 * segment already sitting in the laid window (tvBanInWindow +
 * the tvTrimAt re-lay in tvTick) — including the protected
 * classes, because a ban is a house decision, not a fault call.
 * tvCleared is unchanged: the record gate AND the ban gate now
 * both bind, at lay time, on every source. */
const TV_BAN_SEED = ["_Tu_SAqNinU"]; // confirmed US-unplayable aggregator upload (see above); the keeper seeds it into brain/ytblock itself so the ban lives in the shared list every surface reads
function tvBanInWindow(segs, banSet, now) {
  if (!banSet || !banSet.size || !Array.isArray(segs)) return false;
  return segs.some((sg) => sg && sg.yt && banSet.has(String(sg.yt)) && sg.start + (+sg.dur || 0) * 1000 > now);
}
async function tvBanGate(env, now, D) {
  let blk = null;
  try { blk = await readDoc(env, "brain/ytblock"); } catch (_) {}
  const ids = blk && Array.isArray(blk.ids) ? blk.ids.map(String) : [];
  const banSet = new Set(ids);
  const purged = [];
  let seedDirty = false;
  for (const id of TV_BAN_SEED) if (!banSet.has(id)) { banSet.add(id); ids.push(id); seedDirty = true; }
  if (seedDirty) { try { await writeDoc(env, "brain/ytblock", "brain", { ...(blk && typeof blk === "object" && !Array.isArray(blk) ? blk : {}), ids }); } catch (_) {} }
  const strip = async (doc, path, coll, from) => {
    if (!doc || !Array.isArray(doc.items)) return doc;
    const kept = doc.items.filter((it) => { const hit = !!(it && it.yt && banSet.has(String(it.yt))); if (hit) purged.push({ yt: String(it.yt), from }); return !hit; });
    if (kept.length === doc.items.length) return doc;
    const out = { ...doc, items: kept, updatedAt: now, by: "keeper-bangate" };
    if (path) { try { await writeDoc(env, path, coll, out); } catch (_) {} }
    return out;
  };
  D.chan = await strip(D.chan, "tv/channel", "tv", "channel");
  // Break pool: a purge also retires the draw bag, so a banned id
  // can never be drawn from a bag built before the ban landed.
  if (D.pool && Array.isArray(D.pool.items)) {
    const before = D.pool.items.length;
    D.pool = await strip(D.pool, null, "tv", "breakpool");
    if (D.pool.items.length !== before) { D.pool = { ...D.pool, bag: [], bagIx: 0 }; try { await writeDoc(env, "tv/breakpool", "tv", D.pool); } catch (_) {} }
  }
  // Premiere / rerun docs are the show's own records: stripped in
  // memory every tick (never laid), never rewritten from here.
  D.prem = await strip(D.prem, null, "tv", "premiere");
  D.rerun = await strip(D.rerun, null, "tv", "rerun");
  D.movies = await strip(D.movies, "tv/movieblock", "tv", "movieblock");
  if (D.insDoc && Array.isArray(D.insDoc.items)) D.insDoc = await strip(D.insDoc, "tv/insert", "tv", "insert");
  // DRAIN FIX (2026-11-07): only once. Without the consumedAt check this
  // branch re-wrote the already-consumed doc on EVERY keeper tick (live D1:
  // tv/insert rewritten every 4-15 s, ~1,700 writes/day, each one a changes
  // row and a re-read for every MW TV watcher).
  else if (D.insDoc && D.insDoc.yt && !D.insDoc.consumedAt && banSet.has(String(D.insDoc.yt))) {
    // v1 top-level insert shape (the owner play-next door's doc):
    // a banned pick is consumed on the spot, with the reason on the
    // doc, so the firing rule can never stamp its window.
    purged.push({ yt: String(D.insDoc.yt), from: "insert" });
    D.insDoc = { ...D.insDoc, consumedAt: now, consumedNote: "banned (shared ban list)", updatedAt: now };
    try { await writeDoc(env, "tv/insert", "tv", D.insDoc); } catch (_) {}
  }
  if (D.quDoc) {
    const qBefore = Array.isArray(D.quDoc.items) ? D.quDoc.items : null;
    D.quDoc = await strip(D.quDoc, "tv/queue", "tv", "queue");
    if (qBefore && Array.isArray(D.quDoc.items) && D.quDoc.items.length !== qBefore.length) {
      // SELF-REMOVE LAW (queue side): a queued item this gate
      // purged as banned leaves its reason on the doc, so the
      // owner's list can say why it vanished ("removed —
      // couldn't play"). Matching is count-based per yt:
      // duplicate adds of one id each earn their own entry.
      const keptCount = {};
      for (const r of D.quDoc.items) { const y = String((r && r.yt) || ""); keptCount[y] = (keptCount[y] || 0) + 1; }
      const remEntries = [];
      for (const r of qBefore) {
        const y = String((r && r.yt) || "");
        if (keptCount[y] > 0) { keptCount[y] -= 1; continue; }
        remEntries.push({ qid: String((r && r.qid) || ""), yt: y, title: String((r && r.title) || ""), at: now, why: "couldn't play" });
      }
      if (remEntries.length) {
        D.quDoc = { ...D.quDoc, removed: [...(Array.isArray(D.quDoc.removed) ? D.quDoc.removed : []), ...remEntries].slice(-10) };
        try { await writeDoc(env, "tv/queue", "tv", D.quDoc); } catch (_) {}
      }
    }
  }
  return { banSet, purged };
}
/* PAID SPONSOR SPOTS (Malik, 2026-11-03: "put paid commercials on my
 * TV channel — I get paid every time people see commercials"): a pool
 * item with kind "sponsor" is a paying business's commercial, sold on
 * /promote. The sponsor record of truth (contact, payment) lives in
 * the sponsor_claims D1 table — never in this public doc; the pool
 * item carries only what airs: { sponsor: { name, tier, paidThrough,
 * approved, claimId }, tally }. A sponsor spot airs only while
 * approved AND inside its paid week: the tick gate holds it the
 * moment either lapses and the cadence gate checks it per occurrence,
 * so an expired or unapproved spot never plays. The tally counts only
 * segments that actually aired — "plays served" — plus the site's own
 * online count at the last airing ("people tuned in at air time");
 * nothing is ever estimated. */
const SPONSOR_WEEK_MS = 7 * 24 * 3600e3;
function tvSponsorLive(it, now) {
  return !!(it && it.kind === "sponsor" && it.sponsor && it.sponsor.approved === true && (+it.sponsor.paidThrough || 0) > now);
}
/* The promotion gate: a claim becomes a pool spot only when the owner
 * approved it (status approved), it has a real playable file with a
 * positive duration, and — for paid tiers — payment was verified
 * against Stripe server-side (paidVerified is set only by
 * /api/sponsors after reading the session back from Stripe). */
function tvSponsorClaimReady(c, now) {
  if (!c || c.status !== "approved") return false;
  if (!c.mediaUrl || !(+c.dur > 0)) return false;
  if (c.tier !== "free" && c.paidVerified !== true) return false;
  return true;
}
function tvSponsorItemFromClaim(c, now) {
  return {
    id: "spn-" + c.id, kind: "sponsor", src: "file", yt: "", url: c.mediaUrl,
    audioSrc: c.audioSrc || "", audioDur: +c.audioDur || 0,
    title: c.title || (c.business + " — sponsor spot"), show: "", dur: +c.dur, lane: "sponsor",
    rights: { basis: "submission", evidence: "Sponsor-submitted via /promote claim " + c.id + "; sponsor warrants rights to their own ad creative." },
    sponsor: { name: c.business || "", tier: c.tier || "free", paidThrough: now + SPONSOR_WEEK_MS, approved: true, claimId: c.id },
    tally: { served: 0, radioServed: 0, lastAt: 0, lastOnline: 0, countedThrough: 0 },
  };
}
function tvProgSeg(it, start, dur, off) {
  return { k: (it.kind === "house" || it.kind === "sponsor") ? "house" : "prog", id: it.id, src: it.src, yt: it.yt || "", url: it.url || "", iaId: it.iaId || "", title: it.title || "", show: it.show || "", start, dur, off };
}
/* Viewer-vote weighting for the pool bag (Malik, 2026-11-03
 * 19:11 ET: votes feed the picks). voteNet maps a program id to
 * its net tally (likes − dislikes, summed over aired instances
 * from tv/votes by tvVoteNetMap). The adjustment is deliberately
 * modest and mirrors the Featured sponsor's own precedent below:
 * a strongly liked item earns ONE extra copy in the bag (it comes
 * up about twice as often); a strongly disliked item keeps its
 * one copy but sinks to the END of the bag (drawn last this
 * cycle — never starved out entirely). Sponsors are exempt both
 * ways: their placement is a paid contract, not a popularity
 * ranking. Votes rank the POOL only — the hard schedule (news
 * windows, premiere/rerun, owner queue/insert) never reads them. */
const TV_VOTE_BOOST_NET = 10;
const TV_VOTE_SINK_NET = -10;
function tvDrawBreak(pool, voteNet) {
  // v14 ONLY gate: the bag is built from the fill subset only —
  // ASAP Preach (gospel) + Deen Squad (faith) + the MY EMPIRE house
  // show spots. Every other pool item stays in the doc (the cadence
  // rail and the cartoon spots resolve from the full pool) but is
  // never dealt as a break again.
  const cleared = (pool.items || []).filter((x) => tvCleared(x) && tvFillOk(x));
  if (!cleared.length) return null;
  if (!Array.isArray(pool.bag) || !(pool.bagIx >= 0) || pool.bagIx >= pool.bag.length) {
    // Paid sponsors ride the same bag; a Featured sponsor's spot sits
    // in the bag twice (its ~2x rotation weight — the cadence rail
    // weights it the same way, tvAdCadItems).
    // SPARSE SHORTS (v16 — Malik, 2026-11-05 ~19:31 ET: the Deen
    // Squad behind-the-scenes shorts play "sometimes"): a shorts-lane
    // item flagged sparse: true deals into only every THIRD bag
    // (bagCycle 1, 4, 7, ...), one copy when it deals — so across a
    // day it surfaces a third as often as an ordinary short, on top
    // of shorts already being a minority of the bag. The cycle count
    // rides the pool doc, so every keeper pass agrees on the bag.
    pool.bagCycle = ((pool.bagCycle | 0) + 1);
    const sparseIn = pool.bagCycle % 3 === 1;
    pool.bag = [];
    for (const x of cleared) { if (x.lane === "shorts" && x.sparse === true && !sparseIn) continue; pool.bag.push(x.id); if (x.kind === "sponsor" && x.sponsor && x.sponsor.tier === "featured") pool.bag.push(x.id); }
    if (voteNet) for (const x of cleared) { if (x.kind !== "sponsor" && !(x.lane === "shorts" && x.sparse === true && !sparseIn) && (voteNet[x.id] || 0) >= TV_VOTE_BOOST_NET) pool.bag.push(x.id); }
    for (let i = pool.bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool.bag[i]; pool.bag[i] = pool.bag[j]; pool.bag[j] = t; }
    if (voteNet) {
      const sunk = (id) => { const it = cleared.find((x) => x.id === id); return !!it && it.kind !== "sponsor" && (voteNet[id] || 0) <= TV_VOTE_SINK_NET; };
      const keep = pool.bag.filter((id) => !sunk(id)), tail = pool.bag.filter((id) => sunk(id));
      if (tail.length) pool.bag = keep.concat(tail);
    }
    pool.bagIx = 0; pool._dirty = true;
  }
  let id = pool.bag[pool.bagIx];
  let item = cleared.find((x) => x.id === id) || null;
  // Sponsor run cap: never three sponsor spots back-to-back out of the
  // bag — after two, the draw swaps to the nearest non-sponsor still
  // in the bag, so the house (or the news) takes its turn.
  const recent = Array.isArray(pool.recentBreaks) ? pool.recentBreaks : [];
  if (item && item.kind === "sponsor" && recent.length >= 2 && recent[recent.length - 1] && recent[recent.length - 2]) {
    let swapped = false;
    for (let j = pool.bagIx + 1; j < pool.bag.length; j++) {
      const alt = cleared.find((x) => x.id === pool.bag[j]);
      if (alt && alt.kind !== "sponsor") { const t = pool.bag[pool.bagIx]; pool.bag[pool.bagIx] = pool.bag[j]; pool.bag[j] = t; id = pool.bag[pool.bagIx]; item = alt; swapped = true; break; }
    }
    // The rest of this bag is all sponsors: skip the break entirely
    // rather than run a third sponsor spot back-to-back — the slot
    // is consumed, nothing is laid, and the next bag starts clean.
    if (!swapped) { pool.bagIx++; pool._dirty = true; return null; }
  }
  // Shorts run cap (v16): never two shorts back-to-back out of the
  // bag — after a short, the draw swaps to the nearest non-short
  // still in the bag (skipping a sponsor when the sponsor run is
  // already two deep, so the swap cannot break the cap above). The
  // rest of this bag being all shorts skips the break entirely —
  // the slot is consumed, nothing is laid, the next bag starts
  // clean (the sponsor-cap rule's own answer).
  if (item && item.lane === "shorts" && pool.lastBreakShort) {
    let swapped = false;
    for (let j = pool.bagIx + 1; j < pool.bag.length; j++) {
      const alt = cleared.find((x) => x.id === pool.bag[j]);
      if (alt && alt.lane !== "shorts" && !(alt.kind === "sponsor" && recent.length >= 2 && recent[recent.length - 1] && recent[recent.length - 2])) { const t = pool.bag[pool.bagIx]; pool.bag[pool.bagIx] = pool.bag[j]; pool.bag[j] = t; id = pool.bag[pool.bagIx]; item = alt; swapped = true; break; }
    }
    if (!swapped) { pool.bagIx++; pool._dirty = true; return null; }
  }
  pool.bagIx++; pool._dirty = true;
  pool.recentBreaks = [...recent.slice(-1), !!(item && item.kind === "sponsor")];
  if (item) pool.lastBreakShort = item.lane === "shorts"; // a seed-bag miss (returns null, nothing aired) must not clear the after-short state — the next aired break still may not be a short
  return item;
}
/* Net tallies per program id from the tv/votes doc the vote
 * endpoint writes: sum (likes − dislikes) over every aired
 * instance of the id. Read fresh each tick in tvTick and carried
 * on the chan object as chan._voteNet (transient — deleted before
 * the tv/now write, like the window states). */
function tvVoteNetMap(votesDoc) {
  const net = {};
  const inst = votesDoc && votesDoc.inst && typeof votesDoc.inst === "object" ? votesDoc.inst : {};
  for (const k of Object.keys(inst)) {
    const r = inst[k];
    if (!r || !r.id) continue;
    net[r.id] = (net[r.id] || 0) + ((r.up | 0) - (r.down | 0));
  }
  return net;
}
/* CROWD-SKIP GATE (Malik, 2026-11-03 19:13 ET: "If 5 people vote
 * no i want it to get skipped" — carve-outs confirmed by Malik
 * 19:22 ET: his queue and the news stay protected; the crowd
 * kills Amani's picks only). The vote endpoint records the 5th
 * distinct 👎 as a tv/skip request; THIS gate is the only place
 * that decides whether the request may cut the segment on air,
 * and the cut itself runs through tvAdvanceChannel — THE shared
 * advancer the owner skip uses. The gate applies to CROWD
 * requests only: an owner skip (tv/queue.skipAt) never passes
 * here and cuts anything — owner supremacy. Every protected
 * class is one line, so Malik can flip any of them with one word:
 *   - news segments and the :50 news window (his news law)
 *   - the produced news updates chained after cadence spots
 *   - the 8 PM premiere slot and the 10 PM rerun slot
 *   - owner-queued items (segments carrying a qid) and the
 *     one-shot owner insert window
 *   - the anchor (local update edition) window
 * Everything else on the channel — cycle programs, break-pool
 * picks, the movie block — is the keeper's own pool programming
 * and may be crowd-skipped.
 * GUARDIAN AMENDMENT (Malik, 2026-11-03 20:39 ET: "Guardian can
 * skip a proven-dead item even in my queue/news"): this gate also
 * serves the Guardian (by:"guardian"). A guardian call carrying
 * proven-dead proof (see tvSkipGate) may pass the queue and news
 * lines ONLY. The crowd lines stay absolute for crowd calls, and
 * premiere / rerun / anchor / insert stay refused for everyone
 * but the owner. */
const TV_CROWD_PROTECTED_IDS = ["charnews-update", "quarter-update", "brk-local-update-5"];
function tvSkipGate(seg, chan, now, by, cadNow, proof) {
  if (by === "owner") return { ok: true };
  if (!seg) return { ok: false, why: "no-seg" };
  /* Guardian proven-dead proof (amendment in the gate comment
   * above): proof.seats >= TV_GUARD_CONFIRM_SEATS distinct seats'
   * hard-error confirmation for this exact segment instance, or
   * proof.banned (the segment's yt id is on brain/ytblock — a ban
   * is a house conviction). Only a by:"guardian" call can carry
   * proof; crowd calls never do, so the queue/news refusals below
   * stay absolute for the crowd, and a single seat, a bare probe
   * or an inconclusive check never fires a protected-class skip.
   * Precedence is the original one — the FIRST line that matches
   * decides: with proof it passes, marked (prot/proof/seats) so
   * the caller logs an owner-authorized proven-dead skip, counted
   * apart; without proof it refuses with the original why. The
   * window lines and premiere / rerun / family-time / insert /
   * anchor below are never proof-passed. */
  const gProof = (by === "guardian" && proof && (proof.banned === true || (proof.seats | 0) >= TV_GUARD_CONFIRM_SEATS)) ? proof : null;
  const pass = (cls) => ({ ok: true, prot: cls, proof: gProof.banned === true ? "ban" : "seats", seats: gProof.seats | 0 });
  if (seg.k === "news") return gProof ? pass("news") : { ok: false, why: "news" };
  if (seg.qid) return gProof ? pass("owner-queue") : { ok: false, why: "owner-queue" };
  if (seg.fam) return { ok: false, why: "family-time" };
  if (seg.khut) return { ok: false, why: "khutbah" };
  if (seg.cmd) return { ok: false, why: "comedy-hour" };
  if (seg.adh) return { ok: false, why: "adhan" };
  if (TV_CROWD_PROTECTED_IDS.includes(seg.id)) return gProof ? pass("news-update") : { ok: false, why: "news-update" };
  if (cadNow && cadNow.inside && cadNow.upd && seg.id === cadNow.upd.id) return gProof ? pass("news-update") : { ok: false, why: "news-update" };
  if (tvNewsWin(now).inside) return { ok: false, why: "news-window" };
  if (chan._prem) { const w = tvPremWin(now, chan._prem); if (w && w.inside) return { ok: false, why: "premiere" }; }
  if (chan._rerun) { const w = tvPremWin(now, chan._rerun); if (w && w.inside) return { ok: false, why: "rerun" }; }
  if (chan._family) { const w = tvFamilyWin(now, chan._family); if (w && w.inside) return { ok: false, why: "family-time" }; }
  if (chan._khutbah) { const w = tvKhutbahWin(now, chan._khutbah); if (w && w.inside) return { ok: false, why: "khutbah" }; }
  if (chan._comedy) { const w = tvComedyWin(now, chan._comedy); if (w && w.inside) return { ok: false, why: "comedy-hour" }; }
  if (chan._adhan) { const w = tvAdhanWinAt(now, chan._adhan); if (w && w.inside) return { ok: false, why: "adhan" }; }
  if (chan._insert) { const w = tvInsertWin(now, chan._insert); if (w && w.inside) return { ok: false, why: "owner-queue" }; }
  if (chan._anchor) { const w = tvAnchorWin(now, chan._anchor); if (w && w.inside) return { ok: false, why: "news" }; }
  return { ok: true };
}
/* Lay segments from the cursor (at = next segment start ms, ix/off =
 * where the cycle's current program resumes, run = seconds of
 * programming since the last break) out to horizonMs. News windows
 * cut programs mid-item; the item resumes after the window from the
 * offset it reached — a split program is two segments sharing an id. */
function tvGen(chan, pool, cursor, horizonMs) {
  const items = Array.isArray(chan.items) ? chan.items : [];
  const cad = tvAdCadItems(pool);
  // The movie block freezes for the cadence spots laid inside it
  // (the insert freeze rule): tvMovieWin runs the window long by
  // the spot time inside it, which it computes from this state.
  if (chan._movies && cad) chan._movies._cad = { cad, prem: chan._prem, anch: chan._anchor, ins: chan._insert, char: chan._char, lu: chan._lu, rer: chan._rerun, qtr: chan._qtr };
  if (chan._queue) chan._queue._st = { cad, prem: chan._prem, anch: chan._anchor, ins: chan._insert, char: chan._char, lu: chan._lu, rerun: chan._rerun, qtr: chan._qtr, family: chan._family, comedy: chan._comedy, crt: chan._cartoon, khutbah: chan._khutbah, adhan: chan._adhan };
  const segs = [];
  let t = cursor.at, ix = cursor.ix || 0, off = +cursor.off || 0, run = +cursor.run || 0;
  let guard = 0, skips = 0;
  while (t < horizonMs && guard++ < 600) {
    const win = tvNewsWin(t);
    const pwin = tvPremWin(t, chan._prem);
    const rwin = tvPremWin(t, chan._rerun);
    const fwin = tvFamilyWin(t, chan._family);
    const kwin = tvKhutbahWin(t, chan._khutbah);
    const hwin = tvComedyWin(t, chan._comedy);
    const dwin = tvAdhanWinAt(t, chan._adhan);
    const awin = tvAnchorWin(t, chan._anchor);
    const mwin = tvMovieWin(t, chan._movies);
    const iwin = tvInsertWin(t, chan._insert);
    const cadwin = tvAdWin(t, cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr, chan._khutbah);
    const qwin = tvQueueWin(t, chan._queue);
    const cwin = tvCartoonWinAt(t, chan._cartoon);
    // NEWS WINDOW — laid only under the v11 gates (see
    // TV_NEWS_FRESH_MS / tvNewsOverlapsFamily): a FRESH edition
    // must exist for this window, and the window must not overlap
    // Family Time. newsLive is judged for the window `win` names
    // (the one containing t, or the next one) and drives BOTH the
    // lay below and the program branch's boundary: a window that
    // will not be laid is no boundary at all, so the program
    // chain plays straight through it — no news segment, no stale
    // edition, no cut into the family movie, and no stall (the
    // program branch used to cut every item at every window start
    // and spin when the window then was not laid; an owner-cut
    // window truncated generation the same way — both now flow).
    const newsLive = !(chan._qCut && chan._qCut.news === win.start) && tvNewsFreshFor(chan, win.start) && !tvNewsOverlapsFamily(win, chan._family) && !tvNewsOverlapsKhutbah(win, chan._khutbah);
    if (win.inside && newsLive) { const dur = Math.max(1, Math.round((win.end - t) / 1000)); segs.push({ k: "news", start: t, dur, edWin: win.start }); t = win.end; skips = 0; continue; }
    if (pwin && pwin.inside && !(chan._qCut && chan._qCut.prem === pwin.start)) {
      // MY EMPIRE premiere slot: chain the live slot items; the program
      // cursor freezes and the interrupted program resumes after the
      // slot from the offset it reached (same split rule as news).
      let slotOff = (t - pwin.start) / 1000, segIt = null, segOff = 0;
      for (const sit of chan._prem.items) { if (slotOff < +sit.dur) { segIt = sit; segOff = slotOff; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((pwin.end - t) / 100) / 10); if (d > 0.05) { segs.push(tvProgSeg(segIt, t, d, segOff)); t += Math.round(d * 1000); skips = 0; continue; } }
      t = pwin.end; continue;
    }
    if (rwin && rwin.inside && !(chan._qCut && chan._qCut.rerun === rwin.start)) {
      // MY EMPIRE 10 PM rerun slot: the premiere chain replayed at
      // 22:00 ET (tvPremLive over tv/rerun, same window arithmetic):
      // the slot items chain in order, the program cursor freezes
      // and the interrupted program resumes after the slot from the
      // offset it reached (same split rule as the premiere).
      let slotOff = (t - rwin.start) / 1000, segIt = null, segOff = 0;
      for (const sit of chan._rerun.items) { if (slotOff < +sit.dur) { segIt = sit; segOff = slotOff; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((rwin.end - t) / 100) / 10); if (d > 0.05) { segs.push(tvProgSeg(segIt, t, d, segOff)); t += Math.round(d * 1000); skips = 0; continue; } }
      t = rwin.end; continue;
    }
    if (fwin && fwin.inside && !(chan._qCut && chan._qCut.family === fwin.start)) {
      // FAMILY TIME (Malik, 2026-11-03 20:38 ET): tonight's family
      // movie chains inside its window exactly like the premiere
      // chain — the program cursor freezes and the interrupted
      // program resumes after the block from the offset it
      // reached. The branch sits ahead of the anchor and the ad
      // cadence, so quarter breaks never chop the movie (the
      // premiere rule); and since the v11 build the news window
      // no longer passes over the span either — its lay gate
      // (tvNewsOverlapsFamily) refuses any window overlapping
      // this one, so the movie plays wall-to-wall.
      const fit = chan._family.item;
      const foff = (t - fwin.start) / 1000;
      const d = Math.min(Math.round((+fit.dur - foff) * 10) / 10, Math.round((fwin.end - t) / 100) / 10);
      if (d > 0.05) { const sg = tvProgSeg(fit, t, d, foff); sg.fam = 1; segs.push(sg); t += Math.round(d * 1000); skips = 0; continue; }
      t = fwin.end; continue;
    }
    if (kwin && kwin.inside && !(chan._qCut && chan._qCut.khutbah === kwin.start)) {
      // FRIDAY KHUTBAH (v16): this Friday's sermon chains inside
      // its window exactly like the Family Time movie — the
      // program cursor freezes and the interrupted program
      // resumes after the block from the offset it reached. The
      // branch sits ahead of the anchor and the ad cadence, so
      // quarter breaks never chop the sermon, and the news gate
      // refuses any :50 window overlapping it
      // (tvNewsOverlapsKhutbah) — the khutbah plays wall-to-wall.
      const kit = chan._khutbah.item;
      const koff = (t - kwin.start) / 1000;
      const d = Math.min(Math.round((+kit.dur - koff) * 10) / 10, Math.round((kwin.end - t) / 100) / 10);
      if (d > 0.05) { const sg = tvProgSeg(kit, t, d, koff); sg.khut = 1; segs.push(sg); t += Math.round(d * 1000); skips = 0; continue; }
      t = kwin.end; continue;
    }
    if (hwin && hwin.inside && !(chan._qCut && chan._qCut.comedy === hwin.start)) {
      // COMEDY HOUR (Fix #2B): tonight's comedy chain chains
      // inside its window by wall-clock offset exactly like the
      // premiere chain — the program cursor freezes and the
      // interrupted program resumes after the block from the
      // offset it reached. The branch sits ahead of the anchor,
      // the ad cadence, the cartoon block, the insert, the queue
      // and the fill, so none of them chop the hour; the :50 news
      // window keeps precedence the insert way — segments cap at
      // the window start when a fresh edition will lay (newsLive)
      // and the news branch above owns that span — and the window
      // ends sharp at 20:00, where Family Time takes the channel.
      let cap = hwin.end;
      if (newsLive && win.start > t && win.start < cap) cap = win.start;
      let slotOff = (t - hwin.start) / 1000, segIt = null, segOff = 0;
      for (const sit of chan._comedy.items) { if (slotOff < +sit.dur - 1e-6) { segIt = sit; segOff = slotOff > 0 ? slotOff : 0; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((cap - t) / 100) / 10); if (d > 0.05) { const sg = tvProgSeg(segIt, t, d, segOff); sg.cmd = 1; segs.push(sg); t += Math.round(d * 1000); skips = 0; continue; } }
      t = cap; continue;
    }
    if (awin && awin.inside && !(chan._qCut && chan._qCut.anchor === awin.start)) {
      // Anchor news slot: the current anchor edition plays as one
      // program segment; the interrupted program freezes and resumes
      // after the slot from the offset it reached (premiere split rule).
      const ait = chan._anchor.item;
      const aoff = (t - awin.start) / 1000;
      const d = Math.min(Math.round((+ait.dur - aoff) * 10) / 10, Math.round((awin.end - t) / 100) / 10);
      if (d > 0.05) { segs.push(tvProgSeg(ait, t, d, aoff)); t += Math.round(d * 1000); skips = 0; continue; }
      t = awin.end; continue;
    }
    if (cwin && cwin.inside && !(chan._qCut && chan._qCut.cartoon === cwin.start)) {
      // HOURLY CARTOON (tvCartoonSpans): the slot's sequence
      // chains inside its span by wall-clock offset exactly like
      // the premiere chain — the program cursor frozen, the
      // interrupted program resumes after the span from the
      // offset it reached. The span never overlaps a hard window
      // (tvCartoonSpans slid it past them all) and this branch
      // sits ahead of the ad cadence, so no OUTSIDE spot chops
      // the block: since v2 the sequence itself (tvCartoonSeq
      // for THIS span's hour) is Episode 1, one of Malik's show
      // commercials, Episode 2, one more commercial — since
      // TV_CARTOON_V 4 the Squishy Saga episode after it, and
      // since TV_CARTOON_V 5 Episodes 3 and 4 between Episode 2
      // and Squishy Saga with one show commercial after each of
      // the four South Park episodes — each part back-to-back,
      // no gap. An instance the owner (or the
      // Guardian) cut is stamped in qCut by the shared advancer
      // and never resumes — the check above reads qCut live, so
      // a same-tick skip is honored. The block is a normal
      // auto-picked program for every skip rule: no protected
      // id, no qid/fam flag.
      const cspan = (chan._cartoon.spans || []).find((sp) => sp.start === cwin.start);
      const cseq = tvCartoonSeq(chan._cartoon, cspan ? cspan.hour : cwin.start);
      let slotOff = (t - cwin.start) / 1000, segIt = null, segOff = 0;
      // WALKER FLOAT FIX (2026-11-06, authorized by Malik's "A" —
      // the v17-flagged fragility, cured at the walker): the
      // subtraction chain carries a ~1e-13 s residue, so a cursor
      // landing exactly on a piece boundary could read a hair
      // INSIDE the finished piece, round its remaining time to
      // zero and bail to the span end — silently dropping every
      // later piece (at the 14-piece v5 block: the fourth
      // commercial + both Squishy parts, from ~97% of spans). The
      // 1e-6 s epsilon is ~10^7 times the residue yet 1000x under
      // the 0.001 s grain of every genuine offset (t and the span
      // start are whole milliseconds, the pins whole 0.1 s
      // steps), so it absorbs residue only and can never move a
      // real position; segOff clamps at 0 for the same reason.
      for (const sit of cseq) { if (slotOff < +sit.dur - 1e-6) { segIt = sit; segOff = slotOff > 0 ? slotOff : 0; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((cwin.end - t) / 100) / 10); if (d > 0.05) { segs.push(tvProgSeg(segIt, t, d, segOff)); t += Math.round(d * 1000); skips = 0; continue; } }
      t = cwin.end; continue;
    }
    if (dwin && dwin.inside && !(chan._qCut && chan._qCut.adhan === dwin.key)) {
      // THE ADHAN (v16): the prayer placed by tvAdhanSpans — at
      // its exact time through everything still running at this
      // precedence (the fill chain, the break bag, the ad cadence
      // below, the owner queue), or slid to the end of the
      // protected span it would have overlapped. It chains by
      // wall-clock offset like the premiere chain; the program
      // cursor does not move here, so whatever it interrupts
      // resumes from the offset it reached.
      const dit = dwin.item;
      const doff = (t - dwin.start) / 1000;
      const d = Math.min(Math.round((+dit.dur - doff) * 10) / 10, Math.round((dwin.end - t) / 100) / 10);
      if (d > 0.05) { const sg = tvProgSeg(dit, t, d, doff); sg.adh = 1; sg.adhKey = dwin.key; segs.push(sg); t += Math.round(d * 1000); skips = 0; continue; }
      t = dwin.end; continue;
    }
    if (cadwin && cadwin.inside && !(chan._qCut && chan._qCut.cad === cadwin.start)) {
      // MY EMPIRE ad cadence: the spot interrupts whatever is
      // playing — music program, movie chain or insert alike — and
      // what it interrupts resumes from the offset it reached: the
      // music program's generator cursor does not move here (the
      // news-window split rule), and the movie block subtracts the
      // spot time from its wall-clock position (the insert freeze
      // rule, tvAdTimeIn in the movie branch). When the span carries
      // a chained character news update (cadwin.upd, tvAdSpans), the
      // update plays immediately after the spot inside the same
      // span: whichever part of the span contains t is laid here.
      const spotEnd = cadwin.start + (+cadwin.item.dur || 0) * 1000;
      if (cadwin.upd && t >= spotEnd) {
        const upit = cadwin.upd;
        const upoff = (t - spotEnd) / 1000;
        const d = Math.min(Math.round((+upit.dur - upoff) * 10) / 10, Math.round((cadwin.end - t) / 100) / 10);
        if (d > 0.05) { segs.push(tvProgSeg(upit, t, d, upoff)); t += Math.round(d * 1000); skips = 0; continue; }
        t = cadwin.end; continue;
      }
      const adit = cadwin.item;
      const adoff = (t - cadwin.start) / 1000;
      const d = Math.min(Math.round((+adit.dur - adoff) * 10) / 10, Math.round((cadwin.end - t) / 100) / 10);
      if (d > 0.05) { segs.push(tvProgSeg(adit, t, d, adoff)); t += Math.round(d * 1000); skips = 0; continue; }
      t = cadwin.end; continue;
    }
    if (iwin && iwin.inside) {
      // One-shot owner-ordered insert (tv/insert): the item — or,
      // v2, the short playlist — plays exactly once, wall-clock
      // like the premiere chain: the offset runs from the window
      // start across the items in order, and news, premiere and
      // anchor windows keep precedence and pass over the span they
      // cover. The movie-block window start is NOT a cap: the
      // insert cuts into whatever is laid, and when it cuts into
      // the movie block the block freezes for the span the insert
      // covers and resumes from the offset it reached (the movie
      // branch subtracts the frozen span once the window has run).
      let cap = iwin.end;
      if (win.start > t && win.start < cap) cap = win.start;
      if (pwin && !pwin.inside && pwin.start > t && pwin.start < cap) cap = pwin.start;
      if (rwin && !rwin.inside && rwin.start > t && rwin.start < cap) cap = rwin.start;
      if (awin && !awin.inside && awin.start > t && awin.start < cap) cap = awin.start;
      if (cadwin && !cadwin.inside && cadwin.start > t && cadwin.start < cap) cap = cadwin.start;
      if (qwin && !qwin.inside && qwin.start > t && qwin.start < cap) cap = qwin.start;
      if (fwin && !fwin.inside && fwin.start > t && fwin.start < cap) cap = fwin.start;
      if (cwin && !cwin.inside && cwin.start > t && cwin.start < cap) cap = cwin.start;
      if (kwin && !kwin.inside && kwin.start > t && kwin.start < cap) cap = kwin.start;
      if (hwin && !hwin.inside && hwin.start > t && hwin.start < cap) cap = hwin.start;
      if (dwin && !dwin.inside && dwin.start > t && dwin.start < cap) cap = dwin.start;
      const list = Array.isArray(chan._insert.items) && chan._insert.items.length ? chan._insert.items : [chan._insert.item];
      let slotOff = (t - iwin.start) / 1000, segIt = null, segOff = 0;
      for (const sit of list) { if (slotOff < +sit.dur) { segIt = sit; segOff = slotOff; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((cap - t) / 100) / 10); if (d > 0.05) { segs.push(tvProgSeg(segIt, t, d, segOff)); t += Math.round(d * 1000); skips = 0; continue; } }
      t = cap; continue;
    }

    if (qwin && qwin.inside) {
      // MW TV OWNER QUEUE: the owner's list plays here — after
      // the hard schedule and the one-shot insert, ahead of the
      // movie block and the cycle. Position is content time
      // (tvQueueElapsed), so a preemption never eats the list;
      // items chain in list order from the offset reached, cut
      // at the next hard boundary like every chain on the channel.
      let cap = qwin.end;
      if (win.start > t && win.start < cap) cap = win.start;
      if (pwin && !pwin.inside && pwin.start > t && pwin.start < cap) cap = pwin.start;
      if (rwin && !rwin.inside && rwin.start > t && rwin.start < cap) cap = rwin.start;
      if (awin && !awin.inside && awin.start > t && awin.start < cap) cap = awin.start;
      if (iwin && !iwin.inside && iwin.start > t && iwin.start < cap) cap = iwin.start;
      if (cadwin && !cadwin.inside && cadwin.start > t && cadwin.start < cap) cap = cadwin.start;
      if (mwin && !mwin.inside && mwin.start > t && mwin.start < cap) cap = mwin.start;
      if (fwin && !fwin.inside && fwin.start > t && fwin.start < cap) cap = fwin.start;
      if (cwin && !cwin.inside && cwin.start > t && cwin.start < cap) cap = cwin.start;
      if (kwin && !kwin.inside && kwin.start > t && kwin.start < cap) cap = kwin.start;
      if (hwin && !hwin.inside && hwin.start > t && hwin.start < cap) cap = hwin.start;
      if (dwin && !dwin.inside && dwin.start > t && dwin.start < cap) cap = dwin.start;
      const qat = tvQueueAt(chan._queue, tvQueueElapsed(chan._queue, t));
      if (qat) { const d = Math.min(Math.round((+qat.it.dur - qat.off) * 10) / 10, Math.round((cap - t) / 100) / 10); if (d > 0.05) { const sg = tvProgSeg(qat.it, t, d, qat.off); sg.qid = qat.it.qid; segs.push(sg); t += Math.round(d * 1000); skips = 0; continue; } }
      t = cap; continue;
    }
    if (mwin && mwin.inside) {
      // Post-premiere movie block: chain tonight's movies in order;
      // the music program freezes and resumes after the block (same
      // split rule as the premiere slot). Movie offsets are wall-clock
      // like the premiere chain, so a news window or an anchor slot
      // that takes its place mid-movie passes over the span it covers
      // and the movie resumes on the other side — the chain therefore
      // cuts at the next news/anchor/premiere boundary, exactly like
      // a program item does.
      let cap = mwin.end;
      if (win.start > t && win.start < cap) cap = win.start;
      if (pwin && !pwin.inside && pwin.start > t && pwin.start < cap) cap = pwin.start;
      if (rwin && !rwin.inside && rwin.start > t && rwin.start < cap) cap = rwin.start;
      if (awin && !awin.inside && awin.start > t && awin.start < cap) cap = awin.start;
      if (iwin && !iwin.inside && iwin.start > t && iwin.start < cap) cap = iwin.start;
      if (cadwin && !cadwin.inside && cadwin.start > t && cadwin.start < cap) cap = cadwin.start;
      if (qwin && !qwin.inside && qwin.start > t && qwin.start < cap) cap = qwin.start;
      if (fwin && !fwin.inside && fwin.start > t && fwin.start < cap) cap = fwin.start;
      if (cwin && !cwin.inside && cwin.start > t && cwin.start < cap) cap = cwin.start;
      if (kwin && !kwin.inside && kwin.start > t && kwin.start < cap) cap = kwin.start;
      if (hwin && !hwin.inside && hwin.start > t && hwin.start < cap) cap = hwin.start;
      if (dwin && !dwin.inside && dwin.start > t && dwin.start < cap) cap = dwin.start;
      let slotOff = (t - mwin.start) / 1000, segIt = null, segOff = 0;
      // An insert that cut into this block froze it: once the
      // insert window has run, positions sit behind the wall clock
      // by the frozen span (tvInsertFrozen, stamped in tvTick).
      if (chan._movies.insShift > 0 && isFinite(chan._movies.insEnd) && t >= chan._movies.insEnd) slotOff -= chan._movies.insShift;
      if (chan._movies.qShift > 0 && isFinite(chan._movies.qEnd) && t >= chan._movies.qEnd) slotOff -= chan._movies.qShift;
      if (chan._movies.crtShift > 0 && isFinite(chan._movies.crtEnd) && t >= chan._movies.crtEnd) slotOff -= chan._movies.crtShift;
      // The ad cadence froze the block at every spot inside it:
      // positions likewise sit behind the wall clock by the spot
      // time laid between the window start and here.
      if (cad) slotOff -= tvAdTimeIn(cad, chan._prem, chan._anchor, chan._insert, mwin.start, t, chan._char, chan._lu, chan._rerun, chan._qtr, chan._khutbah);
      if (chan._movies.skipShift > 0 && t >= chan._movies.skipAt) slotOff += chan._movies.skipShift;
      for (const sit of chan._movies.items) { if (slotOff < +sit.dur) { segIt = sit; segOff = slotOff; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((cap - t) / 100) / 10); if (d > 0.05) { segs.push(tvProgSeg(segIt, t, d, segOff)); t += Math.round(d * 1000); skips = 0; continue; } }
      t = cap; continue;
    }
    const it = items[ix];
    if (!it) break;
    // v14 ONLY gate: the chain lays fill items only (tvFillOk) —
    // the rest of the cycle seed is skipped in place (it stays in
    // the doc for Family Time eligibility, it just never airs).
    if (!tvCleared(it) || !tvFillOk(it)) { ix = (ix + 1) % items.length; off = 0; if (++skips > items.length) break; continue; }
    skips = 0;
    const remain = Math.round((+it.dur - off) * 10) / 10;
    if (!(remain > 0)) { ix = (ix + 1) % items.length; off = 0; continue; }
    const progEnd = t + remain * 1000;
    let boundary = newsLive ? win.start : Infinity;
    if (pwin && !pwin.inside && pwin.start > t && pwin.start < boundary) boundary = pwin.start;
    if (rwin && !rwin.inside && rwin.start > t && rwin.start < boundary) boundary = rwin.start;
    if (awin && !awin.inside && awin.start > t && awin.start < boundary) boundary = awin.start;
    if (mwin && !mwin.inside && mwin.start > t && mwin.start < boundary) boundary = mwin.start;
    if (iwin && !iwin.inside && iwin.start > t && iwin.start < boundary) boundary = iwin.start;
    if (cadwin && !cadwin.inside && cadwin.start > t && cadwin.start < boundary) boundary = cadwin.start;
    if (qwin && !qwin.inside && qwin.start > t && qwin.start < boundary) boundary = qwin.start;
    if (fwin && !fwin.inside && fwin.start > t && fwin.start < boundary) boundary = fwin.start;
    if (cwin && !cwin.inside && cwin.start > t && cwin.start < boundary) boundary = cwin.start;
    if (kwin && !kwin.inside && kwin.start > t && kwin.start < boundary) boundary = kwin.start;
    if (hwin && !hwin.inside && hwin.start > t && hwin.start < boundary) boundary = hwin.start;
    if (dwin && !dwin.inside && dwin.start > t && dwin.start < boundary) boundary = dwin.start;
    if (boundary < progEnd) {
      const cutSec = Math.round((boundary - t) / 100) / 10;
      if (cutSec > 0.05) { segs.push(tvProgSeg(it, t, cutSec, off)); run += cutSec; off += cutSec; }
      t = boundary;
      continue;
    }
    segs.push(tvProgSeg(it, t, remain, off)); run += remain; t = progEnd; ix = (ix + 1) % items.length; off = 0;
    if (run >= (chan.chainSec > 0 ? +chan.chainSec : TV_CHAIN_SEC)) {
      const b = tvDrawBreak(pool, chan._voteNet);
      if (b) {
        // A break never overruns a slot start: premiere, anchor and
        // movie-block windows begin on time, so a break that would
        // cross one is cut at its edge (and skipped if only a sliver
        // would remain). News windows keep their long-standing
        // behaviour — the window simply starts when the break ends.
        let bd = +b.dur, capS = Infinity;
        for (const w of [tvPremWin(t, chan._prem), tvPremWin(t, chan._rerun), tvAnchorWin(t, chan._anchor), tvMovieWin(t, chan._movies), tvInsertWin(t, chan._insert), tvAdWin(t, cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr, chan._khutbah), tvQueueWin(t, chan._queue), tvFamilyWin(t, chan._family), tvCartoonWinAt(t, chan._cartoon), tvKhutbahWin(t, chan._khutbah), tvComedyWin(t, chan._comedy), tvAdhanWinAt(t, chan._adhan)]) { if (w && !w.inside && w.start > t && w.start < capS) capS = w.start; }        if (capS < t + bd * 1000) bd = Math.round((capS - t) / 100) / 10;
        if (bd > 0.05) { segs.push({ k: (b.kind === "house" || b.kind === "sponsor") ? "house" : "break", id: b.id, src: b.src, yt: b.yt || "", url: b.url || "", iaId: b.iaId || "", title: b.title || "", show: "", start: t, dur: bd, off: 0 }); t += Math.round(bd * 1000); }
      }
      run = 0;
    }
  }
  return { segs, cursor: { at: t, ix, off, run } };
}
function tvSegAt(segs, t) {
  if (!Array.isArray(segs)) return null;
  for (const sg of segs) { if (t >= sg.start && t < sg.start + sg.dur * 1000) return sg; }
  return null;
}
/* Cold start / long-silence landing: where the cycle sits right now,
 * by epoch math over the CLEARED + FILL items only (held items and
 * non-fill items never air — tvFillOk, the v14 ONLY gate: the epoch
 * rotation runs over the same fill subset tvGen's walk lays). */
function tvCyclePos(chan, now) {
  const items = (chan.items || []).map((it, i) => ({ it, i })).filter((x) => tvCleared(x.it) && tvFillOk(x.it));
  const total = items.reduce((a, x) => a + (+x.it.dur || 0), 0);
  if (!total) return null;
  const epoch = +chan.epoch || now;
  let pos = ((now - epoch) / 1000) % total; if (pos < 0) pos += total;
  for (const x of items) { if (pos < +x.it.dur) return { ix: x.i, off: Math.round(pos * 10) / 10 }; pos -= +x.it.dur; }
  return { ix: items[0].i, off: 0 };
}
/* The radio news gate (NEWS-BLOCK; source changed by Malik
 * 2026-11-03 ~14:54: "new news every time — 60 seconds of it every
 * 15 minutes"): fire in the first five minutes of every quarter
 * hour (:00/:15/:30/:45) the SAME fresh ~60-second piece the TV
 * quarter break plays — the producer's quarter piece for the
 * quarter we are IN (tv/quarternews), at its honest produced
 * length. Freshness law: the piece must have been produced FOR
 * this quarter (forQuarter == the quarter's start) and within
 * TV_QUARTER_FRESH_MS of now; last quarter's piece NEVER replays.
 * Only once per quarter, only on a live Auto-DJ station. There is
 * NO booth exception (Malik, 2026-11-01: the break cuts in even
 * during his own live booth sets): a due fire falls through the
 * booth stand-down in the handler, like the breakers. Every other
 * state is a named skip — no fresh piece, no break, ever. */
function tvRadioDecision(S, qDoc, now) {
  const cur = qDoc && qDoc.current;
  if (!cur || !cur.radioUrl || !(+cur.radioDur > 0) || !(+cur.forQuarter > 0) || !(+cur.producedAt > 0)) return { fire: false, why: "no-quarter-piece" };
  const qStart = Math.floor(now / TV_AD_EVERY_MS) * TV_AD_EVERY_MS;
  if (+cur.forQuarter !== qStart) return { fire: false, why: "wrong-quarter" };
  if (+cur.producedAt > now) return { fire: false, why: "future-piece" };
  if (now - +cur.producedAt > TV_QUARTER_FRESH_MS) return { fire: false, why: "stale-piece" };
  const et = tvEtParts(now);
  const q = Math.floor(et.minute / 15), minInQ = et.minute - q * 15;
  if (minInQ > 4) return { fire: false, why: "outside-window" };
  const qKey = et.dayKey + "T" + et.hour + ":" + String(q * 15).padStart(2, "0");
  if (S.newsHour === qKey) return { fire: false, why: "already-fired" };
  if (!S.live || !S.autodj || S.pausedAt) return { fire: false, why: "station-not-live" };
  return { fire: true, hourKey: qKey, item: { src: String(cur.radioUrl), title: "📰 Meechie's World News", dur: Math.min(600, Math.max(5, Math.round(+cur.radioDur))) } };
}
function tvSeedChannel(now) {
  const R = (basis, evidence, simulcast) => ({ basis, evidence, clearedBy: basis === "own" ? "owner" : "keeper-check", at: now, simulcast: !!simulcast });
  const RE = (evidence) => R("embed", evidence, false);
  const chan = {
    on: true, epoch: now, breakEvery: 1, chainSec: TV_CHAIN_SEC,
    breakMix: { video: 3, house: 1, legal: 1 },
    progV: TV_PROGRAM_V,
    items: [
      { id: "own-anthem", kind: "house", src: "file", url: "/media/the-world-gone-be.mp4", title: "The World Gone Be — Official Video", show: "Meechie's World", dur: 266, block: "anytime", rights: R("own", "Malik's own song and video, hosted on his own site media (/media/the-world-gone-be.mp4, HTTP 200 video/mp4 verified at seed time); he is the artist and rights holder", true) },
      { id: "mv-h58vbez_m4e", kind: "show", src: "yt", yt: "H58vbez_m4E", title: "Kendrick Lamar - Not Like Us", show: "MW Mixed Hits", dur: 355, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader KendrickLamarVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-4qize708gj4", kind: "show", src: "yt", yt: "4QIZE708gJ4", title: "Post Malone - I Had Some Help (feat. Morgan Wallen) (Official Video)", show: "MW Mixed Hits", dur: 202, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader PostMaloneVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-t7bqwwqw-hc", kind: "show", src: "yt", yt: "t7bQwwqW-Hc", title: "Shaboozey - A Bar Song (Tipsy) [Official Visualizer]", show: "MW Mixed Hits", dur: 174, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ShaboozeyVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-4nrxx6u8abq", kind: "show", src: "yt", yt: "4NRXx6U8ABQ", title: "The Weeknd - Blinding Lights (Official Video)", show: "MW Mixed Hits", dur: 263, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader TheWeekndVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-kpa7bskwl-c", kind: "show", src: "yt", yt: "kPa7bsKwL-c", title: "Lady Gaga, Bruno Mars - Die With A Smile (Official Music Video)", show: "MW Mixed Hits", dur: 253, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader LadyGagaVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-iq8h3gee22o", kind: "show", src: "yt", yt: "Iq8h3GEe22o", title: "Jack Harlow - Lovin On Me [Official Music Video]", show: "MW Mixed Hits", dur: 140, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Jack Harlow (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-m4_9tfemfje", kind: "show", src: "yt", yt: "m4_9TFeMfJE", title: "Doja Cat - Paint The Town Red (Official Video)", show: "MW Mixed Hits", dur: 296, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader dojacatVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-srxh9abt280", kind: "show", src: "yt", yt: "SRXH9AbT280", title: "The Emptiness Machine (Official Music Video) - Linkin Park", show: "MW Mixed Hits", dur: 201, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Linkin Park (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-ldy_xyxbu8a", kind: "show", src: "yt", yt: "LDY_XyxBu8A", title: "SZA - Snooze (Official Video)", show: "MW Mixed Hits", dur: 281, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader SZAVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-bujppbxbqrq", kind: "show", src: "yt", yt: "bUjPPBxbQrQ", title: "Morgan Wallen - Last Night (One Record At A Time Sessions)", show: "MW Mixed Hits", dur: 166, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader MorganWallenVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-8ekjmc8otgu", kind: "show", src: "yt", yt: "8ekJMC8OtGU", title: "Drake - NOKIA (Official Music Video)", show: "MW Mixed Hits", dur: 266, block: "mixed", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader DrakeVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-tvtrzj-4eyi", kind: "show", src: "yt", yt: "tvTRZJ-4EyI", title: "Kendrick Lamar - HUMBLE.", show: "MW Rap", dur: 184, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader KendrickLamarVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-sny_2temzho", kind: "show", src: "yt", yt: "sNY_2TEmzho", title: "Kendrick Lamar, SZA - luther", show: "MW Rap", dur: 312, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader KendrickLamarVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xpvfcz0zcfm", kind: "show", src: "yt", yt: "xpVfcZ0ZcFM", title: "Drake - God's Plan", show: "MW Rap", dur: 357, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader DrakeVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-narftb5tdtq", kind: "show", src: "yt", yt: "narFtb5tdTQ", title: "Cardi B - Enough (Miami) [Official Music Video]", show: "MW Rap", dur: 156, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Cardi B (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xvgclq_jqfu", kind: "show", src: "yt", yt: "XVgCLQ_JQfU", title: "Megan Thee Stallion - HISS [Official Video]", show: "MW Rap", dur: 195, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Megan Thee Stallion (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-zp6eqcom7tk", kind: "show", src: "yt", yt: "zP6eqCOM7tk", title: "GloRilla - TGIF (Official Music Video)", show: "MW Rap", dur: 165, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader GloRillaVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-py9s2bd0rzq", kind: "show", src: "yt", yt: "Py9S2bD0RZQ", title: "GloRilla - WHATCHU KNO ABOUT ME ft. Sexyy Red (Official Music Video)", show: "MW Rap", dur: 167, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader GloRillaVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-d66aymovmze", kind: "show", src: "yt", yt: "D66AyMOVmzE", title: "Latto - Put It On Da Floor (Official Video)", show: "MW Rap", dur: 190, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Latto (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-n2neoys8niw", kind: "show", src: "yt", yt: "N2neoYs8niw", title: "Ice Spice, Central Cee - Did It First", show: "MW Rap", dur: 127, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader IceSpiceVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-pdddlvcftiw", kind: "show", src: "yt", yt: "pDddlvCfTiw", title: "CENTRAL CEE FT. LIL BABY - BAND4BAND (MUSIC VIDEO)", show: "MW Rap", dur: 152, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Central Cee (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-u4madkt6o-m", kind: "show", src: "yt", yt: "U4mADkt6o-M", title: "21 Savage - redrum (Official Music Video)", show: "MW Rap", dur: 267, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader 21 Savage (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-b9synwjqbn8", kind: "show", src: "yt", yt: "B9synWjqBn8", title: "Travis Scott - FE!N ft. Playboi Carti", show: "MW Rap", dur: 210, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader TravisScottVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-qer3lwd5hya", kind: "show", src: "yt", yt: "Qer3lwd5hyA", title: "Tyler, The Creator - NOID", show: "MW Rap", dur: 163, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Tyler, The Creator (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-3gopffinomk", kind: "show", src: "yt", yt: "3GoPfFInOMk", title: "Eminem - Houdini (Official Music Video)", show: "MW Rap", dur: 224, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Eminem (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-wilnixzr2oc", kind: "show", src: "yt", yt: "WILNIXZr2oc", title: "J. Cole - MIDDLE CHILD", show: "MW Rap", dur: 219, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader JColeVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-v6zsxke8qmq", kind: "show", src: "yt", yt: "V6ZsXKE8QmQ", title: "Gunna - fukumean [Official Video]", show: "MW Rap", dur: 140, block: "rap", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Gunna (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-roexmase7lo", kind: "show", src: "yt", yt: "RoeXmaSE7Lo", title: "Post Malone ft. Blake Shelton - Pour Me A Drink (Official Video) ft. Blake Shelton", show: "MW Country", dur: 196, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader PostMaloneVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-fr7oyjnt3bm", kind: "show", src: "yt", yt: "Fr7oYjnt3bM", title: "Luke Combs - Fast Car (Official Live Video)", show: "MW Country", dur: 270, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader LukeCombsVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-j6ylaeace4e", kind: "show", src: "yt", yt: "J6YlaeACE4E", title: "Luke Combs – Ain’t No Love In Oklahoma (From Twisters: The Album) [Official Music Video]", show: "MW Country", dur: 209, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Luke Combs (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-la8f9sihgdg", kind: "show", src: "yt", yt: "lA8F9sIhGdg", title: "Zach Bryan - Something In The Orange", show: "MW Country", dur: 263, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Zach Bryan (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-ii-l8hq0_i4", kind: "show", src: "yt", yt: "II-L8Hq0_i4", title: "Tyler Childers - In Your Love (Official Video)", show: "MW Country", dur: 285, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader TylerChildersVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv--q-ijqe8nty", kind: "show", src: "yt", yt: "-q-IjQE8nTY", title: "Chris Stapleton - White Horse (Official Music Video)", show: "MW Country", dur: 374, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ChrisStapletonVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-rnreepitjn0", kind: "show", src: "yt", yt: "rNReepITjN0", title: "Lainey Wilson - Heart Like A Truck (Official Music Video)", show: "MW Country", dur: 208, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Lainey Wilson (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-uycwak6sbik", kind: "show", src: "yt", yt: "UYCWaK6Sbik", title: "Bailey Zimmerman - Religiously (Official Music Video)", show: "MW Country", dur: 244, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Bailey Zimmerman (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-mpacja3hgda", kind: "show", src: "yt", yt: "MPacja3hGdA", title: "Megan Moroney - Tennessee Orange (Official Video)", show: "MW Country", dur: 230, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader MeganMoroneyVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-dm2tsmergpq", kind: "show", src: "yt", yt: "Dm2TSMerGPQ", title: "Ella Langley (feat. Riley Green) - you look like you love me (Official Video)", show: "MW Country", dur: 281, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader EllaLangleyVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-fyjnbssz2tc", kind: "show", src: "yt", yt: "FyjnbSsZ2tc", title: "Dasha - Austin (Official Music Video)", show: "MW Country", dur: 185, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Dasha (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-cdvn4zijute", kind: "show", src: "yt", yt: "cdVN4ZiJUTE", title: "Cody Johnson - Dirt Cheap (Official Music Video)", show: "MW Country", dur: 255, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Cody Johnson (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-qbhu2y7rnnm", kind: "show", src: "yt", yt: "qbHu2Y7rnNM", title: "Parker McCollum - Burn It Down (Official Music Video)", show: "MW Country", dur: 244, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ParkerMcCollumVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-fxfnprpodss", kind: "show", src: "yt", yt: "FxFNprPOdss", title: "Jelly Roll - Save Me (New Unreleased Video)", show: "MW Country", dur: 237, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Jelly Roll (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-mvdjxmxztl0", kind: "show", src: "yt", yt: "MVDJxMxzTL0", title: "Jessie Murph, Jelly Roll - Wild Ones (Official Video)", show: "MW Country", dur: 146, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader JessieMurphVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-ysmb0i5ytoc", kind: "show", src: "yt", yt: "YsMB0i5YTOc", title: "HARDY - wait in the truck (feat. Lainey Wilson) (Official Music Video)", show: "MW Country", dur: 301, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader HARDYVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-uyakpowkuda", kind: "show", src: "yt", yt: "UyAKpowkUDA", title: "Koe Wetzel, Jessie Murph - High Road (Official Video)", show: "MW Country", dur: 177, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader KoeWetzelVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-238z4yaar1g", kind: "show", src: "yt", yt: "238Z4YaAr1g", title: "Beyoncé - TEXAS HOLD 'EM (Official Visualizer)", show: "MW Country", dur: 238, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader BeyoncéVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-5frhtahqirc", kind: "show", src: "yt", yt: "5FrhtahQiRc", title: "Heavy Is The Crown ft. Linkin Park (Official Music Video) | League of Legends Worlds 2024 Anthem", show: "MW Rock", dur: 226, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader League of Legends (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-_u-7rwknvvo", kind: "show", src: "yt", yt: "_u-7rWKnVVo", title: "Metallica: Lux Æterna (Official Music Video)", show: "MW Rock", dur: 211, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Metallica (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-mgr2m2mbjxu", kind: "show", src: "yt", yt: "mGR2M2mBJXU", title: "Ghost - Satanized (Official Music Video)", show: "MW Rock", dur: 247, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Ghost (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-jjpftup6fio", kind: "show", src: "yt", yt: "JJpFTUP6fIo", title: "Sleep Token - Emergence", show: "MW Rock", dur: 387, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader SleepTokenVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-glrfl26q92s", kind: "show", src: "yt", yt: "GLRFl26Q92s", title: "Bad Omens - Just Pretend (Official Music Video)", show: "MW Rock", dur: 239, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader SUMERIAN (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-jakpo7tj7qw", kind: "show", src: "yt", yt: "jakpo7tj7Qw", title: "Falling In Reverse - \"Popular Monster\"", show: "MW Rock", dur: 233, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Epitaph Records (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xv-70a6yxfm", kind: "show", src: "yt", yt: "xv-70a6yXfM", title: "Bring Me The Horizon - LosT (Official Video)", show: "MW Rock", dur: 259, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader BMTHOfficialVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-fskqrdq3rkm", kind: "show", src: "yt", yt: "fSKQRDq3RkM", title: "blink-182 - ONE MORE TIME (Official Video)", show: "MW Rock", dur: 208, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader blink182VEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-qamulkjchoo", kind: "show", src: "yt", yt: "qAmulKjcHoo", title: "Green Day - Dilemma (Official Music Video)", show: "MW Rock", dur: 198, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Green Day (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-r1g6-ruz3oa", kind: "show", src: "yt", yt: "R1G6-RUz3OA", title: "Foo Fighters - Shame Shame (Official Video)", show: "MW Rock", dur: 242, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader foofightersVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-os8taaszl8k", kind: "show", src: "yt", yt: "OS8taasZl8k", title: "Red Hot Chili Peppers - Black Summer (Official Music Video)", show: "MW Rock", dur: 234, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Red Hot Chili Peppers (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-v08qmr8m_-w", kind: "show", src: "yt", yt: "v08qmr8m_-w", title: "Imagine Dragons - Eyes Closed (Official Music Video)", show: "MW Rock", dur: 249, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ImagineDragonsVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-53tgvlxbzvg", kind: "show", src: "yt", yt: "53tgVlXBZVg", title: "Twenty One Pilots - Overcompensate (Official Video)", show: "MW Rock", dur: 256, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader twenty one pilots (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-obrkbwsb3ls", kind: "show", src: "yt", yt: "oBrkbWSB3Ls", title: "Fall Out Boy - Love From The Other Side (Official Video)", show: "MW Rock", dur: 328, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Fall Out Boy (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xiyj7vasxyy", kind: "show", src: "yt", yt: "xIYJ7VaSxYY", title: "Paramore: This Is Why [OFFICIAL VIDEO]", show: "MW Rock", dur: 238, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Paramore (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-54leywabkl4", kind: "show", src: "yt", yt: "54LEywabkl4", title: "AC/DC - Shot In The Dark (Official Video)", show: "MW Rock", dur: 196, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader acdcVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-qchpbdn2tp0", kind: "show", src: "yt", yt: "qCHPBDN2Tp0", title: "Guns N' Roses - Perhaps (Official Music Video)", show: "MW Rock", dur: 225, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader GunsNRosesVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-jodrvofka54", kind: "show", src: "yt", yt: "jODrVofka54", title: "Måneskin - SUPERMODEL (Official Video)", show: "MW Rock", dur: 186, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ManeskinVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-j16linlzrms", kind: "show", src: "yt", yt: "J16lInLZRms", title: "Creed - Higher (Official HD Music Video)", show: "MW Rock", dur: 283, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader CreedVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-tagnkpe4nci", kind: "show", src: "yt", yt: "tAGnKpE4NCI", title: "Metallica: Nothing Else Matters (Official Music Video)", show: "MW Rock", dur: 386, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Metallica (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-u9dg-g7t2l4", kind: "show", src: "yt", yt: "u9Dg-g7t2l4", title: "Disturbed  - The Sound Of Silence (Official Music Video) [4K UPGRADE]", show: "MW Rock", dur: 263, block: "rock", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Disturbed (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-msrcc626prw", kind: "show", src: "yt", yt: "MSRcC626prw", title: "SZA - Kill Bill (Official Video)", show: "MW R&B", dur: 276, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader SZAVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-upd0qogtmmi", kind: "show", src: "yt", yt: "uPD0QOGTmMI", title: "The Weeknd - Die For You", show: "MW R&B", dur: 281, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader TheWeekndVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-v9pvrfjebti", kind: "show", src: "yt", yt: "V9PVRfjEBTI", title: "Billie Eilish - BIRDS OF A FEATHER (Official Music Video)", show: "MW R&B", dur: 231, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader BillieEilishVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-pfxyk1gleq4", kind: "show", src: "yt", yt: "pfxyk1glEq4", title: "Chris Brown - Under The Influence (Official Video)", show: "MW R&B", dur: 177, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ChrisBrownVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-vya3ak-3p60", kind: "show", src: "yt", yt: "vYa3ak-3p60", title: "Muni Long - Made For Me (Official Music Video)", show: "MW R&B", dur: 238, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader MuniLongVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-rtfyuviyakw", kind: "show", src: "yt", yt: "rtfyUvIYaKw", title: "Coco Jones - ICU", show: "MW R&B", dur: 242, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader CocoJonesMusicVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xoiooiuh8ii", kind: "show", src: "yt", yt: "XoiOOiuH8iI", title: "Tyla - Water (Official Music Video)", show: "MW R&B", dur: 220, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader TylaVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-1iprd0wgb0c", kind: "show", src: "yt", yt: "1ipRd0WgB0c", title: "Summer Walker - Heart Of A Woman (Official Music Video)", show: "MW R&B", dur: 205, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Summer Walker (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-kdj-qwu3y4y", kind: "show", src: "yt", yt: "KdJ-Qwu3y4Y", title: "Victoria Monét - On My Mama (Official Video)", show: "MW R&B", dur: 217, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader VictoriaMonétVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-dsv9eauw5h8", kind: "show", src: "yt", yt: "Dsv9EAuW5H8", title: "USHER, Pheelz - Ruin (Official Music Video)", show: "MW R&B", dur: 189, block: "rb", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader UsherVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-hue6haw_3zg", kind: "show", src: "yt", yt: "hUE6Haw_3zg", title: "Sexyy Red \"Get It Sexyy\" (Official Video)", show: "MW Late Night", dur: 240, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Sexyy Red (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-_yzd9kw82sk", kind: "show", src: "yt", yt: "_YzD9KW82sk", title: "Lil Baby x Gunna - \"Drip Too Hard\" (Official Music Video)", show: "MW Late Night", dur: 155, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Lil Baby Official  (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-z4n8lzknfy4", kind: "show", src: "yt", yt: "Z4N8lzKNfy4", title: "Lil Durk - All My Life ft. J. Cole", show: "MW Late Night", dur: 245, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader LilDurkVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-w2ihccxakke", kind: "show", src: "yt", yt: "w2IhccXakkE", title: "Polo G - RAPSTAR (Official Video)", show: "MW Late Night", dur: 169, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader PoloGVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-oorvww9ywg0", kind: "show", src: "yt", yt: "oorVWW9ywG0", title: "POP SMOKE - DIOR (OFFICIAL VIDEO)", show: "MW Late Night", dur: 173, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader POP SMOKE (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xvzqhgfz51i", kind: "show", src: "yt", yt: "xvZqHgFz51I", title: "Future - Mask Off (Official Music Video)", show: "MW Late Night", dur: 290, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader FutureVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-demlg4fpfhq", kind: "show", src: "yt", yt: "deMLg4FPFhQ", title: "Rod Wave - Heart On Ice (Official Music Video)", show: "MW Late Night", dur: 164, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader RodWave (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-xf3eab4l38y", kind: "show", src: "yt", yt: "xf3eAb4l38Y", title: "FIVIO FOREIGN - BIG DRIP (OFFICIAL VIDEO)", show: "MW Late Night", dur: 169, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Fivio Foreign (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-kmhaqjqoaiy", kind: "show", src: "yt", yt: "KmhAQJqOaIY", title: "BossMan Dlow - Get In With Me (Official Video)", show: "MW Late Night", dur: 125, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader BossMan Dlow (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-r9vpqobes2s", kind: "show", src: "yt", yt: "r9vPqobEs2s", title: "Cash Cobain, Ice Spice, Bay Swag - Fisherrr (Remix)", show: "MW Late Night", dur: 249, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader IceSpiceVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "mv-cuj2awejnwq", kind: "show", src: "yt", yt: "CUj2AWEJnwQ", title: "Nicki Minaj & Ice Spice – Barbie World (with Aqua) [Official Music Video]", show: "MW Late Night", dur: 130, block: "latenight", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Nicki Minaj (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "cmd-gary-owen", kind: "show", src: "yt", yt: "GGQpv-4k3II", title: "Gary Owen | No Hard Feelings (Full Comedy Special)", show: "MW Comedy", dur: 3509, block: "comedy", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader 800 Pound Gorilla Media (the releasing label's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "cmd-brian-simpson", kind: "show", src: "yt", yt: "NqK1gyTYt8M", title: "Brian Simpson | Live From The Mothership (Full Comedy Special)", show: "MW Comedy", dur: 4112, block: "comedy", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader 800 Pound Gorilla Media (the releasing label's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "cmd-joe-mande", kind: "show", src: "yt", yt: "0GlbHTqDizQ", title: "Joe Mande | Chill (Full Comedy Special)", show: "MW Comedy", dur: 4276, block: "comedy", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader 800 Pound Gorilla Media (the releasing label's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "cmd-nish-kumar", kind: "show", src: "yt", yt: "uomLlydZpNU", title: "Nish Kumar | Nish, Don't Kill My Vibe (Full Comedy Special)", show: "MW Comedy", dur: 5829, block: "comedy", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader 800 Pound Gorilla Comedy Exports (the releasing label's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "cmd-kellen-erskine", kind: "show", src: "yt", yt: "VbOALuHrK_M", title: "Dry Humor Has Never Been This Funny | Kellen Erskine FULL SPECIAL", show: "MW Comedy", dur: 2354, block: "comedy", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader Dry Bar Comedy (the releasing label's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "cmd-dan-mcgowan", kind: "show", src: "yt", yt: "jlm3L_Qnze4", title: "The Hardest Part of Losing Weight | Dan McGowan FULL SPECIAL", show: "MW Comedy", dur: 1516, block: "comedy", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader Dry Bar Comedy (the releasing label's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "show-unsung-debarge", kind: "show", src: "yt", yt: "uCrlKJLl_xU", title: "FULL EPISODE: #Unsung 102 - Debarge", show: "MW TV Shows", dur: 2517, block: "shows", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader TV One TV (the network's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "show-unsung-winbush", kind: "show", src: "yt", yt: "hKItRtGaZUs", title: "FULL EPISODE: #Unsung 309 - Angela Winbush", show: "MW TV Shows", dur: 2644, block: "shows", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader TV One TV (the network's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "show-opry-live", kind: "show", src: "yt", yt: "CYHTE0Wsl-M", title: "Opry Live - Chris Young, Gary Sinise & Lt. Dan Band, and Sara Evans", show: "MW Country Live", dur: 3277, block: "country", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader Grand Ole Opry (the venue's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "show-paw-patrol", kind: "show", src: "yt", yt: "x9CdSgXnp-Q", title: "PAW Patrol - Assemble! | Season 1 Full Episodes | WildBrain Zoo | Kids Cartoons", show: "MW Family", dur: 1968, block: "family", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader WildBrain Zoo (the distributor's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      { id: "show-johnny-test", kind: "show", src: "yt", yt: "EqEyFCgQXtA", title: "1 Hour of Johnny Test: The Lost Web Series | Full Episodes | Cartoons For Kids", show: "MW Family", dur: 3603, block: "family", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader Johnny Test - WildBrain (the distributor's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") },
      // ONLY FILL (v14, Malik 2026-11-05 12:25 ET — scope B): the
      // program chain may air ONLY these ASAP Preach + Deen Squad
      // videos (the same verified uploads as the break bag, carried
      // here as program items — tvFillOk admits them by fill: true;
      // every older cycle item above stays in the seed for Family
      // Time eligibility and is simply never laid as fill again).
      { id: "mv-w_o8r_2dopg", kind: "show", src: "yt", yt: "w_O8R_2doPg", title: "ASAP Preach — The Light", show: "ASAP Preach", dur: 171, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 171 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv--mg7vmzk4ua", kind: "show", src: "yt", yt: "-mG7Vmzk4uA", title: "ASAP Preach — Tested", show: "ASAP Preach", dur: 252, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 252 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-vopzm0cmyac", kind: "show", src: "yt", yt: "VOpzm0cMYac", title: "ASAP Preach — City Boy", show: "ASAP Preach", dur: 137, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 137 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-olujvm1hzge", kind: "show", src: "yt", yt: "OlujvM1HZGE", title: "ASAP Preach — Don't Let Me Go", show: "ASAP Preach", dur: 168, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-0qr2d7ap7us", kind: "show", src: "yt", yt: "0qR2d7ap7us", title: "ASAP Preach — Let It Go", show: "ASAP Preach", dur: 176, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-tkjt4k1gwg8", kind: "show", src: "yt", yt: "tkjT4k1GwG8", title: "ASAP Preach — All Of Me", show: "ASAP Preach", dur: 283, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 283 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-qktoqpqfshs", kind: "show", src: "yt", yt: "QkToQPqFShs", title: "ASAP Preach — Owe You Praise", show: "ASAP Preach", dur: 167, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 167 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-zz1hxwehwvc", kind: "show", src: "yt", yt: "Zz1hXWEHwvc", title: "ASAP Preach — Rose In The Road", show: "ASAP Preach", dur: 176, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-4sodikunneq", kind: "show", src: "yt", yt: "4SodIcKUNeQ", title: "ASAP Preach — FALL", show: "ASAP Preach", dur: 194, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 194 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-fipzwgho_pa", kind: "show", src: "yt", yt: "fIPZwghO_PA", title: "ASAP Preach — LIFE", show: "ASAP Preach", dur: 187, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 187 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-ijap51ezgog", kind: "show", src: "yt", yt: "Ijap51EZGog", title: "ASAP Preach — PAIN", show: "ASAP Preach", dur: 290, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 290 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-tpuqrrhkleu", kind: "show", src: "yt", yt: "tpuqRrHKLEU", title: "ASAP Preach — DRAPED", show: "ASAP Preach", dur: 243, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 243 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-rqtknjb0_aw", kind: "show", src: "yt", yt: "rqtKnjB0_Aw", title: "ASAP Preach — FORGIVEN", show: "ASAP Preach", dur: 244, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 244 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-bqotl5pqun8", kind: "show", src: "yt", yt: "BQoTL5pQUn8", title: "ASAP Preach — Counterfeit", show: "ASAP Preach", dur: 234, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 234 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-i3z-ec7jxjq", kind: "show", src: "yt", yt: "i3Z-eC7jxjQ", title: "ASAP Preach — Get Right", show: "ASAP Preach", dur: 185, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 185 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-2r3ji9eijtq", kind: "show", src: "yt", yt: "2r3Ji9eijtQ", title: "ASAP Preach — Lowest", show: "ASAP Preach", dur: 219, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 219 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-fbkcfmcj4bg", kind: "show", src: "yt", yt: "FBkcFMCj4Bg", title: "ASAP Preach — Crying Out", show: "ASAP Preach", dur: 224, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 224 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-jew6zipvdfo", kind: "show", src: "yt", yt: "jEW6ZiPVdFo", title: "ASAP Preach — Letting Go", show: "ASAP Preach", dur: 192, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 192 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-mv3a0mc-xl4", kind: "show", src: "yt", yt: "mV3a0Mc-Xl4", title: "ASAP Preach — Yahweh", show: "ASAP Preach", dur: 149, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 149 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-2vrtbr2jnmc", kind: "show", src: "yt", yt: "2VRTbR2jnmc", title: "ASAP Preach — God Made Muzic", show: "ASAP Preach", dur: 382, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 382 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-rvra29b1pqk", kind: "show", src: "yt", yt: "rvrA29B1pqk", title: "Deen Squad — Halal Boy (Slowed Down)", show: "Deen Squad", dur: 252, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 252 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-mx4hbcmggi4", kind: "show", src: "yt", yt: "mX4HbcMGgi4", title: "Deen Squad — RAMADAN", show: "Deen Squad", dur: 191, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-cavfobzw8rc", kind: "show", src: "yt", yt: "CaVFOBzw8rc", title: "Deen Squad — COVER GIRL", show: "Deen Squad", dur: 276, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 276 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-itxckklebre", kind: "show", src: "yt", yt: "itXckkLebRE", title: "Deen Squad — RAMADAN KAREEM", show: "Deen Squad", dur: 211, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-qbl5slpznjs", kind: "show", src: "yt", yt: "qBL5sLPznjs", title: "Deen Squad — NO GOD BUT YOU", show: "Deen Squad", dur: 173, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 173 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-onqqu_y6_se", kind: "show", src: "yt", yt: "ONqqu_y6_sE", title: "Deen Squad — PAKISTANI", show: "Deen Squad", dur: 191, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-w53egdphkzu", kind: "show", src: "yt", yt: "w53EgDpHkZU", title: "Deen Squad — HALAL LOVIN", show: "Deen Squad", dur: 223, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-xhv6wjd_1ps", kind: "show", src: "yt", yt: "XHV6WJD_1ps", title: "Deen Squad — HANDS OF ALLAH", show: "Deen Squad", dur: 190, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 190 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-defxddayqsq", kind: "show", src: "yt", yt: "deFXDDAyqsQ", title: "Deen Squad — OOOUUU", show: "Deen Squad", dur: 175, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 175 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-izq2tpczm4o", kind: "show", src: "yt", yt: "IzQ2TPCzm4o", title: "Deen Squad — ON MY DEEN", show: "Deen Squad", dur: 200, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 200 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-5usjjr2dojc", kind: "show", src: "yt", yt: "5UsjjR2DOJc", title: "Deen Squad — MASJID", show: "Deen Squad", dur: 161, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 161 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-pf25t2ds5nk", kind: "show", src: "yt", yt: "Pf25t2dS5Nk", title: "Deen Squad — MECCA", show: "Deen Squad", dur: 214, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 214 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-oknhojavszg", kind: "show", src: "yt", yt: "OKnHojaVSzg", title: "Deen Squad — PRAY IN PEACE", show: "Deen Squad", dur: 221, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-zykuxgu_qbi", kind: "show", src: "yt", yt: "ZYkUXgU_qBI", title: "Deen Squad — NO LIMIT", show: "Deen Squad", dur: 222, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 222 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-s9czmfyxvwq", kind: "show", src: "yt", yt: "S9CZmFyxVwQ", title: "Deen Squad — MUSLIM QUEEN", show: "Deen Squad", dur: 179, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 179 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-dzgaxvpqoeo", kind: "show", src: "yt", yt: "DzGaxvPqoeo", title: "Deen Squad — DEEN STARS", show: "Deen Squad", dur: 209, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 209 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-_hdk44ccbre", kind: "show", src: "yt", yt: "_HDK44cCbRE", title: "Deen Squad — MADINA", show: "Deen Squad", dur: 208, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 208 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-up5zlavdecq", kind: "show", src: "yt", yt: "uP5zLaVdECQ", title: "Deen Squad — MUSLIM MAN", show: "Deen Squad", dur: 219, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 219 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-vd6yzywtwwg", kind: "show", src: "yt", yt: "Vd6yzyWTWWg", title: "Deen Squad — BELIEVER", show: "Deen Squad", dur: 174, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 174 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-ff5pobglsjy", kind: "show", src: "yt", yt: "Ff5pOBGLsJY", title: "Deen Squad — FRIDAY", show: "Deen Squad", dur: 208, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 208 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-j82a1gyzqyw", kind: "show", src: "yt", yt: "j82A1GyZqYw", title: "Deen Squad — JANNAH", show: "Deen Squad", dur: 191, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-7bdodtlgmlo", kind: "show", src: "yt", yt: "7bdoDTlGMLo", title: "Deen Squad — ALLAH'S PLAN", show: "Deen Squad", dur: 206, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-f5c3lh33pie", kind: "show", src: "yt", yt: "F5c3LH33pIE", title: "Deen Squad — HALAL BOY", show: "Deen Squad", dur: 238, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 238 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      { id: "mv-zr4bztphc_u", kind: "show", src: "yt", yt: "ZR4bztPhc_U", title: "Deen Squad — LOOK ALIVE", show: "Deen Squad", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement") },
      // v16: the 48 Muslim rap videos (Native Deen, Essam, Khalil
      // Ismail, Muslim Belal, Ilyas Mao — the same verified uploads
      // as the break bag's faith lane) join the fill here as program
      // items, so the weave deals them into the mixed cycle by
      // artist alongside ASAP Preach and Deen Squad.
      { id: "mv-4ahhnr6dcpg", kind: "show", src: "yt", yt: "4AhhNR6dCpg", title: "Native Deen — Not Afraid to Stand Alone", show: "Native Deen", dur: 302, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 302 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-vnw258w0crk", kind: "show", src: "yt", yt: "vNW258w0CRk", title: "Native Deen — Small Deeds", show: "Native Deen", dur: 233, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 233 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-ixlnueanlgq", kind: "show", src: "yt", yt: "iXLnUeANLGQ", title: "Native Deen — Shaded Seven", show: "Native Deen", dur: 377, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 377 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-h7k4vyzgom8", kind: "show", src: "yt", yt: "h7K4vYZGoM8", title: "Native Deen — Living Halal", show: "Native Deen", dur: 289, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 289 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-hfkgp3izp6c", kind: "show", src: "yt", yt: "HFKgP3IzP6c", title: "Native Deen — Lord, Enable Me", show: "Native Deen", dur: 274, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 274 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-1zpn1ebxgce", kind: "show", src: "yt", yt: "1ZpN1ebXgCE", title: "Native Deen — SubhanAllah", show: "Native Deen", dur: 262, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 262 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-prn8kdglcbe", kind: "show", src: "yt", yt: "prn8KDGlCbE", title: "Native Deen — Al-Widaa", show: "Native Deen", dur: 353, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 353 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-qqldnckvsrc", kind: "show", src: "yt", yt: "qQlDNCkVsRc", title: "Native Deen — Lose Their Way", show: "Native Deen", dur: 346, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 346 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-1-ykiu4cdl8", kind: "show", src: "yt", yt: "1-YKIU4cDL8", title: "Native Deen — Baligna Ramadan", show: "Native Deen", dur: 176, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-ifcd8fh5v7m", kind: "show", src: "yt", yt: "ifCD8fh5v7M", title: "Native Deen — I Am Near", show: "Native Deen", dur: 639, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 639 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-apelpqwjyz0", kind: "show", src: "yt", yt: "apELpQWJyz0", title: "Essam — Runnin", show: "Essam", dur: 264, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 264 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-tz_jxqw9lzs", kind: "show", src: "yt", yt: "Tz_jxQw9LZs", title: "Essam — Runnin' Pt. 2", show: "Essam", dur: 447, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 447 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-wvhunbwhumu", kind: "show", src: "yt", yt: "WvHuNbwHumU", title: "Essam — Wonder", show: "Essam", dur: 206, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-1_lv0il4wf8", kind: "show", src: "yt", yt: "1_lV0iL4wF8", title: "Essam — No Love", show: "Essam", dur: 172, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 172 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-pr2o2zepik4", kind: "show", src: "yt", yt: "Pr2O2ZEpiK4", title: "Essam — Morocco", show: "Essam", dur: 145, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 145 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-w7qyamxj-wa", kind: "show", src: "yt", yt: "W7qyAmxj-wA", title: "Essam — Hero", show: "Essam", dur: 134, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 134 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-4cvetqh1hbk", kind: "show", src: "yt", yt: "4cVEtQH1HBk", title: "Essam — Famila", show: "Essam", dur: 324, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 324 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-ygsuhespjau", kind: "show", src: "yt", yt: "YGsUHespjaU", title: "Essam — On the Road", show: "Essam", dur: 328, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 328 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-qm93ntinjnc", kind: "show", src: "yt", yt: "qM93ntiNJnc", title: "Essam — Fly", show: "Essam", dur: 199, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 199 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-beondshthog", kind: "show", src: "yt", yt: "beOndSHThog", title: "Essam — Fajr", show: "Essam", dur: 199, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 199 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-afgvko9tyxg", kind: "show", src: "yt", yt: "AfgVKo9Tyxg", title: "Essam — Free", show: "Essam", dur: 223, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-e-ycldzq_wk", kind: "show", src: "yt", yt: "E-YclDzq_Wk", title: "Essam — My People", show: "Essam", dur: 211, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-m7ridiplgk8", kind: "show", src: "yt", yt: "m7ridipLgk8", title: "Khalil Ismail — 20/20", show: "Khalil Ismail", dur: 367, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 367 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-hgisdptdida", kind: "show", src: "yt", yt: "hgISdPTdiDA", title: "Khalil Ismail — First We Need the Love", show: "Khalil Ismail", dur: 256, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 256 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-d6gtqhigyh8", kind: "show", src: "yt", yt: "D6GtQhIgyH8", title: "Khalil Ismail — Man Up", show: "Khalil Ismail", dur: 290, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 290 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-fmcwc3k3cmy", kind: "show", src: "yt", yt: "FmCWC3k3CmY", title: "Khalil Ismail — Sometimes", show: "Khalil Ismail", dur: 285, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 285 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-0guiy2mfoo4", kind: "show", src: "yt", yt: "0GuIy2mFoO4", title: "Khalil Ismail — Knocking", show: "Khalil Ismail", dur: 276, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 276 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-mzvr-ff5xcm", kind: "show", src: "yt", yt: "mzvR-ff5xcM", title: "Khalil Ismail — Thank You Haters", show: "Khalil Ismail", dur: 276, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 276 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-w91s8wqtkf0", kind: "show", src: "yt", yt: "w91s8WqtKf0", title: "Khalil Ismail — Freedom Fighters", show: "Khalil Ismail", dur: 183, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)") },
      { id: "mv-uwdya5-kbws", kind: "show", src: "yt", yt: "uwdyA5-kBWs", title: "Muslim Belal — KABIR", show: "Muslim Belal", dur: 337, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 337 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-v0u6rwtmc_g", kind: "show", src: "yt", yt: "V0U6RwtmC_g", title: "Muslim Belal — Ameen", show: "Muslim Belal", dur: 260, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 260 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-0xptcdzutp0", kind: "show", src: "yt", yt: "0xptcdZuTp0", title: "Muslim Belal — Family", show: "Muslim Belal", dur: 253, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 253 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-pqmvxcyen2c", kind: "show", src: "yt", yt: "pqMVxcyEN2c", title: "Muslim Belal — The Corner", show: "Muslim Belal", dur: 340, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 340 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-keusmki6l_k", kind: "show", src: "yt", yt: "KeusmKI6L_k", title: "Muslim Belal — Journey", show: "Muslim Belal", dur: 152, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 152 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-fm2yjvkcoqw", kind: "show", src: "yt", yt: "Fm2yjvKcOQw", title: "Muslim Belal — Traveller", show: "Muslim Belal", dur: 249, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 249 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-rrdqrfm_d9w", kind: "show", src: "yt", yt: "RrDqRfm_d9w", title: "Muslim Belal — Layla (The Dunya)", show: "Muslim Belal", dur: 202, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 202 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-fzhwu4vr7as", kind: "show", src: "yt", yt: "fzHwu4Vr7as", title: "Muslim Belal — Real Life", show: "Muslim Belal", dur: 285, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 285 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-pljjllr0kas", kind: "show", src: "yt", yt: "pLJJLlr0kas", title: "Muslim Belal — Faith 2 Faith", show: "Muslim Belal", dur: 304, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 304 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-jthchlgfpjo", kind: "show", src: "yt", yt: "JTHChlgfpJo", title: "Muslim Belal — Spot Project", show: "Muslim Belal", dur: 360, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 360 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-9690aghz1ss", kind: "show", src: "yt", yt: "9690aGhZ1Ss", title: "Muslim Belal — LIFE", show: "Muslim Belal", dur: 412, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 412 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-f03jplwetgu", kind: "show", src: "yt", yt: "F03jpLWeTgU", title: "Muslim Belal — Palestine (Live at Conway Hall)", show: "Muslim Belal", dur: 330, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 330 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-azxfcb68luy", kind: "show", src: "yt", yt: "azxFcb68luY", title: "Ilyas Mao — The Blame Game", show: "Ilyas Mao", dur: 233, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 233 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-4iipcjguddq", kind: "show", src: "yt", yt: "4iiPcJgUDdQ", title: "Ilyas Mao — The Battle Of Badr", show: "Ilyas Mao", dur: 284, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 284 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-tjd1kw3379w", kind: "show", src: "yt", yt: "TJd1Kw3379w", title: "Ilyas Mao — Still A Muslim", show: "Ilyas Mao", dur: 187, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 187 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-yxelkr5ktri", kind: "show", src: "yt", yt: "yXElKR5KTrI", title: "Ilyas Mao — Ghost", show: "Ilyas Mao", dur: 219, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 219 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-lyzlw-tp1zc", kind: "show", src: "yt", yt: "LyZlw-tp1zc", title: "Ilyas Mao — Seize The Day", show: "Ilyas Mao", dur: 202, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 202 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-muxc-8ciago", kind: "show", src: "yt", yt: "muXc-8CiAGo", title: "Ilyas Mao — WHOLE", show: "Ilyas Mao", dur: 199, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 199 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      { id: "mv-fb1fykja3xs", kind: "show", src: "yt", yt: "FB1fykja3xs", title: "Ilyas Mao — How Far", show: "Ilyas Mao", dur: 226, block: "anytime", fill: true, rights: RE("YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 226 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)") },
      // v18: the COLLABORATORS build (Malik, 2026-11-05
      // ~22:24 ET: "add every bodys music video that makes
      // music with asap preach and deen squad into my music
      // shuffle") — every artist with a credited collaboration
      // with ASAP Preach or Deen Squad joins the fill here as
      // program items (same verified uploads as the break bag
      // below), so the weave deals them into the mixed cycle
      // by artist alongside the existing acts. Gospel lane =
      // ASAP Preach collaborators; faith lane = Deen Squad
      // side (incl. the members' own solo channels).
      { id: "mv-_-gqtvmarpg", kind: "show", src: "yt", yt: "_-GQtvMaRpg", title: "Brother Bo — On A Mission", show: "Brother Bo", dur: 282, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 282 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-jfkvdpmveom", kind: "show", src: "yt", yt: "jfKVdPMVEOM", title: "Brother Bo — Love Letter", show: "Brother Bo", dur: 193, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 193 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-yaleoohqs9y", kind: "show", src: "yt", yt: "yaLEoOhQS9Y", title: "Brother Bo — LOOK AT MY GOD", show: "Brother Bo", dur: 128, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 128 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-sf8anxz5pra", kind: "show", src: "yt", yt: "SF8AnXZ5PRA", title: "Brother Bo — STILL GROWING", show: "Brother Bo", dur: 212, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-lt__ojndsce", kind: "show", src: "yt", yt: "lt__OjndSCE", title: "Brother Bo — Way Of The Lord", show: "Brother Bo", dur: 221, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-fwiyfs4ldcc", kind: "show", src: "yt", yt: "FwiYFS4lDCc", title: "Brother Bo — NOT FORGOTTEN", show: "Brother Bo", dur: 251, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 251 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-xlil8voy2ag", kind: "show", src: "yt", yt: "XliL8voy2ag", title: "Brother Bo — Want to see you", show: "Brother Bo", dur: 257, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 257 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-2qecxen_hea", kind: "show", src: "yt", yt: "2qEcXEn_HEA", title: "Brother Bo — Father Forgive 'Em", show: "Brother Bo", dur: 210, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 210 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-pmkrua5b-fo", kind: "show", src: "yt", yt: "PmKRuA5B-fo", title: "Brother Bo — By Your Spirit", show: "Brother Bo", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-lxelkz-3ywi", kind: "show", src: "yt", yt: "lXElKZ-3ywI", title: "Brother Bo — WIN SOULS", show: "Brother Bo", dur: 231, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-5pnjbcnj-pk", kind: "show", src: "yt", yt: "5pnJbcNj-Pk", title: "Brother Bo — HOUSE OF BREAD", show: "Brother Bo", dur: 226, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 226 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-uvsrmu3t1v8", kind: "show", src: "yt", yt: "uvSRMu3t1v8", title: "Brother Bo — Church", show: "Brother Bo", dur: 227, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 227 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-cnuhnbqdsm4", kind: "show", src: "yt", yt: "CNUhnbqDsM4", title: "Brother Bo — Prodigal", show: "Brother Bo", dur: 237, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 237 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-2zzn9gytcjc", kind: "show", src: "yt", yt: "2zzn9gYtCjc", title: "Brother Bo — Fill Me Up", show: "Brother Bo", dur: 182, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 182 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-6u8_ajzdqwa", kind: "show", src: "yt", yt: "6u8_aJZdqwA", title: "Brother Bo — Check Your Heart", show: "Brother Bo", dur: 212, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-v4ewep0tvgi", kind: "show", src: "yt", yt: "v4EwEP0TVgI", title: "Brother Bo — Aliens", show: "Brother Bo", dur: 209, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 209 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vgwma2pugpa", kind: "show", src: "yt", yt: "vgWma2puGpA", title: "Brother Bo — Narrow Road", show: "Brother Bo", dur: 181, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-hzok7uw_hni", kind: "show", src: "yt", yt: "HZok7UW_HnI", title: "Brother Bo — Fallen Stars", show: "Brother Bo", dur: 203, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 203 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kfz_lmrijqa", kind: "show", src: "yt", yt: "kFz_LmRijqA", title: "Big Yeet — Yahweh", show: "Big Yeet", dur: 117, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 117 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-l0pzs3vsbno", kind: "show", src: "yt", yt: "L0pzs3vsBNo", title: "Big Yeet — Nobody Knew", show: "Big Yeet", dur: 190, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 190 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-n9aptatncg0", kind: "show", src: "yt", yt: "N9APtatNCg0", title: "Big Yeet — Take Me Back", show: "Big Yeet", dur: 138, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 138 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-0g72dwp2eve", kind: "show", src: "yt", yt: "0g72dWP2EVE", title: "Big Yeet — I Need Jesus", show: "Big Yeet", dur: 181, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ch6zgoxgamk", kind: "show", src: "yt", yt: "ch6zgOXGAMk", title: "Big Yeet — Guard My Heart", show: "Big Yeet", dur: 151, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-fko3j2lqg0g", kind: "show", src: "yt", yt: "FKo3j2Lqg0g", title: "Big Yeet — Better Life", show: "Big Yeet", dur: 148, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 148 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-mvqgsjye4-c", kind: "show", src: "yt", yt: "MvqGsJYE4-c", title: "Big Yeet — My God", show: "Big Yeet", dur: 172, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 172 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-0ww98xwrx18", kind: "show", src: "yt", yt: "0WW98XWRX18", title: "Adrion Butler — UGH UGH", show: "Adrion Butler", dur: 591, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 591 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-xnkhr_szojq", kind: "show", src: "yt", yt: "XNkHR_SzojQ", title: "Adrion Butler — Robotnic", show: "Adrion Butler", dur: 215, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 215 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ieog-hsg5vs", kind: "show", src: "yt", yt: "IeoG-HSG5vs", title: "Adrion Butler — What Was That", show: "Adrion Butler", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zgxhefoxutq", kind: "show", src: "yt", yt: "zgXHeFOxuTQ", title: "Adrion Butler — Can't Tell Me Nothing", show: "Adrion Butler", dur: 222, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 222 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-xnpfj8e9lbk", kind: "show", src: "yt", yt: "xNpFJ8e9lBk", title: "Adrion Butler — On Time", show: "Adrion Butler", dur: 314, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 314 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-qt9uyrekkgc", kind: "show", src: "yt", yt: "qT9UyREKkgc", title: "Adrion Butler — Day III", show: "Adrion Butler", dur: 149, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 149 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-rsg1eym-elw", kind: "show", src: "yt", yt: "rSg1eyM-ELw", title: "REDEEMED — ECHOES", show: "REDEEMED", dur: 204, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 204 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-jns9esipg74", kind: "show", src: "yt", yt: "jNS9esiPG74", title: "REDEEMED — Creation Is Groaning", show: "REDEEMED", dur: 213, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 213 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-6y8v1qp2paw", kind: "show", src: "yt", yt: "6Y8v1qP2PAw", title: "REDEEMED — I BELIEVE", show: "REDEEMED", dur: 168, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-onasrjfx3eq", kind: "show", src: "yt", yt: "ONaSrJFx3EQ", title: "REDEEMED — BIG HOMIE", show: "REDEEMED", dur: 214, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 214 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-9at_hjembr0", kind: "show", src: "yt", yt: "9At_HJEmbr0", title: "REDEEMED — OFF THE BLOCK", show: "REDEEMED", dur: 231, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ulpwmyozbru", kind: "show", src: "yt", yt: "UlPwMyOzBRU", title: "REDEEMED — ACTION", show: "REDEEMED", dur: 233, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 233 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zi3gaztm3vg", kind: "show", src: "yt", yt: "ZI3gAzTm3vg", title: "REDEEMED — ANOTHER MINUTE", show: "REDEEMED", dur: 230, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 230 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-30xpwq-hoea", kind: "show", src: "yt", yt: "30XPWq-HoeA", title: "REDEEMED — Hear Me Now", show: "REDEEMED", dur: 180, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 180 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kqu7ghqvgsq", kind: "show", src: "yt", yt: "kQU7gHQVGsQ", title: "REDEEMED — 2 DA CHURCH", show: "REDEEMED", dur: 217, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 217 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kbx_89zw6ys", kind: "show", src: "yt", yt: "KBX_89zw6Ys", title: "Jysa BP — Intermission", show: "Jysa BP", dur: 213, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 213 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gg_zrzik74k", kind: "show", src: "yt", yt: "gg_zRZIK74k", title: "Jysa BP — Adderrall and Prayers", show: "Jysa BP", dur: 146, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 146 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-pgkyygk45j0", kind: "show", src: "yt", yt: "PGkyYgk45j0", title: "Jysa BP — Legacy", show: "Jysa BP", dur: 162, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 162 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-nsd12mlxwo0", kind: "show", src: "yt", yt: "NSD12MLXWO0", title: "Jysa BP — Halo", show: "Jysa BP", dur: 183, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-tjrr-qreyjk", kind: "show", src: "yt", yt: "TJrr-qrEYJk", title: "Jysa BP — There For You", show: "Jysa BP", dur: 158, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 158 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-v4_icgckgr0", kind: "show", src: "yt", yt: "V4_IcgcKGR0", title: "Jysa BP — Way Out", show: "Jysa BP", dur: 239, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 239 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kpelcrwxfs0", kind: "show", src: "yt", yt: "KpeLcRWxfS0", title: "Jysa BP — Let 'Em Know", show: "Jysa BP", dur: 218, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 218 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-wripoaigw5o", kind: "show", src: "yt", yt: "wRipoaIGw5o", title: "Blizz — Always", show: "Blizz", dur: 216, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 216 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zo1lcsmsi9g", kind: "show", src: "yt", yt: "Zo1lcSmsI9g", title: "Blizz — I Lie to Me", show: "Blizz", dur: 311, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 311 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-urnnm3qmjpy", kind: "show", src: "yt", yt: "uRNnm3qmjPY", title: "Blizz — Looking Up", show: "Blizz", dur: 271, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 271 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-e-x8vmy3_f4", kind: "show", src: "yt", yt: "E-x8VMY3_F4", title: "Blizz — More Than Life", show: "Blizz", dur: 254, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 254 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-umt5moafy7k", kind: "show", src: "yt", yt: "umt5moaFY7k", title: "Blizz — Thin Line", show: "Blizz", dur: 246, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 246 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-des2fq8lpe4", kind: "show", src: "yt", yt: "DeS2Fq8LPE4", title: "Blizz — You Still Love Me", show: "Blizz", dur: 219, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 219 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-u6n7evj7ds4", kind: "show", src: "yt", yt: "u6n7evj7dS4", title: "Blizz — When It Rains", show: "Blizz", dur: 352, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 352 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-2s4w-zabkkc", kind: "show", src: "yt", yt: "2s4W-zabkkc", title: "Kamban — On The Road", show: "Kamban", dur: 197, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 197 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ud2zs4bmmlq", kind: "show", src: "yt", yt: "ud2zs4bmmlQ", title: "Kamban — LUKE CAGE", show: "Kamban", dur: 158, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 158 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kckmq2qtohe", kind: "show", src: "yt", yt: "KCkmQ2QToHE", title: "Kamban — Marvelous Things", show: "Kamban", dur: 150, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 150 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-fcw-3qzj3oq", kind: "show", src: "yt", yt: "fcw-3QZj3oQ", title: "Kamban — Rain Down", show: "Kamban", dur: 195, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 195 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ok4x1zhdy-y", kind: "show", src: "yt", yt: "ok4x1zHdy-Y", title: "Kamban — The Race", show: "Kamban", dur: 223, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-nmkpazmrfjs", kind: "show", src: "yt", yt: "NMkpAZMrFjs", title: "Kamban — Got to Go", show: "Kamban", dur: 255, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 255 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-wgbnnxf-ywk", kind: "show", src: "yt", yt: "wgbNNXf-ywk", title: "Kamban — Covenant", show: "Kamban", dur: 238, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 238 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-wc2uqkhgwmu", kind: "show", src: "yt", yt: "wc2UQKhgWmU", title: "Bryann T — Concrete Hymms", show: "Bryann T", dur: 191, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-wmdab0tau38", kind: "show", src: "yt", yt: "wMDAB0TAU38", title: "Bryann T — With Me", show: "Bryann T", dur: 228, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 228 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ajbk6odbnem", kind: "show", src: "yt", yt: "AjBk6oDBNeM", title: "Bryann T — Seeking Grace", show: "Bryann T", dur: 188, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 188 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-h852p3dpoiy", kind: "show", src: "yt", yt: "H852P3dpOIY", title: "Bryann T — Everything", show: "Bryann T", dur: 266, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 266 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-s3nkpahor-a", kind: "show", src: "yt", yt: "s3nKpAHOR-A", title: "Bryann T — Learn From This", show: "Bryann T", dur: 254, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 254 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-9en8d-far1u", kind: "show", src: "yt", yt: "9en8d-FAR1U", title: "Bryann T — Free My Lil Brudda", show: "Bryann T", dur: 257, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 257 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-odwrxs7xic8", kind: "show", src: "yt", yt: "oDWRXS7XIC8", title: "Bryann T — Vent", show: "Bryann T", dur: 324, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 324 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ouxahi4dyv8", kind: "show", src: "yt", yt: "OuXaHI4DYv8", title: "Bryann T — Older & Wiser", show: "Bryann T", dur: 292, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 292 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-hhvjd8pzcdo", kind: "show", src: "yt", yt: "hHVJd8pZcDo", title: "Bryann T — Prayer Changes Everything", show: "Bryann T", dur: 225, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 225 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-91zciegigm0", kind: "show", src: "yt", yt: "91ZCIEGIGm0", title: "Bryann T — Struggle", show: "Bryann T", dur: 296, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 296 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ruh_ucxawkm", kind: "show", src: "yt", yt: "RuH_UcxAWKM", title: "Tyson James — Broken Hallelujah", show: "Tyson James", dur: 150, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 150 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-g9bcjy4auey", kind: "show", src: "yt", yt: "g9bCjy4AUeY", title: "Tyson James — 2A Heavy", show: "Tyson James", dur: 181, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-imi5cgcp5ua", kind: "show", src: "yt", yt: "iMI5CGCP5uA", title: "Tyson James — Catch Me Listening", show: "Tyson James", dur: 178, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 178 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ttecbltcpk4", kind: "show", src: "yt", yt: "tTeCblTCpk4", title: "Tyson James — Dangerous", show: "Tyson James", dur: 217, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 217 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-upeacolzh4w", kind: "show", src: "yt", yt: "uPeACoLzH4w", title: "Tyson James — Pride is the Devil 2", show: "Tyson James", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gh5cs-x7s0g", kind: "show", src: "yt", yt: "gh5cs-X7s0g", title: "Tyson James — Free", show: "Tyson James", dur: 175, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 175 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-sgojopsiee0", kind: "show", src: "yt", yt: "SGojopSiEe0", title: "Tyson James — Co-Sign", show: "Tyson James", dur: 109, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 109 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-v2cwuqey-ik", kind: "show", src: "yt", yt: "V2cWUqEy-Ik", title: "Tyson James — Pressure Makes Diamonds", show: "Tyson James", dur: 169, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 169 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ekzwgwsvqgq", kind: "show", src: "yt", yt: "EkZWGwSvqGQ", title: "Tyson James — Fighting Myself", show: "Tyson James", dur: 208, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 208 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-tovoe4zda4q", kind: "show", src: "yt", yt: "toVoE4zDA4Q", title: "Tyson James — Never Sell My Soul", show: "Tyson James", dur: 187, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 187 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gmvyt3mg6ek", kind: "show", src: "yt", yt: "gmvyT3MG6Ek", title: "Tyson James — Psalm 23", show: "Tyson James", dur: 213, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 213 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-6r4asyf2gom", kind: "show", src: "yt", yt: "6R4AsyF2GOM", title: "Tyson James — God Over Government", show: "Tyson James", dur: 190, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 190 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-s-tknliylmg", kind: "show", src: "yt", yt: "S-TKnLiylmg", title: "Tyson James — True Colors", show: "Tyson James", dur: 287, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 287 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-k5dan8ml_ue", kind: "show", src: "yt", yt: "K5Dan8ml_uE", title: "Tyson James — All by Design", show: "Tyson James", dur: 195, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 195 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-q0yolnmf6su", kind: "show", src: "yt", yt: "q0YolnMf6sU", title: "Tyson James — Big Mad", show: "Tyson James", dur: 167, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 167 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-tnxqggmu-em", kind: "show", src: "yt", yt: "TnxQGgmu-EM", title: "Tyson James — See it Clearly", show: "Tyson James", dur: 183, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-saidxwwdkbg", kind: "show", src: "yt", yt: "saidxWwDKBg", title: "Tyson James — Christian Rappers", show: "Tyson James", dur: 199, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 199 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-us8vglkdzq0", kind: "show", src: "yt", yt: "US8vglkDZQ0", title: "Tyson James — Send Me An Angel", show: "Tyson James", dur: 253, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 253 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-z6qnr42wjq0", kind: "show", src: "yt", yt: "Z6Qnr42wjQ0", title: "Tyson James — Sodom Got Smoked", show: "Tyson James", dur: 177, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 177 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-bugimrspkuq", kind: "show", src: "yt", yt: "bUGiMRSpkuQ", title: "Tyson James — Holy Rebellion", show: "Tyson James", dur: 131, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 131 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gmvbovl033i", kind: "show", src: "yt", yt: "GMVbovL033I", title: "Brett Raio — Freedom", show: "Brett Raio", dur: 178, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 178 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ruknbsqvr6i", kind: "show", src: "yt", yt: "rUKnBSQvR6I", title: "Brett Raio — Leading My Way", show: "Brett Raio", dur: 197, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 197 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-idsykc1eeq4", kind: "show", src: "yt", yt: "IDSYKC1EEq4", title: "Brett Raio — Scars", show: "Brett Raio", dur: 179, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 179 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zlyo0kw9iiy", kind: "show", src: "yt", yt: "ZLyO0KW9iIY", title: "Brett Raio — Slow Baby", show: "Brett Raio", dur: 198, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 198 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-jghc9hsc1pe", kind: "show", src: "yt", yt: "JGHc9Hsc1PE", title: "Brett Raio — Last Days", show: "Brett Raio", dur: 164, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 164 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-wjc3r9pqpsw", kind: "show", src: "yt", yt: "wjc3r9PQpsw", title: "Brett Raio — Unleashed Ignite", show: "Brett Raio", dur: 151, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-o1erlujcapo", kind: "show", src: "yt", yt: "o1ErLuJCapo", title: "Justo Chalaire — Tell Em The Truth", show: "Justo Chalaire", dur: 184, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 184 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-v3wpauytt0y", kind: "show", src: "yt", yt: "V3wPauytt0Y", title: "Justo Chalaire — Drop", show: "Justo Chalaire", dur: 176, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-od_xifblvzu", kind: "show", src: "yt", yt: "Od_xIfBlVzU", title: "Justo Chalaire — Who Is Jesus?", show: "Justo Chalaire", dur: 144, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 144 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-r67zvrq5efs", kind: "show", src: "yt", yt: "r67zVRq5Efs", title: "Justo Chalaire — Look Where I Stand", show: "Justo Chalaire", dur: 149, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 149 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-lnjgk70uuhk", kind: "show", src: "yt", yt: "lnjgK70uUHk", title: "Justo Chalaire — Tryna Get It", show: "Justo Chalaire", dur: 195, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 195 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vy1yhfaj1xa", kind: "show", src: "yt", yt: "vY1yHFAj1XA", title: "Kurtis Hoppie — WHATCHUDOIN?", show: "Kurtis Hoppie", dur: 218, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 218 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kuvscdsscdc", kind: "show", src: "yt", yt: "KUvSCdSScDc", title: "Kurtis Hoppie — Sunflowers", show: "Kurtis Hoppie", dur: 196, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 196 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-a00d2ucscbq", kind: "show", src: "yt", yt: "a00d2uCScbQ", title: "Kurtis Hoppie — MASTERPIECE", show: "Kurtis Hoppie", dur: 205, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 205 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv--6mf14___f4", kind: "show", src: "yt", yt: "-6mf14___F4", title: "Kurtis Hoppie — Problem Child", show: "Kurtis Hoppie", dur: 187, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 187 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-qd_-fvij0ok", kind: "show", src: "yt", yt: "qd_-fvIj0Ok", title: "Kurtis Hoppie — Eye of the Storm", show: "Kurtis Hoppie", dur: 202, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 202 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-_sxoaezmud0", kind: "show", src: "yt", yt: "_sXOAezMUD0", title: "Kurtis Hoppie — Icy", show: "Kurtis Hoppie", dur: 207, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 207 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-cnkh2invmre", kind: "show", src: "yt", yt: "CnKH2InvmrE", title: "SYL noiZ — Rain On The Window", show: "SYL noiZ", dur: 230, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 230 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-n9guwdeemae", kind: "show", src: "yt", yt: "n9GUwDEeMAE", title: "SYL noiZ — Know You Lord", show: "SYL noiZ", dur: 160, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 160 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-31jg3lphsbc", kind: "show", src: "yt", yt: "31JG3lPHSbc", title: "SYL noiZ — 26", show: "SYL noiZ", dur: 242, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 242 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-eit0l5lo5cy", kind: "show", src: "yt", yt: "eit0L5Lo5CY", title: "SYL noiZ — Legacy", show: "SYL noiZ", dur: 224, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 224 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-i8g4c1hksus", kind: "show", src: "yt", yt: "i8g4C1hkSus", title: "#HERO — NOT AFRAID", show: "#HERO", dur: 216, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 216 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-aw3msusu1g0", kind: "show", src: "yt", yt: "aw3msUsu1g0", title: "#HERO — Sumn", show: "#HERO", dur: 143, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 143 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-d9ei2xnwl_4", kind: "show", src: "yt", yt: "d9EI2xNWl_4", title: "#HERO — Repent or Perish", show: "#HERO", dur: 198, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 198 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-cojtwec8mgq", kind: "show", src: "yt", yt: "COjTwEC8MgQ", title: "#HERO — Billboard", show: "#HERO", dur: 223, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-228rtnk_aes", kind: "show", src: "yt", yt: "228RTNk_aEs", title: "#HERO — In The Name of Jesus", show: "#HERO", dur: 151, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-yuomnvk0qfy", kind: "show", src: "yt", yt: "yuomnVk0qFY", title: "#HERO — BIG GOD BIG CHAIN", show: "#HERO", dur: 248, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 248 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-1_e6ek6q6gs", kind: "show", src: "yt", yt: "1_E6ek6q6Gs", title: "#HERO — Mercy", show: "#HERO", dur: 147, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 147 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-yzbdslipsmq", kind: "show", src: "yt", yt: "YzbdSLIpsmQ", title: "#HERO — Set Apart", show: "#HERO", dur: 118, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 118 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-372bcws22w4", kind: "show", src: "yt", yt: "372BCWs22w4", title: "#HERO — Brand New Name", show: "#HERO", dur: 193, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 193 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-2xckuwayvgq", kind: "show", src: "yt", yt: "2XckUwAyVGQ", title: "#HERO — Dead Man", show: "#HERO", dur: 146, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 146 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-od1r2xuacig", kind: "show", src: "yt", yt: "od1r2XuACIg", title: "#HERO — Wake Up", show: "#HERO", dur: 156, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 156 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-1kevzbceefi", kind: "show", src: "yt", yt: "1KevZBcEefI", title: "#HERO — American Church", show: "#HERO", dur: 182, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 182 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-fpdqgpc1uem", kind: "show", src: "yt", yt: "fPdQGPC1UeM", title: "#HERO — Praise Yahweh", show: "#HERO", dur: 223, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-5czla5xkwxw", kind: "show", src: "yt", yt: "5cZla5XkWxw", title: "#HERO — 1 Way", show: "#HERO", dur: 202, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 202 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-bvcwf4wzab4", kind: "show", src: "yt", yt: "BvCwf4wzAb4", title: "Nicky Gracious — 1st String", show: "Nicky Gracious", dur: 226, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 226 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv--crses5jcuo", kind: "show", src: "yt", yt: "-CrSes5jcuo", title: "Nicky Gracious — Everything", show: "Nicky Gracious", dur: 249, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 249 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-tg1yr9ug8ve", kind: "show", src: "yt", yt: "tG1Yr9uG8vE", title: "Nicky Gracious — Oil Stay Drippin", show: "Nicky Gracious", dur: 258, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 258 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-frcdhrhn5z8", kind: "show", src: "yt", yt: "fRCDHrHn5Z8", title: "Nicky Gracious — Wack A Mole", show: "Nicky Gracious", dur: 194, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 194 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zfqeujdkhg8", kind: "show", src: "yt", yt: "zFQEujDKhg8", title: "Nicky Gracious — Open Eyes", show: "Nicky Gracious", dur: 191, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-mez8tqbmpim", kind: "show", src: "yt", yt: "Mez8TQBMPIM", title: "Nicky Gracious — Not Here Anymore", show: "Nicky Gracious", dur: 249, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 249 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-exhy5xqoppy", kind: "show", src: "yt", yt: "exHY5XqOPpY", title: "Nicky Gracious — Get Up", show: "Nicky Gracious", dur: 165, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 165 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-o6mjzerpvdy", kind: "show", src: "yt", yt: "O6mJZerPVdY", title: "Nicky Gracious — What Type of Time You On?", show: "Nicky Gracious", dur: 223, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-2xguspc8nqo", kind: "show", src: "yt", yt: "2XGusPC8nQo", title: "Nicky Gracious — Right Out The Gate", show: "Nicky Gracious", dur: 210, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 210 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-h0cdqtgajz8", kind: "show", src: "yt", yt: "H0CdqTGAJZ8", title: "Nicky Gracious — STUPID", show: "Nicky Gracious", dur: 274, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 274 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-dhtan777qy4", kind: "show", src: "yt", yt: "DhtAn777qY4", title: "Nicky Gracious — Sinner Saved", show: "Nicky Gracious", dur: 264, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 264 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zmo8v6p__co", kind: "show", src: "yt", yt: "ZMO8v6P__Co", title: "Nicky Gracious — If I Died", show: "Nicky Gracious", dur: 320, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 320 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-n9kv1k7pt38", kind: "show", src: "yt", yt: "n9KV1k7pt38", title: "Marquese Saenz — Valleys", show: "Marquese Saenz", dur: 396, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 396 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vu5fmglry-i", kind: "show", src: "yt", yt: "VU5FMglrY-I", title: "Marquese Saenz — Lifting Up Your Name", show: "Marquese Saenz", dur: 253, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 253 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-plr1sh6_eoq", kind: "show", src: "yt", yt: "PLr1sH6_eoQ", title: "Marquese Saenz — God's Realer", show: "Marquese Saenz", dur: 240, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 240 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gpu3tkme90q", kind: "show", src: "yt", yt: "GpU3TKME90Q", title: "Marquese Saenz — Send the Rain", show: "Marquese Saenz", dur: 228, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 228 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-j8iybdbdkz4", kind: "show", src: "yt", yt: "J8iYbDbDkZ4", title: "Marquese Saenz — Cleaning Out My Closet", show: "Marquese Saenz", dur: 350, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 350 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv--bzem7msax8", kind: "show", src: "yt", yt: "-bZEm7MsaX8", title: "Marquese Saenz — Not About It", show: "Marquese Saenz", dur: 180, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 180 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-iwyscfxjiwc", kind: "show", src: "yt", yt: "IwySCFXJIwc", title: "REZUM — Rock Bottom", show: "REZUM", dur: 194, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 194 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gcpvlvw9yvq", kind: "show", src: "yt", yt: "gcPVLVW9YVQ", title: "REZUM — Still With Me", show: "REZUM", dur: 227, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 227 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-nlqkk554m9g", kind: "show", src: "yt", yt: "NLQkK554m9g", title: "REZUM — Get It Right", show: "REZUM", dur: 212, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-igkdrxzm2xy", kind: "show", src: "yt", yt: "IGkDrXZm2xY", title: "REZUM — I'm Sorry", show: "REZUM", dur: 230, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 230 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-i3jzh2xedj8", kind: "show", src: "yt", yt: "i3jzH2xEDJ8", title: "REZUM — Going Through The Motions", show: "REZUM", dur: 181, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-opgzbqswpci", kind: "show", src: "yt", yt: "OPgZBQSWPCI", title: "REZUM — FREE TONIGHT", show: "REZUM", dur: 176, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-pyftsn7ysas", kind: "show", src: "yt", yt: "PyFtsN7YSas", title: "REZUM — Through The Flame", show: "REZUM", dur: 322, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 322 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-bc3vfmzgjzy", kind: "show", src: "yt", yt: "Bc3VFmzgJzY", title: "REZUM — Landslide", show: "REZUM", dur: 170, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 170 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-o82nbgqy4tw", kind: "show", src: "yt", yt: "o82nbGqy4Tw", title: "REZUM — Bye Bye", show: "REZUM", dur: 206, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-rp4coof6hgy", kind: "show", src: "yt", yt: "RP4cOof6hgY", title: "REZUM — He Knows What We Need", show: "REZUM", dur: 207, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 207 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-flv7d6cs9rc", kind: "show", src: "yt", yt: "Flv7d6cS9rc", title: "REZUM — Target On My Back", show: "REZUM", dur: 130, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 130 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-_ot6a0c8z6e", kind: "show", src: "yt", yt: "_OT6a0c8Z6E", title: "REZUM — Running to God", show: "REZUM", dur: 231, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-3m2hfm9ksz8", kind: "show", src: "yt", yt: "3m2hfm9ksZ8", title: "REZUM — Sanity", show: "REZUM", dur: 185, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 185 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-ubuz_5-jtfu", kind: "show", src: "yt", yt: "ubUz_5-JtFU", title: "Nino Salas — FOUND IN YOUR LOVE", show: "Nino Salas", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-_5clafdjtim", kind: "show", src: "yt", yt: "_5ClafdJtIM", title: "Nino Salas — IM GRATEFUL", show: "Nino Salas", dur: 237, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 237 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-7pemsruijss", kind: "show", src: "yt", yt: "7peMsRUijSs", title: "Nino Salas — Blame Game", show: "Nino Salas", dur: 176, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-kmcazmkeo88", kind: "show", src: "yt", yt: "KMcaZMKeO88", title: "Nino Salas — REMEMBER ME", show: "Nino Salas", dur: 172, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 172 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-e5axizhiqvw", kind: "show", src: "yt", yt: "e5axizhiQvw", title: "Nino Salas — PAPER", show: "Nino Salas", dur: 144, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 144 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-w8u6reglan0", kind: "show", src: "yt", yt: "w8u6ReGlaN0", title: "Nino Salas — Pain", show: "Nino Salas", dur: 185, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 185 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vh4wz_aklka", kind: "show", src: "yt", yt: "vH4wz_aklkA", title: "Nino Salas — FIND MY WAY", show: "Nino Salas", dur: 201, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 201 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-evf05ypveaa", kind: "show", src: "yt", yt: "evF05yPveaA", title: "Nino Salas — STILL FREE", show: "Nino Salas", dur: 168, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-sfhdwpec8wc", kind: "show", src: "yt", yt: "sfHdWpEC8wc", title: "Jae Deen — Ramadan Fiesta", show: "Jae Deen", dur: 209, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 209 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-qxfurc_zdqy", kind: "show", src: "yt", yt: "qXFURc_ZDQY", title: "Jae Deen — MASHALLAH", show: "Jae Deen", dur: 221, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-uvziq5w9wv4", kind: "show", src: "yt", yt: "uvziq5W9WV4", title: "Jae Deen — WAX WALBA", show: "Jae Deen", dur: 217, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 217 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-h7jzvzzn1ha", kind: "show", src: "yt", yt: "h7JZVZZn1HA", title: "Jae Deen — SOO SOCO", show: "Jae Deen", dur: 136, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 136 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-dzmarqob2f4", kind: "show", src: "yt", yt: "dzMarqob2F4", title: "Jae Deen — HAYE HAYE", show: "Jae Deen", dur: 151, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-torsfknoqwy", kind: "show", src: "yt", yt: "TORSFKNOqwY", title: "Jae Deen — KAALAY YA XABIBTI", show: "Jae Deen", dur: 203, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 203 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-w0tey-rybsw", kind: "show", src: "yt", yt: "W0teY-RYBsw", title: "Karter Zaher — WE WON'T FORGET", show: "Karter Zaher", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-wlsyvutmczk", kind: "show", src: "yt", yt: "wLSYvUTMcZk", title: "Karter Zaher — PALESTINE WILL BE", show: "Karter Zaher", dur: 154, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 154 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-6nqp7tprrfi", kind: "show", src: "yt", yt: "6NQp7TpRRfI", title: "Karter Zaher — MUZZY SAUCE", show: "Karter Zaher", dur: 218, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 218 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-uioks9_6rvk", kind: "show", src: "yt", yt: "uiOkS9_6RVk", title: "Karter Zaher — THATS HARAM", show: "Karter Zaher", dur: 156, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 156 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vkojlkpgj60", kind: "show", src: "yt", yt: "vkojlkPgJ60", title: "Karter Zaher — Mecca Money", show: "Karter Zaher", dur: 147, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 147 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vts5gisw73m", kind: "show", src: "yt", yt: "vtS5GIsW73M", title: "Karter Zaher — Beirut", show: "Karter Zaher", dur: 211, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-xwkui_3uo3i", kind: "show", src: "yt", yt: "XwkUI_3UO3I", title: "Karter Zaher — Say MashAllah", show: "Karter Zaher", dur: 174, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 174 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-fczi86wejj4", kind: "show", src: "yt", yt: "FCZi86WEJj4", title: "Karter Zaher — You Can Be Awesome", show: "Karter Zaher", dur: 212, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-y-vvcbioo-k", kind: "show", src: "yt", yt: "Y-VVcBIoo-k", title: "Karter Zaher — WHAT ARE YOUR INTENTIONS?", show: "Karter Zaher", dur: 234, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 234 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-9ptk6mkdxkw", kind: "show", src: "yt", yt: "9ptk6mKDXKw", title: "Karter Zaher — Who You Are", show: "Karter Zaher", dur: 148, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 148 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-unerdm9cwr8", kind: "show", src: "yt", yt: "uNerdm9Cwr8", title: "Karter Zaher — Hijabi Queen", show: "Karter Zaher", dur: 277, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 277 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-byyfikvxraq", kind: "show", src: "yt", yt: "bYyfikVXraQ", title: "Karter Zaher — Convert for me", show: "Karter Zaher", dur: 262, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 262 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-4pvizmgsuts", kind: "show", src: "yt", yt: "4PvizmgSUts", title: "KHXLED — Selfish Love", show: "KHXLED", dur: 183, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-rljriwbsbyg", kind: "show", src: "yt", yt: "rLJRIWBSBYg", title: "KHXLED — ONLY2U", show: "KHXLED", dur: 206, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv--h_qg1pmcgi", kind: "show", src: "yt", yt: "-h_qG1PmCgI", title: "KHXLED — DEAR BELOVED SON", show: "KHXLED", dur: 177, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 177 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-pfz9k2zb8po", kind: "show", src: "yt", yt: "pFz9k2zB8po", title: "KHXLED — FREEDOM", show: "KHXLED", dur: 169, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 169 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-memasgjn2hm", kind: "show", src: "yt", yt: "mEmAsgJN2hM", title: "KHXLED — HOMECOMING", show: "KHXLED", dur: 109, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 109 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zgu5o2wukgs", kind: "show", src: "yt", yt: "zgu5o2WUKgs", title: "KHXLED — NO WHITE GOD", show: "KHXLED", dur: 121, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 121 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-u6ghuwezjww", kind: "show", src: "yt", yt: "u6GHUwEzJww", title: "KHXLED — GOD FORBID", show: "KHXLED", dur: 125, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 125 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-rnyjh1txre8", kind: "show", src: "yt", yt: "RnYjH1tXRE8", title: "Waheeb Nasan — Ceasefire", show: "Waheeb Nasan", dur: 221, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-4cap6u8xdly", kind: "show", src: "yt", yt: "4caP6u8xdlY", title: "Waheeb Nasan — A Free Palestine", show: "Waheeb Nasan", dur: 200, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 200 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-jqc72i6acyw", kind: "show", src: "yt", yt: "jqC72i6ACyw", title: "Waheeb Nasan — Is It Wrong", show: "Waheeb Nasan", dur: 231, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-pfoeri_tc-o", kind: "show", src: "yt", yt: "PFOeri_TC-o", title: "Waheeb Nasan — Crickets", show: "Waheeb Nasan", dur: 145, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 145 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-cp8hqaa4bqk", kind: "show", src: "yt", yt: "cp8Hqaa4bQk", title: "Waheeb Nasan — Touchdown Palestine", show: "Waheeb Nasan", dur: 193, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 193 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-bfk2bpm7kmq", kind: "show", src: "yt", yt: "bfK2bpM7KMQ", title: "Waheeb Nasan — My Village", show: "Waheeb Nasan", dur: 211, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-xjayvg2ffga", kind: "show", src: "yt", yt: "XjayVG2FFGA", title: "Waheeb Nasan — Tawel Balek", show: "Waheeb Nasan", dur: 251, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 251 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-5-xzev9ufye", kind: "show", src: "yt", yt: "5-XzEv9UfyE", title: "Waheeb Nasan — Enough", show: "Waheeb Nasan", dur: 143, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 143 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-yy3g9hk5iw8", kind: "show", src: "yt", yt: "YY3g9HK5IW8", title: "Waheeb Nasan — I'm So Elite", show: "Waheeb Nasan", dur: 203, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 203 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-tnvryq2-1do", kind: "show", src: "yt", yt: "TnvRyQ2-1Do", title: "Waheeb Nasan — Backseat", show: "Waheeb Nasan", dur: 240, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 240 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-slmrv06npgm", kind: "show", src: "yt", yt: "SlmRV06NPGM", title: "Waheeb Nasan — The Farthest Mosque", show: "Waheeb Nasan", dur: 181, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-jz4lpocyqck", kind: "show", src: "yt", yt: "jZ4LpOcyqCk", title: "Lil Baliil — Royal", show: "Lil Baliil", dur: 177, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 177 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-o6jmfiytzlq", kind: "show", src: "yt", yt: "O6JMfIYtzlQ", title: "Lil Baliil — Bad Gal", show: "Lil Baliil", dur: 207, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 207 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-zqv68ykblpo", kind: "show", src: "yt", yt: "ZQV68YKbLpo", title: "Lil Baliil — ONE MORE NIGHT", show: "Lil Baliil", dur: 175, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 175 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-j4q23bwtams", kind: "show", src: "yt", yt: "J4q23BwTaMs", title: "Lil Baliil — Kista", show: "Lil Baliil", dur: 168, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-cqsppeuzno8", kind: "show", src: "yt", yt: "CqSpPEUznO8", title: "Lil Baliil — LAST SONG", show: "Lil Baliil", dur: 186, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-65iyuojtwo8", kind: "show", src: "yt", yt: "65IYuoJTWo8", title: "Lil Baliil — THE BAG", show: "Lil Baliil", dur: 220, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 220 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-gys0fulojsi", kind: "show", src: "yt", yt: "GYS0fuloJSI", title: "Lil Baliil — QURUXDIYO QOF AH", show: "Lil Baliil", dur: 211, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-vrdfzjiqivo", kind: "show", src: "yt", yt: "VRDFZjiqiVo", title: "Lil Baliil — HAIWEEYDIIN", show: "Lil Baliil", dur: 171, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 171 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      { id: "mv-5q4iiubiplg", kind: "show", src: "yt", yt: "5Q4IiUbipLg", title: "Lil Baliil — IF", show: "Lil Baliil", dur: 205, block: "anytime", fill: true, rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 205 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)") },
      // v15: Malik's two barbershop cartoons join the fill as WHOLE
      // EPISODES (Malik, 2026-11-05 ~14:38 ET: "And shuffle in my
      // cartoons as well" / "All 3 asap deen and my cartoons") — the
      // same items the hourly slot plays (tvCartoonItems: same ids,
      // files, titles and durations), seeded here as fill so the
      // weave below deals each episode into the shuffle as ONE unit
      // (Part 1 → Part 2 back-to-back, never split). The hourly
      // cartoon block itself is unchanged and still plays on its
      // own pinned span every hour.
      // v20: Episodes 3 and 4 join the fill the same way (Malik,
      // 2026-11-06 17:10 ET: "Put episode 3 and 4 in the tv line
      // up") — two more whole-episode units in the weave below;
      // the hourly block grows with them too (TV_CARTOON_V 5).
      { id: "cartoon-barbershop-p1", kind: "show", src: "file", yt: "", url: "/media/barbershop-cartoon-v2-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 1, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.3, block: "anytime", fill: true, rights: R("own", "Malik's own barbershop cartoon — sent by him on 2026-11-05 with his order to air it on MW TV once every hour, right after scheduled programming, as-is; owner media file hosted on the site itself", true) },
      { id: "cartoon-barbershop-p2", kind: "show", src: "file", yt: "", url: "/media/barbershop-cartoon-v2-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 1, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.3, block: "anytime", fill: true, rights: R("own", "Malik's own barbershop cartoon — sent by him on 2026-11-05 with his order to air it on MW TV once every hour, right after scheduled programming, as-is; owner media file hosted on the site itself", true) },
      { id: "cartoon-djbattle-p1", kind: "show", src: "file", yt: "", url: "/media/dj-battle-cartoon-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 2, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.1, block: "anytime", fill: true, rights: R("own", "Malik's own cartoon — Episode 2 of South Park in Meechie's World (the DJ battle), sent by him on 2026-11-05 with his order to air it right after Episode 1, back-to-back, looped in with his commercials; owner media file hosted on the site itself", true) },
      { id: "cartoon-djbattle-p2", kind: "show", src: "file", yt: "", url: "/media/dj-battle-cartoon-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 2, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.5, block: "anytime", fill: true, rights: R("own", "Malik's own cartoon — Episode 2 of South Park in Meechie's World (the DJ battle), sent by him on 2026-11-05 with his order to air it right after Episode 1, back-to-back, looped in with his commercials; owner media file hosted on the site itself", true) },
      { id: "cartoon-spmw-ep3-p1", kind: "show", src: "file", yt: "", url: "/media/spmw-ep3-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 3, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.0, block: "anytime", fill: true, rights: R("own", "Malik's own cartoon — Episode 3 of South Park in Meechie's World (the record-deal story), sent by him on 2026-11-06 with his order to put Episodes 3 and 4 in the TV lineup; owner media file hosted on the site itself", true) },
      { id: "cartoon-spmw-ep3-p2", kind: "show", src: "file", yt: "", url: "/media/spmw-ep3-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 3, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.9, block: "anytime", fill: true, rights: R("own", "Malik's own cartoon — Episode 3 of South Park in Meechie's World (the record-deal story), sent by him on 2026-11-06 with his order to put Episodes 3 and 4 in the TV lineup; owner media file hosted on the site itself", true) },
      { id: "cartoon-spmw-ep4-p1", kind: "show", src: "file", yt: "", url: "/media/spmw-ep4-p1.mp4", iaId: "", title: "South Park in Meechie's World — Episode 4, Part 1 of 2", show: "Meechie's World Cartoon", dur: 301.1, block: "anytime", fill: true, rights: R("own", "Malik's own cartoon — Episode 4 of South Park in Meechie's World (the talent-show story), sent by him on 2026-11-06 with his order to put Episodes 3 and 4 in the TV lineup; owner media file hosted on the site itself", true) },
      { id: "cartoon-spmw-ep4-p2", kind: "show", src: "file", yt: "", url: "/media/spmw-ep4-p2.mp4", iaId: "", title: "South Park in Meechie's World — Episode 4, Part 2 of 2", show: "Meechie's World Cartoon", dur: 301.9, block: "anytime", fill: true, rights: R("own", "Malik's own cartoon — Episode 4 of South Park in Meechie's World (the talent-show story), sent by him on 2026-11-06 with his order to put Episodes 3 and 4 in the TV lineup; owner media file hosted on the site itself", true) },
    ],
    updatedAt: now, by: "keeper-seed"
  };
  // v15 FILL WEAVE: the fill items above are seeded grouped — the
  // 44 music videos as one ASAP Preach run followed by one Deen
  // Squad run, then the two cartoon episodes — and the program
  // chain plays the seed in order, so grouped seeding plays as
  // blocks, not a shuffle. Below, the fill items are re-dealt
  // across their OWN positions in chan.items as one mixed cycle:
  // the music videos interleave by artist, and each cartoon
  // episode enters as a single whole unit. Membership is
  // untouched: the same items in the same fill slots, only the
  // order among those slots changes; every non-fill item stays
  // exactly where it was, and the hourly cartoon span machinery
  // (tvCartoonSpans) never reads this list — it plays from
  // tvCartoonItems on its own pinned span, exactly as before.
  const fillPos = [], fillItems = [];
  chan.items.forEach((it, i) => { if (it && it.fill === true) { fillPos.push(i); fillItems.push(it); } });
  if (fillPos.length > 1) {
    // Episode units: a file-media fill item whose id ends in -p1,
    // -p2, ... is one part of a whole episode — the parts are glued
    // into a single unit here and the unit is dealt into the weave
    // whole, so an episode's parts always play back-to-back in
    // order and a lone part is never drawn.
    const music = [], epParts = new Map();
    for (const it of fillItems) {
      const m = it.src === "file" ? /^(.*)-p(\d+)$/.exec(String(it.id || "")) : null;
      if (m) { if (!epParts.has(m[1])) epParts.set(m[1], []); epParts.get(m[1]).push({ n: +m[2], it }); }
      else music.push(it);
    }
    // Music weave: proportional interleave by artist — the picks
    // track each artist's share of the music set, so the artists
    // alternate (an extra video from the bigger catalog lands
    // every so often; no artist plays more than two in a row), and
    // each artist's videos keep their seeded order inside the
    // weave.
    const byArtist = new Map();
    for (const it of music) { const k = String(it.show || ""); if (!byArtist.has(k)) byArtist.set(k, []); byArtist.get(k).push(it); }
    const groups = [...byArtist.values()].map((items) => ({ items, taken: 0 }));
    const units = [];
    for (let n = 0; n < music.length; n++) {
      let best = null, bestDeficit = -Infinity;
      for (const g of groups) {
        if (g.taken >= g.items.length) continue;
        const deficit = (g.items.length / music.length) * (n + 1) - g.taken;
        if (deficit > bestDeficit) { bestDeficit = deficit; best = g; }
      }
      units.push([best.items[best.taken++]]);
    }
    // Episodes woven in by time: the episodes divide the whole
    // cycle (music + episodes) into equal shares — with two
    // episodes, each lands half a cycle from the other, so a
    // cartoon starts at a steady cadence all the way around the
    // loop instead of bunching up in one stretch of it.
    const eps = [...epParts.values()].map((parts) => parts.sort((a, b) => a.n - b.n).map((p) => p.it));
    if (eps.length) {
      const musicSec = music.reduce((a, it) => a + (+it.dur || 0), 0);
      const totalSec = musicSec + eps.reduce((a, ep) => a + ep.reduce((b, it) => b + (+it.dur || 0), 0), 0);
      const withEps = [];
      let acc = 0, epSec = 0, ei = 0;
      for (const u of units) {
        withEps.push(u);
        acc += +u[0].dur || 0;
        while (ei < eps.length && acc + epSec >= (totalSec * (2 * ei + 1)) / (2 * eps.length)) { withEps.push(eps[ei]); epSec += eps[ei].reduce((b, it) => b + (+it.dur || 0), 0); ei++; }
      }
      while (ei < eps.length) withEps.push(eps[ei++]);
      units.length = 0; units.push(...withEps);
    }
    const woven = units.flat();
    fillPos.forEach((pos, n) => { chan.items[pos] = woven[n]; });
  }
  return chan;
}
function tvSeedPool(now) {
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  const Y = (id, yt, title, dur, lane, evidence) => ({ id, kind: "break", src: "yt", yt, title, dur, lane, rights: R(evidence) });
  const YS = (id, yt, title, dur, sparse, evidence) => { const it = Y(id, yt, title, dur, "shorts", evidence); if (sparse) it.sparse = true; return it; };
  const items = [
    Y("brk-gxbsyx85kp8", "GxBSyx85Kp8", "Usher — Yeah! (Official Video) ft. Lil Jon, Ludacris", 253, "rb", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader UsherVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-gezzr_p6vb8", "GeZZr_p6vB8", "Nelly — Hot In Herre (Official Music Video)", 245, "hiphop", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader NellyVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-pwgvgjahviw", "PWgvGjAhvIw", "Outkast — Hey Ya! (Official HD Video)", 304, "hiphop", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader OutkastVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-8ahcfztrgii", "8AHCfZTRGiI", "Johnny Cash — Hurt", 229, "country", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader JohnnyCashVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-htwkbfoikeg", "hTWKbfoikeg", "Nirvana — Smells Like Teen Spirit (Official Music Video)", 279, "rock", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader NirvanaVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-znlfu_lemsu", "znlFu_lemsU", "Mary J. Blige — Family Affair (Official Music Video)", 225, "rb", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader MaryJBligeVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-kgdr2uytpdi", "Kgdr2uytpDI", "T.I. — Whatever You Like (Official Video)", 253, "trap", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Atlantic Records (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-iyh7_gzp4tg", "IYH7_GzP4Tg", "Lil Jon & The East Side Boyz — Get Low (Official Music Video)", 271, "trap", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Radial by The Orchard (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-xfyqqpaoz7y", "xFYQQPAOz7Y", "Eminem - Lose Yourself", 328, "hiphop", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader EminemMusic (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-myxaik6vnxw", "MYxAiK6VnXw", "Outkast - Ms. Jackson (Official HD Video)", 299, "hiphop", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader OutkastVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-5qm8ph4xass", "5qm8PH4xAss", "50 Cent - In Da Club (Official Music Video)", 248, "hiphop", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader 50CentVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-gtuvqei3nx4", "GtUVQei3nX4", "Snoop Dogg - Drop It Like It's Hot (Official Music Video) ft. Pharrell Williams", 264, "hiphop", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader SnoopDoggVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-viwtnluqkmy", "ViwtNLUqkMY", "Beyoncé - Crazy In Love ft. JAY Z", 237, "rb", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader BeyoncéVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-hl1uzik-fla", "HL1UzIK-flA", "Rihanna - Work (Explicit) ft. Drake", 455, "rb", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader RihannaVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-34na4j8avga", "34Na4j8AVgA", "The Weeknd - Starboy ft. Daft Punk (Official Video) ft. Daft Punk", 274, "rb", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader TheWeekndVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-uxpda-c-4mc", "uxpDa-c-4Mc", "Drake - Hotline Bling", 296, "rb", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader DrakeVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-zjl4ugsbefg", "ZJL4UGSbeFg", "Shania Twain - Man! I Feel Like A Woman! (Official Music Video)", 235, "country", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader ShaniaTwainVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-wasy8yy-mr8", "WaSy8yy-mr8", "Carrie Underwood - Before He Cheats (Official Video)", 199, "country", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader carrieunderwoodVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-rb7onnfijai", "rB7ONnfIjaI", "Miranda Lambert - Kerosene (Official HD Video)", 185, "country", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader mirandalambertVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-jw5uew2kyvc", "JW5UEW2kYvc", "Alan Jackson - Chattahoochee (Official HD Video)", 245, "country", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader alanjacksonVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-ry0wxgsxdee", "rY0WxgSXdEE", "Queen - Another One Bites the Dust (Official Video Remastered)", 219, "rock", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Queen Official (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-pagnjdjn4va", "pAgnJDJN4VA", "AC/DC - Back In Black (Official 4K Video)", 254, "rock", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader acdcVEVO (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    Y("brk-evtxpuf4oz4", "eVTXPUF4Oz4", "In The End [Official HD Music Video] - Linkin Park", 219, "rock", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at reprogram time (2026-11-02): embeddable, uploader Linkin Park (official artist/label channel); keeper-recheck simulation (gate search by exact title returns this id) passed"),
    // ASAP Preach (Malik, 2026-11-05 ~08:34 ET: "I want asap preach
    // s music to get shuffled on my tv station"): the Christian
    // rapper's official-channel music videos join the bag as
    // ordinary cleared auto-picks — crowd-skippable and
    // vote-weightable like every break pick, and never displacing
    // any hard schedule (breaks only fill gaps the keeper already
    // leaves). Every id is an upload on his own channel
    // (@OfficialASAPPreach, channel UCDG6YLw_vMVDRXKErys6EJQ) with
    // ASAP Preach as lead artist, verified at build time
    // (2026-11-05): YouTube oEmbed HTTP 200 with author
    // "ASAP Preach" on every id (oEmbed refuses when embedding is
    // disabled), the site embed gate (/api/ytsearch) returning each
    // id for its title search, and every duration pinned from the
    // actual upload twice — the channel grid and the embed-gate
    // relay — in exact agreement. Per-id evidence files:
    // website/asap-preach-tv-2026-11-05/verify/.
    Y("brk-w_o8r_2dopg", "w_O8R_2doPg", "ASAP Preach — The Light", 171, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 171 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk--mg7vmzk4ua", "-mG7Vmzk4uA", "ASAP Preach — Tested", 252, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 252 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-vopzm0cmyac", "VOpzm0cMYac", "ASAP Preach — City Boy", 137, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 137 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-olujvm1hzge", "OlujvM1HZGE", "ASAP Preach — Don't Let Me Go", 168, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-0qr2d7ap7us", "0qR2d7ap7us", "ASAP Preach — Let It Go", 176, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-tkjt4k1gwg8", "tkjT4k1GwG8", "ASAP Preach — All Of Me", 283, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 283 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-qktoqpqfshs", "QkToQPqFShs", "ASAP Preach — Owe You Praise", 167, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 167 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-zz1hxwehwvc", "Zz1hXWEHwvc", "ASAP Preach — Rose In The Road", 176, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-4sodikunneq", "4SodIcKUNeQ", "ASAP Preach — FALL", 194, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 194 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-fipzwgho_pa", "fIPZwghO_PA", "ASAP Preach — LIFE", 187, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 187 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-ijap51ezgog", "Ijap51EZGog", "ASAP Preach — PAIN", 290, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 290 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-tpuqrrhkleu", "tpuqRrHKLEU", "ASAP Preach — DRAPED", 243, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 243 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-rqtknjb0_aw", "rqtKnjB0_Aw", "ASAP Preach — FORGIVEN", 244, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 244 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-bqotl5pqun8", "BQoTL5pQUn8", "ASAP Preach — Counterfeit", 234, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 234 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-i3z-ec7jxjq", "i3Z-eC7jxjQ", "ASAP Preach — Get Right", 185, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 185 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-2r3ji9eijtq", "2r3Ji9eijtQ", "ASAP Preach — Lowest", 219, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 219 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-fbkcfmcj4bg", "FBkcFMCj4Bg", "ASAP Preach — Crying Out", 224, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 224 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-jew6zipvdfo", "jEW6ZiPVdFo", "ASAP Preach — Letting Go", 192, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 192 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-mv3a0mc-xl4", "mV3a0Mc-Xl4", "ASAP Preach — Yahweh", 149, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 149 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-2vrtbr2jnmc", "2VRTbR2jnmc", "ASAP Preach — God Made Muzic", 382, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader ASAP Preach (the artist's official channel, @OfficialASAPPreach); gate search by title returns this id; duration 382 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    // Deen Squad (Malik, 2026-11-05 ~11:03 ET: "And deen squad" /
    // "Music videos"): the Muslim hip-hop duo's (Jae Deen &
    // Karter Zaher) official-channel music videos join the bag as
    // ordinary cleared auto-picks — crowd-skippable and
    // vote-weightable like every break pick, and never displacing
    // any hard schedule (breaks only fill gaps the keeper already
    // leaves). Every id is an upload on their own channel
    // (@deensquadmusic, channel UCh6MhPyvzCNz_VF5q9UcV1A) with
    // Deen Squad as lead artist, verified at build time
    // (2026-11-05): YouTube oEmbed HTTP 200 with author
    // "Deen Squad" on every id (oEmbed refuses when embedding is
    // disabled), the site embed gate (/api/ytsearch) returning each
    // id for its title search, and every duration pinned from the
    // actual upload twice — the channel grid and the embed-gate
    // relay — in exact agreement. Lane "faith": the pool's
    // "gospel" lane is ASAP Preach's Christian rap; Deen Squad is
    // Muslim hip-hop — the same faith-based break flavor in a
    // different tradition, kept distinguishable. Per-id evidence
    // files: website/deen-squad-tv-2026-11-05/verify/.
    Y("brk-rvra29b1pqk", "rvrA29B1pqk", "Deen Squad — Halal Boy (Slowed Down)", 252, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 252 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-mx4hbcmggi4", "mX4HbcMGgi4", "Deen Squad — RAMADAN", 191, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-cavfobzw8rc", "CaVFOBzw8rc", "Deen Squad — COVER GIRL", 276, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 276 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-itxckklebre", "itXckkLebRE", "Deen Squad — RAMADAN KAREEM", 211, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-qbl5slpznjs", "qBL5sLPznjs", "Deen Squad — NO GOD BUT YOU", 173, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 173 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-onqqu_y6_se", "ONqqu_y6_sE", "Deen Squad — PAKISTANI", 191, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-w53egdphkzu", "w53EgDpHkZU", "Deen Squad — HALAL LOVIN", 223, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-xhv6wjd_1ps", "XHV6WJD_1ps", "Deen Squad — HANDS OF ALLAH", 190, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 190 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-defxddayqsq", "deFXDDAyqsQ", "Deen Squad — OOOUUU", 175, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 175 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-izq2tpczm4o", "IzQ2TPCzm4o", "Deen Squad — ON MY DEEN", 200, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 200 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-5usjjr2dojc", "5UsjjR2DOJc", "Deen Squad — MASJID", 161, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 161 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-pf25t2ds5nk", "Pf25t2dS5Nk", "Deen Squad — MECCA", 214, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 214 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-oknhojavszg", "OKnHojaVSzg", "Deen Squad — PRAY IN PEACE", 221, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-zykuxgu_qbi", "ZYkUXgU_qBI", "Deen Squad — NO LIMIT", 222, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 222 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-s9czmfyxvwq", "S9CZmFyxVwQ", "Deen Squad — MUSLIM QUEEN", 179, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 179 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-dzgaxvpqoeo", "DzGaxvPqoeo", "Deen Squad — DEEN STARS", 209, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 209 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-_hdk44ccbre", "_HDK44cCbRE", "Deen Squad — MADINA", 208, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 208 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-up5zlavdecq", "uP5zLaVdECQ", "Deen Squad — MUSLIM MAN", 219, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 219 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-vd6yzywtwwg", "Vd6yzyWTWWg", "Deen Squad — BELIEVER", 174, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 174 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-ff5pobglsjy", "Ff5pOBGLsJY", "Deen Squad — FRIDAY", 208, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 208 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-j82a1gyzqyw", "j82A1GyZqYw", "Deen Squad — JANNAH", 191, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-7bdodtlgmlo", "7bdoDTlGMLo", "Deen Squad — ALLAH'S PLAN", 206, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-f5c3lh33pie", "F5c3LH33pIE", "Deen Squad — HALAL BOY", 238, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 238 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    Y("brk-zr4bztphc_u", "ZR4bztPhc_U", "Deen Squad — LOOK ALIVE", 186, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Deen Squad (the artist's official channel, @deensquadmusic); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement"),
    // Muslim rap expansion (v16 — Malik, 2026-11-05 ~18:00 ET:
    // "find more muslin rap like deen squad and mix that in";
    // picks locked 2026-11-05 ~19:31 ET): 48 more verified Muslim
    // rap videos join Deen Squad in the faith lane — Native Deen
    // 10, Essam 12, Khalil Ismail 7 (the strict verified set),
    // plus Muslim Belal 12 and Ilyas Mao 7 (Malik: Belal and Ilyas
    // are "in"). Every id is an upload on the artist's OWN official
    // channel — no "- Topic" auto-generated channels, no fan
    // re-uploads — oEmbed-verified with the artist's own channel
    // as author, durations pinned from the actual uploads
    // (research records: website/islamic-programming-2026-11-05/
    // MUSLIM-RAP.md + MUSLIM-RAP-VERIFIED.md). The same 48 uploads
    // ride the cycle seed as fill: true program items below.
    Y("brk-4ahhnr6dcpg", "4AhhNR6dCpg", "Native Deen — Not Afraid to Stand Alone", 302, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 302 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-vnw258w0crk", "vNW258w0CRk", "Native Deen — Small Deeds", 233, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 233 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-ixlnueanlgq", "iXLnUeANLGQ", "Native Deen — Shaded Seven", 377, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 377 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-h7k4vyzgom8", "h7K4vYZGoM8", "Native Deen — Living Halal", 289, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 289 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-hfkgp3izp6c", "HFKgP3IzP6c", "Native Deen — Lord, Enable Me", 274, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 274 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-1zpn1ebxgce", "1ZpN1ebXgCE", "Native Deen — SubhanAllah", 262, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 262 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-prn8kdglcbe", "prn8KDGlCbE", "Native Deen — Al-Widaa", 353, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 353 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-qqldnckvsrc", "qQlDNCkVsRc", "Native Deen — Lose Their Way", 346, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 346 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-1-ykiu4cdl8", "1-YKIU4cDL8", "Native Deen — Baligna Ramadan", 176, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-ifcd8fh5v7m", "ifCD8fh5v7M", "Native Deen — I Am Near", 639, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Native Deen (the artist's official channel, @nativedeen); gate search by title returns this id; duration 639 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-apelpqwjyz0", "apELpQWJyz0", "Essam — Runnin", 264, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 264 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-tz_jxqw9lzs", "Tz_jxQw9LZs", "Essam — Runnin' Pt. 2", 447, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 447 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-wvhunbwhumu", "WvHuNbwHumU", "Essam — Wonder", 206, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-1_lv0il4wf8", "1_lV0iL4wF8", "Essam — No Love", 172, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 172 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-pr2o2zepik4", "Pr2O2ZEpiK4", "Essam — Morocco", 145, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 145 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-w7qyamxj-wa", "W7qyAmxj-wA", "Essam — Hero", 134, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 134 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-4cvetqh1hbk", "4cVEtQH1HBk", "Essam — Famila", 324, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 324 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-ygsuhespjau", "YGsUHespjaU", "Essam — On the Road", 328, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 328 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-qm93ntinjnc", "qM93ntiNJnc", "Essam — Fly", 199, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 199 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-beondshthog", "beOndSHThog", "Essam — Fajr", 199, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 199 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-afgvko9tyxg", "AfgVKo9Tyxg", "Essam — Free", 223, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-e-ycldzq_wk", "E-YclDzq_Wk", "Essam — My People", 211, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Essam (the artist's official channel, @masseone39); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-m7ridiplgk8", "m7ridipLgk8", "Khalil Ismail — 20/20", 367, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 367 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-hgisdptdida", "hgISdPTdiDA", "Khalil Ismail — First We Need the Love", 256, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 256 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-d6gtqhigyh8", "D6GtQhIgyH8", "Khalil Ismail — Man Up", 290, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 290 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-fmcwc3k3cmy", "FmCWC3k3CmY", "Khalil Ismail — Sometimes", 285, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 285 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-0guiy2mfoo4", "0GuIy2mFoO4", "Khalil Ismail — Knocking", 276, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 276 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-mzvr-ff5xcm", "mzvR-ff5xcM", "Khalil Ismail — Thank You Haters", 276, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 276 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-w91s8wqtkf0", "w91s8WqtKf0", "Khalil Ismail — Freedom Fighters", 183, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Khalil Ismail (the artist's official channel, @khalilismailtv); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP.md)"),
    Y("brk-uwdya5-kbws", "uwdyA5-kBWs", "Muslim Belal — KABIR", 337, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 337 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-v0u6rwtmc_g", "V0U6RwtmC_g", "Muslim Belal — Ameen", 260, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 260 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-0xptcdzutp0", "0xptcdZuTp0", "Muslim Belal — Family", 253, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 253 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-pqmvxcyen2c", "pqMVxcyEN2c", "Muslim Belal — The Corner", 340, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 340 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-keusmki6l_k", "KeusmKI6L_k", "Muslim Belal — Journey", 152, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 152 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-fm2yjvkcoqw", "Fm2yjvKcOQw", "Muslim Belal — Traveller", 249, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 249 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-rrdqrfm_d9w", "RrDqRfm_d9w", "Muslim Belal — Layla (The Dunya)", 202, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 202 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-fzhwu4vr7as", "fzHwu4Vr7as", "Muslim Belal — Real Life", 285, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 285 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-pljjllr0kas", "pLJJLlr0kas", "Muslim Belal — Faith 2 Faith", 304, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 304 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-jthchlgfpjo", "JTHChlgfpJo", "Muslim Belal — Spot Project", 360, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 360 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-9690aghz1ss", "9690aGhZ1Ss", "Muslim Belal — LIFE", 412, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 412 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-f03jplwetgu", "F03jpLWeTgU", "Muslim Belal — Palestine (Live at Conway Hall)", 330, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Muslim Belal (the artist's official channel, @muslimbelal885) with the author matching on this id; duration 330 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-azxfcb68luy", "azxFcb68luY", "Ilyas Mao — The Blame Game", 233, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 233 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-4iipcjguddq", "4iiPcJgUDdQ", "Ilyas Mao — The Battle Of Badr", 284, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 284 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-tjd1kw3379w", "TJd1Kw3379w", "Ilyas Mao — Still A Muslim", 187, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 187 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-yxelkr5ktri", "yXElKR5KTrI", "Ilyas Mao — Ghost", 219, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 219 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-lyzlw-tp1zc", "LyZlw-tp1zc", "Ilyas Mao — Seize The Day", 202, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 202 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-muxc-8ciago", "muXc-8CiAGo", "Ilyas Mao — WHOLE", 199, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 199 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    Y("brk-fb1fykja3xs", "FB1fykja3xs", "Ilyas Mao — How Far", 226, "faith", "YouTube oEmbed verification at research time (2026-11-05): embeddable, uploader Ilyas Mao (the artist's official channel, @IlyasMao) with the author matching on this id; duration 226 pinned from the artist's own channel grid; kept in the pool by Malik's decision 2026-11-05 ~19:31 ET (research record: website/islamic-programming-2026-11-05/MUSLIM-RAP-VERIFIED.md)"),
    // Collaborators (v18 — Malik, 2026-11-05 ~22:24 ET:
    // "add every bodys music video that makes music with
    // asap preach and deen squad into my music shuffle"):
    // the official-channel music videos of every credited
    // ASAP Preach / Deen Squad collaborator join the bag in
    // the lane of their collaboration (gospel = ASAP side,
    // faith = Deen Squad side, incl. Jae Deen's and Karter
    // Zaher's own solo channels) — the same uploads ride
    // the cycle seed as fill: true program items above.
    Y("brk-_-gqtvmarpg", "_-GQtvMaRpg", "Brother Bo — On A Mission", 282, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 282 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-jfkvdpmveom", "jfKVdPMVEOM", "Brother Bo — Love Letter", 193, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 193 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-yaleoohqs9y", "yaLEoOhQS9Y", "Brother Bo — LOOK AT MY GOD", 128, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 128 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-sf8anxz5pra", "SF8AnXZ5PRA", "Brother Bo — STILL GROWING", 212, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-lt__ojndsce", "lt__OjndSCE", "Brother Bo — Way Of The Lord", 221, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-fwiyfs4ldcc", "FwiYFS4lDCc", "Brother Bo — NOT FORGOTTEN", 251, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 251 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-xlil8voy2ag", "XliL8voy2ag", "Brother Bo — Want to see you", 257, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 257 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-2qecxen_hea", "2qEcXEn_HEA", "Brother Bo — Father Forgive 'Em", 210, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 210 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-pmkrua5b-fo", "PmKRuA5B-fo", "Brother Bo — By Your Spirit", 186, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-lxelkz-3ywi", "lXElKZ-3ywI", "Brother Bo — WIN SOULS", 231, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-5pnjbcnj-pk", "5pnJbcNj-Pk", "Brother Bo — HOUSE OF BREAD", 226, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 226 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-uvsrmu3t1v8", "uvSRMu3t1v8", "Brother Bo — Church", 227, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 227 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-cnuhnbqdsm4", "CNUhnbqDsM4", "Brother Bo — Prodigal", 237, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 237 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-2zzn9gytcjc", "2zzn9gYtCjc", "Brother Bo — Fill Me Up", 182, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 182 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-6u8_ajzdqwa", "6u8_aJZdqwA", "Brother Bo — Check Your Heart", 212, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-v4ewep0tvgi", "v4EwEP0TVgI", "Brother Bo — Aliens", 209, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 209 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vgwma2pugpa", "vgWma2puGpA", "Brother Bo — Narrow Road", 181, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-hzok7uw_hni", "HZok7UW_HnI", "Brother Bo — Fallen Stars", 203, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brother Bo Music (the artist's official channel, @BrotherBoMusic); gate search by title returns this id; duration 203 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kfz_lmrijqa", "kFz_LmRijqA", "Big Yeet — Yahweh", 117, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 117 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-l0pzs3vsbno", "L0pzs3vsBNo", "Big Yeet — Nobody Knew", 190, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 190 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-n9aptatncg0", "N9APtatNCg0", "Big Yeet — Take Me Back", 138, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 138 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-0g72dwp2eve", "0g72dWP2EVE", "Big Yeet — I Need Jesus", 181, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ch6zgoxgamk", "ch6zgOXGAMk", "Big Yeet — Guard My Heart", 151, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-fko3j2lqg0g", "FKo3j2Lqg0g", "Big Yeet — Better Life", 148, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 148 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-mvqgsjye4-c", "MvqGsJYE4-c", "Big Yeet — My God", 172, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Big Yeet (the artist's official channel, @OfficialBigYeet); gate search by title returns this id; duration 172 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-0ww98xwrx18", "0WW98XWRX18", "Adrion Butler — UGH UGH", 591, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 591 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-xnkhr_szojq", "XNkHR_SzojQ", "Adrion Butler — Robotnic", 215, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 215 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ieog-hsg5vs", "IeoG-HSG5vs", "Adrion Butler — What Was That", 186, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zgxhefoxutq", "zgXHeFOxuTQ", "Adrion Butler — Can't Tell Me Nothing", 222, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 222 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-xnpfj8e9lbk", "xNpFJ8e9lBk", "Adrion Butler — On Time", 314, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 314 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-qt9uyrekkgc", "qT9UyREKkgc", "Adrion Butler — Day III", 149, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader im.adrion (the artist's official channel, @imadrion); gate search by title returns this id; duration 149 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-rsg1eym-elw", "rSg1eyM-ELw", "REDEEMED — ECHOES", 204, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 204 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-jns9esipg74", "jNS9esiPG74", "REDEEMED — Creation Is Groaning", 213, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 213 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-6y8v1qp2paw", "6Y8v1qP2PAw", "REDEEMED — I BELIEVE", 168, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-onasrjfx3eq", "ONaSrJFx3EQ", "REDEEMED — BIG HOMIE", 214, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 214 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-9at_hjembr0", "9At_HJEmbr0", "REDEEMED — OFF THE BLOCK", 231, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ulpwmyozbru", "UlPwMyOzBRU", "REDEEMED — ACTION", 233, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 233 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zi3gaztm3vg", "ZI3gAzTm3vg", "REDEEMED — ANOTHER MINUTE", 230, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 230 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-30xpwq-hoea", "30XPWq-HoeA", "REDEEMED — Hear Me Now", 180, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 180 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kqu7ghqvgsq", "kQU7gHQVGsQ", "REDEEMED — 2 DA CHURCH", 217, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REDEEMED (the artist's official channel, @redeemedmuzic); gate search by title returns this id; duration 217 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kbx_89zw6ys", "KBX_89zw6Ys", "Jysa BP — Intermission", 213, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 213 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gg_zrzik74k", "gg_zRZIK74k", "Jysa BP — Adderrall and Prayers", 146, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 146 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-pgkyygk45j0", "PGkyYgk45j0", "Jysa BP — Legacy", 162, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 162 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-nsd12mlxwo0", "NSD12MLXWO0", "Jysa BP — Halo", 183, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-tjrr-qreyjk", "TJrr-qrEYJk", "Jysa BP — There For You", 158, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 158 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-v4_icgckgr0", "V4_IcgcKGR0", "Jysa BP — Way Out", 239, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 239 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kpelcrwxfs0", "KpeLcRWxfS0", "Jysa BP — Let 'Em Know", 218, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader JysaBP (the artist's official channel, @JysaBP); gate search by title returns this id; duration 218 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-wripoaigw5o", "wRipoaIGw5o", "Blizz — Always", 216, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 216 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zo1lcsmsi9g", "Zo1lcSmsI9g", "Blizz — I Lie to Me", 311, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 311 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-urnnm3qmjpy", "uRNnm3qmjPY", "Blizz — Looking Up", 271, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 271 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-e-x8vmy3_f4", "E-x8VMY3_F4", "Blizz — More Than Life", 254, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 254 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-umt5moafy7k", "umt5moaFY7k", "Blizz — Thin Line", 246, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 246 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-des2fq8lpe4", "DeS2Fq8LPE4", "Blizz — You Still Love Me", 219, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 219 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-u6n7evj7ds4", "u6n7evj7dS4", "Blizz — When It Rains", 352, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Blizz (the artist's official channel, @Blizz260); gate search by title returns this id; duration 352 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-2s4w-zabkkc", "2s4W-zabkkc", "Kamban — On The Road", 197, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 197 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ud2zs4bmmlq", "ud2zs4bmmlQ", "Kamban — LUKE CAGE", 158, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 158 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kckmq2qtohe", "KCkmQ2QToHE", "Kamban — Marvelous Things", 150, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 150 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-fcw-3qzj3oq", "fcw-3QZj3oQ", "Kamban — Rain Down", 195, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 195 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ok4x1zhdy-y", "ok4x1zHdy-Y", "Kamban — The Race", 223, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-nmkpazmrfjs", "NMkpAZMrFjs", "Kamban — Got to Go", 255, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 255 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-wgbnnxf-ywk", "wgbNNXf-ywk", "Kamban — Covenant", 238, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KambanMusic (the artist's official channel, @kambanmusic); gate search by title returns this id; duration 238 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-wc2uqkhgwmu", "wc2UQKhgWmU", "Bryann T — Concrete Hymms", 191, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-wmdab0tau38", "wMDAB0TAU38", "Bryann T — With Me", 228, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 228 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ajbk6odbnem", "AjBk6oDBNeM", "Bryann T — Seeking Grace", 188, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 188 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-h852p3dpoiy", "H852P3dpOIY", "Bryann T — Everything", 266, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 266 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-s3nkpahor-a", "s3nKpAHOR-A", "Bryann T — Learn From This", 254, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 254 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-9en8d-far1u", "9en8d-FAR1U", "Bryann T — Free My Lil Brudda", 257, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 257 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-odwrxs7xic8", "oDWRXS7XIC8", "Bryann T — Vent", 324, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 324 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ouxahi4dyv8", "OuXaHI4DYv8", "Bryann T — Older & Wiser", 292, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 292 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-hhvjd8pzcdo", "hHVJd8pZcDo", "Bryann T — Prayer Changes Everything", 225, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 225 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-91zciegigm0", "91ZCIEGIGm0", "Bryann T — Struggle", 296, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Bryann T (the artist's official channel, @kingdommuzic); gate search by title returns this id; duration 296 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ruh_ucxawkm", "RuH_UcxAWKM", "Tyson James — Broken Hallelujah", 150, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 150 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-g9bcjy4auey", "g9bCjy4AUeY", "Tyson James — 2A Heavy", 181, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-imi5cgcp5ua", "iMI5CGCP5uA", "Tyson James — Catch Me Listening", 178, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 178 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ttecbltcpk4", "tTeCblTCpk4", "Tyson James — Dangerous", 217, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 217 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-upeacolzh4w", "uPeACoLzH4w", "Tyson James — Pride is the Devil 2", 186, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gh5cs-x7s0g", "gh5cs-X7s0g", "Tyson James — Free", 175, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 175 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-sgojopsiee0", "SGojopSiEe0", "Tyson James — Co-Sign", 109, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 109 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-v2cwuqey-ik", "V2cWUqEy-Ik", "Tyson James — Pressure Makes Diamonds", 169, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 169 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ekzwgwsvqgq", "EkZWGwSvqGQ", "Tyson James — Fighting Myself", 208, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 208 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-tovoe4zda4q", "toVoE4zDA4Q", "Tyson James — Never Sell My Soul", 187, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 187 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gmvyt3mg6ek", "gmvyT3MG6Ek", "Tyson James — Psalm 23", 213, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 213 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-6r4asyf2gom", "6R4AsyF2GOM", "Tyson James — God Over Government", 190, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 190 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-s-tknliylmg", "S-TKnLiylmg", "Tyson James — True Colors", 287, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 287 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-k5dan8ml_ue", "K5Dan8ml_uE", "Tyson James — All by Design", 195, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 195 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-q0yolnmf6su", "q0YolnMf6sU", "Tyson James — Big Mad", 167, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 167 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-tnxqggmu-em", "TnxQGgmu-EM", "Tyson James — See it Clearly", 183, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-saidxwwdkbg", "saidxWwDKBg", "Tyson James — Christian Rappers", 199, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 199 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-us8vglkdzq0", "US8vglkDZQ0", "Tyson James — Send Me An Angel", 253, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 253 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-z6qnr42wjq0", "Z6Qnr42wjQ0", "Tyson James — Sodom Got Smoked", 177, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 177 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-bugimrspkuq", "bUGiMRSpkuQ", "Tyson James — Holy Rebellion", 131, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Tyson James (the artist's official channel, @TysonJamesMusic); gate search by title returns this id; duration 131 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gmvbovl033i", "GMVbovL033I", "Brett Raio — Freedom", 178, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 178 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ruknbsqvr6i", "rUKnBSQvR6I", "Brett Raio — Leading My Way", 197, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 197 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-idsykc1eeq4", "IDSYKC1EEq4", "Brett Raio — Scars", 179, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 179 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zlyo0kw9iiy", "ZLyO0KW9iIY", "Brett Raio — Slow Baby", 198, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 198 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-jghc9hsc1pe", "JGHc9Hsc1PE", "Brett Raio — Last Days", 164, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 164 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-wjc3r9pqpsw", "wjc3r9PQpsw", "Brett Raio — Unleashed Ignite", 151, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Brett Raio (the artist's official channel, @BrettRaio); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-o1erlujcapo", "o1ErLuJCapo", "Justo Chalaire — Tell Em The Truth", 184, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 184 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-v3wpauytt0y", "V3wPauytt0Y", "Justo Chalaire — Drop", 176, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-od_xifblvzu", "Od_xIfBlVzU", "Justo Chalaire — Who Is Jesus?", 144, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 144 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-r67zvrq5efs", "r67zVRq5Efs", "Justo Chalaire — Look Where I Stand", 149, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 149 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-lnjgk70uuhk", "lnjgK70uUHk", "Justo Chalaire — Tryna Get It", 195, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Justo Chalaire (the artist's official channel, @JustoChalaire); gate search by title returns this id; duration 195 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vy1yhfaj1xa", "vY1yHFAj1XA", "Kurtis Hoppie — WHATCHUDOIN?", 218, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 218 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kuvscdsscdc", "KUvSCdSScDc", "Kurtis Hoppie — Sunflowers", 196, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 196 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-a00d2ucscbq", "a00d2uCScbQ", "Kurtis Hoppie — MASTERPIECE", 205, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 205 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk--6mf14___f4", "-6mf14___F4", "Kurtis Hoppie — Problem Child", 187, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 187 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-qd_-fvij0ok", "qd_-fvIj0Ok", "Kurtis Hoppie — Eye of the Storm", 202, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 202 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-_sxoaezmud0", "_sXOAezMUD0", "Kurtis Hoppie — Icy", 207, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Kurtis Hoppie (the artist's official channel, @TheKurtisHoppie); gate search by title returns this id; duration 207 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-cnkh2invmre", "CnKH2InvmrE", "SYL noiZ — Rain On The Window", 230, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 230 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-n9guwdeemae", "n9GUwDEeMAE", "SYL noiZ — Know You Lord", 160, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 160 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-31jg3lphsbc", "31JG3lPHSbc", "SYL noiZ — 26", 242, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 242 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-eit0l5lo5cy", "eit0L5Lo5CY", "SYL noiZ — Legacy", 224, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader SYL noiZ (the artist's official channel, @sylnoiz); gate search by title returns this id; duration 224 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-i8g4c1hksus", "i8g4C1hkSus", "#HERO — NOT AFRAID", 216, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 216 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-aw3msusu1g0", "aw3msUsu1g0", "#HERO — Sumn", 143, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 143 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-d9ei2xnwl_4", "d9EI2xNWl_4", "#HERO — Repent or Perish", 198, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 198 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-cojtwec8mgq", "COjTwEC8MgQ", "#HERO — Billboard", 223, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-228rtnk_aes", "228RTNk_aEs", "#HERO — In The Name of Jesus", 151, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-yuomnvk0qfy", "yuomnVk0qFY", "#HERO — BIG GOD BIG CHAIN", 248, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 248 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-1_e6ek6q6gs", "1_E6ek6q6Gs", "#HERO — Mercy", 147, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 147 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-yzbdslipsmq", "YzbdSLIpsmQ", "#HERO — Set Apart", 118, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 118 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-372bcws22w4", "372BCWs22w4", "#HERO — Brand New Name", 193, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 193 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-2xckuwayvgq", "2XckUwAyVGQ", "#HERO — Dead Man", 146, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 146 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-od1r2xuacig", "od1r2XuACIg", "#HERO — Wake Up", 156, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 156 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-1kevzbceefi", "1KevZBcEefI", "#HERO — American Church", 182, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 182 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-fpdqgpc1uem", "fPdQGPC1UeM", "#HERO — Praise Yahweh", 223, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-5czla5xkwxw", "5cZla5XkWxw", "#HERO — 1 Way", 202, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader #HERO (the artist's official channel, @Heromusicpage); gate search by title returns this id; duration 202 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-bvcwf4wzab4", "BvCwf4wzAb4", "Nicky Gracious — 1st String", 226, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 226 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk--crses5jcuo", "-CrSes5jcuo", "Nicky Gracious — Everything", 249, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 249 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-tg1yr9ug8ve", "tG1Yr9uG8vE", "Nicky Gracious — Oil Stay Drippin", 258, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 258 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-frcdhrhn5z8", "fRCDHrHn5Z8", "Nicky Gracious — Wack A Mole", 194, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 194 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zfqeujdkhg8", "zFQEujDKhg8", "Nicky Gracious — Open Eyes", 191, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 191 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-mez8tqbmpim", "Mez8TQBMPIM", "Nicky Gracious — Not Here Anymore", 249, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 249 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-exhy5xqoppy", "exHY5XqOPpY", "Nicky Gracious — Get Up", 165, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 165 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-o6mjzerpvdy", "O6mJZerPVdY", "Nicky Gracious — What Type of Time You On?", 223, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 223 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-2xguspc8nqo", "2XGusPC8nQo", "Nicky Gracious — Right Out The Gate", 210, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 210 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-h0cdqtgajz8", "H0CdqTGAJZ8", "Nicky Gracious — STUPID", 274, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 274 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-dhtan777qy4", "DhtAn777qY4", "Nicky Gracious — Sinner Saved", 264, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 264 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zmo8v6p__co", "ZMO8v6P__Co", "Nicky Gracious — If I Died", 320, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nicky Gracious (the artist's official channel, @NickyGraciousMusic); gate search by title returns this id; duration 320 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-n9kv1k7pt38", "n9KV1k7pt38", "Marquese Saenz — Valleys", 396, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 396 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vu5fmglry-i", "VU5FMglrY-I", "Marquese Saenz — Lifting Up Your Name", 253, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 253 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-plr1sh6_eoq", "PLr1sH6_eoQ", "Marquese Saenz — God's Realer", 240, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 240 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gpu3tkme90q", "GpU3TKME90Q", "Marquese Saenz — Send the Rain", 228, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 228 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-j8iybdbdkz4", "J8iYbDbDkZ4", "Marquese Saenz — Cleaning Out My Closet", 350, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 350 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk--bzem7msax8", "-bZEm7MsaX8", "Marquese Saenz — Not About It", 180, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Marquese Saenz (the artist's official channel, @MarqueseSaenz); gate search by title returns this id; duration 180 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-iwyscfxjiwc", "IwySCFXJIwc", "REZUM — Rock Bottom", 194, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 194 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gcpvlvw9yvq", "gcPVLVW9YVQ", "REZUM — Still With Me", 227, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 227 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-nlqkk554m9g", "NLQkK554m9g", "REZUM — Get It Right", 212, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-igkdrxzm2xy", "IGkDrXZm2xY", "REZUM — I'm Sorry", 230, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 230 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-i3jzh2xedj8", "i3jzH2xEDJ8", "REZUM — Going Through The Motions", 181, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-opgzbqswpci", "OPgZBQSWPCI", "REZUM — FREE TONIGHT", 176, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-pyftsn7ysas", "PyFtsN7YSas", "REZUM — Through The Flame", 322, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 322 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-bc3vfmzgjzy", "Bc3VFmzgJzY", "REZUM — Landslide", 170, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 170 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-o82nbgqy4tw", "o82nbGqy4Tw", "REZUM — Bye Bye", 206, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-rp4coof6hgy", "RP4cOof6hgY", "REZUM — He Knows What We Need", 207, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 207 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-flv7d6cs9rc", "Flv7d6cS9rc", "REZUM — Target On My Back", 130, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 130 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-_ot6a0c8z6e", "_OT6a0c8Z6E", "REZUM — Running to God", 231, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-3m2hfm9ksz8", "3m2hfm9ksZ8", "REZUM — Sanity", 185, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader REZUM (the artist's official channel, @REZUM); gate search by title returns this id; duration 185 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-ubuz_5-jtfu", "ubUz_5-JtFU", "Nino Salas — FOUND IN YOUR LOVE", 186, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-_5clafdjtim", "_5ClafdJtIM", "Nino Salas — IM GRATEFUL", 237, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 237 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-7pemsruijss", "7peMsRUijSs", "Nino Salas — Blame Game", 176, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 176 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-kmcazmkeo88", "KMcaZMKeO88", "Nino Salas — REMEMBER ME", 172, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 172 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-e5axizhiqvw", "e5axizhiQvw", "Nino Salas — PAPER", 144, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 144 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-w8u6reglan0", "w8u6ReGlaN0", "Nino Salas — Pain", 185, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 185 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vh4wz_aklka", "vH4wz_aklkA", "Nino Salas — FIND MY WAY", 201, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 201 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-evf05ypveaa", "evF05yPveaA", "Nino Salas — STILL FREE", 168, "gospel", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Nino Salas (the artist's official channel, @Ninosalas_1); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-sfhdwpec8wc", "sfHdWpEC8wc", "Jae Deen — Ramadan Fiesta", 209, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 209 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-qxfurc_zdqy", "qXFURc_ZDQY", "Jae Deen — MASHALLAH", 221, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-uvziq5w9wv4", "uvziq5W9WV4", "Jae Deen — WAX WALBA", 217, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 217 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-h7jzvzzn1ha", "h7JZVZZn1HA", "Jae Deen — SOO SOCO", 136, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 136 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-dzmarqob2f4", "dzMarqob2F4", "Jae Deen — HAYE HAYE", 151, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 151 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-torsfknoqwy", "TORSFKNOqwY", "Jae Deen — KAALAY YA XABIBTI", 203, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Jae Deen (the artist's official channel, @JaeDeenOfficial); gate search by title returns this id; duration 203 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-w0tey-rybsw", "W0teY-RYBsw", "Karter Zaher — WE WON'T FORGET", 186, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-wlsyvutmczk", "wLSYvUTMcZk", "Karter Zaher — PALESTINE WILL BE", 154, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 154 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-6nqp7tprrfi", "6NQp7TpRRfI", "Karter Zaher — MUZZY SAUCE", 218, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 218 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-uioks9_6rvk", "uiOkS9_6RVk", "Karter Zaher — THATS HARAM", 156, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 156 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vkojlkpgj60", "vkojlkPgJ60", "Karter Zaher — Mecca Money", 147, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 147 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vts5gisw73m", "vtS5GIsW73M", "Karter Zaher — Beirut", 211, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-xwkui_3uo3i", "XwkUI_3UO3I", "Karter Zaher — Say MashAllah", 174, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 174 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-fczi86wejj4", "FCZi86WEJj4", "Karter Zaher — You Can Be Awesome", 212, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 212 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-y-vvcbioo-k", "Y-VVcBIoo-k", "Karter Zaher — WHAT ARE YOUR INTENTIONS?", 234, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 234 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-9ptk6mkdxkw", "9ptk6mKDXKw", "Karter Zaher — Who You Are", 148, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 148 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-unerdm9cwr8", "uNerdm9Cwr8", "Karter Zaher — Hijabi Queen", 277, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 277 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-byyfikvxraq", "bYyfikVXraQ", "Karter Zaher — Convert for me", 262, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Karter Zaher (the artist's official channel, @OfficialKarterZaher); gate search by title returns this id; duration 262 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-4pvizmgsuts", "4PvizmgSUts", "KHXLED — Selfish Love", 183, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 183 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-rljriwbsbyg", "rLJRIWBSBYg", "KHXLED — ONLY2U", 206, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 206 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk--h_qg1pmcgi", "-h_qG1PmCgI", "KHXLED — DEAR BELOVED SON", 177, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 177 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-pfz9k2zb8po", "pFz9k2zB8po", "KHXLED — FREEDOM", 169, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 169 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-memasgjn2hm", "mEmAsgJN2hM", "KHXLED — HOMECOMING", 109, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 109 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zgu5o2wukgs", "zgu5o2WUKgs", "KHXLED — NO WHITE GOD", 121, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 121 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-u6ghuwezjww", "u6GHUwEzJww", "KHXLED — GOD FORBID", 125, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader KHXLED (the artist's official channel, @IAMKHXLED); gate search by title returns this id; duration 125 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-rnyjh1txre8", "RnYjH1tXRE8", "Waheeb Nasan — Ceasefire", 221, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 221 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-4cap6u8xdly", "4caP6u8xdlY", "Waheeb Nasan — A Free Palestine", 200, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 200 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-jqc72i6acyw", "jqC72i6ACyw", "Waheeb Nasan — Is It Wrong", 231, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 231 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-pfoeri_tc-o", "PFOeri_TC-o", "Waheeb Nasan — Crickets", 145, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 145 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-cp8hqaa4bqk", "cp8Hqaa4bQk", "Waheeb Nasan — Touchdown Palestine", 193, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 193 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-bfk2bpm7kmq", "bfK2bpM7KMQ", "Waheeb Nasan — My Village", 211, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-xjayvg2ffga", "XjayVG2FFGA", "Waheeb Nasan — Tawel Balek", 251, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 251 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-5-xzev9ufye", "5-XzEv9UfyE", "Waheeb Nasan — Enough", 143, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 143 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-yy3g9hk5iw8", "YY3g9HK5IW8", "Waheeb Nasan — I'm So Elite", 203, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 203 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-tnvryq2-1do", "TnvRyQ2-1Do", "Waheeb Nasan — Backseat", 240, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 240 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-slmrv06npgm", "SlmRV06NPGM", "Waheeb Nasan — The Farthest Mosque", 181, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Waheeb Nasan (the artist's official channel, @WaheebNasan); gate search by title returns this id; duration 181 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-jz4lpocyqck", "jZ4LpOcyqCk", "Lil Baliil — Royal", 177, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 177 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-o6jmfiytzlq", "O6JMfIYtzlQ", "Lil Baliil — Bad Gal", 207, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 207 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-zqv68ykblpo", "ZQV68YKbLpo", "Lil Baliil — ONE MORE NIGHT", 175, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 175 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-j4q23bwtams", "J4q23BwTaMs", "Lil Baliil — Kista", 168, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 168 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-cqsppeuzno8", "CqSpPEUznO8", "Lil Baliil — LAST SONG", 186, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 186 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-65iyuojtwo8", "65IYuoJTWo8", "Lil Baliil — THE BAG", 220, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 220 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-gys0fulojsi", "GYS0fuloJSI", "Lil Baliil — QURUXDIYO QOF AH", 211, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 211 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-vrdfzjiqivo", "VRDFZjiqiVo", "Lil Baliil — HAIWEEYDIIN", 171, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 171 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    Y("brk-5q4iiubiplg", "5Q4IiUbipLg", "Lil Baliil — IF", 205, "faith", "Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at pool build time (2026-11-05): embeddable, uploader Lil Baliil (the artist's official channel, @LilBaliilofficial); gate search by title returns this id; duration 205 pinned from the actual upload via the channel grid and the embed-gate relay in exact agreement (build record: website/collaborators-tv-2026-11-05/PROGRESS.md)"),
    // Islamic shorts (v16 — Malik, 2026-11-05 ~18:00 ET: "i want
    // random islamic shorts to play randomly"): 25 verified
    // shorts from official channels only (Mufti Menk x8, Yaqeen
    // Institute x7, Bayyinah x6, Deen Squad x4) join the bag in
    // the new "shorts" lane — break interludes only, never
    // program items, never in the cycle seed. The bag never deals
    // two shorts back-to-back (tvDrawBreak), and the 4 Deen Squad
    // behind-the-scenes clips are sparse: true — Malik, 2026-11-05
    // ~19:31 ET: they play "sometimes" — so they deal into only
    // every third bag.
    YS("brk-amy3o06gylw", "aMY3O06GYlw", "Mufti Menk — No Excuse For Salah", 88, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 88s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-_nll7uwkq4y", "_NLL7uwkQ4Y", "Mufti Menk — The Right Time For Tahajjud", 85, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 85s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-xlfjgaf9-mi", "xLFjgaF9-mI", "Mufti Menk — 1 Outweighed 99", 84, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 84s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-gltvkus5hey", "gltvKUs5hEY", "Mufti Menk — We Only Cry When Desperate", 86, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 86s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-9am8stmow5k", "9AM8stMOw5k", "Mufti Menk — Control Your Tongue!", 44, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 44s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-hkrq0de-gto", "HKRq0DE-GTo", "Mufti Menk — Just Don't Get Angry", 60, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 60s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-ssrro74bwgm", "SSRRo74BwGM", "Mufti Menk — Ask Allah To Soften Hearts", 78, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 78s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-mht_hiayqqo", "mHt_HiAYQqo", "Mufti Menk — What Islam Really Teaches", 48, false, "Verified Islamic short on the official channel (Mufti Menk, @muftimenkofficial): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); duration 48s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-ezthsni6k_0", "ezThSnI6K_0", "Yaqeen Institute — Would You Cheat Your Sibling? (Dr. Omar Suleiman)", 36, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 36s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-xwrpvuvjk_g", "xWRPVuVJk_g", "Yaqeen Institute — What Would You Regret On Your Last Day? (Dr. Omar Suleiman)", 60, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 60s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-c75mxhxvvgu", "C75mxHXvvGU", "Yaqeen Institute — Does Your Shaytan Have Hope In You? (Dr. Omar Suleiman)", 56, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 56s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-zetmuqiic2u", "ZEtMUqIic2U", "Yaqeen Institute — When Parents Aren't The Priority Anymore (Dr. Omar Suleiman)", 37, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 37s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-uinxl4jxjk4", "uINXL4JxJK4", "Yaqeen Institute — Umar (RA) Was Offered to Pray in a Church (Dr. Omar Suleiman)", 106, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 106s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-3hrec0raxgi", "3Hrec0RaxGI", "Yaqeen Institute — A Message About Al-Aqsa You Need to Hear (Dr. Omar Suleiman)", 158, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 158s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk--6cmwxozvz4", "-6CmWXoZvz4", "Yaqeen Institute — Why Your Dua Isn't Being Answered (Sh. Mohammad Elshinawy)", 30, false, "Verified Islamic short on the official channel (Yaqeen Institute, @yaqeeninstituteofficial): YouTube oEmbed HTTP 200 with author 'Yaqeen Institute' at research time (2026-11-05); duration 30s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-xtwxak2qai0", "XTWxaK2QAi0", "Bayyinah — When You Stop Hearing the Truth (Nouman Ali Khan)", 105, false, "Verified Islamic short on the official channel (Bayyinah, @bayyinah): YouTube oEmbed HTTP 200 with author 'Nouman Ali Khan - Official - Bayyinah' at research time (2026-11-05); duration 105s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-axn1ojh4y2m", "AXn1OJH4y2M", "Bayyinah — Our Limits Point Back to Allah (Nouman Ali Khan)", 178, false, "Verified Islamic short on the official channel (Bayyinah, @bayyinah): YouTube oEmbed HTTP 200 with author 'Nouman Ali Khan - Official - Bayyinah' at research time (2026-11-05); duration 178s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-xu_15cvuee4", "xU_15CVuEE4", "Bayyinah — Allah Is Already Near You (Nouman Ali Khan)", 154, false, "Verified Islamic short on the official channel (Bayyinah, @bayyinah): YouTube oEmbed HTTP 200 with author 'Nouman Ali Khan - Official - Bayyinah' at research time (2026-11-05); duration 154s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-py4bnqjifu4", "pY4bnQJIFu4", "Bayyinah — How To Make Kids Love The Masjid (Nouman Ali Khan)", 72, false, "Verified Islamic short on the official channel (Bayyinah, @bayyinah): YouTube oEmbed HTTP 200 with author 'Nouman Ali Khan - Official - Bayyinah' at research time (2026-11-05); duration 72s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-ppzopfy5xps", "PpZOPFY5XPs", "Bayyinah — Gratitude: This is Allah's Promise (Nouman Ali Khan)", 69, false, "Verified Islamic short on the official channel (Bayyinah, @bayyinah): YouTube oEmbed HTTP 200 with author 'Nouman Ali Khan - Official - Bayyinah' at research time (2026-11-05); duration 69s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-hsonht8gjym", "hSONHt8gJYM", "Bayyinah — How Do I Raise My Muslim Kids In The West? (Nouman Ali Khan)", 90, false, "Verified Islamic short on the official channel (Bayyinah, @bayyinah): YouTube oEmbed HTTP 200 with author 'Nouman Ali Khan - Official - Bayyinah' at research time (2026-11-05); duration 90s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-objqr-a5h54", "OBjqR-A5H54", "Deen Squad — Everybody Say Muslim (Short)", 25, true, "Verified Islamic short on the official channel (Deen Squad, @deensquadmusic): YouTube oEmbed HTTP 200 with author 'Deen Squad' at research time (2026-11-05); duration 25s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-hwncv9ljuqq", "HWNcV9LJUQQ", "Deen Squad — Karter on the Comeback (Short)", 29, true, "Verified Islamic short on the official channel (Deen Squad, @deensquadmusic): YouTube oEmbed HTTP 200 with author 'Deen Squad' at research time (2026-11-05); duration 29s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-3bh-psudc3a", "3bH-PSUDc3A", "Deen Squad — Cooking (Short)", 16, true, "Verified Islamic short on the official channel (Deen Squad, @deensquadmusic): YouTube oEmbed HTTP 200 with author 'Deen Squad' at research time (2026-11-05); duration 16s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    YS("brk-bn8omhsmlsq", "bn8OMhSMLSQ", "Deen Squad — Halal Lovin Live in Ohio (Short)", 11, true, "Verified Islamic short on the official channel (Deen Squad, @deensquadmusic): YouTube oEmbed HTTP 200 with author 'Deen Squad' at research time (2026-11-05); duration 11s read from the video's own Shorts page; vertical 9:16 short-form — airs pillarboxed as a brief break interlude, never a program item (research record: website/islamic-programming-2026-11-05/SHORTS.md)"),
    { id: "brk-house-anthem", kind: "house", src: "file", url: "/media/the-world-gone-be.mp4", title: "Meechie's World — The World Gone Be", dur: 266, lane: "house", rights: { basis: "own", evidence: "Malik's own song and video, hosted on his own site media (/media/the-world-gone-be.mp4, HTTP 200 video/mp4 verified at seed time); he is the artist and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-ad", kind: "house", src: "file", url: "/media/my-empire-commercial.mp4", title: "MY EMPIRE — Premiere Commercial", dur: 42, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE, his business and himself, hosted on his own site media (/media/my-empire-commercial.mp4, HTTP 200 video/mp4 verified at seed time); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-by10", kind: "house", src: "file", url: "/media/my-empire-by10.mp4", title: "MY EMPIRE — Done by 10 Tonight", dur: 15, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE, hosted on his own site media (/media/my-empire-by10.mp4, HTTP 200 video/mp4 verified at seed time); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-8oclock", kind: "house", src: "file", url: "/media/my-empire-8oclock.mp4", title: "MY EMPIRE — Every Day at 8, Rerun at 10", dur: 15, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE, hosted on his own site media (/media/my-empire-8oclock.mp4, HTTP 200 video/mp4 verified at seed time); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-v2", kind: "house", src: "file", url: "/media/my-empire-commercial-v2.mp4", title: "MY EMPIRE — The Don (Show Commercial)", dur: 42, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (v2 — his character on camera, the premieres-at-8 announcement), hosted on his own site media (/media/my-empire-commercial-v2.mp4); he is the creator and rights holder. Joins the pool under his 2026-11-03 order to play the show commercials in random rotation on MW TV and radio", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-shop", kind: "house", src: "file", url: "/media/my-empire-shop-station-family.mp4", title: "MY EMPIRE — The Shop, The Station, The Family", dur: 10, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (the shop-opened, station-signed-on, family line), supplied by Malik on 2026-11-03 for the random show-spot rotation and hosted on his own site media (/media/my-empire-shop-station-family.mp4); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-family", kind: "house", src: "file", url: "/media/my-empire-family-foundation.mp4", title: "MY EMPIRE — Family Is the Foundation", dur: 10, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (the family-is-the-foundation line), supplied by Malik on 2026-11-03 for the random show-spot rotation and hosted on his own site media (/media/my-empire-family-foundation.mp4); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-12", kind: "house", src: "file", url: "/media/my-empire-12-shirts.mp4", title: "MY EMPIRE — 12 Shirts, Zero Excuses", dur: 10, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (the 12-shirts, zero-excuses line), supplied by Malik on 2026-11-03 for the random show-spot rotation and hosted on his own site media (/media/my-empire-12-shirts.mp4); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-spot-trump-grillz", kind: "house", src: "file", url: "/media/spot-trump-grillz.mp4", title: "Trump — Grillz (Commercial)", dur: 11.3, lane: "house", rights: { basis: "own", evidence: "Commercial clip supplied by Malik on 2026-11-06 for the MW TV commercial rotation on his own channel (his order: 'Play this randomly every other hour on mwtv as a comercials'), hosted on his own site media (/media/spot-trump-grillz.mp4, 1,718,494 B, md5 7ee5c66d778d6476c14dba96ae5b02df, measured 11.266667 s, pin 11.3 on the keeper's 0.1 s grid); he is the supplier and rights holder for airing", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-spot-trump-president", kind: "house", src: "file", url: "/media/spot-trump-president.mp4", title: "Trump — Still Your President (Commercial)", dur: 52.3, lane: "house", rights: { basis: "own", evidence: "Commercial clip supplied by Malik on 2026-11-06 for the MW TV commercial rotation on his own channel (sent in the same breath as his order: 'Play this randomly every other hour on mwtv as a comercials'), hosted on his own site media (/media/spot-trump-president.mp4, 6,602,991 B, md5 55bf4f13b5078527f186a13680ee6335, measured 52.335104 s, pin 52.3 on the keeper's 0.1 s grid); he is the supplier and rights holder for airing", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-spot-bandz", kind: "house", src: "file", url: "/media/spot-bandz.mp4", title: "BANDZ (Commercial)", dur: 36.5, lane: "house", rights: { basis: "own", evidence: "Commercial clip supplied by Malik on 2026-11-06 for the MW TV commercial rotation on his own channel (sent in the same breath as his order: 'Play this randomly every other hour on mwtv as a comercials'), hosted on his own site media (/media/spot-bandz.mp4, 6,047,660 B, md5 f6e7b58c5748df0ecbbfe29c51e20e25, measured 36.466667 s, pin 36.5 on the keeper's 0.1 s grid); he is the supplier and rights holder for airing", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-local-update", kind: "house", src: "file", url: "/m/media/local-update.mp4", title: "Uniontown Local Update — News & Traffic", dur: 51, lane: "house", rights: { basis: "own", evidence: "Produced in-house by the site news producer from attributed public sources (Herald-Standard headlines, PennDOT 511PA traffic, NWS alerts); Malik is the publisher and rights holder of the produced spot", clearedBy: "owner", at: now, simulcast: true } }
  ];
  const bag = items.filter((x) => !(x.lane === "shorts" && x.sparse === true)).map((x) => x.id); // v16: sparse shorts never ride the seed bag either — they deal in only on the tvDrawBreak bag cycle
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
  return { items, bag, bagIx: 0, progV: TV_PROGRAM_V, updatedAt: now, by: "keeper-seed" };
}
function tvSeedPremiere(now) {
  const R = (evidence) => ({ basis: "own", evidence, clearedBy: "owner", at: now, simulcast: true });
  // MY EMPIRE premiere slot (owner order 2026-11-02): every day at
  // 20:00 ET. Items chain in order inside the slot. A file item airs
  // only once the file actually exists on site media (tvPremLive
  // probes it): a missing file means the slot silently skips and the
  // music cycle plays through, so the slot can never be dead air
  // before the uploads land.
  return { on: true, startMinET: 1200, progV: TV_PREM_V, items: [
    { id: "me-episode", kind: "show", src: "file", url: "/media/my-empire-ep1.mp4", title: "Episode 1 — Premiere Night", show: "MY EMPIRE", dur: 900, rights: R("Malik own show: his life, his music, his businesses; he is the creator and rights holder. Episode file lands on his own site media.") },
    { id: "me-teaser", kind: "show", src: "file", url: "/media/my-empire-teaser.mp4", title: "First Look — Official Teaser", show: "MY EMPIRE", dur: 210, rights: R("Malik own show teaser, cut from his own episode footage at his request (2026-11-02).") }
  ], updatedAt: now, by: "keeper-seed" };
}
function tvSeedRerun(now) {
  const R = (evidence) => ({ basis: "own", evidence, clearedBy: "owner", at: now, simulcast: true });
  // MY EMPIRE 10 PM rerun slot (owner order 2026-11-02 ~22:05 ET:
  // a new episode premieres every day at 8 PM and reruns at
  // 10 PM): the mirror of tvSeedPremiere at 22:00 ET, carrying the
  // same items by default — the day's episode, then the teaser.
  // Same probe gate as the premiere (tvPremLive, its own probe
  // cache): a file item airs only once the file actually exists on
  // site media, so on a night when the episode has not landed the
  // slot stays dark and the evening programs normally — the slot
  // can never be dead air.
  return { on: true, startMinET: 1320, progV: TV_RERUN_V, items: [
    { id: "me-episode", kind: "show", src: "file", url: "/media/my-empire-ep1.mp4", title: "Episode 1 — 10 PM Rerun", show: "MY EMPIRE", dur: 900, rights: R("Malik own show: his life, his music, his businesses; he is the creator and rights holder. Episode file lands on his own site media.") },
    { id: "me-teaser", kind: "show", src: "file", url: "/media/my-empire-teaser.mp4", title: "First Look — Official Teaser", show: "MY EMPIRE", dur: 210, rights: R("Malik own show teaser, cut from his own episode footage at his request (2026-11-02).") }
  ], updatedAt: now, by: "keeper-seed" };
}
function tvSeedMovieBlock(now) {
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  // MW Movie Night — REMOVED (the B build, 2026-11-06; Malik's
  // orders 2026-11-06 12:29 + 12:39 ET: "Sugar Daddy Killer isnt
  // suposed to be on" — and scope B: his shows + the Muslim content
  // take over everything in between, the scheduled blocks stay on
  // their times, movies + the outside shuffle come out). All 46
  // Movie Night titles are out of this seed — Sugar Daddy Killer
  // (yt 7Mr0VALZ4K4) struck by name first; PR #704's single-title
  // strike is superseded by this build. The chain itself has stood
  // down as fill since v14 (tvMovieState returns null under
  // TV_FILL_ONLY); the bump to TV_MOVIE_V 5 makes the stored
  // tv/movieblock doc re-seed to this emptied pool on the keeper's
  // first pass after the merge — no D1 access needed. The removed
  // pool's provenance (the 2026-11-03 sweep's verified titles, and
  // the 19 titles held unpinned under the duration law) lives in
  // git history for this function and in
  // mwtv-newpool-2026-11-03/REPORT.md.
  // ONE item stayed — mov-giving-thanks — held only as a Family
  // Time eligibility source (never a movie: the chain stands
  // down), until Malik struck it too (2026-11-06 20:32 EST:
  // "Take it out"): a watcher deep seat found the 8 PM Family
  // Time block airing Giving Thanks (yt 8-ngS-WjqJw) and reported
  // what a viewer sees — an adult drama (profanity, sexual
  // innuendo, a choking scene) in the younger-teens block. The
  // seed now carries NO items; Family Time runs on Johnny Test
  // alone (show-johnny-test in tvSeedChannel), and the
  // TV_MOVIE_V 6 bump re-seeds the stored tv/movieblock doc to
  // this empty pool on the keeper's first pass after the merge.
  const MV = (id, yt, title, dur, evidence) => ({ id, kind: "show", src: "yt", yt, title, show: "MW Movie Night", dur, rights: R(evidence) });
  return { on: true, progV: TV_MOVIE_V, items: [], updatedAt: now, by: "keeper-seed" };
}
function tvSeedInsert(now) {
  // One-shot owner-ordered insert, v3: TONIGHT'S Comedy Hour
  // (Tue 2026-11-03). Malik's standing orders: the 7 PM hour is the
  // Comedy Hour, and for Tue Nov 3 it plays Thanksgiving movies under
  // the official-embed rights rule. Of the three Thanksgiving titles
  // that exist on the official-free side (NEWEST-MOVIES.md), Giving
  // Thanks (2023, Maverick Movies) is the newest and the only one
  // whose duration could be pinned from the actual upload, so it
  // carries the hour alone; the other two are held, never guessed
  // (schedule record: mwtv-channel/SCHEDULE.md). The order carries an
  // explicit startAt — tonight 19:00 ET — and a hard endBy exactly at
  // the feature's end, so the firing rule (the block must be able to
  // finish before endBy) passes. The recurring nightly Comedy Hour
  // window is a separate staged build; this seed is tonight only.
  // The feature passed the channel gates at build time (2026-11-03):
  // YouTube oEmbed HTTP 200 with the author being the distributor's
  // own channel (Maverick Movies), and the duration pinned from the
  // actual upload via the site embed gate (/api/ytsearch, id-matched).
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  const PK = (id, yt, title, dur, evidence) => ({ id, kind: "show", src: "yt", yt, title, show: "MW Comedy Hour", dur, rights: R(evidence) });
  const et = tvEtParts(now), sec = Math.floor((now % 60000) / 1000);
  const mins = et.hour * 60 + et.minute;
  const startAt = now - ((mins - 1140) * 60 + sec) * 1000; // today 19:00 ET (whole-hour ET offset arithmetic, as tvPremWin)
  const total = 4233;
  return { progV: TV_INSERT_V, at: now, show: "MW Comedy Hour", startAt, endBy: startAt + total * 1000, items: [
    PK("thx-giving-thanks", "8-ngS-WjqJw", "Giving Thanks — Thanksgiving Movie Night", total, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200, author Maverick Movies) at research time (2026-11-02, NEWEST-MOVIES.md) and re-verified 2026-11-03; duration 4233s pinned from the actual upload via the site embed-gate relay (2026-11-03)")
  ], updatedAt: now, by: "keeper-seed" };
}
/* The insert doc as a lineup: v2 docs carry an items array (a
 * short playlist); v1 docs carry one item's fields at the top
 * level. Every item is gated by the same rights rule as every
 * other item on the channel (tvCleared); an item whose record is
 * incomplete drops out, and when nothing clears the insert never
 * airs. Returns null when the doc is missing or already consumed. */
function tvInsertItems(doc) {
  if (!doc || doc.consumedAt) return null;
  let items = null;
  if (Array.isArray(doc.items) && doc.items.length) items = doc.items.filter(tvCleared);
  else {
    const it = { id: "insert-movie", kind: "show", src: doc.kind === "file" ? "file" : "yt", yt: doc.yt || "", url: doc.url || "", iaId: "", title: doc.title || "", show: doc.show || "MW Movie Night", dur: +doc.dur || 0, rights: { basis: doc.basis || "", evidence: doc.evidence || "", clearedBy: "owner", at: +doc.at || 0, simulcast: false } };
    items = tvCleared(it) ? [it] : [];
  }
  if (!items.length) return null;
  return { items, total: items.reduce((a, x) => a + (+x.dur || 0), 0) };
}
/* How much of an insert window actually FREEZES the movie block:
 * the window's full span, minus the spans the precedence windows
 * (news, premiere, anchor, rerun) covered inside it — those pass over
 * the movie by the channel's standing doctrine, so the movie's
 * position kept advancing through them even while the insert
 * owned the screen everywhere else. */
function tvInsertFrozen(ins, chan) {
  if (!ins || !(ins.dur > 0)) return 0;
  const i0 = ins.start, i1 = ins.start + ins.dur * 1000;
  let froz = ins.dur;
  let nw0 = tvNewsWin(i0);
  for (let ws = nw0.start; ws < i1; ws += 3600e3) { const o = Math.min(i1, ws + TV_NEWS_LEN * 1000) - Math.max(i0, ws); if (o > 0) froz -= o / 1000; }
  const pw = tvPremWin(i0, chan._prem); if (pw && pw.start < i1 && pw.end > i0) froz -= (Math.min(i1, pw.end) - Math.max(i0, pw.start)) / 1000;
  const aw = tvAnchorWin(i0, chan._anchor); if (aw && aw.start < i1 && aw.end > i0) froz -= (Math.min(i1, aw.end) - Math.max(i0, aw.start)) / 1000;
  const rw = tvPremWin(i0, chan._rerun); if (rw && rw.start < i1 && rw.end > i0) froz -= (Math.min(i1, rw.end) - Math.max(i0, rw.start)) / 1000;
  return Math.max(0, Math.round(froz * 10) / 10);
}
/* ---------------------------------------------------------------
 * HOURLY CARTOON LIVE (the media gate): the episodes count as
 * live only when ALL TEN files actually exist on the site —
 * probed here with the premiere's cached verdicts (tv/now
 * cartoonProbe), so a slow upload can never lay a dead segment;
 * the slot simply joins by itself the first tick all ten files
 * are really there. (Since v2 the gate covers Episode 2's parts
 * too: until they land, the whole slot — Episode 1 included —
 * stays dark, exactly the gate discipline Malik's order was
 * built under — v4 extends it to the Squishy Saga pair, so the
 * v4 code must not go live before both Squishy files are on
 * the site (media first, code second — the v2 precedent) —
 * v5 extends it to the Episode 3 and 4 pairs, so the v5 code
 * must not go live before all four new files are on the site
 * (the same media-first rule); the
 * in-slot commercials need no probe here, the
 * tick's spot gate already holds a spot whose file is missing
 * out of the pool tvCartoonSpots resolves from.) */
async function tvCartoonLive(env, nw, now, origin) {
  const cache = { ...((nw && nw.cartoonProbe) || {}) };
  let cacheChanged = false;
  const items = tvCartoonItems(now);
  let all = true;
  for (const it of items) {
    const c = cache[it.url];
    if (c && now - c.at < TV_PREM_PROBE_MS) { if (!c.ok) all = false; continue; }
    const ok = await tvMediaExists(env, origin, it.url);
    cache[it.url] = { ok, at: now }; cacheChanged = true;
    if (!ok) all = false;
  }
  const live = all ? items.filter(tvCleared) : [];
  const crt = live.length === items.length ? { items: live, total: live.reduce((a, x) => a + (+x.dur || 0), 0) } : null;
  return { crt, cache, cacheChanged };
}
/* The cartoon spans in [fromMs, toMs): one candidate per clock-
 * hour boundary B. due(B) is the end of B's :50 news window (B
 * itself) when that window is laid under the same v11 gates tvGen
 * applies — fresh edition, no Family Time overlap, not owner-cut —
 * so the pair starts the moment the news segment ends; when no
 * news segment is laid for the window, due(B) is :55 of the hour
 * behind it, and tvGen cuts the chain at the span start, so the
 * pair takes the first lay point from there. The fire time then
 * slides forward past every hard window the pair would overlap (a
 * laid news window, the premiere, the rerun, Family Time, an
 * anchor edition, the one-shot insert — Comedy Hour rides it): the
 * pair NEVER cuts or interrupts a segment, never displaces the
 * news window itself and never starts inside Family Time — when a
 * hard block spans the slot, the pair waits and plays immediately
 * after the block ends. A slot whose fire time slides to/past
 * B + 1 h is dropped for that hour (it never fires an hour late),
 * and a slot is dropped when the pair would start within ten
 * minutes of the previous pair's end (never stacked back-to-back
 * around a long block). A span already laid (tv/now crtWin pins,
 * { start, hour }) is authoritative: its start never moves if a
 * late edition flips the news gate mid-hour, and the pins — with
 * the timeline cursor — are what make re-runs lay each hour's pair
 * exactly once. A span the owner (or the Guardian, through the
 * shared advancer) cut is suppressed by qCut exactly like the
 * premiere's: the wall-clock span never resumes.
 * v2 (Episode 2 + commercials): a span's length is its hour's
 * FULL sequence total (tvCartoonSeqTotal — both episodes plus
 * the hour's two show spots), a pure function of the hour, so
 * the slide past hard windows, the stacking guard and a pinned
 * span's end all read the same total tvGen chains by; every v1
 * placement rule above is unchanged, only the payload grew.
 * v3 (2026-11-05 sequence fix): a pin is authoritative only
 * while the block can still play AS A UNIT from the pinned
 * start. The 12:00 failure: the hour-12 span was pinned at
 * 11:55 while the 11:50 window's edition was not yet fresh
 * (fire = B - 300e3, the pair laid from 11:55); when the fresh
 * edition landed (produced 11:54:07), the next tick laid the
 * news segment 11:55-12:00 over the span's head — and tvGen,
 * entering the pinned span at wall-clock offset 300 s, landed
 * 0.7 s into Part 2 (laid 292.1 of 292.8 s): Episode 1 Part 1
 * never aired. A block never amputates: when a hard window
 * laid this tick overlaps the pinned span, the span re-slides
 * as a unit past the window (the same slide loop) and the full
 * sequence plays from the new start; if it no longer fits the
 * hour it drops under the normal guards, like any other span. */
function tvCartoonSpans(chan, crt, fromMs, toMs, pins) {
  if (!crt || !Array.isArray(crt.items) || !(crt.total > 0)) return [];
  const laidAt = (ws) => !(chan._qCut && chan._qCut.news === ws) && tvNewsFreshFor(chan, ws) && !tvNewsOverlapsFamily({ start: ws, end: ws + TV_NEWS_LEN * 1000 }, chan._family) && !tvNewsOverlapsKhutbah({ start: ws, end: ws + TV_NEWS_LEN * 1000 }, chan._khutbah);
  const out = [];
  let lastEnd = -Infinity;
  const b0 = Math.floor((fromMs - 3600e3) / 3600e3) * 3600e3;
  for (let B = b0; B < toMs + 3600e3; B += 3600e3) {
    const totalMs = tvCartoonSeqTotal(crt, B) * 1000;
    // Slide a candidate start forward past every hard window the
    // block would overlap (the v1 placement rule, factored out so
    // the pinned-start validation below runs the identical loop).
    const slideFrom = (f0) => {
      let f = f0;
      for (let i = 0; i < 10; i++) {
        const e = f + totalMs;
        let push = 0;
        const consider = (w, blocks) => { if (blocks && w && f < w.end && e > w.start && w.end > push) push = w.end; };
        const nw1 = tvNewsWin(f);
        for (let k = 0; k < 2; k++) { const ws = nw1.start + k * 3600e3; consider({ start: ws, end: ws + TV_NEWS_LEN * 1000 }, laidAt(ws)); }
        consider(tvPremWin(f, chan._prem), true);
        consider(tvPremWin(f, chan._rerun), true);
        consider(tvFamilyWin(f, chan._family), true);
        consider(tvAnchorWin(f, chan._anchor), true);
        consider(tvInsertWin(f, chan._insert), true);
        consider(tvKhutbahWin(f, chan._khutbah), true);
        consider(tvComedyWin(f, chan._comedy), true);
        if (!(push > f)) break;
        f = push;
      }
      return f;
    };
    let fire = slideFrom(laidAt(B - TV_NEWS_LEN * 1000) ? B : B - 300e3);
    const pin = (Array.isArray(pins) ? pins : []).find((p) => p && +p.hour === B && +p.start > 0);
    let pinned = false;
    if (pin) {
      // v3: the pin holds only if the block still plays as a unit
      // from it. Re-slide the pinned start past any hard window
      // laid since the pin was written; a start that moves was
      // covered, so the span continues as an ordinary candidate
      // (the drop/stack guards below decide its fate) — it is
      // never entered mid-sequence.
      fire = slideFrom(+pin.start);
      pinned = fire === +pin.start;
    }
    if (chan._qCut && (chan._qCut.cartoon === fire || (pin && chan._qCut.cartoon === +pin.start))) continue;
    if (!pinned) {
      if (fire >= B + 3600e3) continue;
      if (fire < lastEnd + 600e3) continue;
    }
    out.push({ start: fire, end: fire + totalMs, hour: B });
    lastEnd = Math.max(lastEnd, fire + totalMs);
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter((sp) => sp.end > fromMs && sp.start < toMs);
}
/* The cartoon window containing ms, or the next one — same shape
 * as tvInsertWin's answer ({ start, end, inside }). */
function tvCartoonWinAt(ms, crt) {
  if (!crt || !Array.isArray(crt.spans)) return null;
  for (const sp of crt.spans) {
    if (ms >= sp.start && ms < sp.end) return { start: sp.start, end: sp.end, inside: true };
    if (sp.start > ms) return { start: sp.start, end: sp.end, inside: false };
  }
  return null;
}
/* A re-lay cut (tvCharCut — the character-stamp cut and the
 * cadence-chain relay cut in tvTick) must never land INSIDE a
 * cartoon span. The block is a unit, but the cuts are blind to
 * it: on 2026-11-05 the relay-grid cut at 12:05 split the 12:00
 * block's in-slot spot into two back-to-back segments of the
 * same commercial (7.9 s + 7.1 s), and the cut at 12:15 trimmed
 * Episode 2 Part 2 at the grid mark — after which generation,
 * re-entering the span by wall-clock offset, re-laid its 9.7 s
 * tail as a resume stub even though the episode had already
 * been laid to completion. A cut that would land inside a span
 * moves to the span's end instead: the block's laid segments
 * stand untouched and the re-lay happens after the block. (If
 * the span's end is at/past the generation cursor the cut is a
 * no-op in tvCharCut anyway — generation has not reached the
 * span's end yet and lays past it with the new state.) */
function tvCartoonCutGuard(spans, cutAt) {
  if (!Array.isArray(spans) || !isFinite(cutAt)) return cutAt;
  for (const sp of spans) { if (sp && cutAt > sp.start && cutAt < sp.end) return sp.end; }
  return cutAt;
}
/* MW TV OWNER QUEUE + SKIP (Malik, 2026-11-03 19:09 ET: "Make it so
 * i can skip the movies on mw tv and que a list and if nothings qued
 * you pick stuff"). The owner builds a list — tv/queue, written
 * only by /api/tv/queue behind the owner gate — and the keeper
 * plays it as one more standing window on the channel. Playback
 * precedence, stated once and enforced in tvGen: the piece on air
 * finishes (or the owner skips) → QUEUE items in order → the
 * channel's own picks (cycle / movie block), exactly as before.
 * The HARD schedule still preempts the queue — quarter news
 * windows, the :50 windows, anchor editions, the premiere slot,
 * the 10 PM rerun, one-shot inserts and the ad cadence — and the
 * queue FREEZES across every preemption (tvQueueFrozen): an item
 * is consumed only by the seconds it actually aired, so after a
 * preemption the list resumes where it left off. An empty queue
 * changes nothing at all: the keeper fills from the cleared pool
 * and the lineup exactly as it always has. The queue accepts
 * exactly what the owner insert accepts — the same embed gate,
 * the same evidence line (functions/api/tv/queue.js) — no new
 * sourcing, no scraping, no lineup changes.
 * SKIP: the owner's skip asks ride tv/queue.skipAt; tvTick answers
 * them through tvAdvanceChannel — THE shared channel advancer
 * (the crowd-skip trigger calls the same routine; do not grow a
 * second one). The owner's skip cuts anything on air: where the
 * channel's state carries a cursor (cycle, queue, movie chain,
 * insert) the advance is a real content advance, and where the
 * piece rides a wall-clock window (news, premiere, rerun, anchor,
 * ad cadence) the advancer stamps a one-instance suppression
 * (nw.qCut) so that window's airing ends here while its docs,
 * probes and schedule machinery stay untouched. */
const TV_QUEUE_V = 1;               // owner queue doc generation (tv/queue)
const TV_QUEUE_EVIDENCE = "Owner pick from the MW TV owner search box (owner seat only, functions/api/tv/queue.js); passed the site embed gate at order time: /api/ytsearch age/embed relay (id-matched) plus the brain/ytblock learned-ban check";
function tvQueueItem(raw) {
  if (!raw || !raw.qid) return null;
  return { id: "q-" + raw.qid, qid: String(raw.qid), kind: "show", src: "yt", yt: String(raw.yt || ""), url: "", iaId: "", title: String(raw.title || ""), show: "Owner Queue", dur: +raw.dur || 0, rights: { basis: "embed", evidence: TV_QUEUE_EVIDENCE, clearedBy: "owner", at: +raw.at || 0, simulcast: false } };
}
/* The queue doc as a window state: cleared items in list order
 * and the anchor the window opens at. Items whose record no
 * longer clears drop out here (tvCleared — the channel's rule),
 * so a pick banned after it was queued can never air. */
function tvQueueState(doc) {
  if (!doc || !Array.isArray(doc.items)) return null;
  const items = [];
  for (const raw of doc.items) { const it = tvQueueItem(raw); if (it && tvCleared(it)) items.push(it); }
  if (!items.length) return null;
  const anchor = +doc.anchor || 0;
  if (!(anchor > 0)) return null;
  return { items, anchor, total: items.reduce((a, x) => a + (+x.dur || 0), 0) };
}
/* How much of [fromMs, toMs) the queue does NOT own: the hard
 * windows (news, premiere, rerun, anchor — each walked forward),
 * the one-shot insert span and the ad-cadence spans. The owner's
 * list freezes across all of it: position inside the queue is
 * content time, never wall time. q._st carries the window states
 * (attached in tvTick and again in tvGen, like _movies._cad). */
function tvQueueFrozen(q, fromMs, toMs) {
  if (!q || !(toMs > fromMs)) return 0;
  const st = q._st || {};
  let froz = 0;
  const sub = (a, b) => { const o = Math.min(toMs, b) - Math.max(fromMs, a); if (o > 0) froz += o / 1000; };
  const nw0 = tvNewsWin(fromMs);
  for (let ws = nw0.start; ws < toMs; ws += 3600e3) sub(ws, ws + TV_NEWS_LEN * 1000);
  const walk = (winFn, stt) => { let t2 = fromMs; for (let i = 0; i < 4; i++) { const w = winFn(t2, stt); if (!w || w.start >= toMs) break; sub(w.start, w.end); t2 = w.end; } };
  walk(tvPremWin, st.prem); walk(tvPremWin, st.rerun); walk(tvAnchorWin, st.anchor);
  // The Friday khutbah freezes the queue like every hard window,
  // and the placed adhan spans freeze it for their (exact or
  // slid) spans — the queue is consumed only by seconds it
  // actually aired, so both preempt it losslessly (v16).
  walk(tvKhutbahWin, st.khutbah);
  if (st.adhan && Array.isArray(st.adhan.spans)) for (const sp of st.adhan.spans) sub(sp.start, sp.end);
  // Family Time freezes the queue for its whole span — minus the
  // news windows that pass over it and the cadence time inside it,
  // which the lines above/below already count (the tvInsertFrozen
  // overlap rule: a span counted twice would make the queue
  // replay content it already aired).
  if (st.family) { let t3 = fromMs; for (let i = 0; i < 4; i++) { const w = tvFamilyWin(t3, st.family); if (!w || w.start >= toMs) break; const a = Math.max(fromMs, w.start), b = Math.min(toMs, w.end); if (b > a) { let ov = 0; const nw1 = tvNewsWin(a); for (let ws = nw1.start; ws < b; ws += 3600e3) { const o = Math.min(b, ws + TV_NEWS_LEN * 1000) - Math.max(a, ws); if (o > 0) ov += o / 1000; } if (st.cad) ov += tvAdTimeIn(st.cad, st.prem, st.anchor, st.insert, a, b, st.char, st.lu, st.rerun, st.qtr); froz += Math.max(0, (b - a) / 1000 - ov); } t3 = w.end; } }
  // Comedy Hour freezes the queue the same way (Fix #2B): its
  // whole span, minus the :50 news window that passes over it —
  // the news lines above already count that span, and counting
  // it twice would make the queue replay content it aired.
  if (st.comedy) { let t4 = fromMs; for (let i = 0; i < 4; i++) { const w = tvComedyWin(t4, st.comedy); if (!w || w.start >= toMs) break; const a = Math.max(fromMs, w.start), b = Math.min(toMs, w.end); if (b > a) { let ov = 0; const nw1 = tvNewsWin(a); for (let ws = nw1.start; ws < b; ws += 3600e3) { const o = Math.min(b, ws + TV_NEWS_LEN * 1000) - Math.max(a, ws); if (o > 0) ov += o / 1000; } froz += Math.max(0, (b - a) / 1000 - ov); } t4 = w.end; } }
  if (st.insert && isFinite(st.insert.start) && (st.insert.dur || 0) > 0) sub(st.insert.start, st.insert.start + st.insert.dur * 1000);
  // The hourly cartoon spans the queue freezes across — netted of
  // any :50 news window and cadence span inside one, like the
  // family block's care above: those seconds belong to the span
  // only when nothing else owns them, so no second of queue
  // content is ever frozen twice.
  if (st.crt && Array.isArray(st.crt.spans)) {
    for (const sp of st.crt.spans) {
      const a = Math.max(fromMs, sp.start), b = Math.min(toMs, sp.end);
      if (b > a) {
        let ov = 0;
        const nw1 = tvNewsWin(a);
        for (let ws = nw1.start; ws < b; ws += 3600e3) { const o = Math.min(b, ws + TV_NEWS_LEN * 1000) - Math.max(a, ws); if (o > 0) ov += o / 1000; }
        if (st.cad) ov += tvAdTimeIn(st.cad, st.prem, st.anchor, st.insert, a, b, st.char, st.lu, st.rerun, st.qtr);
        froz += Math.max(0, (b - a) / 1000 - ov);
      }
    }
  }
  if (st.cad) froz += tvAdTimeIn(st.cad, st.prem, st.anchor, st.insert, fromMs, toMs, st.char, st.lu, st.rerun, st.qtr);
  return Math.max(0, Math.min((toMs - fromMs) / 1000, Math.round(froz * 10) / 10));
}
/* The queue window's full span: the anchor plus the list's total
 * content, stretched by every frozen span inside it (fixed-point,
 * like the movie block's cadence extension). */
function tvQueueSpan(q) {
  if (!q || !(q.total > 0) || !(q.anchor > 0)) return null;
  const start = q.anchor;
  let end = start + q.total * 1000;
  for (let i = 0; i < 4; i++) { const ne = start + (q.total + tvQueueFrozen(q, start, end)) * 1000; if (!(ne > end)) break; end = ne; }
  return { start, end };
}
function tvQueueWin(ms, q) {
  const sp = tvQueueSpan(q);
  if (!sp) return null;
  if (ms >= sp.start && ms < sp.end) return { start: sp.start, end: sp.end, inside: true };
  if (ms < sp.start) return { start: sp.start, end: sp.end, inside: false };
  return null;
}
/* Content seconds of the list that have actually aired by ms:
 * wall time since the anchor minus the frozen spans — an item
 * is consumed exactly when this passes its end. */
function tvQueueElapsed(q, ms) {
  if (!q || !(q.anchor > 0) || ms <= q.anchor) return 0;
  return Math.max(0, Math.round(((ms - q.anchor) / 1000 - tvQueueFrozen(q, q.anchor, ms)) * 10) / 10);
}
/* Which queue item a content position falls in (and its offset):
 * shared by generation, consumption and the advancer's jump. */
function tvQueueAt(q, pos) {
  let acc = 0;
  for (let i = 0; i < (q ? q.items.length : 0); i++) { const it = q.items[i]; if (pos < acc + (+it.dur || 0)) return { ix: i, it, off: Math.round((pos - acc) * 10) / 10, before: acc }; acc += +it.dur || 0; }
  return null;
}
/* The movie chain's content position at t, measured with exactly
 * the movie branch's own accounting (insert freeze, queue freeze,
 * cadence freeze, skip shift) — the advancer measures the current
 * movie with the same ruler generation lays it by. */
function tvMoviePosAt(chan, t) {
  const mov = chan._movies;
  if (!mov) return null;
  const mwin = tvMovieWin(t, mov);
  if (!mwin || !mwin.inside) return null;
  let slotOff = (t - mwin.start) / 1000;
  if (mov.insShift > 0 && isFinite(mov.insEnd) && t >= mov.insEnd) slotOff -= mov.insShift;
  if (mov.qShift > 0 && isFinite(mov.qEnd) && t >= mov.qEnd) slotOff -= mov.qShift;
  if (mov.crtShift > 0 && isFinite(mov.crtEnd) && t >= mov.crtEnd) slotOff -= mov.crtShift;
  const cad = chan._queue && chan._queue._st ? chan._queue._st.cad : (mov._cad ? mov._cad.cad : null);
  if (cad) slotOff -= tvAdTimeIn(cad, chan._prem, chan._anchor, chan._insert, mwin.start, t, chan._char, chan._lu, chan._rerun, chan._qtr);
  if (mov.skipShift > 0 && t >= mov.skipAt) slotOff += mov.skipShift;
  let acc = 0;
  for (const sit of mov.items) { if (slotOff < acc + (+sit.dur || 0)) return { win: mwin, it: sit, off: Math.round((slotOff - acc) * 10) / 10, end: acc + (+sit.dur || 0) }; acc += +sit.dur || 0; }
  return null;
}
/* tvAdvanceChannel — THE channel advancer (owner skip today;
 * the crowd-skip trigger calls this same routine — one advance
 * path, never two). Ends the segment on air at now (tvTrimAt —
 * no hole) and re-anchors the program cursor by cycle math; the
 * caller (tvTick) then re-lays forward, so what plays next is
 * decided by the standing precedence: queue head → hard schedule
 * → the channel's own picks. The side-effect stamps are RETURNED,
 * not written — the caller persists them (into tv/now, and into
 * tv/queue for a queue jump) in its own write:
 *   qCut:    { news|prem|rerun|anchor|cad: windowStart } — the
 *            wall-clock window on air ends with this cut; only
 *            its laid airing ends, never its docs or schedule.
 *   qJump:   { anchor } — the queue item on air is skipped: the
 *            caller rewrites tv/queue's anchor so the item's
 *            content end is exactly now; consumption then retires
 *            it and the list continues with the next item.
 *   movSkip: { at, shift } — the movie on air is skipped:
 *            tonight's chain position shifts by the movie's
 *            remaining seconds (the freeze-ruler inverse).
 *   insTrunc:{ dur } — the one-shot insert on air is cut: its
 *            stamped window ends at now.
 * chan must carry the tick's resolved states (_prem, _rerun,
 * _anchor, _insert, _movies, _queue); cadNow is the ad-cadence
 * window containing now (tvAdWin) or null. Returns
 * { segs, cursor, applied, note, qCut, qJump, movSkip, insTrunc }. */
function tvAdvanceChannel(chan, segs, cursor, now, cadNow) {
  const cur = segs ? tvSegAt(segs, now) : null;
  if (!cur) return { segs, cursor, applied: false, note: "nothing on air this second", qCut: null, qJump: null, movSkip: null, insTrunc: null };
  const out = { segs: tvTrimAt(segs, now), cursor, applied: true, note: "", qCut: null, qJump: null, movSkip: null, insTrunc: null };
  const cp = tvCyclePos(chan, now);
  if (cp) out.cursor = { at: now, ix: cp.ix, off: cp.off, run: 0 };
  const title = String(cur.title || cur.id || "the current piece").slice(0, 80);
  // Wall-clock windows: cut the airing, keep the machinery.
  const nWin = tvNewsWin(now);
  if (cur.k === "news" || (nWin.inside && cur.start >= nWin.start && cur.start < nWin.end)) { out.qCut = { news: nWin.start }; out.note = "cut the news window short — the channel moves on; the schedule itself is untouched"; return out; }
  const slotCut = (win, items, kind, label) => {
    if (!win || !win.inside || !Array.isArray(items)) return null;
    if (!items.some((x) => x && x.id === cur.id)) return null;
    const qq = {}; qq[kind] = win.start;
    return { qCut: qq, note: "cut the " + label + " short — the channel moves on; the slot itself is untouched" };
  };
  let sc = null;
  if ((sc = slotCut(tvPremWin(now, chan._prem), chan._prem && chan._prem.items, "prem", "premiere"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if ((sc = slotCut(tvPremWin(now, chan._rerun), chan._rerun && chan._rerun.items, "rerun", "rerun"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if ((sc = slotCut(tvFamilyWin(now, chan._family), chan._family && chan._family.items, "family", "Family Time"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if ((sc = slotCut(tvKhutbahWin(now, chan._khutbah), chan._khutbah && chan._khutbah.items, "khutbah", "Friday khutbah"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if ((sc = slotCut(tvComedyWin(now, chan._comedy), chan._comedy && chan._comedy.items, "comedy", "Comedy Hour"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if (cur.adh && cur.adhKey) { out.qCut = { adhan: cur.adhKey }; out.note = "cut the adhan short — the channel moves on; the next prayer is untouched"; return out; }
  if ((sc = slotCut(tvAnchorWin(now, chan._anchor), chan._anchor ? [chan._anchor.item] : null, "anchor", "anchor edition"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if ((sc = slotCut(tvCartoonWinAt(now, chan._cartoon), chan._cartoon ? chan._cartoon.items.concat(chan._cartoon.spots || []) : null, "cartoon", "the cartoon block"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if (cadNow && cadNow.inside && cur.start >= cadNow.start && cur.start < cadNow.end && ((cadNow.item && cur.id === cadNow.item.id) || (cadNow.upd && cur.id === cadNow.upd.id))) { out.qCut = { cad: cadNow.start }; out.note = "cut the break short — back to the program"; return out; }
  // The owner's queue: jump the anchor past the item on air, so
  // the next item in the list starts at the cut.
  if (cur.qid && chan._queue) {
    const el = tvQueueElapsed(chan._queue, now);
    const at = tvQueueAt(chan._queue, el);
    if (at && at.it.qid === cur.qid) {
      // The jump moves the anchor BACKWARD by the item's remaining
      // content seconds, so the item's content end lands exactly at
      // now: consumption retires it and generation lays the NEXT
      // item at the cut. (The pre-fix code moved the anchor FORWARD
      // by the remaining seconds instead — the skipped item was
      // deferred, never retired, and replayed in full later; the
      // comment above this function always stated the backward
      // intent.) The shift is stretched by any frozen (hard-window)
      // time the moved anchor crosses — fixed-point, like
      // tvQueueSpan.
      let dJump = (at.before + (+at.it.dur || 0)) - el;
      for (let i = 0; i < 10; i++) {
        const nd = (at.before + (+at.it.dur || 0)) - el + tvQueueFrozen(chan._queue, chan._queue.anchor - dJump * 1000, chan._queue.anchor);
        const done = Math.abs(nd - dJump) < 0.05;
        dJump = nd;
        if (done) break;
      }
      out.qJump = { anchor: Math.round(chan._queue.anchor - dJump * 1000) };
      out.note = "skipped the queued \u201c" + title + "\u201d — the list moves to the next one";
      return out;
    }
  }
  // The one-shot insert: end its stamped window at now.
  if (chan._insert && isFinite(chan._insert.start) && now >= chan._insert.start && now < chan._insert.start + (chan._insert.dur || 0) * 1000 && Array.isArray(chan._insert.items) && chan._insert.items.some((x) => x && x.id === cur.id)) {
    out.insTrunc = { dur: Math.max(0.1, Math.round((now - chan._insert.start) / 100) / 10) };
    out.note = "cut \u201c" + title + "\u201d short — the channel moves on";
    return out;
  }
  // The movie chain: shift tonight's chain past this movie.
  if (chan._movies && (chan._movies.items || []).some((x) => x && x.id === cur.id)) {
    const mp = tvMoviePosAt(chan, now);
    if (mp && mp.it.id === cur.id) {
      const rem = Math.round(((+mp.it.dur || 0) - mp.off) * 10) / 10;
      if (rem > 0.05) { out.movSkip = { at: now, shift: rem }; out.note = "skipped the movie \u201c" + title + "\u201d — the next one starts now"; return out; }
    }
  }
  out.note = "skipped \u201c" + title + "\u201d — the channel picks what's next";
  return out;
}

/* The one-shot insert window: a single fixed span [start, start+dur]
 * stamped into tv/now when the insert fired. Unlike the daily
 * windows it never repeats — once ms is past the end there is no
 * next one. */
function tvInsertWin(ms, ins) {
  if (!ins || !(ins.dur > 0) || !isFinite(ins.start)) return null;
  const start = ins.start, end = start + ins.dur * 1000;
  if (ms >= start && ms < end) return { start, end, inside: true };
  if (ms < start) return { start, end, inside: false };
  return null;
}
/* The MY EMPIRE ad cadence lineup (Malik, 2026-11-02 ~21:05: "my tv
 * show comercial every 15 min"; pool + random draw, Malik,
 * 2026-11-03: "play them randomly"): the 15-minute rail serves the
 * FULL show-spot pool — every MY EMPIRE spot currently in the break
 * pool and cleared (tvSpotGate holds any whose file is not on the
 * site yet, so a spot joins the rail by itself once uploaded) —
 * resolved from the break pool on every pass. The pool is the
 * gate, so a missing or uncleared spot is simply no cadence —
 * never an error, never dead air. Which spot fills an occurrence
 * is tvAdPick's seeded block shuffle, never a fixed order. */
function tvAdCadItems(pool) {
  const items = [];
  for (const id of TV_SHOW_SPOT_IDS) {
    const it = ((pool && pool.items) || []).find((x) => x.id === id);
    if (it && tvCleared(it)) items.push(it);
  }
  // PAID SPONSOR SPOTS join the cadence rail alongside the house
  // spots: a Starter spot takes one slot in the block shuffle, a
  // Featured spot takes two (~2x rotation). Sponsor slots never
  // outnumber the house slots in a block — Malik's own commercials
  // keep the majority of his breaks. Held sponsors (unapproved, past
  // their paid week, or missing their file — the tick gate holds
  // them) never reach this list because tvCleared drops held items.
  if (items.length) {
    const spn = ((pool && pool.items) || []).filter((x) => x && x.kind === "sponsor" && tvCleared(x) && x.sponsor && x.sponsor.approved === true);
    const feat = spn.filter((x) => x.sponsor && x.sponsor.tier === "featured");
    const start = spn.filter((x) => !(x.sponsor && x.sponsor.tier === "featured"));
    const entries = [];
    for (const it of feat) entries.push(it, it);
    for (const it of start) entries.push(it);
    const room = Math.min(entries.length, items.length);
    for (let i = 0; i < room; i++) items.push(entries[i]);
  }
  return items.length ? items : null;
}
/* Which pool spot fills cadence occurrence k: a seeded shuffle-bag
 * over blocks of n occurrences (n = pool size). Every block plays
 * each spot exactly once, in an order shuffled by a PRNG seeded
 * from the block index — so the draw is a pure function of k:
 * every keeper pass agrees on the same spot for the same
 * occurrence with no state to store, while the order still varies
 * block to block. A block never opens with the previous block's
 * last spot: when the fresh block's head equals the previous
 * block's (raw) last entry, the head is swapped with the first
 * differing entry from the block's middle — the swap never touches
 * the block's own last entry, so the next block's check reads the
 * same last entry this block actually played, and every position
 * of the block reads the one adjusted order. With two spots the
 * only no-repeat order is strict alternation; with one, itself. */
function tvAdPick(cad, k) {
  const n = cad.length;
  if (n <= 1) return cad[0];
  if (n === 2) return cad[((k % 2) + 2) % 2];
  const raw = (b) => {
    const a = []; for (let i = 0; i < n; i++) a.push(i);
    let s = ((b + 1) * 2654435761) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };
  const block = Math.floor(k / n), pos = k - block * n;
  // House-only cadence: the original seeded block shuffle with its
  // boundary no-repeat swap, byte for byte — sponsor machinery below
  // never touches the rotation Malik already hears.
  if (!cad.some((x) => x && x.kind === "sponsor")) {
    const ord = raw(block);
    if (block > 0) {
      const prevLast = raw(block - 1)[n - 1];
      if (ord[0] === prevLast) {
        const j = ord.findIndex((x, ix) => ix >= 1 && ix <= n - 2 && x !== prevLast);
        if (j > 0) { const t = ord[0]; ord[0] = ord[j]; ord[j] = t; }
      }
    }
    return cad[ord[pos]];
  }
  // Sponsor cadence — break discipline (paid spots): no spot plays
  // twice in a row (a Featured sponsor legitimately holds two entries
  // in a block, so the check is on the spot id, not the entry), and
  // sponsor spots never run three deep: after two, the house is owed
  // a turn. Construction: every block ENDS on a house spot (the last
  // house entry in the block's raw order, reserved as the tail), so
  // the next block's context is exact — the previous tail is a house
  // spot whose id is a pure function of the previous block's raw
  // order — and the remaining positions are filled greedily by raw
  // rank, taking the highest-ranked entry that is legal there and
  // does not strand the rest (the doom filter: never leave a
  // remainder that is all one spot, or all sponsors behind a run of
  // two). A repair pass then swaps inside the block if anything
  // still violates; only a truly degenerate remainder keeps a
  // violation, and the harness measures that honestly.
  const tailOf = (ordRaw) => { for (let i = n - 1; i >= 0; i--) { const it = cad[ordRaw[i]]; if (it && it.kind !== "sponsor") return ordRaw[i]; } return -1; };
  const ord0 = raw(block);
  const tailIx = tailOf(ord0);
  if (tailIx < 0) return cad[ord0[pos]]; // no house entry at all — nothing to discipline against
  let ctxId = null;
  if (block > 0) { const pTail = tailOf(raw(block - 1)); ctxId = pTail >= 0 ? cad[pTail].id : null; }
  const remaining = ord0.filter((ix) => ix !== tailIx);
  const out = [];
  let lastId = ctxId, spnRun = 0;
  const legalHere = (it, lid, run) => !!it && (lid === null || it.id !== lid) && !(it.kind === "sponsor" && run >= 2);
  const doomed = (candIt, runAfter, rem) => {
    if (!rem.length) return false;
    if (rem.every((ix) => cad[ix].id === candIt.id)) return true;         // next slot would repeat the pick
    if (rem.length >= 2 && rem.every((ix) => cad[ix].id === cad[rem[0]].id)) return true; // a stranded pair always repeats
    if (runAfter >= 2 && rem.every((ix) => cad[ix].kind === "sponsor")) return true;      // next slot would be a third sponsor
    return false;
  };
  for (let i = 0; i < n - 1; i++) {
    let pickAt = -1, fallbackAt = -1;
    for (let j = 0; j < remaining.length; j++) {
      const it = cad[remaining[j]];
      if (!legalHere(it, lastId, spnRun)) continue;
      if (fallbackAt < 0) fallbackAt = j;
      const remAfter = remaining.filter((_, x) => x !== j);
      if (!doomed(it, it.kind === "sponsor" ? spnRun + 1 : 0, remAfter)) { pickAt = j; break; }
    }
    if (pickAt < 0) pickAt = fallbackAt;
    if (pickAt < 0) pickAt = 0;
    const ix = remaining.splice(pickAt, 1)[0];
    out.push(ix);
    const it = cad[ix];
    lastId = it.id; spnRun = it.kind === "sponsor" ? spnRun + 1 : 0;
  }
  out.push(tailIx);
  // Repair pass: count violations of the emitted block (with the
  // exact cross-block context); swap any two non-tail positions that
  // reduce the count, until clean or out of ideas.
  const violations = (seq) => {
    let v = 0, lid = ctxId, run = 0;
    for (let i = 0; i < n; i++) {
      const it = cad[seq[i]];
      if (!it) continue;
      if (lid !== null && it.id === lid) v++;
      if (it.kind === "sponsor" && run >= 2) v++;
      lid = it.id; run = it.kind === "sponsor" ? run + 1 : 0;
    }
    return v;
  };
  let v = violations(out);
  for (let pass = 0; pass < n && v > 0; pass++) {
    let improved = false;
    for (let i = 0; i < n - 1 && v > 0; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const t = out[i]; out[i] = out[j]; out[j] = t;
        const nv = violations(out);
        if (nv < v) { v = nv; improved = true; break; }
        const t2 = out[i]; out[i] = out[j]; out[j] = t2;
      }
    }
    if (!improved) break;
  }
  return cad[out[pos]];
}
/* The effective cadence spans overlapping [fromMs, toMs), in order.
 * Occurrences sit on fixed 15-minute wall-clock blocks (the whole-
 * hour ET offset keeps the blocks on the ET quarter hours);
 * occurrence k plays items[k % items.length]. News, premiere,
 * anchor, insert and rerun windows outrank the spot: an occurrence whose
 * span would overlap one slides to that window's end (re-checked
 * until clear), and an occurrence displaced past the previous
 * occurrence's end chains right behind it — the spot never stacks
 * on a window, and a premiere or news block is never cut for it.
 * The chain is computed from 2h before fromMs: no combination of
 * the higher windows can displace an occurrence further than that,
 * so the carry-in is exact. */
function tvAdSpans(cad, prem, anch, ins, fromMs, toMs, char, lu, rer, qtr, khu) {  if (!cad || !cad.length) return [];
  const spans = [];
  let prevEnd = -Infinity;
  const kFirst = Math.floor((fromMs - 2 * 3600e3) / TV_AD_EVERY_MS);
  const kLast = Math.floor(toMs / TV_AD_EVERY_MS) + 1;
  // The update chained after the spot — QUARTER FRESHNESS LAW
  // (Malik, 2026-11-03 ~14:54: "it gives the same news — I want new
  // news every time, and 60 seconds of it every 15 minutes with my
  // commercials"): an occurrence may chain ONLY an update produced
  // for THAT quarter, inside TV_QUARTER_FRESH_MS. First the
  // character-hosted clip (char, built by tvCharLive from the
  // producer-owned tv/charnews doc) when IT is fresh at the
  // occurrence — the character is the host of the local news — else
  // the produced quarter piece made for this exact quarter (qtr,
  // built by tvQuarterLive from tv/quarternews). Nothing fresh =
  // the spot plays alone; an older update NEVER replays. The
  // hourly edition's local update (lu) no longer chains here — it
  // still airs as the pool break spot and in the :50 block. The
  // pair slides as ONE span: the window-slide loop and the prevEnd
  // chain both use the combined duration, so the update never
  // stacks on a news, premiere, anchor or insert window either.
  const charDur = char && char.item ? (+char.dur || +char.item.dur || 0) : 0;
  const qtrDur = qtr && qtr.item ? (+qtr.dur || +qtr.item.dur || 0) : 0;
  const updAt = (st) => {
    if (char && char.item && charDur > 0 && +char.producedAt > 0 && char.producedAt <= st && st - char.producedAt < TV_QUARTER_FRESH_MS) return { item: char.item, dur: charDur };
    if (qtr && qtr.item && qtrDur > 0 && +qtr.forQuarter === st && +qtr.producedAt > 0 && qtr.producedAt <= st && st - qtr.producedAt < TV_QUARTER_FRESH_MS) return { item: qtr.item, dur: qtrDur };
    return null;
  };
  for (let k = kFirst; k <= kLast; k++) {
    let it = tvAdPick(cad, k);
    // Paid-week boundary, per occurrence: a sponsor spot whose week
    // has run out by this occurrence's start never plays — the house
    // pick for the same occurrence takes its place, so the break and
    // its chained fresh update still run.
    if (it && it.kind === "sponsor" && !tvSponsorLive(it, k * TV_AD_EVERY_MS)) {
      const houseCad = cad.filter((x) => x && x.kind !== "sponsor");
      if (houseCad.length) it = tvAdPick(houseCad, k);
    }
    const dur = +it.dur || 0;
    if (!(dur > 0)) continue;
    let s = k * TV_AD_EVERY_MS;
    for (let i = 0; i < 8; i++) {
      const e = s + (dur + (updAt(s) ? updAt(s).dur : 0)) * 1000;
      let slid = false;
      for (const w of [tvNewsWin(s), tvPremWin(s, prem), tvAnchorWin(s, anch), tvInsertWin(s, ins), tvPremWin(s, rer), tvKhutbahWin(s, khu)]) {
        if (w && s < w.end && e > w.start) { s = w.end; slid = true; break; }
      }
      if (!slid) break;
    }
    const start = Math.max(s, prevEnd);
    const upd = updAt(start);
    const end = start + (dur + (upd ? upd.dur : 0)) * 1000;
    prevEnd = end;
    if (end > fromMs && start < toMs) spans.push({ start, end, item: it, upd: upd ? upd.item : null });
  }
  return spans;
}
/* The cadence window containing ms (inside: true) or the next one. */
function tvAdWin(ms, cad, prem, anch, ins, char, lu, rer, qtr, khu) {  if (!cad || !cad.length) return null;
  for (const sp of tvAdSpans(cad, prem, anch, ins, ms, ms + TV_HORIZON, char, lu, rer, qtr, khu)) {
    if (ms >= sp.start && ms < sp.end) return { start: sp.start, end: sp.end, inside: true, item: sp.item, upd: sp.upd || null };
    if (sp.start > ms) return { start: sp.start, end: sp.end, inside: false, item: sp.item, upd: sp.upd || null };  }
  return null;
}
/* How much cadence time falls inside [fromMs, toMs): the span the
 * movie block freezes for the spots laid inside it (the insert
 * freeze rule — the block resumes from the offset it reached and
 * its window runs long by this much). */
function tvAdTimeIn(cad, prem, anch, ins, fromMs, toMs, char, lu, rer, qtr, khu) {  let sec = 0;
  for (const sp of tvAdSpans(cad, prem, anch, ins, fromMs, toMs, char, lu, rer, qtr, khu)) sec += (Math.min(sp.end, toMs) - Math.max(sp.start, fromMs)) / 1000;  return Math.round(sec * 10) / 10;
}
/* The MY EMPIRE premiere window containing ms (inside: true) or the
 * next one. prem = { startMinET, liveDurSec } as built by tvPremLive.
 * Same whole-hour ET offset arithmetic as tvNewsWin; 20:00 ET exists
 * every day, DST transitions never touch it. */
function tvPremWin(ms, prem) {
  if (!prem || !(prem.liveDurSec > 0)) return null;
  const startMin = +prem.startMinET || 1200;
  const et = tvEtParts(ms), sec = Math.floor((ms % 60000) / 1000);
  const mins = et.hour * 60 + et.minute;
  let start = ms - ((mins - startMin) * 60 + sec) * 1000;
  if (start > ms) start -= 86400e3;
  const end = start + prem.liveDurSec * 1000;
  if (ms >= start && ms < end) return { start, end, inside: true };
  const nstart = start + 86400e3;
  return { start: nstart, end: nstart + prem.liveDurSec * 1000, inside: false };
}
/* FAMILY TIME (Malik, 2026-11-03 20:38 ET: "I want family time
 * to start at 8" / "A family movie for younger teens ect every
 * night at 8"): a standing nightly HARD window at 20:00 ET
 * carrying ONE cleared family movie suitable for younger teens
 * (animation / family / adventure / comedy class — no horror, no
 * R-rated, no adult titles). It is built exactly like the premiere
 * window it shares the hour with:
 *   - Precedence in tvGen: a LIVE premiere, then the rerun, then
 *     FAMILY TIME — all ahead of the anchor, the ad cadence
 *     (quarter breaks never chop it, the premiere rule), inserts,
 *     the owner queue and the movie chain, which yield and resume
 *     after it (the queue freezes across it, tvQueueFrozen, with
 *     the in-span news/cadence overlap netted so nothing is
 *     double-frozen). Like the premiere/rerun chains it mirrors,
 *     the movie is wall-clock: a news window falling inside its
 *     span does not chop it.
 *   - PREMIERE YIELD: while the MY EMPIRE premiere is HELD (no
 *     episode file on site media, tvPremLive resolves null) Family
 *     Time owns 20:00. The night a premiere is actually LIVE
 *     (premState.prem non-null) the premiere wins the slot and
 *     Family Time does not lay and does not consume a pick — the
 *     two are reconciled by that one state, never a code fight.
 *   - FIRST AIRING: windows starting before TV_FAMILY_FROM_MS
 *     (Wed 2026-11-04 20:00 ET) never lay — tonight's 8 PM had
 *     already passed when the order landed.
 *   - Eligibility is an ALLOWLIST resolved at tick time from the
 *     docs the keeper already lays from (tv/channel cycle +
 *     tv/movieblock): an item qualifies only when it is cleared
 *     (tvCleared — the standing rights rail; the ban gate has
 *     already stripped banned ids from both docs), runs
 *     TV_FAMILY_MIN_SEC..TV_FAMILY_MAX_SEC (a real feature that
 *     ends by the 22:00 rerun; episode-length pieces never fill
 *     the block), and is family-tagged (block "family" / show
 *     "MW Family") or matches the family-feature title registry
 *     below (the features the current lineup already schedules).
 *     Adult chain titles can never match an allowlist, so an
 *     unsuitable title is unpickable by construction; this build
 *     adds no new titles.
 *   - Rotation lives in tv/familytime (keeper-owned): a shuffled
 *     pick bag like the break pool's; a night's pick is locked on
 *     the first tick that resolves it and never re-drawn mid-night;
 *     the same title never plays two nights running, and the bag
 *     draw skips anything played inside the last 7 days while the
 *     eligible pool allows (history kept on the doc).
 *   - Protection: a scheduled window — tvSkipGate refuses crowd
 *     AND Guardian cuts inside it (log + report only, the
 *     premiere/rerun class); votes still collect; the OWNER skip
 *     still cuts it (tvAdvanceChannel slot cut, qCut "family").
 * Segments carry fam:1 and the item's show is stamped
 * "👨‍👩‍👧 Family Time", so the Guide and TV bar paint the block. */
const TV_FAMILY_V = 1;              // familytime doc generation (tv/familytime)
const TV_FAMILY_START_MIN = 1200;   // 20:00 ET, every night
const TV_FAMILY_FROM_MS = 1793840400000; // first airing: Wed 2026-11-04 20:00 ET — earlier windows never lay
const TV_FAMILY_MIN_SEC = 2400;     // a real feature, not an episode-length piece
const TV_FAMILY_MAX_SEC = 7200;     // at most ~120 min: the block ends by the 22:00 rerun window
const TV_FAMILY_TITLE_KEYS = ["kung fu panda", "lion king", "karate kid", "the mask", "grinch", "ice age", "wild robot", "the wild", "the lost world", "johnny test", "madeline"];
function tvSeedFamilyTime(now) {
  return { progV: TV_FAMILY_V, on: true, startMinET: TV_FAMILY_START_MIN, bag: [], night: "", itemId: "", hist: [], updatedAt: now, by: "keeper-seed" };
}
function tvFamilySuitable(it) {
  if (!it) return false;
  if (it.block === "family" || it.show === "MW Family") return true;
  const t = String(it.title || "").toLowerCase();
  return TV_FAMILY_TITLE_KEYS.some((k) => t.includes(k));
}
function tvFamilyEligible(chan, movies) {
  const out = [], seen = new Set();
  for (const src of [chan && chan.items, movies && movies.items]) {
    for (const it of (src || [])) {
      if (!it || seen.has(it.id)) continue;
      if (!tvCleared(it)) continue;
      if (!(+it.dur >= TV_FAMILY_MIN_SEC && +it.dur <= TV_FAMILY_MAX_SEC)) continue;
      if (!tvFamilySuitable(it)) continue;
      seen.add(it.id); out.push(it);
    }
  }
  return out;
}
/* The Family Time window containing ms (inside: true) or the next
 * one — tvPremWin's arithmetic over the resolved family state
 * ({ startMinET, liveDurSec } built by tvFamilyResolve). */
function tvFamilyWin(ms, fam) {
  if (!fam || !fam.item || !(fam.liveDurSec > 0)) return null;
  return tvPremWin(ms, { startMinET: fam.startMinET || TV_FAMILY_START_MIN, liveDurSec: fam.liveDurSec });
}
/* Resolve tonight's Family Time state from the rotation doc.
 * Pure: returns { state, doc, changed } — tvTick persists the doc
 * when a pick was locked. state is null when the block is off,
 * when a live premiere owns the night, when the window predates
 * the first airing, or when nothing eligible exists (the channel
 * simply plays its standing lineup — never dead air). The night a
 * window belongs to is its 20:00 ET start's ET day, so the pick is
 * the same at 18:00 (when generation first reaches the window) and
 * at 21:00 (mid-window) — locked once, never re-drawn. */
function tvFamilyResolve(famDoc, chan, movies, premState, now) {
  const doc = famDoc && typeof famDoc === "object" ? famDoc : tvSeedFamilyTime(now);
  if (doc.on === false) return { state: null, doc, changed: false };
  if (premState && premState.prem) return { state: null, doc, changed: false }; // a LIVE premiere wins 8 PM — Family Time yields, no pick consumed
  const et0 = tvEtParts(now), sec0 = Math.floor((now % 60000) / 1000);
  const winStart = now - ((et0.hour * 60 + et0.minute - TV_FAMILY_START_MIN) * 60 + sec0) * 1000;
  if (winStart < TV_FAMILY_FROM_MS) return { state: null, doc, changed: false };
  const dayKey = tvEtParts(winStart).dayKey;
  const eligible = tvFamilyEligible(chan, movies);
  if (!eligible.length) return { state: null, doc, changed: false };
  let changed = false;
  let it = null;
  if (doc.night === dayKey && doc.itemId) it = eligible.find((x) => x.id === doc.itemId) || null;
  if (!it) {
    const ids = new Set(eligible.map((x) => x.id));
    let bag = (Array.isArray(doc.bag) ? doc.bag : []).filter((id) => ids.has(id));
    if (!bag.length) { bag = eligible.map((x) => x.id); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t2 = bag[i]; bag[i] = bag[j]; bag[j] = t2; } }
    const hist = Array.isArray(doc.hist) ? doc.hist : [];
    const cutMs = Date.parse(dayKey) - 7 * 86400e3;
    const recent = new Set(hist.filter((h) => h && Date.parse(h.day || "") >= cutMs).map((h) => h.id));
    const lastNight = hist.length ? hist[hist.length - 1].id : "";
    const pick = bag.find((id) => !recent.has(id) && id !== lastNight) || bag.find((id) => id !== lastNight) || bag[0];
    bag = bag.filter((id) => id !== pick);
    it = eligible.find((x) => x.id === pick) || null;
    if (it) {
      doc.bag = bag; doc.night = dayKey; doc.itemId = pick;
      doc.hist = [...hist, { day: dayKey, id: pick }].slice(-14);
      doc.updatedAt = now; doc.by = "keeper";
      changed = true;
    }
  }
  if (!it) return { state: null, doc, changed };
  const item = { ...it, show: "👨‍👩‍👧 Family Time" };
  return { state: { startMinET: TV_FAMILY_START_MIN, item, items: [item], liveDurSec: +it.dur, night: dayKey }, doc, changed };
}
/* FRIDAY KHUTBAH (v16 — Malik, 2026-11-05 ~18:00 ET: "Every
 * friday at 1 i want a kutbah from mufti menk to play"): a standing
 * WEEKLY hard window at 13:00 ET on Fridays carrying ONE verified
 * Mufti Menk Jumu'ah sermon from his OFFICIAL channel
 * (@muftimenkofficial, channel UCNB_OaI4524fASt8h0IL8dw — the
 * @MuftiMenk handle is a squatter and is never used). Built exactly
 * like the Family Time window it is modelled on:
 *   - Precedence in tvGen: premiere, rerun, Family Time, then the
 *     KHUTBAH — ahead of the anchor, the ad cadence, inserts, the
 *     owner queue and the fill chain, which freeze and resume
 *     after it (the queue in content time, the program cursor by
 *     split/resume). The cadence never lays inside it (the
 *     tvAdSpans exclusion) and the hourly cartoon block slides
 *     past it as a unit (tvCartoonSpans).
 *   - The :50 news gate refuses any window overlapping it
 *     (tvNewsOverlapsKhutbah), so news never cuts the sermon.
 *   - Rotation lives in tv/khutbah (keeper-owned, the familytime
 *     shape): a shuffled bag over the 10 verified sermons below, a
 *     week's pick locked on the first resolve of that Friday and
 *     never re-drawn, never the same sermon inside 28 days while
 *     the pool allows.
 *   - A week with nothing eligible = no window; the channel plays
 *     its standing lineup — never dead air.
 *   - Protection: crowd-skip AND Guardian cuts refused (the
 *     Family Time class, tvSkipGate); the OWNER skip still cuts
 *     one Friday's instance (qCut.khutbah, stamped by window
 *     start). Segments carry khut:1 and the item's show is stamped
 *     "🕌 Friday Khutbah" so the Guide and TV bar paint the block.
 * Every sermon below: YouTube oEmbed HTTP 200 with author "Mufti
 * Menk" (@muftimenkofficial) at research time (2026-11-05), billed
 * as a Jumu'ah/Friday sermon in its own title or description, its
 * duration pinned from the actual upload (research record:
 * website/islamic-programming-2026-11-05/KHUTBAH-ADHAN.md). All run
 * 20–32 min, so a 13:00 start always ends clear of the 13:50 news
 * window even before the overlap refusal above. */
const TV_KHUTBAH_V = 1;              // khutbah doc generation (tv/khutbah)
const TV_KHUTBAH_START_MIN = 780;    // 13:00 ET, Fridays only
const TV_KHUTBAH_FROM_MS = 1793988000000; // first airing: Fri 2026-11-06 13:00 ET — earlier windows never lay
function tvKhutbahItems(now) {
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  const EV = (dur) => "Verified Mufti Menk Jumu'ah sermon on his official channel (@muftimenkofficial, channel UCNB_OaI4524fASt8h0IL8dw): YouTube oEmbed HTTP 200 with author 'Mufti Menk' at research time (2026-11-05); billed as a Friday/Jumu'ah sermon in its own title or description; duration " + dur + "s pinned from the actual upload (research record: website/islamic-programming-2026-11-05/KHUTBAH-ADHAN.md)";
  const K = (yt, title, dur) => ({ id: "khut-" + yt.toLowerCase(), kind: "show", src: "yt", yt, title, show: "Mufti Menk", dur, rights: R(EV(dur)) });
  return [
    K("f2H740A9s3Y", "Mufti Menk — The Ummah & The Holidays (Jumu'ah, Mayfair)", 1906),
    K("m9xcwWBwXkc", "Mufti Menk — The Biggest Hypocrite! (Friday Lecture)", 1863),
    K("pRVHGIT2DwQ", "Mufti Menk — How to Become a Muslim (Jumu'ah, Harare)", 1353),
    K("JXO7QaTsxoU", "Mufti Menk — This Will Be an Amazing Ramadan (Jumu'ah Lecture)", 1353),
    K("3EoSp8rb6c4", "Mufti Menk — Work Towards a Good Death (Jumu'ah, Harare)", 1318),
    K("Cnc5FPFtUgc", "Mufti Menk — The Call to Goodness (Khutbah, Kuala Lumpur)", 1255),
    K("aHy26wN728g", "Mufti Menk — When They Say Bad Things About You (Jumu'ah Lecture)", 1241),
    K("w8G2piyhNlY", "Mufti Menk — B+ (Jumu'ah Talk)", 1241),
    K("FMBvXbIIm18", "Mufti Menk — How to Protect Yourself from Evil (Jumu'ah, Johannesburg)", 1202),
    K("c1aOe6d2kcE", "Mufti Menk — You Pay a Price for Your Tongue (Jumu'ah Lecture)", 1201),
  ];
}
function tvSeedKhutbah(now) {
  return { progV: TV_KHUTBAH_V, on: true, startMinET: TV_KHUTBAH_START_MIN, bag: [], week: "", itemId: "", hist: [], updatedAt: now, by: "keeper-seed" };
}
function tvKhutbahEligible(now, banSet) {
  return tvKhutbahItems(now).filter((it) => tvCleared(it) && !(banSet && it.yt && banSet.has(String(it.yt))));
}
/* The khutbah window containing ms (inside: true) or the next
 * one: tvPremWin's daily arithmetic over the resolved state,
 * filtered to Fridays — a daily window whose start is not a
 * Friday is stepped over, day by day, to the next Friday. */
function tvKhutbahWin(ms, kh) {
  if (!kh || !kh.item || !(kh.liveDurSec > 0)) return null;
  let w = tvPremWin(ms, { startMinET: kh.startMinET || TV_KHUTBAH_START_MIN, liveDurSec: kh.liveDurSec });
  for (let i = 0; i < 8 && w; i++) {
    if (tvEtParts(w.start).weekday === "Fri") return w;
    w = { start: w.start + 86400e3, end: w.end + 86400e3, inside: false };
  }
  return null;
}
function tvNewsOverlapsKhutbah(win, kh) {
  if (!win || !kh) return false;
  const kw = tvKhutbahWin(win.start, kh);
  if (!kw) return false;
  return kw.start < win.end && win.start < kw.end;
}
/* Resolve the khutbah state for the Friday this tick must serve:
 * today's window when today is Friday (or the coming Friday's —
 * generation reaches 2 hours ahead, and the pick locks the first
 * time any tick resolves that Friday, the familytime discipline).
 * Pure: returns { state, doc, changed } — tvTick persists the doc
 * when a pick was locked. State is null when the block is off,
 * before the first airing, or when nothing eligible exists. */
function tvKhutbahResolve(khDoc, now, banSet) {
  const doc = khDoc && typeof khDoc === "object" ? khDoc : tvSeedKhutbah(now);
  if (doc.on === false) return { state: null, doc, changed: false };
  const et0 = tvEtParts(now), sec0 = Math.floor((now % 60000) / 1000);
  const wdIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[et0.weekday];
  const add = (5 - wdIdx + 7) % 7; // days until Friday (0 when today is Friday)
  let winStart = now - ((et0.hour * 60 + et0.minute - TV_KHUTBAH_START_MIN) * 60 + sec0) * 1000 + add * 86400e3;
  if (add === 0) {
    // Friday: once this week's window has fully ended, the state
    // this tick serves is NEXT Friday's.
    const locked0 = doc.itemId ? tvKhutbahItems(now).find((x) => x.id === doc.itemId) : null;
    const durMs = ((locked0 && +locked0.dur) || 1906) * 1000;
    if (doc.week === tvEtParts(winStart).dayKey && winStart + durMs <= now) winStart += 7 * 86400e3;
    else if (doc.week !== tvEtParts(winStart).dayKey && winStart + 1906e3 <= now) winStart += 7 * 86400e3;
  }
  if (winStart < TV_KHUTBAH_FROM_MS) return { state: null, doc, changed: false };
  const weekKey = tvEtParts(winStart).dayKey;
  const eligible = tvKhutbahEligible(now, banSet);
  if (!eligible.length) return { state: null, doc, changed: false };
  let changed = false;
  let it = null;
  if (doc.week === weekKey && doc.itemId) it = eligible.find((x) => x.id === doc.itemId) || null;
  if (!it) {
    const ids = new Set(eligible.map((x) => x.id));
    let bag = (Array.isArray(doc.bag) ? doc.bag : []).filter((id) => ids.has(id));
    if (!bag.length) { bag = eligible.map((x) => x.id); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t2 = bag[i]; bag[i] = bag[j]; bag[j] = t2; } }
    const hist = Array.isArray(doc.hist) ? doc.hist : [];
    const cutMs = Date.parse(weekKey) - 28 * 86400e3;
    const recent = new Set(hist.filter((h) => h && Date.parse(h.week || "") >= cutMs).map((h) => h.id));
    const lastWeek = hist.length ? hist[hist.length - 1].id : "";
    const pick = bag.find((id) => !recent.has(id) && id !== lastWeek) || bag.find((id) => id !== lastWeek) || bag[0];
    bag = bag.filter((id) => id !== pick);
    it = eligible.find((x) => x.id === pick) || null;
    if (it) {
      doc.bag = bag; doc.week = weekKey; doc.itemId = pick;
      doc.hist = [...hist, { week: weekKey, id: pick }].slice(-12);
      doc.updatedAt = now; doc.by = "keeper";
      changed = true;
    }
  }
  if (!it) return { state: null, doc, changed };
  const item = { ...it, show: "🕌 Friday Khutbah" };
  return { state: { startMinET: TV_KHUTBAH_START_MIN, item, items: [item], liveDurSec: +it.dur, week: weekKey }, doc, changed };
}
/* COMEDY HOUR (Fix #2B, 2026-11-08 — fault 115): Malik's standing
 * order (2026-11-03): the 7 PM hour is the Comedy Hour. Until this
 * build the recurring window was never laid — only the one-shot
 * tvSeedInsert for Tue 2026-11-03 ever carried the hour, so at
 * 19:00 the channel simply played its standing fill (the watcher
 * deep seat that filed fault 115 sat through South Park in the
 * slot). It is built exactly like the Family Time window it
 * precedes:
 *   - A standing nightly HARD window at 19:00 ET, one hour sharp
 *     (TV_COMEDY_LEN_SEC): the window ends at 20:00 ET on the
 *     dot, where Family Time takes the channel.
 *   - Precedence in tvGen: premiere, rerun, Family Time, the
 *     khutbah, then the COMEDY HOUR — ahead of the anchor, the ad
 *     cadence, the cartoon block (whose spans slide past it,
 *     tvCartoonSpans), the insert, the owner queue (which freezes
 *     across it, tvQueueFrozen) and the fill chain; what it
 *     preempts freezes and resumes after the block.
 *   - The :50 news window keeps precedence over it the insert
 *     way: comedy segments cap at the window start and the news
 *     branch lays a FRESH edition when the standing gates allow
 *     (the chain's wall-clock offset then sits at the window end,
 *     so the block owes nothing after); with no fresh edition the
 *     hour plays wall-to-wall. News is never cut by the block.
 *   - The chain: the night's picks are drawn from the comedy pool
 *     — the cleared items carrying block "comedy" in the cycle
 *     seed (the v8 stand-up specials) — until they cover the
 *     hour, and chain inside the window by wall-clock offset
 *     exactly like the premiere chain; a pick that runs past
 *     20:00 is cut there sharp.
 *   - Rotation lives in tv/comedyhour (keeper-owned, the
 *     familytime shape): a shuffled pick bag; a night's chain is
 *     locked on the first tick that resolves it and never
 *     re-drawn mid-night; the draw skips anything played inside
 *     the last 7 days while the pool allows.
 *   - A night with nothing eligible = no window; the channel
 *     plays its standing lineup — never dead air.
 *   - Protection: a scheduled window — tvSkipGate refuses crowd
 *     AND Guardian cuts inside it (log + report only, the Family
 *     Time class); votes still collect; the OWNER skip still
 *     cuts one night's instance (tvAdvanceChannel slot cut,
 *     qCut "comedy").
 * Segments carry cmd:1 and the items' show is stamped
 * "MW Comedy Hour", so the Guide and TV bar paint the block. */
const TV_COMEDY_V = 1;              // comedyhour doc generation (tv/comedyhour)
const TV_COMEDY_START_MIN = 1140;   // 19:00 ET, every night
const TV_COMEDY_LEN_SEC = 3600;     // one hour sharp: ends 20:00 ET at Family Time
const TV_COMEDY_FROM_MS = 1794182400000; // first airing: Sun 2026-11-08 19:00 ET — earlier windows never lay
function tvSeedComedyHour(now) {
  return { progV: TV_COMEDY_V, on: true, startMinET: TV_COMEDY_START_MIN, bag: [], night: "", itemIds: [], hist: [], updatedAt: now, by: "keeper-seed" };
}
function tvComedyEligible(chan) {
  const out = [], seen = new Set();
  for (const it of (chan && chan.items) || []) {
    if (!it || seen.has(it.id)) continue;
    if (!tvCleared(it)) continue;
    if (it.block !== "comedy") continue;
    seen.add(it.id); out.push(it);
  }
  return out;
}
/* The Comedy Hour window containing ms (inside: true) or the next
 * one — tvPremWin's arithmetic over the resolved comedy state at
 * the fixed one-hour length. */
function tvComedyWin(ms, com) {
  if (!com || !Array.isArray(com.items) || !com.items.length) return null;
  return tvPremWin(ms, { startMinET: com.startMinET || TV_COMEDY_START_MIN, liveDurSec: TV_COMEDY_LEN_SEC });
}
/* Resolve tonight's Comedy Hour state from the rotation doc.
 * Pure: returns { state, doc, changed } — tvTick persists the doc
 * when a chain was locked. state is null when the block is off,
 * when the window predates the first airing, or when nothing
 * eligible exists. The night a window belongs to is its 19:00 ET
 * start's ET day, so the chain is the same at 17:00 (when
 * generation first reaches the window) and at 19:30 (mid-window)
 * — locked once, never re-drawn. */
function tvComedyResolve(cmdDoc, chan, now) {
  const doc = cmdDoc && typeof cmdDoc === "object" ? cmdDoc : tvSeedComedyHour(now);
  if (doc.on === false) return { state: null, doc, changed: false };
  const et0 = tvEtParts(now), sec0 = Math.floor((now % 60000) / 1000);
  const winStart = now - ((et0.hour * 60 + et0.minute - TV_COMEDY_START_MIN) * 60 + sec0) * 1000;
  if (winStart < TV_COMEDY_FROM_MS) return { state: null, doc, changed: false };
  const dayKey = tvEtParts(winStart).dayKey;
  const eligible = tvComedyEligible(chan);
  if (!eligible.length) return { state: null, doc, changed: false };
  let changed = false;
  let picks = null;
  if (doc.night === dayKey && Array.isArray(doc.itemIds) && doc.itemIds.length) {
    const locked = doc.itemIds.map((id) => eligible.find((x) => x.id === id) || null);
    if (locked.every(Boolean)) picks = locked;
  }
  if (!picks) {
    const ids = new Set(eligible.map((x) => x.id));
    let bag = (Array.isArray(doc.bag) ? doc.bag : []).filter((id) => ids.has(id));
    picks = [];
    const refill = () => {
      const used = new Set(picks.map((x) => x.id));
      bag = eligible.map((x) => x.id).filter((id) => !used.has(id));
      if (!bag.length) bag = eligible.map((x) => x.id);
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t2 = bag[i]; bag[i] = bag[j]; bag[j] = t2; }
    };
    if (!bag.length) refill();
    const hist = Array.isArray(doc.hist) ? doc.hist : [];
    const cutMs = Date.parse(dayKey) - 7 * 86400e3;
    const recent = new Set(hist.filter((h) => h && Date.parse(h.day || "") >= cutMs).map((h) => h.id));
    const lastNight = hist.length ? hist[hist.length - 1].id : "";
    let covered = 0;
    while (covered < TV_COMEDY_LEN_SEC) {
      if (!bag.length) refill();
      const pick = picks.length ? bag[0] : bag.find((id) => !recent.has(id) && id !== lastNight) || bag.find((id) => id !== lastNight) || bag[0];
      if (!pick) break;
      bag = bag.filter((id) => id !== pick);
      const it = eligible.find((x) => x.id === pick) || null;
      if (!it) break;
      picks.push(it); covered += +it.dur || 0;
    }
    if (picks.length) {
      doc.bag = bag; doc.night = dayKey; doc.itemIds = picks.map((x) => x.id);
      doc.hist = [...hist, ...picks.map((x) => ({ day: dayKey, id: x.id }))].slice(-42);
      doc.updatedAt = now; doc.by = "keeper";
      changed = true;
    }
  }
  if (!picks || !picks.length) return { state: null, doc, changed };
  const items = picks.map((it) => ({ ...it, show: "MW Comedy Hour" }));
  return { state: { startMinET: TV_COMEDY_START_MIN, item: items[0], items, liveDurSec: TV_COMEDY_LEN_SEC, night: dayKey }, doc, changed };
}
/* THE ADHAN (v16 — Malik, 2026-11-05 ~18:00 ET: "i want the adan
 * to play when its time to pray i want it to be a beautiful
 * recitation"; the voice picked by Malik 2026-11-05 ~19:31 ET:
 * ALAFASY): five daily windows at the prayer times for Uniontown,
 * PA (ISNA / Aladhan method 2). The times are PRECOMPUTED daily by
 * the adhan producer (record:
 * website/islamic-programming-2026-11-05/PROGRESS.md) into the
 * producer-owned doc tv/adhan — { days: { "<ET dayKey>": { fajr,
 * dhuhr, asr, maghrib, isha } (ms ET) }, updatedAt } — carrying
 * TODAY's AND TOMORROW's times, because generation lays 2 hours
 * ahead and the horizon crosses midnight. The keeper only lays:
 * a day missing from the doc (a stale producer, a missed refresh)
 * means NO adhan that day — the channel never guesses a prayer
 * time. The recitation is one pinned pair (v19): the live
 * Makkah athaan recordings on the official channel of Mufti
 * Menk — the standard cut for Dhuhr/Asr/Maghrib/Isha, and the
 * live Fajr athaan from Makkah at Fajr. (From v16 to v18 the
 * pair was Alafasy standard + Fajr; Malik changed the voice
 * pick 2026-11-06 — see the v19 note at TV_PROGRAM_V.)
 * Placement (the cartoon-span method): each prayer is placed AT
 * its exact time — cutting fill, the break bag, the ad cadence
 * and the owner queue mid-item under the split/resume rule —
 * UNLESS it would land inside a protected span, in which case it
 * SLIDES to that span's end: an hourly cartoon span, an anchor
 * edition, a laid :50 news window, the premiere/rerun, the
 * khutbah, and Family Time (in midsummer Uniontown's Maghrib
 * falls inside the movie; the movie stays whole and the adhan
 * follows it — Malik's standing defaults, 2026-11-05). The
 * Friday Dhuhr adhan is SUPPRESSED outright: Jumu'ah replaces
 * Dhuhr and the khutbah is the observance. Placed segments carry
 * adh:1 and adhKey ("<dayKey>:<prayer>") and are protected from
 * crowd-skip AND Guardian cuts (tvSkipGate); the owner skip can
 * cut one prayer (qCut.adhan, stamped by adhKey — one cut never
 * suppresses the next prayer). */
const TV_ADHAN_PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
function tvAdhanItems(now) {
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  return {
    std: { id: "adhan-menk", kind: "show", src: "yt", yt: "aZ5RxRFBu-8", title: "Adhan — Live from Makkah (Mufti Menk)", show: "🕌 Adhan", dur: 217, rights: R("The live Maghrib athaan recorded at the door of the Kaabah, on the official channel of Mufti Menk (@muftimenkofficial): YouTube oEmbed HTTP 200 with author Mufti Menk verified 2026-11-06; duration 217s double-pinned from two independent reads of the actual upload; picked by Malik 2026-11-06 knowing the recording edge cleanliness cannot be transcript-proven (no captions exist) — his word is the authorization (build record: website/adhan-menk-swap-2026-11-06/PROGRESS.md)") },
    fajr: { id: "adhan-menk-fajr", kind: "show", src: "yt", yt: "tagIhATHfPs", title: "Adhan (Fajr) — Live from Makkah (Mufti Menk)", show: "🕌 Adhan", dur: 185, rights: R("The live Fajr athaan from Makkah, on the official channel of Mufti Menk (@muftimenkofficial): YouTube oEmbed HTTP 200 with author Mufti Menk verified 2026-11-06; duration 185s double-pinned from two independent reads of the actual upload; picked by Malik 2026-11-06 with the same knowing acceptance as the standard cut — edge cleanliness unproven, his word is the authorization (build record: website/adhan-menk-swap-2026-11-06/PROGRESS.md)") },
  };
}
/* The adhan state from the producer doc: the prayer entries for
 * the ET days the doc actually carries at resolve time (today and
 * tomorrow — any other day in the doc is ignored, so a stale doc
 * yields no entries at all and no adhan is laid). Pure; spans are
 * placed by tvAdhanSpans once the keeper's window states exist. */
function tvAdhanState(doc, now, banSet) {
  if (!doc || typeof doc !== "object" || !doc.days || typeof doc.days !== "object") return null;
  const items = tvAdhanItems(now);
  if (banSet && (banSet.has(String(items.std.yt)) || banSet.has(String(items.fajr.yt)))) return null;
  if (!tvCleared(items.std) || !tvCleared(items.fajr)) return null;
  const dayKeys = [tvEtParts(now).dayKey, tvEtParts(now + 86400e3).dayKey];
  const entries = [];
  for (const dk of dayKeys) {
    const day = doc.days[dk];
    if (!day || typeof day !== "object") continue;
    for (const name of TV_ADHAN_PRAYERS) {
      const at = +day[name] || 0;
      if (!(at > 0)) continue;
      entries.push({ key: dk + ":" + name, name, dayKey: dk, at, item: name === "fajr" ? items.fajr : items.std });
    }
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.at - b.at);
  return { entries, items, spans: [] };
}
/* Place the adhan spans for [fromMs, toMs): each prayer AT its
 * time, slid forward past every protected span it would overlap
 * (the tvCartoonSpans slide discipline). Friday Dhuhr never
 * places (Jumu'ah). An owner-cut prayer (qCut.adhan === its key)
 * never places. A prayer slid more than 2 hours is dropped rather
 * than laid absurdly late — no protected span on this channel
 * runs anywhere near that long; the cap is a safety rail only. */
function tvAdhanSpans(chan, adh, fromMs, toMs) {
  if (!adh || !Array.isArray(adh.entries)) return [];
  const out = [];
  const newsLaidAt = (ws) => !(chan._qCut && chan._qCut.news === ws) && tvNewsFreshFor(chan, ws) && !tvNewsOverlapsFamily({ start: ws, end: ws + TV_NEWS_LEN * 1000 }, chan._family) && !tvNewsOverlapsKhutbah({ start: ws, end: ws + TV_NEWS_LEN * 1000 }, chan._khutbah);
  for (const e of adh.entries) {
    if (e.at < fromMs - 3600e3 || e.at >= toMs) continue;
    if (e.name === "dhuhr" && tvEtParts(e.at).weekday === "Fri") continue;
    if (chan._qCut && chan._qCut.adhan === e.key) continue;
    const durMs = (+e.item.dur || 0) * 1000;
    if (!(durMs > 0)) continue;
    let f = e.at;
    for (let i = 0; i < 10; i++) {
      const en = f + durMs;
      let push = 0;
      const consider = (w) => { if (w && f < w.end && en > w.start && w.end > push) push = w.end; };
      if (chan._cartoon && Array.isArray(chan._cartoon.spans)) for (const sp of chan._cartoon.spans) consider(sp);
      consider(tvAnchorWin(f, chan._anchor));
      { const nw1 = tvNewsWin(f); for (let k = 0; k < 2; k++) { const ws = nw1.start + k * 3600e3; if (newsLaidAt(ws)) consider({ start: ws, end: ws + TV_NEWS_LEN * 1000 }); } }
      consider(tvPremWin(f, chan._prem));
      consider(tvPremWin(f, chan._rerun));
      consider(tvFamilyWin(f, chan._family));
      consider(tvKhutbahWin(f, chan._khutbah));
      for (const sp of out) consider(sp);
      if (!(push > f)) break;
      f = push;
    }
    if (f - e.at > 2 * 3600e3) continue;
    out.push({ start: f, end: f + durMs, key: e.key, name: e.name, item: e.item });
  }
  out.sort((a, b) => a.start - b.start);
  return out.filter((sp) => sp.end > fromMs && sp.start < toMs);
}
/* The adhan window containing ms, or the next one — the
 * tvCartoonWinAt shape ({ start, end, inside } + the prayer's
 * key, name and item). */
function tvAdhanWinAt(ms, adh) {
  if (!adh || !Array.isArray(adh.spans)) return null;
  for (const sp of adh.spans) {
    if (ms >= sp.start && ms < sp.end) return { start: sp.start, end: sp.end, inside: true, key: sp.key, name: sp.name, item: sp.item };
    if (sp.start > ms) return { start: sp.start, end: sp.end, inside: false, key: sp.key, name: sp.name, item: sp.item };
  }
  return null;
}
/* The anchor news window containing ms (inside: true) or the next one,
 * over the fixed daily slots (TV_ANCHOR_SLOTS, minutes ET). anch is the
 * state built by tvAnchorLive: { slots, dur, slotMinET, producedAt }.
 * A window exists ONLY for the slot the current edition was produced
 * for (strictly its own slot — a stale edition never re-airs as new),
 * and only while the edition is fresh: produced within
 * TV_ANCHOR_FRESH_MS before the slot and never after the slot begins.
 * Same whole-hour ET offset arithmetic as tvPremWin. */
function tvAnchorWin(ms, anch) {
  if (!anch || !(anch.dur > 0) || !Array.isArray(anch.slots)) return null;
  const et = tvEtParts(ms), sec = Math.floor((ms % 60000) / 1000);
  const mins = et.hour * 60 + et.minute;
  let next = null;
  for (const slotMin of anch.slots) {
    let start = ms - ((mins - slotMin) * 60 + sec) * 1000;
    if (start > ms) start -= 86400e3;
    const end = start + anch.dur * 1000;
    if (slotMin !== anch.slotMinET) continue;
    if (ms >= start && ms < end && anch.producedAt >= start - TV_ANCHOR_FRESH_MS && anch.producedAt <= start) return { start, end, inside: true, slotMinET: slotMin };
    const nstart = start + 86400e3;
    if (anch.producedAt >= nstart - TV_ANCHOR_FRESH_MS && anch.producedAt <= nstart && (!next || nstart < next.start)) next = { start: nstart, end: nstart + anch.dur * 1000, inside: false, slotMinET: slotMin };
  }
  return next;
}
/* Which anchor edition can air: the tv/anchor doc's current edition,
 * gated by the same rights rule as every lineup item (tvCleared over a
 * synthesized program item) and by the media actually existing — the
 * file is probed like premiere files, verdict cached in tv/now, so a
 * missing file means the slot silently plays music, never dead air.
 * The doc is producer-owned (the keeper never seeds or writes it):
 * { on, current: { slotMinET, producedAt, videoUrl, dur } }, published
 * ~30 min before each slot by the anchor producer. */
async function tvAnchorLive(env, doc, nw, now, origin) {
  const cache = { ...((nw && nw.anchorProbe) || {}) };
  let cacheChanged = false;
  const cur = doc && (doc.current || (doc.videoUrl ? doc : null));
  if (!doc || doc.on === false || !cur || !cur.videoUrl || !(+cur.dur > 0) || !(+cur.producedAt > 0)) return { anch: null, cache, cacheChanged };
  const it = { id: "anchor-edition", kind: "show", src: "file", url: String(cur.videoUrl), title: "Meechie's World News — Anchor Edition", show: "MW TV News", dur: +cur.dur, rights: (cur.rights && typeof cur.rights === "object") ? cur.rights : { basis: "own", evidence: "Anchor news edition produced in-house by the site news producer from attributed public sources (Herald-Standard headlines, PennDOT 511PA traffic, NWS alerts); Malik is the publisher and rights holder of the produced segment", clearedBy: "owner", at: +cur.producedAt, simulcast: true } };
  if (!tvCleared(it)) return { anch: null, cache, cacheChanged };
  const c = cache[it.url];
  if (c && now - c.at < TV_PREM_PROBE_MS) { if (!c.ok) return { anch: null, cache, cacheChanged }; }
  else {
    const ok = await tvMediaExists(env, origin, it.url);
    cache[it.url] = { ok, at: now }; cacheChanged = true;
    if (!ok) return { anch: null, cache, cacheChanged };
  }
  return { anch: { slots: TV_ANCHOR_SLOTS, item: it, slotMinET: +cur.slotMinET, producedAt: +cur.producedAt, dur: +cur.dur }, cache, cacheChanged };
}
/* When a NEW anchor edition lands (a producedAt the laid window has
 * never seen), segments already generated past the slot would play
 * music through it. Cut them at the slot start (or at now, if the
 * slot is already open) so the normal generation re-lays from there
 * with the edition known; the program cursor re-anchors by cycle math
 * at the cut — the cold-start rule the held-item path relies on.
 * Returns null when nothing laid reaches the slot yet. */
/* Cut the laid window at cutAt WITHOUT opening a hole: segments
 * starting at/after cutAt drop, and the segment STRADDLING cutAt is
 * TRIMMED to end at cutAt instead of being dropped whole. The old
 * filter (sg.start < cutAt && end <= cutAt) dropped the straddler
 * too, and since generation resumes AT cutAt, the span between the
 * previous segment's end and cutAt was never laid — a hole the
 * client could only park on (poster + a connecting slate) for up
 * to a full re-lay grid step after nearly every quarter break, and
 * a re-lay landing mid-segment tore a playing segment's picture
 * down while its sound ran on. Trimming keeps the laid coverage
 * continuous up to the cut; the re-lay from cutAt is unchanged. */
function tvTrimAt(segs, cutAt) {
  const out = [];
  for (const sg of (segs || [])) {
    if (sg.start >= cutAt) continue;
    if (sg.start + sg.dur * 1000 <= cutAt) { out.push(sg); continue; }
    const d = Math.round((cutAt - sg.start) / 100) / 10;
    if (d > 0.05) out.push({ ...sg, dur: d });
  }
  return out;
}
function tvAnchorCut(chan, segs, cursor, anch, now) {
  const w = tvAnchorWin(now, anch);
  if (!w || !cursor || !isFinite(cursor.at)) return null;
  const cutAt = Math.max(now, w.start);
  if (cutAt >= cursor.at) return null;
  const kept = tvTrimAt(segs, cutAt);
  const cp = tvCyclePos(chan, cutAt);
  if (!cp) return null;
  return { segs: kept, cursor: { at: cutAt, ix: cp.ix, off: cp.off, run: 0 } };
}
/* Which character news update can air: the tv/charnews doc's current
 * update, gated by the same rights rule as every lineup item
 * (tvCleared over a synthesized house item) and by the media actually
 * existing — the file is probed exactly like anchor edition files,
 * verdict cached in tv/now as charProbe, so a missing file means the
 * cadence plays the spot alone, never dead air. The doc is
 * producer-owned (the keeper never seeds or writes it):
 * { on, current: { producedAt, videoUrl, dur } }, published by the
 * site news producer alongside each fresh edition. The returned char
 * state — { item, producedAt, dur } — chains onto every cadence
 * occurrence whose start it is still fresh at (tvAdSpans). */
async function tvCharLive(env, doc, nw, now, origin) {
  const cache = { ...((nw && nw.charProbe) || {}) };
  let cacheChanged = false;
  const cur = doc && (doc.current || (doc.videoUrl ? doc : null));
  if (!doc || doc.on === false || !cur || !cur.videoUrl || !(+cur.dur > 0) || !(+cur.producedAt > 0)) return { char: null, cache, cacheChanged };
  const it = { id: "charnews-update", kind: "house", src: "file", url: String(cur.videoUrl), title: "MW TV News Update", show: "MW TV News", dur: +cur.dur, rights: (cur.rights && typeof cur.rights === "object") ? cur.rights : { basis: "own", evidence: "Character news update produced in-house by the site news producer from the current published edition's attributed sources (Herald-Standard headlines, PennDOT 511PA traffic, NWS alerts); Malik is the publisher and rights holder of the produced segment", clearedBy: "owner", at: +cur.producedAt, simulcast: true } };
  if (!tvCleared(it)) return { char: null, cache, cacheChanged };
  const c = cache[it.url];
  if (c && now - c.at < TV_PREM_PROBE_MS) { if (!c.ok) return { char: null, cache, cacheChanged }; }
  else {
    const ok = await tvMediaExists(env, origin, it.url);
    cache[it.url] = { ok, at: now }; cacheChanged = true;
    if (!ok) return { char: null, cache, cacheChanged };
  }
  return { char: { item: it, producedAt: +cur.producedAt, dur: +cur.dur }, cache, cacheChanged };
}
/* Which quarter update can air: the tv/quarternews doc the news
 * producer publishes with EVERY quarter run (Malik, 2026-11-03
 * ~14:54) — a fresh ~60-second Uniontown & Fayette County update
 * produced for one specific quarter mark (current.forQuarter),
 * under a per-quarter versioned media key, so a fresh piece can
 * never serve stale bytes. Gated by the same rights rule as every
 * lineup item (tvCleared over a synthesized house item) and by the
 * media actually existing, probed exactly like the character
 * update with the verdict cached in tv/now as qProbe. The returned
 * qtr state — { item, producedAt, forQuarter, dur } — feeds the
 * ad-cadence chained update (tvAdSpans), where the freshness law
 * is enforced per occurrence; an aged-out piece simply stops
 * chaining — no cut needed on expiry. */
async function tvQuarterLive(env, doc, nw, now, origin) {
  const cache = { ...((nw && nw.qProbe) || {}) };
  let cacheChanged = false;
  const cur = doc && doc.current;
  if (!doc || doc.on === false || !cur || !cur.videoUrl || !(+cur.dur > 0) || !(+cur.producedAt > 0) || !(+cur.forQuarter > 0)) return { qtr: null, cache, cacheChanged };
  const it = { id: "quarter-update", kind: "house", src: "file", url: String(cur.videoUrl), title: "MW TV Local Update", show: "MW TV News", dur: +cur.dur, rights: { basis: "own", evidence: "Quarter local news+traffic update produced in-house by the site news producer from attributed sources (Herald-Standard and Google News headlines, PennDOT 511PA traffic, NWS alerts) for Uniontown and Fayette County; Malik is the publisher and rights holder of the produced segment", clearedBy: "owner", at: +cur.producedAt, simulcast: true } };
  if (!tvCleared(it)) return { qtr: null, cache, cacheChanged };
  const c = cache[it.url];
  if (c && now - c.at < TV_PREM_PROBE_MS) { if (!c.ok) return { qtr: null, cache, cacheChanged }; }
  else {
    const ok = await tvMediaExists(env, origin, it.url);
    cache[it.url] = { ok, at: now }; cacheChanged = true;
    if (!ok) return { qtr: null, cache, cacheChanged };
  }
  return { qtr: { item: it, producedAt: +cur.producedAt, forQuarter: +cur.forQuarter, dur: +cur.dur }, cache, cacheChanged };
}
/* When a NEW character update lands (a producedAt the laid window
 * has never seen), occurrences already generated would play the
 * spot alone. Cut them at cutAt — the first cadence occurrence
 * start after now, computed by tvTick from the NEW char state — so
 * the normal generation re-lays from there with the update chained;
 * the program cursor re-anchors by cycle math at the cut (the
 * tvAnchorCut discipline). Returns null when nothing laid reaches
 * the cut yet. Expiry needs no cut: tvAdSpans gates the update at
 * each occurrence's own start, so a stale update never lays. */
function tvCharCut(chan, segs, cursor, cutAt) {
  if (!cursor || !isFinite(cursor.at) || !isFinite(cutAt)) return null;
  if (cutAt >= cursor.at) return null;
  const kept = tvTrimAt(segs, cutAt);
  const cp = tvCyclePos(chan, cutAt);
  if (!cp) return null;
  return { segs: kept, cursor: { at: cutAt, ix: cp.ix, off: cp.off, run: 0 } };
}
/* Which produced local update can air: the tv/localupdate doc the
 * news producer publishes with every edition — its stamp IS the
 * edition stamp, and tvLuLive requires it to match tv/news' current
 * edition, so a half-published pair never airs. Gated by the same
 * rights rule as every lineup item (tvCleared over a synthesized
 * house item) and by the media actually existing, probed exactly
 * like the character update with the verdict cached in tv/now as
 * luProbe. The returned lu state — { item, at, dur } — feeds the
 * ad-cadence chained update (tvAdSpans); freshness is gated per
 * occurrence there, so an aged-out
 * edition simply stops producing hits — no cut needed on expiry. */
async function tvLuLive(env, luDoc, newsDoc, nw, now, origin) {
  const cache = { ...((nw && nw.luProbe) || {}) };
  let cacheChanged = false;
  const ed = newsDoc && newsDoc.current;
  if (!luDoc || !luDoc.url || !(+luDoc.dur > 0) || !(+luDoc.at > 0) || !ed || +ed.at !== +luDoc.at) return { lu: null, cache, cacheChanged };
  const it = { id: "brk-local-update-5", kind: "house", src: "file", url: String(luDoc.url), title: "Uniontown Local Update", show: "MW TV News", dur: +luDoc.dur, rights: { basis: "own", evidence: "Local news+traffic update produced in-house by the site news producer from the current published edition's attributed sources (Herald-Standard headlines, PennDOT 511PA traffic, NWS alerts); Malik is the publisher and rights holder of the produced segment", clearedBy: "owner", at: +luDoc.at, simulcast: true } };
  if (!tvCleared(it)) return { lu: null, cache, cacheChanged };
  const c = cache[it.url];
  if (c && now - c.at < TV_PREM_PROBE_MS) { if (!c.ok) return { lu: null, cache, cacheChanged }; }
  else {
    const ok = await tvMediaExists(env, origin, it.url);
    cache[it.url] = { ok, at: now }; cacheChanged = true;
    if (!ok) return { lu: null, cache, cacheChanged };
  }
  return { lu: { item: it, at: +luDoc.at, dur: +luDoc.dur }, cache, cacheChanged };
}
/* The movie block's standing state, from the tv/movieblock doc and
 * tonight's premiere state: the block starts when the premiere chain
 * actually ends (slot start + its live duration), or — when the
 * premiere airs nothing — TV_MOVIE_FALLBACK_MIN after the slot start
 * (20:15 ET), so the movies never wait on a missing episode. Items
 * pass the same rights gate as the whole channel (tvCleared). */
function tvMovieState(doc, premDoc, premState) {
  if (!doc || doc.on === false || !Array.isArray(doc.items)) return null;
  // ONLY FILL (v14): the movie chain no longer airs as fill — the
  // state stands down, so the span the chain used to cover belongs
  // to the narrowed fill paths (chain + breaks). The doc and its
  // seed are NOT touched: Family Time eligibility (tvFamilyEligible)
  // reads them exactly as before, and flipping TV_FILL_ONLY
  // restores the chain as it was.
  if (TV_FILL_ONLY) return null;
  const items = doc.items.filter(tvCleared);
  if (!items.length) return null;
  const totalDur = items.reduce((a, i) => a + (+i.dur || 0), 0);
  if (!(totalDur > 0)) return null;
  const startMinET = premDoc && +premDoc.startMinET ? +premDoc.startMinET : 1200;
  const offMs = premState && premState.prem && premState.prem.liveDurSec > 0 ? premState.prem.liveDurSec * 1000 : TV_MOVIE_FALLBACK_MIN * 60e3;
  return { items, startMinET, offMs, totalDur };
}
/* The movie-block window containing ms (inside: true) or the next
 * one: anchored to the day's premiere slot start plus the block
 * offset, repeating daily — the block re-arms every night. Same
 * whole-hour ET offset arithmetic as tvPremWin. */
function tvMovieWin(ms, mov) {
  if (!mov || !(mov.totalDur > 0)) return null;
  const et = tvEtParts(ms), sec = Math.floor((ms % 60000) / 1000);
  const mins = et.hour * 60 + et.minute;
  let start = ms - ((mins - mov.startMinET) * 60 + sec) * 1000;
  if (start > ms) start -= 86400e3;
  start += mov.offMs;
  let end = start + mov.totalDur * 1000;
  // A one-shot insert stamped inside this window freezes the block
  // for the span it covers (tvInsertFrozen), so the window runs
  // long by exactly that frozen span (stamped on the state in
  // tvTick as insShift/insStart; absent = the standing behaviour).
  if (mov.insShift > 0 && mov.insStart >= start && mov.insStart < end) end += mov.insShift * 1000;
  if (mov.qShift > 0 && mov.qStart >= start && mov.qStart < end) end += mov.qShift * 1000;
  // The hourly cartoon stamps its freeze the same way (crtShift):
  // the span never overlaps a precedence window, so the frozen
  // span inside the movie is always the pair's full length.
  if (mov.crtShift > 0 && mov.crtStart >= start && mov.crtStart < end) end += mov.crtShift * 1000;
  if (mov.skipShift > 0 && mov.skipStart === start) end -= mov.skipShift * 1000;
  // The ad cadence freezes the block at every spot inside it (the
  // insert freeze rule), so the window runs long by the spot time
  // laid inside it — fixed-pointed, because a longer window can
  // pull in one more spot at its tail. _cad is attached by tvGen;
  // absent (the calls tvTick makes itself) nothing changes.
  if (mov._cad) {
    let e2 = end;
    for (let i = 0; i < 4; i++) { const ext = tvAdTimeIn(mov._cad.cad, mov._cad.prem, mov._cad.anch, mov._cad.ins, start, e2, mov._cad.char, mov._cad.lu, mov._cad.rer, mov._cad.qtr); const ne = end + ext * 1000; if (!(ne > e2)) break; e2 = ne; }    end = e2;
  }
  if (ms >= start && ms < end) return { start, end, inside: true };
  if (ms < start) return { start, end, inside: false };
  const nstart = start + 86400e3;
  return { start: nstart, end: nstart + mov.totalDur * 1000, inside: false };
}
/* Boundary re-check (SPEC §1.4): embedding can be switched off after
 * an item is added, so when the on-air segment rolls over, verify the
 * NEXT program in the window — rights record still complete, not on
 * the shared ban list, and (throttled, fail-open) still returned by
 * the embed gate. A failure holds the item on the lineup itself, bans
 * the id for every surface, and reports the held id so the tick can
 * regenerate the window around it. */
async function tvRecheckNext(env, chan, segs, now, origin, nw) {
  const next = (segs || []).find((sg) => (sg.k === "prog" || sg.k === "house") && sg.start > now);
  if (!next) return "";
  const it = (chan.items || []).find((x) => x.id === next.id);
  if (!it) return "";
  let held = "";
  if (!tvCleared(it)) held = "rights record incomplete";
  if (!held && it.src === "yt") {
    try { const blk = await readDoc(env, "brain/ytblock"); if (blk && Array.isArray(blk.ids) && blk.ids.includes(it.yt)) held = "embed blocked (shared ban list)"; } catch (_) {}
    if (!held) {
      const checked = (nw && nw.checked) || {};
      if (!(checked[it.id] && now - checked[it.id] < 30 * 60e3)) {
        try {
          const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : {};
          const r = await fetch(origin + "/api/ytsearch?q=" + encodeURIComponent(it.title || it.yt) + "&page=1", ctl);
          const j = await r.json();
          if (j && j.ok && Array.isArray(j.results) && j.results.length && !j.results.some((x) => x.id === it.yt)) held = "embed gate no longer returns it";
          else { checked[it.id] = now; if (nw) nw.checked = checked; }
        } catch (_) { /* fail open: a dead relay says nothing about the video (the relay's own doctrine) */ }
      }
    }
    if (held) { try { const blk = (await readDoc(env, "brain/ytblock")) || { ids: [] }; if (Array.isArray(blk.ids) && !blk.ids.includes(it.yt)) { blk.ids.push(it.yt); await writeDoc(env, "brain/ytblock", "brain", blk); } } catch (_) {} }
  }
  if (held) {
    it.held = held; it.heldAt = now; chan.updatedAt = now; chan.by = "keeper";
    delete chan._prem;
    delete chan._rerun;
    await writeDoc(env, "tv/channel", "tv", chan);
    return it.id;
  }
  return "";
}
/* Which premiere slot items can actually air right now: cleared items
 * whose media exists. YouTube items pass on the gate/recheck rules;
 * file items are probed (1-byte range GET) with the verdict cached in
 * tv/now for TV_PREM_PROBE_MS, so a file that has not landed yet costs
 * one tiny probe per 10 minutes and the slot stays dark — never a
 * stall — until the upload exists. liveDurSec is clamped so the slot
 * can never reach the next :50 news window. The 10 PM rerun slot
 * (tv/rerun) resolves through this same function, with its own
 * probe cache key (rerunProbe) so the two slots never share a
 * verdict stamp. */
async function tvPremLive(env, prem, nw, now, origin, cacheKey) {
  const cache = { ...((nw && nw[cacheKey || "premProbe"]) || {}) };
  let cacheChanged = false;
  if (!prem || prem.on === false || !Array.isArray(prem.items)) return { prem: null, cache, cacheChanged };
  const live = [];
  for (const it of prem.items) {
    if (!tvCleared(it)) continue;
    if (it.src === "yt") { live.push(it); continue; }
    if (it.src !== "file" && it.src !== "ia") continue;
    const c = cache[it.url];
    if (c && now - c.at < TV_PREM_PROBE_MS) { if (c.ok) live.push(it); continue; }
    const ok = await tvMediaExists(env, origin, it.url);
    cache[it.url] = { ok, at: now }; cacheChanged = true;
    if (ok) live.push(it);
  }
  const liveDurSec = Math.min(2940, live.reduce((a, i) => a + (+i.dur || 0), 0));
  return { prem: live.length && liveDurSec > 0 ? { startMinET: +prem.startMinET || 1200, items: live, liveDurSec } : null, cache, cacheChanged };
}
/* Show-spot media gate: probe every gated show-spot file (the
 * seven newest pool videos + all seven radio cuts) exactly like the
 * premiere / character probes — Range bytes=0-0, verdicts cached
 * in tv/now as spotProbe for TV_PREM_PROBE_MS. Returns the set of
 * URLs that exist right now. tvTick holds any gated pool item
 * whose file is missing (the brk-local-update hold discipline) and
 * the radio decision only picks spots in the set — so a spot whose
 * media has not been uploaded yet can never lay a dead segment or
 * a silent deck, and joins rotation by itself once the file lands. */
async function tvSpotGate(env, nw, now, origin, pool) {
  const cache = { ...((nw && nw.spotProbe) || {}) };
  let cacheChanged = false;
  const urls = ["/media/my-empire-commercial-v2.mp4", "/media/my-empire-shop-station-family.mp4", "/media/my-empire-family-foundation.mp4", "/media/my-empire-12-shirts.mp4", "/media/spot-trump-grillz.mp4", "/media/spot-trump-president.mp4", "/media/spot-bandz.mp4"].concat(RADIO_SPOTS.map((sp) => sp.src));
  // Sponsor media rides the same existence probe: the video file the
  // TV spots are gated on, and the audio cut for the radio lane.
  const spnItems = ((pool && pool.items) || []).filter((x) => x && x.kind === "sponsor");
  for (const it of spnItems) { if (it.url) urls.push(it.url); if (it.audioSrc) urls.push(it.audioSrc); }
  const ok = new Set();
  for (const url of urls) {
    const c = cache[url];
    if (c && now - c.at < TV_PREM_PROBE_MS) { if (c.ok) ok.add(url); continue; }
    const good = await tvMediaExists(env, origin, url);
    cache[url] = { ok: good, at: now }; cacheChanged = true;
    if (good) ok.add(url);
  }
  // Sponsor audio cuts eligible for the radio spot lane right now:
  // approved, inside the paid week, with a probed audio file.
  const sponsors = spnItems.filter((it) => it.audioSrc && ok.has(it.audioSrc) && tvSponsorLive(it, now))
    .map((it) => ({ id: it.id, src: it.audioSrc, title: it.title || "", dur: +it.audioDur || +it.dur || 0 }));
  return { ok, cache, cacheChanged, sponsors };
}
/* The radio show-spot gate (Malik, 2026-11-03: the show
 * commercials play on the radio too, randomly): fire at most one
 * spot per RADIO_SPOT_EVERY_MS of station time, only on a live
 * Auto-DJ station with no deliberate pause standing, only a spot
 * whose audio file is actually on the site (okUrls, from
 * tvSpotGate), and never the same spot twice in a row (S.spotLast).
 * The handler serves the item through nextItem — a song boundary,
 * behind listener picks, the schedule, Malik's own queue and AI
 * stock, and never while his booth is fresh — so a spot can never
 * cut, skip or crowd out anything he or a listener put on. No
 * media, no fire — never a silent deck. */
function tvSpotDecision(S, okUrls, now, sponsorSpots) {
  if (!S || !S.live || !S.autodj || S.pausedAt) return { fire: false, why: "station-not-live" };
  if (now - (+S.spotAt || 0) < RADIO_SPOT_EVERY_MS) return { fire: false, why: "not-due" };
  // House cuts and approved sponsor cuts share this lane and its
  // rails (song boundaries, ~1 per 15 min, never twice in a row).
  const avail = RADIO_SPOTS.filter((sp) => okUrls && okUrls.has(sp.src)).map((sp) => ({ id: sp.id, src: sp.src, title: sp.title, dur: sp.dur }));
  for (const sp of (sponsorSpots || [])) avail.push(sp);
  if (!avail.length) return { fire: false, why: "no-media" };
  let pool = avail.filter((sp) => sp.id !== S.spotLast);
  if (!pool.length) pool = avail;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { fire: true, spotId: pick.id, item: { src: pick.src, title: pick.title, dur: pick.dur } };
}
/* Sponsor pool maintenance, one pass per tick: promote owner-approved
 * claims from the sponsor_claims table into the pool (the ONLY door a
 * sponsor spot enters rotation through), and hold any sponsor spot
 * that is unapproved, past its paid week, or missing its media file,
 * so it stops airing automatically. */
async function tvSponsorMaintain(env, pool, spotOk, now) {
  let changed = false;
  try {
    const rows = ((await env.DB.prepare("select id, data from sponsor_claims where status = 'approved'").all()).results) || [];
    for (const r of rows) {
      let c = null; try { c = JSON.parse(r.data || "{}"); } catch (_) {}
      if (!c || !tvSponsorClaimReady(c, now)) continue;
      if ((pool.items || []).some((x) => x && x.sponsor && x.sponsor.claimId === c.id)) continue;
      const probe = await tvMediaExists(env, "", c.mediaUrl);
      if (!probe) continue;
      pool.items.push(tvSponsorItemFromClaim(c, now));
      changed = true;
      try { c.status = "live"; c.poolItemId = "spn-" + c.id; c.promotedAt = now; await env.DB.prepare("update sponsor_claims set status = 'live', data = ?, updated_at = ? where id = ?").bind(JSON.stringify(c), now, c.id).run(); } catch (_) {}
    }
  } catch (_) {}
  for (const it of (pool.items || [])) {
    if (!it || it.kind !== "sponsor") continue;
    const wantHeld = !tvSponsorLive(it, now) || (spotOk && it.url && !spotOk.has(it.url));
    if (wantHeld && !it.held) { it.held = true; changed = true; }
    else if (!wantHeld && it.held) { delete it.held; changed = true; }
  }
  if (changed) { pool.updatedAt = now; pool._dirty = true; await writeDoc(env, "tv/breakpool", "tv", pool); }
}
/* Play tally: count sponsor segments that actually aired. A segment
 * counts once, when the keeper's laid timeline shows its start has
 * passed; countedThrough is the watermark so a re-laid timeline never
 * double-counts, and starts closer than half the spot's own duration
 * to the previous counted start are the same airing split by a
 * re-lay seam, not a new play. lastOnline is the site's own online
 * count at the most recent airing — labelled exactly that, never an
 * estimate. */
async function tvSponsorTally(env, pool, segs, now, online) {
  if (!pool || !Array.isArray(pool.items) || !Array.isArray(segs)) return;
  let changed = false;
  for (const it of pool.items) {
    if (!it || it.kind !== "sponsor") continue;
    if (!it.tally || typeof it.tally !== "object") it.tally = { served: 0, radioServed: 0, lastAt: 0, lastOnline: 0, countedThrough: 0 };
    const t = it.tally;
    const mine = segs.filter((sg) => sg && sg.id === it.id && sg.start <= now).sort((a, b) => a.start - b.start);
    let lastCounted = +t.countedThrough || 0, n = 0;
    for (const sg of mine) {
      if (sg.start <= (+t.countedThrough || 0)) continue;
      if (lastCounted > 0 && sg.start - lastCounted < (+it.dur || 0) * 500) { lastCounted = sg.start; continue; }
      n++; lastCounted = sg.start;
    }
    if (n > 0) {
      t.served = (+t.served || 0) + n;
      t.countedThrough = lastCounted; t.lastAt = lastCounted;
      if (online != null) t.lastOnline = online;
      changed = true;
    }
  }
  if (changed) { pool.updatedAt = now; await writeDoc(env, "tv/breakpool", "tv", pool); }
}
/* MWTV-GUARDIAN-BEGIN — THE GUARDIAN (Malik, 2026-11-03 19:51 ET:
 * "put a bot that watches the tv chanel for meechie to fix it",
 * 19:56 ET "Give meechie eyes", and the quality mandate the same
 * night: MW TV must be THE BEST CHANNEL IN THE WORLD — "its
 * meechies world" — so the defect bar is ZERO TOLERANCE: dead air,
 * a dead/unplayable title occupying the channel, a stuck or
 * looping segment, or a stale piece airing are all defects.)
 *
 * WHAT THE GUARDIAN IS: a permanent watcher that lives in two
 * places. (1) HERE, inside the keeper: every tick it reads the
 * fault reports real seats filed through /api/tv/guardian (the
 * dj.js channel surface reports its own player errors; the
 * watcher seat's client does too), keeps the per-program watch
 * records Meechie learns from (brain/tvwatch), and applies the
 * SAFE FIXES below. (2) A goal-owned cron (mwtv-guardian, every
 * ~10 min) does independent doc checks + an hourly browser-seat
 * check WITH SCREENSHOTS (Meechie Eyes) and reports defects to
 * Malik — the keeper half never talks to chat itself.
 *
 * THE ONLY HANDS (everything else is detect + log + report):
 *  (a) ADVANCE a segment CONFIRMED unplayable from real seats
 *      (>= TV_GUARD_CONFIRM_SEATS distinct seats with hard player
 *      errors on the instance on air) through tvAdvanceChannel —
 *      and only when tvSkipGate (called with by:"guardian", the
 *      crowd protections) lets it: news, premiere, rerun, anchor,
 *      insert and owner-queue segments are NEVER guardian-cut;
 *      they are logged + reported instead. Owner actions are
 *      never second-guessed: an owner skip/queue is a decision,
 *      not a fault.
 *  (b) QUARANTINE a title on its 2nd confirmed-dead airing:
 *      its yt id joins brain/ytblock (the shared ban list the
 *      insert/queue doors already respect) and the item itself
 *      is held (it.held — the disable tvCleared enforces on
 *      every pick path) in whichever lineup doc carries it.
 *  (c) BANNED-ON-AIR: a segment whose yt id is on brain/ytblock
 *      or the permanent watchlist below must never occupy the
 *      channel, whatever doc laid it (seed, stored lineup doc or
 *      owner insert — the _Tu_SAqNinU incident, 2026-11-03, came
 *      from a STORED doc while no seed contained it). Laid banned
 *      segments are logged once per instance; the one on air NOW
 *      is cut through the same gate + advancer when its class is
 *      unprotected (a ban is a house decision, stronger evidence
 *      than a fault report); protected classes are log + report
 *      only, exactly like a confirmed-dead refusal.
 * Holes and stalls are detected and logged (the re-lay is the
 * generation code's own job); a hole that persists is the cron's
 * report to make. Code fixes are NEVER the Guardian's: they
 * become brain/proposals through the nightly self-review.
 * The Guardian never touches the radio (the wall), never touches
 * money or member data, and every observation, fix and refusal
 * is written to brain/selflog through the hands log (actor
 * "Meechie"), where Malik can read it.
 *
 * WATCH RECORDS (TV LEARNING): when a program segment rolls off
 * the air, the pass finalizes its record into brain/tvwatch —
 * what aired (title, source/channel strand, kind), how long it
 * held vs its full length, how it ended (completed / owner-skip /
 * crowd-skip / guardian-advance / cut / cut-window) and the
 * final vote tallies from tv/votes. Eyes reads (sampled-frame
 * vision descriptions filed through the endpoint) fold in here
 * too. The nightly self-review READS brain/tvwatch: its metrics,
 * notes, look-book digest and proposals now cite TV evidence —
 * what the crowd finishes, loves, skips fast and kills. */
const TV_WATCH_MIN_DUR = 45;   // shorter laid pieces (spots/idents) are not watch-recorded
const TV_WATCH_RECENT_CAP = 80;
const TV_WATCH_EYES_CAP = 40;
const TV_GUARD_LOG_CAP = 120;
/* Permanent Guardian watchlist: ids that are defects on sight,
 * forever, whatever doc lays them. _Tu_SAqNinU = "THE OLD
 * BODYGUARD" (uploader "Vid Evolution Action Movies", an
 * aggregator, NOT cleared): the player region check proved it
 * UNPLAYABLE for US viewers (availability list covers 239
 * countries, US absent; explicit country subreason) while
 * oEmbed answered 200 — oEmbed can NEVER clear this class; the
 * region/availability evidence is the detector. Deliberately
 * NOT listed: xv-70a6yXfM (Bring Me The Horizon "LosT") — its
 * probe said LOGIN_REQUIRED (age-gate); a bare probe status is
 * not evidence (the same probe called all 117 lineup ids
 * UNPLAYABLE, including titles airing fine), so that one is a
 * seat-decides watch item for the cron, never an auto-action. */
const TV_GUARD_WATCHLIST = ["_Tu_SAqNinU"];

function tvGuardEmptyWatch() { return { v: 1, updatedAt: 0, recent: [], days: {}, eyes: [] }; }

/* Fold one finished program record into brain/tvwatch (pure doc
 * mutation; the caller persists). Deduped by instance key — a
 * record the Guardian wrote at advance time is never doubled by
 * the rollover finalizer. */
function tvWatchFold(doc, rec, dayKey) {
  if (!doc || !rec || !rec.key) return false;
  if (!Array.isArray(doc.recent)) doc.recent = [];
  if (doc.recent.some((r) => r && r.key === rec.key)) return false;
  doc.recent.push(rec);
  if (doc.recent.length > TV_WATCH_RECENT_CAP) doc.recent = doc.recent.slice(-TV_WATCH_RECENT_CAP);
  if (!doc.days || typeof doc.days !== "object") doc.days = {};
  const d = doc.days[dayKey] || (doc.days[dayKey] = { aired: 0, completed: 0, ownerSkip: 0, crowdSkip: 0, guardian: 0, cut: 0, cutWindow: 0, byId: {} });
  d.aired += 1;
  if (rec.outcome === "completed") d.completed += 1;
  else if (rec.outcome === "owner-skip") d.ownerSkip += 1;
  else if (rec.outcome === "crowd-skip") d.crowdSkip += 1;
  else if (rec.outcome === "guardian-advance") d.guardian += 1;
  else if (rec.outcome === "cut-window") d.cutWindow += 1;
  else d.cut += 1;
  if (!d.byId || typeof d.byId !== "object") d.byId = {};
  const b = d.byId[rec.id] || (d.byId[rec.id] = { title: rec.title || "", aired: 0, completed: 0, kills: 0, up: 0, down: 0 });
  b.title = rec.title || b.title;
  b.aired += 1;
  if (rec.outcome === "completed") b.completed += 1;
  if (rec.outcome === "crowd-skip" || rec.outcome === "guardian-advance") b.kills += 1;
  b.up += rec.up | 0; b.down += rec.down | 0;
  const idKeys = Object.keys(d.byId);
  if (idKeys.length > 80) for (const k of idKeys.slice(0, idKeys.length - 80)) delete d.byId[k];
  const cutoff = tvEtParts(Math.max(0, (rec.at || 0) - 8 * 864e5)).dayKey;
  for (const k of Object.keys(doc.days)) if (k < cutoff) delete doc.days[k];
  doc.updatedAt = rec.at || Date.now();
  return true;
}

/* Guardian log line inside tv/guardian (the cron reads these to
 * report defects) + the matching brain/selflog entry through the
 * hands log, so Meechie's own record carries it too. The selflog
 * write is fire-and-forget: the log must never break the tick. */
function tvGuardLog(env, gDoc, entry) {
  if (!Array.isArray(gDoc.log)) gDoc.log = [];
  gDoc.log.push(entry);
  if (gDoc.log.length > TV_GUARD_LOG_CAP) gDoc.log = gDoc.log.slice(-TV_GUARD_LOG_CAP);
  try {
    const p = HANDS.handsLog(env, { action: "tv.guardian." + (entry.kind || "note"), target: entry.target || "tv/now", summary: entry.summary || "", by: "guardian", role: "system" });
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

/* Continuity scan of the laid timeline: holes between consecutive
 * segments (the #628 law is zero holes). Returns the holes whose
 * END is past the watermark, so each distinct hole is counted
 * once even though every tick re-lays the same window. */
function tvGuardHoles(segs, watermark) {
  const out = [];
  if (!Array.isArray(segs)) return out;
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1], cur = segs[i];
    if (!prev || !cur) continue;
    const prevEnd = prev.start + (+prev.dur || 0) * 1000;
    const gap = cur.start - prevEnd;
    if (gap > 150 && prevEnd > (watermark || 0)) out.push({ at: prevEnd, gapMs: gap, before: cur.id || "", beforeTitle: cur.title || "" });
  }
  return out;
}
/* MWTV-GUARDIAN-HELPERS-END */
/* F6-MITIGATED light check (see TV_TICK_FULL_MS at the stamp
 * declarations): read ONLY the three action docs and say whether
 * one carries work the full tick must answer NOW. The stamps
 * remember what this isolate already pulled a tick for, so a
 * request the tick saw but left standing (a protected refusal, a
 * crowd request naming another segment, a fault record awaiting
 * more seats) never re-pulls on every check — new evidence (a
 * newer skipAt, a new filing, a higher hard-seat count, a new
 * eyes batch) is what pulls again. A rewind of tv/queue (doc
 * replaced, skipAt smaller) resyncs the stamp down so a future
 * skip can never be masked by a stale one. Failure-silent by
 * contract: the caller treats a throw as "no". */
async function tvLightPending(env, now) {
  const qu = await readDoc(env, "tv/queue");
  const skipAt = qu ? (+qu.skipAt || 0) : 0;
  if (skipAt > tvLightSkipAt) { tvLightSkipAt = skipAt; return true; }
  if (skipAt < tvLightSkipAt) tvLightSkipAt = skipAt;
  const sk = await readDoc(env, "tv/skip");
  if (sk && !sk.consumedAt && (+sk.at || 0) > 0 && now - (+sk.at || 0) < 180e3 && (+sk.at || 0) !== tvLightCrowdAt) { tvLightCrowdAt = +sk.at || 0; return true; }
  const gd = await readDoc(env, "tv/guardian");
  if (gd && typeof gd === "object" && !Array.isArray(gd)) {
    if (Array.isArray(gd.eyes) && gd.eyes.length) {
      const e = gd.eyes[gd.eyes.length - 1];
      const ek = (e && e.segKey ? String(e.segKey) : "") + "@" + ((e && +e.at) || 0) + "#" + gd.eyes.length;
      if (ek !== tvLightEyesKey) { tvLightEyesKey = ek; return true; }
    }
    const faults = gd.faults && typeof gd.faults === "object" ? gd.faults : {};
    for (const k of Object.keys(faults)) {
      const hs = tvGuardHardSeats(faults[k]);
      if (hs >= TV_GUARD_CONFIRM_SEATS && k + ":" + hs !== tvLightGuardKey) { tvLightGuardKey = k + ":" + hs; return true; }
    }
  }
  return false;
}
async function tvTick(env, S, now, origin, online) {
  let chan = await readDoc(env, "tv/channel");
  if (!chan || !Array.isArray(chan.items) || !chan.items.length || (+chan.progV || 0) < TV_PROGRAM_V) { chan = tvSeedChannel(now); await writeDoc(env, "tv/channel", "tv", chan); }
  let pool = await readDoc(env, "tv/breakpool");
  if (!pool || !Array.isArray(pool.items) || !pool.items.length || (+pool.progV || 0) < TV_PROGRAM_V) { pool = tvSeedPool(now); await writeDoc(env, "tv/breakpool", "tv", pool); }
  // Paid sponsors: promotion + expiry/approval gate (their media
  // existence joins the spot probe below; the hold for a missing
  // file lands on the next tick, same discipline as the house
  // spots in TV_SPOT_GATE_IDS). pool._dirty is persisted by the
  // writes further down this tick.
  try { await tvSponsorMaintain(env, pool, null, now); } catch (_) {}
  let prem = await readDoc(env, "tv/premiere");
  if (!prem || !Array.isArray(prem.items) || !prem.items.length || (+prem.progV || 0) < TV_PREM_V) { prem = tvSeedPremiere(now); await writeDoc(env, "tv/premiere", "tv", prem); }
  let rerun = await readDoc(env, "tv/rerun");
  if (!rerun || !Array.isArray(rerun.items) || !rerun.items.length || (+rerun.progV || 0) < TV_RERUN_V) { rerun = tvSeedRerun(now); await writeDoc(env, "tv/rerun", "tv", rerun); }
  let famDoc = await readDoc(env, "tv/familytime");
  if (!famDoc || (+famDoc.progV || 0) < TV_FAMILY_V) { famDoc = tvSeedFamilyTime(now); await writeDoc(env, "tv/familytime", "tv", famDoc); }
  let khuDoc = await readDoc(env, "tv/khutbah");
  if (!khuDoc || (+khuDoc.progV || 0) < TV_KHUTBAH_V) { khuDoc = tvSeedKhutbah(now); await writeDoc(env, "tv/khutbah", "tv", khuDoc); }
  let cmdDoc = await readDoc(env, "tv/comedyhour");
  if (!cmdDoc || (+cmdDoc.progV || 0) < TV_COMEDY_V) { cmdDoc = tvSeedComedyHour(now); await writeDoc(env, "tv/comedyhour", "tv", cmdDoc); }
  const adhanDoc = await readDoc(env, "tv/adhan");
  let movies = await readDoc(env, "tv/movieblock");
  if (!movies || !Array.isArray(movies.items) || (+movies.progV || 0) < TV_MOVIE_V) { movies = tvSeedMovieBlock(now); await writeDoc(env, "tv/movieblock", "tv", movies); }
  let insDoc = await readDoc(env, "tv/insert");
  if (!insDoc || (+insDoc.progV || 0) < TV_INSERT_V) { insDoc = tvSeedInsert(now); await writeDoc(env, "tv/insert", "tv", insDoc); }
  const newsDoc = await readDoc(env, "tv/news");
  const luDoc = await readDoc(env, "tv/localupdate");
  const anchorDoc = await readDoc(env, "tv/anchor");
  const charDoc = await readDoc(env, "tv/charnews");
  const qDoc = await readDoc(env, "tv/quarternews");
  const quDoc0 = await readDoc(env, "tv/queue");
  // Viewer voting (2026-11-03): the tallies doc the vote endpoint
  // writes (pool weighting via chan._voteNet below) and the
  // crowd-skip request doc — the vote endpoint files a request
  // when 5 distinct viewers vote 👎 on the segment on air; the
  // gated block further down answers it through tvAdvanceChannel.
  const votesDoc = await readDoc(env, "tv/votes");
  const guardDoc0 = await readDoc(env, "tv/guardian");
  let skipDoc = await readDoc(env, "tv/skip");
  // SHARED BAN GATE (see tvBanGate above): seed the confirmed ban
  // into brain/ytblock and purge every banned yt from every doc
  // this tick lays from, BEFORE any window state is built — so no
  // source (seed, stored doc, cycle, insert, queue, pool,
  // premiere, rerun) can lay a banned video from this tick on.
  // banSet rides forward to the laid-window cut below.
  const banDocs = { chan, pool, prem, rerun, movies, insDoc, quDoc: quDoc0 };
  const banGate = await tvBanGate(env, now, banDocs);
  chan = banDocs.chan; pool = banDocs.pool; prem = banDocs.prem; rerun = banDocs.rerun; movies = banDocs.movies; insDoc = banDocs.insDoc;
  const quDocP = banDocs.quDoc;
  const banSet = banGate.banSet;
  const decision = tvRadioDecision(S, qDoc, now);
  // Uniontown Local Update hold-by-age: the break spot is only as
  // fresh as its producer stamp (tv/localupdate, written hourly by
  // the news producer). Past TV_LOCAL_HOLD_MS — or with no stamp at
  // all — the item is held out of rotation through the same `held`
  // flag tvCleared already enforces everywhere: zero client change.
  const luItem = (pool.items || []).find((x) => x.id === "brk-local-update");
  if (luItem) {
    const luHeld = !(luDoc && +luDoc.at > 0) || now - (+luDoc.at) > TV_LOCAL_HOLD_MS;
    if (!!luItem.held !== luHeld) {
      if (luHeld) luItem.held = true; else delete luItem.held;
      pool.updatedAt = now;
      await writeDoc(env, "tv/breakpool", "tv", pool);
    }
  }
  // Show-spot media gate (tvSpotGate): hold any gated pool spot
  // whose file is not on the site yet and unhold it the moment the
  // file lands — the brk-local-update hold discipline, driven by
  // media existence instead of age. The same verdicts feed the
  // radio spot decision attached to this tick's decision, so the
  // radio lane works even while the TV channel is off or down.
  const nwEarly = await readDoc(env, "tv/now");
  const spotState = await tvSpotGate(env, nwEarly, now, origin, pool);
  for (const it of (pool.items || [])) {
    if (!TV_SPOT_GATE_IDS.includes(it.id)) continue;
    const held = !spotState.ok.has(it.url);
    if (!!it.held !== held) {
      if (held) it.held = true; else delete it.held;
      pool.updatedAt = now;
      await writeDoc(env, "tv/breakpool", "tv", pool);
    }
  }
  // Sponsor spots: hold the ones whose video file has gone missing
  // (their approval/expiry hold is tvSponsorMaintain's, above).
  for (const it of (pool.items || [])) {
    if (!it || it.kind !== "sponsor" || !it.url) continue;
    if (!spotState.ok.has(it.url) && !it.held) { it.held = true; pool.updatedAt = now; await writeDoc(env, "tv/breakpool", "tv", pool); }
    else if (spotState.ok.has(it.url) && it.held && tvSponsorLive(it, now)) { delete it.held; pool.updatedAt = now; await writeDoc(env, "tv/breakpool", "tv", pool); }
  }
  decision.spot = tvSpotDecision(S, spotState.ok, now, spotState.sponsors);
  if (chan.on === false) {
    const nw0 = await readDoc(env, "tv/now");
    if (!nw0 || !nw0.off) await writeDoc(env, "tv/now", "tv", { off: true, segs: [], updatedAt: now });
    if (spotState.cacheChanged) { const base0 = nw0 && nw0.off ? nw0 : { off: true, segs: [], updatedAt: now }; await writeDoc(env, "tv/now", "tv", { ...base0, spotProbe: spotState.cache, updatedAt: now }); }
    return decision;
  }
  if (!(chan.items || []).some(tvCleared)) {
    const nw0 = await readDoc(env, "tv/now");
    if (!nw0 || !nw0.down) await writeDoc(env, "tv/now", "tv", { down: true, segs: [], updatedAt: now });
    if (spotState.cacheChanged) { const base0 = nw0 && nw0.down ? nw0 : { down: true, segs: [], updatedAt: now }; await writeDoc(env, "tv/now", "tv", { ...base0, spotProbe: spotState.cache, updatedAt: now }); }
    return decision;
  }
  let nw = await readDoc(env, "tv/now");
  const premState = await tvPremLive(env, prem, nw, now, origin);
  chan._prem = premState.prem;
  const rerunState = await tvPremLive(env, rerun, nw, now, origin, "rerunProbe");
  chan._rerun = rerunState.prem;
  const luState = await tvLuLive(env, luDoc, newsDoc, nw, now, origin);
  chan._lu = luState.lu;
  const luStamp = luState.lu ? luState.lu.at : 0;
  const qtrState = await tvQuarterLive(env, qDoc, nw, now, origin);
  chan._qtr = qtrState.qtr;
  const cartoonState = await tvCartoonLive(env, nw, now, origin);
  // The :50 news window's lay gate (v11): the current edition's
  // stamp off tv/news, in the same attached-state shape as _qtr —
  // tvGen lays a news window only when this is fresh for it.
  chan._newsEd = newsDoc && newsDoc.current && newsDoc.current.videoUrl ? { at: +newsDoc.current.at || 0 } : null;
  const qStampSeen = qtrState.qtr ? qtrState.qtr.forQuarter : 0;
  chan._movies = tvMovieState(movies, prem, premState);
  // FAMILY TIME: resolve tonight's state (premiere yield + the
  // night's locked pick) from the post-ban-gate docs; persist the
  // rotation doc only when a new pick was locked.
  const famRes = tvFamilyResolve(famDoc, chan, movies, premState, now);
  chan._family = famRes.state;
  if (famRes.changed) { famDoc = famRes.doc; await writeDoc(env, "tv/familytime", "tv", famDoc); }
  // FRIDAY KHUTBAH (v16): resolve the Friday state from the
  // rotation doc (the familytime discipline — persist only when a
  // pick was locked). The ban gate's set rides in, so a banned
  // sermon can never be picked.
  const khuRes = tvKhutbahResolve(khuDoc, now, banSet);
  chan._khutbah = khuRes.state;
  if (khuRes.changed) { khuDoc = khuRes.doc; await writeDoc(env, "tv/khutbah", "tv", khuDoc); }
  // COMEDY HOUR (Fix #2B): resolve tonight's chain from the
  // rotation doc (the familytime discipline — persist only when
  // a chain was locked). Eligibility reads the post-ban-gate
  // cycle, so a banned special can never be picked.
  const cmdRes = tvComedyResolve(cmdDoc, chan, now);
  chan._comedy = cmdRes.state;
  if (cmdRes.changed) { cmdDoc = cmdRes.doc; await writeDoc(env, "tv/comedyhour", "tv", cmdDoc); }
  // THE ADHAN (v16): the state from the producer-owned tv/adhan
  // doc — the entries for the days it actually carries (today and
  // tomorrow, or nothing at all). Spans are placed further down,
  // once the cartoon spans exist (placement slides past them).
  chan._adhan = tvAdhanState(adhanDoc, now, banSet);
  chan._voteNet = tvVoteNetMap(votesDoc);
  let segs = nw && Array.isArray(nw.segs) ? nw.segs : null;
  let cursor = nw && nw.cursor && isFinite(nw.cursor.at) ? nw.cursor : null;
  let dirty = false;
  if (nw && nw.chanAt && chan.updatedAt && nw.chanAt !== chan.updatedAt) { segs = null; cursor = null; }
  if (segs) { const kept = segs.filter((sg) => sg.start + sg.dur * 1000 > now - TV_KEEP); if (kept.length !== segs.length) { segs = kept; dirty = true; } }
  if (!cursor || !segs || cursor.at < now - 600e3) {
    const cp = tvCyclePos(chan, now);
    if (!cp) return decision;
    cursor = { at: now - Math.round(cp.off * 1000), ix: cp.ix, off: cp.off, run: 0 };
    segs = [];
    dirty = true;
  }
  // BAN GATE — laid window: a segment laid before the ban landed
  // (or from a doc purged above) can still be sitting in tv/now,
  // possibly ON AIR right now. Cut the window at now and re-anchor
  // the cursor by cycle math — the insert-fire discipline — so
  // this tick's generation re-lays from here with the banned video
  // gone. The movie chain needs no cursor help: its positions are
  // wall-clock, recomputed from the purged doc on the same pass.
  if (segs && cursor && tvBanInWindow(segs, banSet, now)) {
    const cpB = tvCyclePos(chan, now);
    if (cpB) { segs = tvTrimAt(segs, now); cursor = { at: now, ix: cpB.ix, off: cpB.off, run: 0 }; dirty = true; }
  }
  // Anchor editions: resolve the current edition (rights gate + media
  // probe) and, when a NEW edition has landed since the laid window
  // was generated, cut the laid segments at its slot so this tick's
  // generation re-lays through the slot with the edition on air.
  const anchorState = await tvAnchorLive(env, anchorDoc, nw, now, origin);
  chan._anchor = anchorState.anch;
  const anchStamp = anchorState.anch ? anchorState.anch.producedAt : 0;
  if (anchorState.cacheChanged) dirty = true;
  if ((+((nw || {}).anchAt) || 0) !== anchStamp) {
    dirty = true; // persist the new stamp in this tick's tv/now write
    if (anchorState.anch && segs && cursor) {
      const cut = tvAnchorCut(chan, segs, cursor, anchorState.anch, now);
      if (cut) { segs = cut.segs; cursor = cut.cursor; }
    }
  }
  // Character news updates: resolve the current update (rights gate
  // + media probe) and, when a NEW update has landed since the laid
  // window was generated (charStamp in tv/now differs), cut the laid
  // segments at the first cadence occurrence start after now —
  // computed with the NEW state — so this tick's generation re-lays
  // the upcoming occurrences with the update chained after the spot.
  const charState = await tvCharLive(env, charDoc, nw, now, origin);
  chan._char = charState.char;
  const charStamp = charState.char ? charState.char.producedAt : 0;
  if (charState.cacheChanged) dirty = true;
  // CARTOON CUT GUARD (v3, 2026-11-05): the two re-lay cuts below
  // (the character-stamp cut and the cadence-chain relay cut)
  // must never land inside a cartoon span — see tvCartoonCutGuard.
  // The tick's own spans are attached further down; this snapshot
  // runs the same computation on the same attached states for
  // cut placement only (the insert/queue states attach later and
  // do not move cartoon spans laid this tick).
  const crtCutSpans = cartoonState.crt ? tvCartoonSpans(chan, { items: cartoonState.crt.items, total: cartoonState.crt.total, spots: tvCartoonSpots(pool) }, now - 3600e3, now + TV_HORIZON + 3600e3, (nw && nw.crtWin) || []) : [];
  if ((+((nw || {}).charStamp) || 0) !== charStamp) {
    dirty = true; // persist the new stamp in this tick's tv/now write
    if (segs && cursor) {
      const cadCut = tvAdCadItems(pool);
      const spansCut = cadCut ? tvAdSpans(cadCut, chan._prem, chan._anchor, chan._insert, now, now + TV_HORIZON, charState.char, luState.lu, chan._rerun, qtrState.qtr) : [];
      const nextOcc = spansCut.find((sp) => sp.start > now);
      if (nextOcc) {
        const cut = tvCharCut(chan, segs, cursor, tvCartoonCutGuard(crtCutSpans, nextOcc.start));
        if (cut) { segs = cut.segs; cursor = cut.cursor; }
      }
    }
  }
  // Cadence-chain re-lay: when a NEW edition's local update lands
  // (or the character state changed above), cadence occurrences
  // already laid would chain nothing — or the old update — after
  // the spot. Cut at the next re-lay grid point after now so this
  // tick's generation re-lays the cadence chain from there (same
  // tvCharCut discipline). Stamp changes ride this tick's tv/now
  // write, so the cut fires once per new edition.
  if ((+((nw || {}).luStamp) || 0) !== luStamp || (+((nw || {}).charStamp) || 0) !== charStamp || (+((nw || {}).qStamp) || 0) !== qStampSeen || qtrState.cacheChanged) {
    dirty = true; // persist the new stamps in this tick's tv/now write
    if (segs && cursor) {
      const mark = tvCartoonCutGuard(crtCutSpans, (Math.floor(now / TV_RELAY_GRID_MS) + 1) * TV_RELAY_GRID_MS);
      if (mark < cursor.at) {
        const cut = tvCharCut(chan, segs, cursor, mark);
        if (cut) { segs = cut.segs; cursor = cut.cursor; }
      }
    }
  }
  // NEWS WINDOW REFILL (2026-11-05 — see tvNewsRefillCut): the
  // cadence re-lay above only re-chains the quarter rail; it does
  // not guarantee the :50 window itself. When the window we are
  // inside was laid before its edition landed, refill its span
  // from the next segment boundary — at most once per window, the
  // refill stamped in tv/now as newsRefill (alongside skipNote /
  // gNote) so the Guardian can see it happened.
  let newsRefill = nw && nw.newsRefill && now - (+nw.newsRefill.at || 0) < 3600e3 ? nw.newsRefill : null;
  if (segs && cursor) {
    const rf = tvNewsRefillCut(chan, segs, cursor, now, (nw && nw.qCut && nw.qCut.news) || 0, newsRefill ? newsRefill.win : 0, crtCutSpans);
    if (rf) { segs = rf.segs; cursor = rf.cursor; newsRefill = { win: rf.win, at: now, to: rf.to }; dirty = true; }
  }
  // One-shot insert: when a fresh, unconsumed, cleared tv/insert
  // doc appears, stamp its window, cut the laid timeline there —
  // the anchor-cut discipline: the program cursor re-anchors by
  // cycle math at the cut — and mark the doc consumed in the same
  // tick, so the insert lays exactly once. Where the window stamps
  // depends on the order: a v1 order stamps at the end of the
  // segment playing right now (owner: "after the next song"); a v2
  // order carries startAt — still ahead, the window stamps there;
  // already reached, it stamps at now (the anchor rule for a window
  // already open) — unless the block can no longer finish before
  // the doc's hard endBy, in which case it never fires at all
  // rather than run late across the line. If the first item
  // ordered is already on air (the movie block got there first),
  // the order is satisfied as-is: consume without a window.
  let insWin = nw && nw.insWin && nw.insWin.item ? nw.insWin : null;
  // BAN GATE — a stamped insert window carrying a banned video
  // dies with the ban: the window state rides tv/now, so dropping
  // it here ends the insert on this tick's write (and the
  // laid-window cut above has already cut its segments).
  if (insWin && banSet.size && ((insWin.item && insWin.item.yt && banSet.has(String(insWin.item.yt))) || (Array.isArray(insWin.items) && insWin.items.some((x) => x && x.yt && banSet.has(String(x.yt)))))) insWin = null;
  const insList = tvInsertItems(insDoc);
  if (insList && (!insWin || insWin.at !== (+insDoc.at || 0))) {
    const cur = segs ? tvSegAt(segs, now) : null;
    if (cur && cur.yt && cur.yt === insList.items[0].yt) {
      insDoc = { ...insDoc, consumedAt: now, consumedNote: "already-on-air", updatedAt: now };
      await writeDoc(env, "tv/insert", "tv", insDoc);
    } else {
      const startAt = +insDoc.startAt || 0, endBy = +insDoc.endBy || 0;
      let cutAt = 0, skipFire = false;
      if (startAt > now) { cutAt = startAt; if (endBy && startAt + insList.total * 1000 > endBy) skipFire = true; }
      else if (startAt && endBy && now + insList.total * 1000 > endBy) skipFire = true;
      else if (startAt) cutAt = now;
      else {
        cutAt = cur ? cur.start + Math.round(cur.dur * 1000) : 0;
        if (!(cutAt > now)) { const cp0 = tvCyclePos(chan, now); const it0 = cp0 ? (chan.items || [])[cp0.ix] : null; cutAt = it0 ? now + Math.round((+it0.dur - cp0.off) * 1000) : now; }
      }
      let fired = false;
      if (!skipFire) {
        if (segs && cursor && cursor.at > cutAt) {
          const cp = tvCyclePos(chan, cutAt);
          if (cp) { segs = tvTrimAt(segs, cutAt); cursor = { at: cutAt, ix: cp.ix, off: cp.off, run: 0 }; fired = true; }
        } else if (cursor) fired = true; // nothing laid past the boundary: the window edge in tvGen makes the cut
      }
      if (fired) {
        insWin = { at: +insDoc.at || 0, start: cutAt, dur: insList.total, item: insList.items[0], items: insList.items };
        insDoc = { ...insDoc, consumedAt: now, consumedStart: cutAt, updatedAt: now };
        await writeDoc(env, "tv/insert", "tv", insDoc);
        dirty = true;
      }
    }
  }
  // Outage self-heal (2026-11-03): a tick that consumed an insert
  // wrote consumedAt/consumedStart to tv/insert, but if that tick
  // died before this tick's tv/now write — the CPU outage did
  // exactly that — the doc stays consumed with no window stamped
  // here, and tvInsertItems returns null for a consumed doc, so
  // the window would never be laid. When the doc's consumed
  // window is still ahead and the window held here is not that
  // doc's, re-stamp it from the doc (same cleared items, same
  // total): the decision was made and recorded; only its second
  // write was lost.
  if (!insList && insDoc && insDoc.consumedAt && (+insDoc.consumedStart || 0) > now && Array.isArray(insDoc.items) && insDoc.items.length && (!insWin || insWin.at !== (+insDoc.at || 0))) {
    const recItems = insDoc.items.filter(tvCleared);
    if (recItems.length) {
      insWin = { at: +insDoc.at || 0, start: +insDoc.consumedStart, dur: recItems.reduce((a, x) => a + (+x.dur || 0), 0), item: recItems[0], items: recItems };
      dirty = true;
    }
  }
  chan._insert = insWin;
  // An insert window stamped inside the movie block freezes the
  // block for the span it covers: stamp the frozen span on the
  // movie state so tvMovieWin runs the window long and tvGen
  // resumes the chain from the offset it reached (recomputed from
  // the stamped window every tick, so it holds all night).
  if (insWin && chan._movies) {
    const mw0 = tvMovieWin(insWin.start, chan._movies);
    if (mw0 && insWin.start >= mw0.start && insWin.start < mw0.end) { chan._movies.insShift = tvInsertFrozen(insWin, chan); chan._movies.insStart = insWin.start; chan._movies.insEnd = insWin.start + insWin.dur * 1000; }
  }
  // MW TV OWNER QUEUE + SKIP (see the queue block above
  // tvQueueItem): resolve the list, attach its window states,
  // stamp tonight's movie block with the queue freeze and any
  // standing skip shift, re-anchor a queue that never got to air,
  // answer a fresh owner skip through the shared advancer
  // (tvAdvanceChannel), and retire the items that have aired.
  let quDoc = quDocP && (+quDocP.progV || 0) >= TV_QUEUE_V ? quDocP : null;
  let qState = tvQueueState(quDoc);
  const qSt = { cad: tvAdCadItems(pool), prem: chan._prem, anch: chan._anchor, ins: chan._insert, char: chan._char, lu: chan._lu, rerun: chan._rerun, qtr: chan._qtr, family: chan._family };
  if (qState) qState._st = qSt;
  chan._queue = qState;
  let qCut = nw && nw.qCut && typeof nw.qCut === "object" ? { ...nw.qCut } : {};
  chan._qCut = qCut;
  // HOURLY CARTOON (tvCartoonSpans): attach the resolved state —
  // the episodes, when all ten files are on the site, plus the
  // in-slot commercial pool resolved from the (already
  // spot-gated) break pool — and the spans this tick lays by.
  // nw.crtWin pins the spans already laid, so a laid
  // slot's start never moves when a late edition flips the news
  // gate mid-hour — unless the flipped gate lays a hard window
  // over the pinned span's head, in which case the span re-slides
  // as a unit (tvCartoonSpans v3) rather than amputating its
  // opening parts. The queue's freeze states pick the spans up
  // here too (qSt.crt), so queue content freezes across the block.
  chan._cartoon = cartoonState.crt ? { items: cartoonState.crt.items, total: cartoonState.crt.total, spots: tvCartoonSpots(pool), spans: [] } : null;
  if (chan._cartoon) chan._cartoon.spans = tvCartoonSpans(chan, chan._cartoon, now - 3600e3, now + TV_HORIZON + 3600e3, (nw && nw.crtWin) || []);
  qSt.crt = chan._cartoon;
  qSt.khutbah = chan._khutbah;
  // Adhan spans place now that every protected state exists (the
  // cartoon spans above; premiere/rerun, Family Time, the khutbah
  // and the anchor attached earlier): exact at the prayer time,
  // slid past protected spans, Friday Dhuhr suppressed — all
  // inside tvAdhanSpans.
  if (chan._adhan) chan._adhan.spans = tvAdhanSpans(chan, chan._adhan, now - 3600e3, now + TV_HORIZON + 3600e3);
  qSt.adhan = chan._adhan;
  let qSkipAtDone = (nw && +nw.qSkipAt) || 0;
  let qSkipNote = nw && nw.qSkipNote && now - nw.qSkipNote.at < 3600e3 ? nw.qSkipNote : null;
  let movSkipState = nw && nw.movSkip && (+nw.movSkip.shift || 0) > 0 ? nw.movSkip : null;
  if (chan._movies) {
    if (movSkipState) {
      const mwN = tvMovieWin(now, chan._movies);
      if (mwN && movSkipState.at >= mwN.start && movSkipState.at < mwN.end) { chan._movies.skipShift = movSkipState.shift; chan._movies.skipAt = movSkipState.at; chan._movies.skipStart = mwN.start; }
    }
    if (chan._cartoon) {
      for (const sp of chan._cartoon.spans) {
        const mwC = tvMovieWin(sp.start, chan._movies);
        if (mwC && sp.start >= mwC.start && sp.start < mwC.end) { chan._movies.crtShift = Math.round((sp.end - sp.start) / 100) / 10; chan._movies.crtStart = sp.start; chan._movies.crtEnd = sp.end; break; }
      }
    }
    if (qState) {
      const qSpan0 = tvQueueSpan(qState);
      if (qSpan0) {
        const mwQ = tvMovieWin(qSpan0.start, chan._movies);
        if (mwQ && qSpan0.start >= mwQ.start && qSpan0.start < mwQ.end) {
          let froz = tvInsertFrozen({ start: qSpan0.start, dur: (qSpan0.end - qSpan0.start) / 1000 }, chan);
          froz = Math.max(0, Math.round((froz - tvAdTimeIn(qSt.cad, chan._prem, chan._anchor, chan._insert, qSpan0.start, qSpan0.end, chan._char, chan._lu, chan._rerun, chan._qtr)) * 10) / 10);
          if (froz > 0) { chan._movies.qShift = froz; chan._movies.qStart = qSpan0.start; chan._movies.qEnd = qSpan0.end; }
        }
      }
    }
  }
  // A queue whose window passed without ever airing (the channel
  // was dark, or nothing of it was ever laid) is re-anchored at
  // the end of the piece on air — never silently eaten.
  if (qState && segs) {
    const qSpan1 = tvQueueSpan(qState);
    const qTouched0 = !!((nw && nw.qTouched) || (segs || []).some((s) => s && s.qid));
    if (qSpan1 && now >= qSpan1.end && !qTouched0) {
      const cs = tvSegAt(segs, now);
      quDoc = { ...quDoc, anchor: cs ? cs.start + Math.round(cs.dur * 1000) : now, updatedAt: now };
      await writeDoc(env, "tv/queue", "tv", quDoc);
      qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
    }
  }
  // Owner skip: a fresh skipAt the laid window has not answered.
  if (quDoc && (+quDoc.skipAt || 0) > qSkipAtDone) {
    const cadNow = tvAdWin(now, qSt.cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr);
    const adv = tvAdvanceChannel(chan, segs, cursor, now, cadNow);
    qSkipAtDone = +quDoc.skipAt || 0;
    qSkipNote = { at: now, note: adv.note };
    if (adv.applied) {
      segs = adv.segs; cursor = adv.cursor; dirty = true;
      if (adv.qCut) { qCut = { ...qCut, ...adv.qCut }; chan._qCut = qCut; }
      if (adv.insTrunc && insWin) { insWin = { ...insWin, dur: adv.insTrunc.dur }; chan._insert = insWin; }
      if (adv.movSkip) { movSkipState = adv.movSkip; if (chan._movies) { const mwS = tvMovieWin(now, chan._movies); chan._movies.skipShift = adv.movSkip.shift; chan._movies.skipAt = adv.movSkip.at; chan._movies.skipStart = mwS ? mwS.start : 0; } }
      if (adv.qJump) {
        quDoc = { ...quDoc, anchor: adv.qJump.anchor, updatedAt: now };
        await writeDoc(env, "tv/queue", "tv", quDoc);
        qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
      }
      // A skip with a list still waiting pulls the list to the
      // cut: the queue head starts at the skip moment, not at
      // the end of the piece that was just cut. (A list already
      // inside its window keeps its anchor — it resumes by the
      // freeze math, never replays.)
      if (!adv.qJump && qState && qState.anchor > now) {
        quDoc = { ...quDoc, anchor: now, updatedAt: now };
        await writeDoc(env, "tv/queue", "tv", quDoc);
        qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
      }
    }
  }
  // QUEUE WINDOW CUT (the skip→queue fix, 2026-11-03): tvGen only
  // ever APPENDS from cursor.at (≈ now + TV_HORIZON), and every
  // other standing window — insert, anchor, character editions —
  // CUTS the already-laid window when it appears so generation
  // re-lays into it. The queue never had such a cut: a list added
  // while the keeper was already running sat behind ~2h of laid
  // pool picks, its anchor passed inside them, and its items were
  // then silently eaten by wall-clock consumption
  // (tvQueueElapsed) without ever airing — the owner's "skip
  // doesn't go to what I queued". Heal both shapes here, after
  // the skip block (so a same-tick skip is answered first):
  //   (a) window still ahead but past the laid cursor → trim the
  //       laid window at the window start and re-anchor the
  //       cursor there, so this tick's generation lays the queue
  //       from its head;
  //   (b) window start already passed with nothing of the queue
  //       laid inside it (missed window) and no hard window owns
  //       this second → restart the list at now: re-anchor the
  //       doc at now, trim at now, cursor by cycle math. The
  //       list then plays from its head instead of mid-item or
  //       never. (A window that FULLY passed unaired is the
  //       re-anchor block above's case, unchanged.)
  if (qState && quDoc && segs && cursor) {
    const spQ = tvQueueSpan(qState);
    if (spQ && spQ.end > now) {
      const qids = new Set(qState.items.map((x) => String(x.qid)));
      const laidQ = (segs || []).some((s) => s && s.qid && qids.has(String(s.qid)) && s.start >= spQ.start - 1000 && s.start < spQ.end);
      if (!laidQ) {
        if (spQ.start > now && cursor.at > spQ.start) {
          const cpQ = tvCyclePos(chan, spQ.start);
          if (cpQ) { segs = tvTrimAt(segs, spQ.start); cursor = { at: spQ.start, ix: cpQ.ix, off: cpQ.off, run: 0 }; dirty = true; }
        } else if (spQ.start <= now && tvQueueElapsed(qState, cursor.at) > 0.05 && tvQueueElapsed(qState, cursor.at) < qState.total) {
          // The missed-window signature: at the generation
          // pointer, the list's content position is already
          // INSIDE the list — generation would lay the head
          // mid-item (or, with the pointer hours deep, never in
          // time). A healthy awaiting-re-lay state (cursor
          // stored at the anchor by a Guardian trim or by the
          // advancer's own pull) sits at elapsed 0 and is left
          // alone: generation lays the head from its start.
          const nwW = tvNewsWin(now);
          const frozenNow = !!((nwW && nwW.inside) || (tvPremWin(now, chan._prem) && tvPremWin(now, chan._prem).inside) || (tvPremWin(now, chan._rerun) && tvPremWin(now, chan._rerun).inside) || (tvAnchorWin(now, chan._anchor) && tvAnchorWin(now, chan._anchor).inside) || (tvInsertWin(now, chan._insert) && tvInsertWin(now, chan._insert).inside) || (tvAdWin(now, qSt.cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr) || {}).inside);
          if (!frozenNow) {
            quDoc = { ...quDoc, anchor: now, updatedAt: now };
            await writeDoc(env, "tv/queue", "tv", quDoc);
            qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
            segs = tvTrimAt(segs, now);
            const cpQ = tvCyclePos(chan, now);
            if (cpQ) cursor = { at: now, ix: cpQ.ix, off: cpQ.off, run: 0 };
            dirty = true;
          }
        }
      }
    }
  }
  // Consumption: retire the items whose content has fully aired
  // (position is content time — a preemption never consumes).
  // When items retire and the list goes on, the anchor shifts
  // forward by the retired content seconds (stretched by the
  // frozen time inside the shifted span, fixed-point like
  // tvQueueSpan): elapsed is measured from the anchor over the
  // CURRENT list, so without the shift the next item would
  // inherit the retired items' seconds and be consumed early —
  // after ~one tick of airtime instead of its full run.
  if (qState && quDoc) {
    const el = tvQueueElapsed(qState, now);
    let cum = 0; const gone = new Set();
    for (const it of qState.items) { cum += +it.dur || 0; if (cum <= el + 0.05) gone.add(it.qid); }
    if (gone.size) {
      const keptItems = (quDoc.items || []).filter((r) => !(r && gone.has(String(r.qid))));
      let retiredSec = 0;
      for (const it of qState.items) if (gone.has(it.qid)) retiredSec += +it.dur || 0;
      quDoc = { ...quDoc, items: keptItems, updatedAt: now };
      if (!keptItems.length) quDoc = { ...quDoc, anchor: 0 };
      else if (retiredSec > 0) {
        let dA = retiredSec;
        for (let i = 0; i < 10; i++) { const nd = retiredSec + tvQueueFrozen(qState, qState.anchor, qState.anchor + dA * 1000); const doneA = Math.abs(nd - dA) < 0.05; dA = nd; if (doneA) break; }
        quDoc = { ...quDoc, anchor: Math.round(qState.anchor + dA * 1000) };
      }
      await writeDoc(env, "tv/queue", "tv", quDoc);
      qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
    }
  }

  // CROWD SKIP (Malik, 2026-11-03 19:13 ET: "If 5 people vote no
  // i want it to get skipped"): a fresh, unconsumed tv/skip
  // request from the vote endpoint naming the segment on air
  // RIGHT NOW is answered here — through the gate (tvSkipGate:
  // news, premiere, rerun, anchor and owner-queued programming
  // are protected; Malik confirmed 19:22 ET) and through
  // tvAdvanceChannel, THE same advancer the owner skip above
  // uses, with the same stamp persistence, so what plays next
  // follows the standing precedence (queue head → hard schedule
  // → pool picks). The request is consumed exactly once either
  // way, so it can never fire late or twice; the fired skip
  // lands in tv/now's skipNote with by:"crowd" (clients paint
  // "Skipped by viewer vote 👎×5") and in the tv/votes audit log.
  let crowdNote = null;
  if (skipDoc && !skipDoc.consumedAt && now - (+skipDoc.at || 0) < 180e3 && segs) {
    const cur0 = tvSegAt(segs, now);
    if (cur0 && cur0.start === (+skipDoc.segStart || 0) && cur0.id === skipDoc.id) {
      const cadNow = tvAdWin(now, qSt.cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr);
      const gate = tvSkipGate(cur0, chan, now, "crowd", cadNow);
      if (!gate.ok) {
        skipDoc = { ...skipDoc, consumedAt: now, consumedNote: "protected:" + gate.why, updatedAt: now };
        await writeDoc(env, "tv/skip", "tv", skipDoc);
      } else {
        const adv = tvAdvanceChannel(chan, segs, cursor, now, cadNow);
        if (adv.applied) {
          segs = adv.segs; cursor = adv.cursor; dirty = true;
          if (adv.qCut) { qCut = { ...qCut, ...adv.qCut }; chan._qCut = qCut; }
          if (adv.insTrunc && insWin) { insWin = { ...insWin, dur: adv.insTrunc.dur }; chan._insert = insWin; }
          if (adv.movSkip) { movSkipState = adv.movSkip; if (chan._movies) { const mwS = tvMovieWin(now, chan._movies); chan._movies.skipShift = adv.movSkip.shift; chan._movies.skipAt = adv.movSkip.at; chan._movies.skipStart = mwS ? mwS.start : 0; } }
          if (adv.qJump && quDoc) {
            quDoc = { ...quDoc, anchor: adv.qJump.anchor, updatedAt: now };
            await writeDoc(env, "tv/queue", "tv", quDoc);
            qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
          }
          if (!adv.qJump && qState && qState.anchor > now && quDoc) {
            quDoc = { ...quDoc, anchor: now, updatedAt: now };
            await writeDoc(env, "tv/queue", "tv", quDoc);
            qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
          }
          crowdNote = { id: skipDoc.id, title: skipDoc.title || String(skipDoc.id), at: now, by: "crowd" };
          skipDoc = { ...skipDoc, consumedAt: now, consumedNote: "advanced", updatedAt: now };
          await writeDoc(env, "tv/skip", "tv", skipDoc);
        } else {
          skipDoc = { ...skipDoc, consumedAt: now, consumedNote: "no-advance:" + String(adv.note || "").slice(0, 60), updatedAt: now };
          await writeDoc(env, "tv/skip", "tv", skipDoc);
        }
      }
    } else if (now - (+skipDoc.at || 0) >= 60e3) {
      skipDoc = { ...skipDoc, consumedAt: now, consumedNote: "stale", updatedAt: now };
      await writeDoc(env, "tv/skip", "tv", skipDoc);
    }
  }

  const genTo = now + TV_HORIZON;
  if (cursor.at < genTo) {
    const gen = tvGen(chan, pool, cursor, genTo);
    if (gen.segs.length) { segs = segs.concat(gen.segs); dirty = true; }
    cursor = gen.cursor;
    if (pool._dirty) { delete pool._dirty; pool.updatedAt = now; await writeDoc(env, "tv/breakpool", "tv", pool); }
  }
  let curSeg = tvSegAt(segs, now);
  let skipNote = nw && nw.skipNote && now - nw.skipNote.at < 3600e3 ? nw.skipNote : null;
  let gNote = nw && nw.gNote && now - nw.gNote.at < 3600e3 ? nw.gNote : null;
  if (crowdNote) skipNote = crowdNote;
  if (nw && nw.curStart && curSeg && curSeg.start !== nw.curStart) {
    const heldId = await tvRecheckNext(env, chan, segs, now, origin, nw || {});
    if (heldId) {
      const heldItem = (chan.items || []).find((x) => x.id === heldId);
      skipNote = { id: heldId, title: heldItem ? heldItem.title : heldId, at: now };
      const badSeg = (segs || []).find((sg) => (sg.k === "prog" || sg.k === "house") && sg.id === heldId && sg.start > now);
      const cutAt = badSeg ? badSeg.start : now;
      segs = (segs || []).filter((sg) => sg.start < cutAt);
      const ixAfter = badSeg ? ((chan.items || []).findIndex((x) => x.id === heldId) + 1) % (chan.items || []).length : cursor.ix;
      cursor = { at: cutAt, ix: ixAfter, off: 0, run: 0 };
      const gen = tvGen(chan, pool, cursor, genTo);
      segs = segs.concat(gen.segs); cursor = gen.cursor;
      if (pool._dirty) { delete pool._dirty; pool.updatedAt = now; await writeDoc(env, "tv/breakpool", "tv", pool); }
      curSeg = tvSegAt(segs, now);
      dirty = true;
    }
  }
  // MW TV GUARDIAN PASS (see MWTV-GUARDIAN-BEGIN above): finalize
  // the departed program's watch record, act on confirmed-dead
  // segments, scan the laid timeline, fold Eyes reads into
  // brain/tvwatch. Fully self-contained and failure-silent: a
  // guardian fault can never hurt the channel it watches.
  try {
    const gDoc = (guardDoc0 && typeof guardDoc0 === "object" && !Array.isArray(guardDoc0)) ? guardDoc0 : { v: 1, faults: {}, strikes: {}, eyes: [], log: [], health: { advances: 0, protAdvances: 0, quarantines: 0, refusals: 0, holes: 0, lastFaultAt: 0, lastAdvanceAt: 0, lastQuarantineAt: 0 } };
    if (!gDoc.faults || typeof gDoc.faults !== "object") gDoc.faults = {};
    if (!gDoc.strikes || typeof gDoc.strikes !== "object") gDoc.strikes = {};
    if (!gDoc.health || typeof gDoc.health !== "object") gDoc.health = { advances: 0, protAdvances: 0, quarantines: 0, refusals: 0, holes: 0, lastFaultAt: 0, lastAdvanceAt: 0, lastQuarantineAt: 0 };
    let gDirty = false;
    let watchDoc = null, watchDirty = false;
    const loadWatch = async () => { if (!watchDoc) { const w = await readDoc(env, "brain/tvwatch"); watchDoc = (w && typeof w === "object" && !Array.isArray(w)) ? w : tvGuardEmptyWatch(); if (!Array.isArray(watchDoc.recent)) watchDoc.recent = []; if (!watchDoc.days || typeof watchDoc.days !== "object") watchDoc.days = {}; if (!Array.isArray(watchDoc.eyes)) watchDoc.eyes = []; } return watchDoc; };
    const findItem = (id) => {
      const lists = [(chan && chan.items) || [], (pool && pool.items) || [], (movies && movies.items) || [], (chan._prem && chan._prem.items) || [], (chan._rerun && chan._rerun.items) || [], (insWin && insWin.items) || [], (qState && qState.items) || []];
      for (const L of lists) { const it = (L || []).find((x) => x && x.id === id); if (it) return it; }
      return null;
    };
    const dayKey = tvEtParts(now).dayKey;
    // (1) FINALIZE the departed program (the previous tv/now's
    // current segment, gone from the air on this tick).
    if (nw && nw.curStart && curSeg && curSeg.start !== nw.curStart && Array.isArray(nw.segs)) {
      const dep = nw.segs.find((sg) => sg && sg.start === nw.curStart);
      if (dep && (dep.k === "prog" || dep.k === "house")) {
        const it = findItem(dep.id);
        const fullDur = it && +it.dur > 0 ? +it.dur : (+dep.dur || 0);
        if (fullDur >= TV_WATCH_MIN_DUR) {
          const laidEnd = dep.start + (+dep.dur || 0) * 1000;
          const airedSec = Math.max(0, Math.round((Math.min(now, laidEnd) - dep.start) / 100) / 10);
          const frac = fullDur > 0 ? Math.round(Math.min(1, airedSec / fullDur) * 100) / 100 : 0;
          const cutShort = now < dep.start + fullDur * 1000 - 2000;
          let outcome = "completed";
          if (cutShort) {
            if (nw.skipNote && nw.skipNote.id === dep.id && nw.skipNote.by === "crowd" && (+nw.skipNote.at || 0) >= dep.start) outcome = "crowd-skip";
            else if (nw.qSkipNote && (+nw.qSkipNote.at || 0) >= dep.start) outcome = "owner-skip";
            else if (curSeg.k === "news" || (nw.skipNote && nw.skipNote.id === dep.id)) outcome = "cut";
            else if (frac >= 0.9) outcome = "completed";
            else outcome = "cut";
            if (outcome === "cut" && curSeg.k === "news") outcome = "cut-window";
          }
          const vrec = votesDoc && votesDoc.inst ? votesDoc.inst[dep.id + "@" + dep.start] : null;
          const wd = await loadWatch();
          if (tvWatchFold(wd, { key: dep.id + "@" + dep.start, id: dep.id, yt: dep.yt || (it && it.yt) || "", title: dep.title || (it && it.title) || String(dep.id), show: dep.show || (it && it.show) || "", kind: dep.qid ? "queue" : dep.k, start: dep.start, dur: fullDur, aired: airedSec, frac, outcome, up: vrec ? (vrec.up | 0) : 0, down: vrec ? (vrec.down | 0) : 0, at: now }, dayKey)) watchDirty = true;
        }
      }
    }
    // (2) CONFIRMED-DEAD segment on air right now?
    if (curSeg && (curSeg.k === "prog" || curSeg.k === "house")) {
      const curKey = curSeg.id + "@" + curSeg.start;
      const frec = gDoc.faults[curKey];
      const hardSeats = frec ? tvGuardHardSeats(frec) : 0;
      if (hardSeats >= TV_GUARD_CONFIRM_SEATS) {
        const cadNow = tvAdWin(now, qSt.cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr);
        const gate = tvSkipGate(curSeg, chan, now, "guardian", cadNow, { seats: hardSeats });
        // SELF-REMOVE LAW (Malik, 2026-11-03 20:29 ET: "It should
        // remove itself if it cant play") — checked BEFORE the
        // gate branches below, on this section's own evidence
        // standard: this block only runs when hardSeats >=
        // TV_GUARD_CONFIRM_SEATS (a ≥2-seat HARD-error conviction
        // — never a single seat, never a bare probe). The owner's
        // own rule retires the convicted item from his list
        // itself (tv/queue), records why it vanished, joins its
        // id to the shared ban list (ban-class conviction), and
        // ends its laid airing by trim + cursor re-anchor (the
        // next tick re-lays whatever stands next — queue head or
        // pool). SEAM NOTE (Malik, 2026-11-03 20:39 ET; separate
        // crew): the Guardian amendment lets a guardian advance
        // PASS tvSkipGate for proven-dead queue/news segments —
        // the on-air advance gate is theirs, the tv/queue doc
        // removal is THIS build's, so this check sits ahead of
        // the gate outcome and fires identically whether the
        // gate refuses (pre-amendment shape) or passes
        // (post-amendment). Crowd protection is untouched:
        // tvSkipGate's crowd refusals for queue + news stand
        // exactly as they were, and this path is keeper-only.
        // News docs/pieces are never touched here: a news
        // segment carries no qid, so it can never enter this
        // branch.
        let qSelfRemoved = false;
        if (curSeg.qid && quDoc && Array.isArray(quDoc.items) && quDoc.items.some((r) => r && String(r.qid) === String(curSeg.qid))) {
            const deadRaw = quDoc.items.find((r) => r && String(r.qid) === String(curSeg.qid)) || {};
            const deadYt = String(curSeg.yt || deadRaw.yt || "");
            const keptQ = quDoc.items.filter((r) => !(r && String(r.qid) === String(curSeg.qid)));
            const removedQ = [...(Array.isArray(quDoc.removed) ? quDoc.removed : []), { qid: String(curSeg.qid), yt: deadYt, title: String(curSeg.title || deadRaw.title || ""), at: now, why: "couldn't play" }].slice(-10);
            quDoc = { ...quDoc, items: keptQ, removed: removedQ, anchor: keptQ.length ? now : 0, updatedAt: now };
            await writeDoc(env, "tv/queue", "tv", quDoc);
            qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
            if (deadYt) { try { const blk = (await readDoc(env, "brain/ytblock")) || { ids: [] }; if (Array.isArray(blk.ids) && !blk.ids.includes(deadYt)) { blk.ids.push(deadYt); await writeDoc(env, "brain/ytblock", "brain", blk); } } catch (_) {} }
            segs = tvTrimAt(segs, now);
            const cpR = tvCyclePos(chan, now);
            if (cpR) cursor = { at: now, ix: cpR.ix, off: cpR.off, run: 0 };
            dirty = true;
            gNote = { id: curSeg.id, title: curSeg.title || String(curSeg.id), at: now, by: "guardian" };
            gDirty = true;
            tvGuardLog(env, gDoc, { at: now, kind: "queue-remove", id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/queue", summary: "SELF-REMOVE: queued “" + String(curSeg.title || curSeg.id).slice(0, 80) + "” was CONFIRMED unplayable at its turn by " + hardSeats + " viewer seats (hard player errors) and removed ITSELF from the owner's queue (reason recorded on tv/queue: couldn't play); its video id joined brain/ytblock and the channel moves on. The doc removal is the owner's self-remove rule (not a crowd power, and independent of the Guardian advance gate's answer). Malik can re-add it any time; it stays until it fails again at its turn." });
            delete gDoc.faults[curKey];
            qSelfRemoved = true;
            curSeg = tvSegAt(segs, now);
        }
        if (!qSelfRemoved && !gate.ok) {
          if (!gDoc.refusedKeys || typeof gDoc.refusedKeys !== "object") gDoc.refusedKeys = {};
          if (!gDoc.refusedKeys[curKey]) {
            gDoc.refusedKeys[curKey] = now;
            const rk = Object.keys(gDoc.refusedKeys); if (rk.length > 60) for (const k of rk.slice(0, rk.length - 60)) delete gDoc.refusedKeys[k];
            gDoc.health.refusals += 1; gDirty = true;
            tvGuardLog(env, gDoc, { at: now, kind: "refusal", id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/guardian", summary: "Guardian: “" + String(curSeg.title || curSeg.id).slice(0, 80) + "” is CONFIRMED unplayable by " + hardSeats + " viewer seats (hard player errors) but it is a protected class (" + gate.why + ") — NOT cut. Logged for Malik/Amani: the piece needs a human decision or a replacement edition." });
          }
        } else if (!qSelfRemoved) {
          const adv = tvAdvanceChannel(chan, segs, cursor, now, cadNow);
          if (adv.applied) {
            segs = adv.segs; cursor = adv.cursor; dirty = true;
            if (adv.qCut) { qCut = { ...qCut, ...adv.qCut }; chan._qCut = qCut; }
            if (adv.insTrunc && insWin) { insWin = { ...insWin, dur: adv.insTrunc.dur }; chan._insert = insWin; }
            if (adv.movSkip) { movSkipState = adv.movSkip; if (chan._movies) { const mwS = tvMovieWin(now, chan._movies); chan._movies.skipShift = adv.movSkip.shift; chan._movies.skipAt = adv.movSkip.at; chan._movies.skipStart = mwS ? mwS.start : 0; } }
            if (adv.qJump && quDoc) { quDoc = { ...quDoc, anchor: adv.qJump.anchor, updatedAt: now }; await writeDoc(env, "tv/queue", "tv", quDoc); qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState; }
            if (!adv.qJump && qState && qState.anchor > now && quDoc) { quDoc = { ...quDoc, anchor: now, updatedAt: now }; await writeDoc(env, "tv/queue", "tv", quDoc); qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState; }
            const airedSec = Math.max(0, Math.round((now - curSeg.start) / 100) / 10);
            const itA = findItem(curSeg.id);
            const fullDurA = itA && +itA.dur > 0 ? +itA.dur : (+curSeg.dur || 0);
            const vrecA = votesDoc && votesDoc.inst ? votesDoc.inst[curKey] : null;
            const wd = await loadWatch();
            if (tvWatchFold(wd, { key: curKey, id: curSeg.id, yt: curSeg.yt || "", title: curSeg.title || String(curSeg.id), show: curSeg.show || (itA && itA.show) || "", kind: curSeg.qid ? "queue" : curSeg.k, start: curSeg.start, dur: fullDurA, aired: airedSec, frac: fullDurA > 0 ? Math.round(Math.min(1, airedSec / fullDurA) * 100) / 100 : 0, outcome: "guardian-advance", up: vrecA ? (vrecA.up | 0) : 0, down: vrecA ? (vrecA.down | 0) : 0, at: now }, dayKey)) watchDirty = true;
            gNote = { id: curSeg.id, title: curSeg.title || String(curSeg.id), at: now, by: "guardian" };
            gDoc.health.advances += 1; gDoc.health.lastAdvanceAt = now; gDirty = true;
            if (gate.prot) {
              gDoc.health.protAdvances = (gDoc.health.protAdvances | 0) + 1;
              tvGuardLog(env, gDoc, { at: now, kind: "advance", prot: gate.prot, proof: gate.proof, seats: hardSeats, id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/now", summary: "Guardian ADVANCED a PROVEN-DEAD protected segment (OWNER-AUTHORIZED \u2014 Malik, 2026-11-03 20:39: the Guardian can skip a proven-dead item even in his queue/news): \u201C" + String(curSeg.title || curSeg.id).slice(0, 80) + "\u201D is protected class " + gate.prot + " but proven dead \u2014 " + hardSeats + " distinct viewer seats reported hard player errors on this exact instance (on air " + airedSec + "s of " + fullDurA + "s). The channel moved to the next piece through the shared advancer. Counted separately in health.protAdvances." });
            } else {
            tvGuardLog(env, gDoc, { at: now, kind: "advance", id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/now", summary: "Guardian ADVANCED a confirmed-dead segment: “" + String(curSeg.title || curSeg.id).slice(0, 80) + "” was unplayable (" + hardSeats + " seats reported hard player errors; on air " + airedSec + "s of " + fullDurA + "s). The channel moved to the next piece through the shared advancer. Zero-tolerance bar: a dead title never occupies MW TV." });
            }
            delete gDoc.faults[curKey];
            // Strike + quarantine on the 2nd confirmed-dead airing.
            const yt = curSeg.yt || "";
            if (yt) {
              const st = gDoc.strikes[yt] || { title: curSeg.title || "", segs: [], at: 0 };
              if (!st.segs.includes(curSeg.start)) st.segs.push(curSeg.start);
              st.at = now; st.title = curSeg.title || st.title;
              gDoc.strikes[yt] = st;
              if (st.segs.length >= 2 && !st.quarantinedAt) {
                st.quarantinedAt = now;
                try { const blk = (await readDoc(env, "brain/ytblock")) || { ids: [] }; if (Array.isArray(blk.ids) && !blk.ids.includes(yt)) { blk.ids.push(yt); await writeDoc(env, "brain/ytblock", "brain", blk); } } catch (_) {}
                const holdIt = async (docObj, path, coll) => { let hit = false; for (const x of (docObj && docObj.items) || []) { if (x && x.yt === yt && !x.held) { x.held = "guardian: confirmed unplayable on 2 separate airings"; x.heldAt = now; hit = true; } } if (hit) { docObj.updatedAt = now; if (docObj === chan) docObj.by = "keeper"; await writeDoc(env, path, coll, docObj); } };
                try { await holdIt(chan, "tv/channel", "tv"); } catch (_) {}
                try { await holdIt(pool, "tv/breakpool", "tv"); } catch (_) {}
                try { await holdIt(movies, "tv/movieblock", "tv"); } catch (_) {}
                gDoc.health.quarantines += 1; gDoc.health.lastQuarantineAt = now;
                tvGuardLog(env, gDoc, { at: now, kind: "quarantine", id: curSeg.id, title: curSeg.title || "", yt, target: "brain/ytblock", summary: "Guardian QUARANTINED “" + String(curSeg.title || yt).slice(0, 80) + "”: confirmed unplayable on 2 separate airings. Its video id is on the shared ban list (brain/ytblock) and the item is held in every lineup doc — it can never be picked again. Re-adding it takes a human with a working copy." });
              }
            }
            curSeg = tvSegAt(segs, now);
          }
        }
      }
    }
    // (2b) BANNED-ON-AIR: scan the whole laid timeline for a
    // banned yt id (brain/ytblock + the permanent watchlist).
    // Doc-level and lineage-blind on purpose: the reference
    // incident reached the air from a stored doc, not a seed.
    try {
      const blkDoc = await readDoc(env, "brain/ytblock");
      const banSet = new Set([...((blkDoc && Array.isArray(blkDoc.ids)) ? blkDoc.ids.map(String) : []), ...TV_GUARD_WATCHLIST]);
      if (banSet.size) {
        if (!gDoc.banKeys || typeof gDoc.banKeys !== "object") gDoc.banKeys = {};
        for (const sg of (segs || [])) {
          if (!sg || !sg.yt || !banSet.has(String(sg.yt))) continue;
          const bKey = sg.id + "@" + sg.start;
          if (gDoc.banKeys[bKey]) continue;
          gDoc.banKeys[bKey] = now;
          const bk = Object.keys(gDoc.banKeys); if (bk.length > 60) for (const k of bk.slice(0, bk.length - 60)) delete gDoc.banKeys[k];
          gDirty = true;
          tvGuardLog(env, gDoc, { at: now, kind: "banned-on-air", id: sg.id, title: sg.title || "", yt: String(sg.yt), segStart: sg.start, target: "tv/now", summary: "Guardian DEFECT: banned video id " + String(sg.yt) + " (\u201C" + String(sg.title || sg.id).slice(0, 80) + "\u201D) is laid in the MW TV timeline. A banned id never occupies this channel, whatever doc laid it. If it is on air now and its class is unprotected, the Guardian cuts it through the shared advancer; protected classes are reported for a human call." });
        }
        if (curSeg && curSeg.yt && banSet.has(String(curSeg.yt)) && (curSeg.k === "prog" || curSeg.k === "house")) {
          const cadNowB = tvAdWin(now, qSt.cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr);
          const inBanList = !!(blkDoc && Array.isArray(blkDoc.ids) && blkDoc.ids.map(String).includes(String(curSeg.yt)));
          const frecB = gDoc.faults[curSeg.id + "@" + curSeg.start];
          const gateB = tvSkipGate(curSeg, chan, now, "guardian", cadNowB, { seats: frecB ? tvGuardHardSeats(frecB) : 0, banned: inBanList });
          if (!gateB.ok) {
            if (!gDoc.refusedKeys || typeof gDoc.refusedKeys !== "object") gDoc.refusedKeys = {};
            const curKeyB = curSeg.id + "@" + curSeg.start;
            if (!gDoc.refusedKeys[curKeyB]) {
              gDoc.refusedKeys[curKeyB] = now;
              const rk = Object.keys(gDoc.refusedKeys); if (rk.length > 60) for (const k of rk.slice(0, rk.length - 60)) delete gDoc.refusedKeys[k];
              gDoc.health.refusals += 1; gDirty = true;
              tvGuardLog(env, gDoc, { at: now, kind: "refusal", id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/guardian", summary: "Guardian: banned video \u201C" + String(curSeg.title || curSeg.id).slice(0, 80) + "\u201D is ON AIR but it is a protected class (" + gateB.why + ") \u2014 NOT cut by the Guardian. Logged for Malik/Amani: it needs a human hand or the laying doc fixed." });
            }
          } else {
            const advB = tvAdvanceChannel(chan, segs, cursor, now, cadNowB);
            if (advB.applied) {
              segs = advB.segs; cursor = advB.cursor; dirty = true;
              if (advB.qCut) { qCut = { ...qCut, ...advB.qCut }; chan._qCut = qCut; }
              if (advB.insTrunc && insWin) { insWin = { ...insWin, dur: advB.insTrunc.dur }; chan._insert = insWin; }
              if (advB.movSkip) { movSkipState = advB.movSkip; if (chan._movies) { const mwS = tvMovieWin(now, chan._movies); chan._movies.skipShift = advB.movSkip.shift; chan._movies.skipAt = advB.movSkip.at; chan._movies.skipStart = mwS ? mwS.start : 0; } }
              if (advB.qJump && quDoc) { quDoc = { ...quDoc, anchor: advB.qJump.anchor, updatedAt: now }; await writeDoc(env, "tv/queue", "tv", quDoc); qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState; }
              if (!advB.qJump && qState && qState.anchor > now && quDoc) { quDoc = { ...quDoc, anchor: now, updatedAt: now }; await writeDoc(env, "tv/queue", "tv", quDoc); qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState; }
              const airedSecB = Math.max(0, Math.round((now - curSeg.start) / 100) / 10);
              const itB = findItem(curSeg.id);
              const fullDurB = itB && +itB.dur > 0 ? +itB.dur : (+curSeg.dur || 0);
              const curKeyB2 = curSeg.id + "@" + curSeg.start;
              const vrecB = votesDoc && votesDoc.inst ? votesDoc.inst[curKeyB2] : null;
              const wdB = await loadWatch();
              if (tvWatchFold(wdB, { key: curKeyB2, id: curSeg.id, yt: curSeg.yt || "", title: curSeg.title || String(curSeg.id), show: curSeg.show || (itB && itB.show) || "", kind: curSeg.qid ? "queue" : curSeg.k, start: curSeg.start, dur: fullDurB, aired: airedSecB, frac: fullDurB > 0 ? Math.round(Math.min(1, airedSecB / fullDurB) * 100) / 100 : 0, outcome: "guardian-advance", up: vrecB ? (vrecB.up | 0) : 0, down: vrecB ? (vrecB.down | 0) : 0, at: now }, dayKey)) watchDirty = true;
              gNote = { id: curSeg.id, title: curSeg.title || String(curSeg.id), at: now, by: "guardian" };
              gDoc.health.advances += 1; gDoc.health.lastAdvanceAt = now; gDirty = true;
              if (gateB.prot) {
                gDoc.health.protAdvances = (gDoc.health.protAdvances | 0) + 1;
                tvGuardLog(env, gDoc, { at: now, kind: "advance", prot: gateB.prot, proof: gateB.proof, seats: frecB ? tvGuardHardSeats(frecB) : 0, id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/now", summary: "Guardian ADVANCED a PROVEN-DEAD protected segment (OWNER-AUTHORIZED \u2014 Malik, 2026-11-03 20:39: the Guardian can skip a proven-dead item even in his queue/news): \u201C" + String(curSeg.title || curSeg.id).slice(0, 80) + "\u201D is protected class " + gateB.prot + " but proven dead \u2014 proof: " + (gateB.proof === "ban" ? "its video id " + String(curSeg.yt) + " is on brain/ytblock (a house conviction)" : (frecB ? tvGuardHardSeats(frecB) : 0) + " distinct viewer seats reported hard player errors on this exact instance") + " (on air " + airedSecB + "s). The channel moved to the next piece through the shared advancer. Counted separately in health.protAdvances." });
              } else {
              tvGuardLog(env, gDoc, { at: now, kind: "advance", id: curSeg.id, title: curSeg.title || "", segStart: curSeg.start, target: "tv/now", summary: "Guardian ADVANCED a BANNED segment: \u201C" + String(curSeg.title || curSeg.id).slice(0, 80) + "\u201D (video id " + String(curSeg.yt) + ") was on air " + airedSecB + "s. Its id is on the ban list / permanent watchlist \u2014 a banned title never occupies MW TV, whatever doc laid it. The channel moved to the next piece through the shared advancer." });
              }
              curSeg = tvSegAt(segs, now);
            }
          }
        }
      }
    } catch (_) { /* banned-scan failure can never hurt the tick */ }
    // (3) HEALTH SCAN: holes in the laid timeline + a stalled
    // current segment (past its end, still laid as current).
    const holes = tvGuardHoles(segs, gDoc.health.lastHoleEnd || 0);
    if (holes.length) {
      for (const h of holes) { gDoc.health.holes += 1; gDoc.health.lastHoleEnd = Math.max(gDoc.health.lastHoleEnd || 0, h.at + h.gapMs); tvGuardLog(env, gDoc, { at: now, kind: "hole", target: "tv/now", gapMs: h.gapMs, summary: "Guardian saw a HOLE in the laid MW TV timeline: " + Math.round(h.gapMs / 100) / 10 + "s of nothing laid before “" + String(h.beforeTitle || h.before).slice(0, 60) + "”. The keeper re-lays every tick; a hole that persists across checks is a defect for Malik's report." }); }
      gDirty = true;
    }
    if (nw && nw.curStart && curSeg && curSeg.start === nw.curStart) {
      const pseg = Array.isArray(nw.segs) ? nw.segs.find((sg) => sg && sg.start === nw.curStart) : null;
      if (pseg && now > pseg.start + (+pseg.dur || 0) * 1000 + 60e3) {
        if (gDoc.health.lastStallKey !== nw.curStart) {
          gDoc.health.lastStallKey = nw.curStart; gDirty = true;
          tvGuardLog(env, gDoc, { at: now, kind: "stall", id: pseg.id, title: pseg.title || "", segStart: pseg.start, target: "tv/now", summary: "Guardian saw a STALLED segment: “" + String(pseg.title || pseg.id).slice(0, 80) + "” is still laid as current " + Math.round((now - (pseg.start + (+pseg.dur || 0) * 1000)) / 1000) + "s past its end. Detect + log only — if it persists, it is a defect for Malik's report." });
        }
      }
    }
    // (4) EYES fold-in: sampled-frame vision reads filed through
    // the endpoint move into brain/tvwatch (the keeper is the
    // only writer of that doc, so reads can never be clobbered).
    if (Array.isArray(gDoc.eyes) && gDoc.eyes.length) {
      const wd = await loadWatch();
      for (const e of gDoc.eyes) { if (e && e.segKey && !wd.eyes.some((x) => x && x.segKey === e.segKey && x.at === e.at)) wd.eyes.push(e); }
      if (wd.eyes.length > TV_WATCH_EYES_CAP) wd.eyes = wd.eyes.slice(-TV_WATCH_EYES_CAP);
      watchDirty = true;
      gDoc.eyes = [];
      gDirty = true;
    }
    if (gDirty) { gDoc.updatedAt = now; await writeDoc(env, "tv/guardian", "tv", gDoc); }
    if (watchDirty && watchDoc) { watchDoc.updatedAt = now; await writeDoc(env, "brain/tvwatch", "brain", watchDoc); }
  } catch (_) { /* the Guardian must never break the tick */ }
  if (premState.cacheChanged) dirty = true;
  if (rerunState.cacheChanged) dirty = true;
  if (luState.cacheChanged) dirty = true;
  if (spotState.cacheChanged) dirty = true;
  if (cartoonState.cacheChanged) dirty = true;
  // The cartoon spans that actually got laid this tick are pinned
  // in tv/now (crtWin) — the next ticks' tvCartoonSpans treats a
  // pinned start as authoritative (see its header).
  const crtPins = [];
  if (chan._cartoon && Array.isArray(chan._cartoon.spans)) {
    const crtEpIds = (chan._cartoon.items || []).map((x) => x.id);
    for (const sp of chan._cartoon.spans) {
      if (sp.start <= now - 2 * 3600e3) continue;
      if ((segs || []).some((s) => s && crtEpIds.includes(s.id) && s.start >= sp.start - 1500 && s.start < sp.end)) crtPins.push({ start: sp.start, hour: sp.hour });
    }
  }
  delete chan._prem;
  delete chan._rerun;
  delete chan._anchor;
  delete chan._char;
  delete chan._lu;
  delete chan._movies;
  delete chan._insert;
  delete chan._queue;
  delete chan._family;
  delete chan._khutbah;
  delete chan._adhan;
  delete chan._voteNet;
  delete chan._qCut;
  delete chan._cartoon;
  if (dirty) {
    await writeDoc(env, "tv/now", "tv", { segs, cursor, chanAt: chan.updatedAt || 0, curStart: curSeg ? curSeg.start : 0, checked: (nw && nw.checked) || {}, skipNote, gNote, newsRefill, premProbe: premState.cache, rerunProbe: rerunState.cache, anchorProbe: anchorState.cache, anchAt: anchStamp, charProbe: charState.cache, charStamp, luProbe: luState.cache, luStamp, qProbe: qtrState.cache, qStamp: qStampSeen, spotProbe: spotState.cache, insWin: insWin || null, crtWin: crtPins, cartoonProbe: cartoonState.cache, qSkipAt: qSkipAtDone, qSkipNote, qCut, movSkip: movSkipState, qTouched: !!((nw && nw.qTouched) || (segs || []).some((s) => s && s.qid)), genAt: now, updatedAt: now });
  }
  // Play tally for sponsor spots (segments that aired this tick).
  try { await tvSponsorTally(env, pool, segs, now, online); } catch (_) {}
  return decision;
}
/* MWTV-END */

/* D1 READ FIX loaders (2026-11-03): the two collection reads the
 * keeper ran against D1 on every pass. The track library and the
 * waiting listener requests both change rarely next to the 12s
 * ping cadence, so each is read once per isolate per window and
 * the parsed rows are shared by every pass inside it. A new track
 * or a fresh pick can take up to the window to enter the rotation
 * — picks already waited for the next song boundary, and the
 * library is a rotation pool, so nothing a listener hears changes
 * shape; the station response itself is never cached. This
 * module's own writes and deletes invalidate the request rows at
 * once (writeDoc above, takePick below). */
const LIB_TTL = 60000, RQ_TTL = 15000;
/* D1 BURN FIX F3 (2026-11-07, AUDIT3): the library changed rarely next
 * to the 12 s ping cadence, but the memo re-read the whole tracks
 * collection every 60 s per isolate. The memo is now keyed on a version
 * stamp (site/tracks-version, bumped by every path that writes a track
 * doc — see bumpTracksVersion in lib/cf.js): when the TTL lapses the
 * keeper reads the 1-row stamp and re-reads the library only when the
 * version moved. A new track still becomes pickable within ~1 min of
 * upload (the TTL window, same as today); a metadata-only change
 * (bpm/key) also bumps the version, so the keeper never serves a stale
 * track row. */
async function loadLib(env, now) {
  if (libMemo.lib && now - libMemo.at < LIB_TTL) return libMemo;
  let ver = 0;
  try { const vr = await env.DB.prepare("select data from docs where path = ?").bind("site/tracks-version").first(); ver = (vr && JSON.parse(vr.data || "{}").v) || 0; } catch (_) { ver = 0; }
  if (libMemo.lib && ver === libMemo.ver) { libMemo.at = now; return libMemo; }
  const { results } = await env.DB.prepare("select data from docs where coll = 'tracks'").all();
  const lib = (results || []).map((r) => { try { return JSON.parse(r.data); } catch (_) { return null; } })
    .filter((t) => t && t.assetId && +t.duration > 3 && !String(t.assetId).includes("supabase"));
  libMemo.at = now; libMemo.lib = lib; libMemo.byAsset = new Map(lib.map((t) => [t.assetId, t])); libMemo.ver = ver;
  return libMemo;
}
/* D1 MINIMISATION (2026-11-06): the requests collection grows by design
 * (listener picks are saved docs) and the old loader read ALL of it on
 * every memo miss, though its only two callers (the harvest, takePick)
 * each parse the rows and keep just the unplayed picks, oldest first.
 * The read is now that subset, in the same order the docs_coll index
 * already returned: a json_valid CASE guard keeps a malformed doc from
 * failing the query (json_extract throws on one), the waiting line is
 * capped at 500 (the keeper consumes one pick per advance, so a deeper
 * line drains oldest-first over later memo cycles; nothing is deleted
 * or dropped, deeper picks load as they near the front), and both
 * callers still apply their own parse + predicate to the rows, so what
 * they act on is exactly what the old full read produced for them. The
 * kind expression index carries the same CASE guard inside its own
 * expression, so creating it cannot fail on a malformed doc either;
 * it is ensured here, failure-contained: if it cannot be created the
 * query still runs correctly on the docs_coll index. */
let rqIdxTried = false;
async function ensureRqPickIndex(env) {
  if (rqIdxTried) return; rqIdxTried = true;
  try { await env.DB.prepare("create index if not exists docs_requests_kind on docs (coll, (case when json_valid(data) then json_extract(data, '$.kind') end), created_at)").run(); }
  catch (_) { rqIdxTried = false; }
}
async function loadRequests(env, now) {
  if (rqMemo.rows && now - rqMemo.at < RQ_TTL) return rqMemo.rows;
  await ensureRqPickIndex(env);
  const { results } = await env.DB.prepare("select path, data from docs where coll = 'requests' and (case when json_valid(data) then json_extract(data, '$.kind') end) = 'pick' and (case when json_valid(data) then coalesce(json_extract(data, '$.played'), 0) else 0 end) = 0 order by created_at asc limit 500").all();
  rqMemo.at = now; rqMemo.rows = results || [];
  return rqMemo.rows;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const now = Date.now();
  const origin = new URL(request.url).origin;
  // presence: every client pings this endpoint every ~12s, so a small ping table
  // doubles as the site's online count — counts only, no identities are stored
  const counts = { online: 0, listening: 0, guestSince: 0 };
  try {
    const u = new URL(request.url);
    const cid = (u.searchParams.get("cid") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const lis = u.searchParams.get("l") === "1" ? 1 : 0;
    const pu = (u.searchParams.get("u") || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const pn = (u.searchParams.get("n") || "").slice(0, 40);
    await ensurePingsSchema(env);
    // DOORBELL arrival spotting, checked BEFORE the upsert below lands:
    // a cid with no fresh ping row is someone landing right now. A member
    // counts only when no other fresh ping already carries their uid (a
    // second tab is not a second arrival); the owner never counts, signed
    // in as himself or not — his own uid is the one thing the ping carries
    // that he cannot be rung about.
    let bellName = null;
    if (cid) {
      try {
        const prev = await env.DB.prepare("select cid from pings where cid = ? and at > ?").bind(cid, now - 45000).first();
        if (!prev) {
          if (pu && pu !== OWNER_ID) {
            const elsewhere = await env.DB.prepare("select cid from pings where uid = ? and at > ? limit 1").bind(pu, now - 35000).first();
            if (!elsewhere) bellName = (pn || "A member").slice(0, 40);
          } else if (!pu) bellName = "A guest";
        }
      } catch (_) {}
    }
    if (cid) await env.DB.prepare("insert into pings (cid, at, listening, uid, name, first) values (?,?,?,?,?,?) on conflict(cid) do update set at = excluded.at, listening = excluded.listening, uid = coalesce(excluded.uid, pings.uid), name = coalesce(excluded.name, pings.name), first = coalesce(pings.first, excluded.first)").bind(cid, now, lis, pu || null, pn || null, now).run();
    // D1 READ FIX (Malik, 2026-11-08 "what if 100 people"): the prune and the three
    // presence reads below each walk every live ping row, on every ping from every
    // tab, so their cost grew with the square of the audience (100 people = ~3M rows
    // an hour). They now run at most once per PRESENCE_TTL per isolate and every ping
    // in between reuses the answer; the ping's own upsert above still lands every time.
    if (!(presenceMemo.counts && now - presenceMemo.at < PRESENCE_TTL)) {
    const pc = { online: 0, listening: 0, users: [], guestSince: 0 };
    await env.DB.prepare("delete from pings where at < ?").bind(now - 45000).run();
    const row = await env.DB.prepare("select count(*) as n, coalesce(sum(listening), 0) as l from pings where at > ?").bind(now - 35000).first();
    if (row) { pc.online = row.n || 0; pc.listening = row.l || 0; }
    // who's online: signed-in members identify themselves on the ping, so every
    // counter on the site (header chip, Book strip, booth) reads this ONE list
    try { const ur = await env.DB.prepare("select uid, name, max(at) as at, min(first) as since from pings where at > ? and uid is not null and uid != '' group by uid order by at desc limit 60").bind(now - 35000).all(); pc.users = (ur.results || []).map((r) => ({ uid: r.uid, name: r.name || "", since: r.since || 0 })); } catch (_) {}
    try { const gr = await env.DB.prepare("select min(first) as f from pings where at > ? and (uid is null or uid = '')").bind(now - 35000).first(); pc.guestSince = (gr && gr.f) || 0; } catch (_) {}
    presenceMemo.at = now; presenceMemo.counts = pc;
    }
    { const pc = presenceMemo.counts; counts.online = pc.online; counts.listening = pc.listening; counts.users = pc.users.slice(); counts.guestSince = pc.guestSince; }
    // a brand-new arrival counts at once even inside a memo window
    if (bellName && presenceMemo.at !== now) counts.online += 1;
    // ring the doorbell for the arrival spotted above — counts.online now
    // includes the person who just landed, which is the number the push
    // quotes. Fully wrapped: the ping answers the same whether or not the
    // ring goes through.
    if (bellName) { try { await doorbell(env, bellName, counts.online, now); } catch (_) {} }
  } catch (_) {}
  let S = await readDoc(env, "radio/dj");
  if (!S) return json({ ok: true, mode: "empty", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
  S.A = Object.assign({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 }, S.A || {});
  S.B = Object.assign({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 }, S.B || {});
  S.C = Object.assign({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 }, S.C || {});
  S.D = Object.assign({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 }, S.D || {});

  // GHOST-SHARE HOLD (mwGhostShare, reworked by the SHARE-STOP FIX,
  // 2026-11-01): this keeper NEVER ends a share. The old switch cleared
  // on + stopAt here once vstream.at was 15 minutes stale — but the
  // stamp only advances on the booth supervisor's proof, and a proof
  // can stall while the capture is alive (the booth tab frozen or
  // discarded, leadership moved to his other screen so the publisher's
  // saves were mirrored away, a repair ladder still climbing). The
  // keeper's stopAt then read on the booth EXACTLY like an owner Stop
  // from another screen, and the healthy share was torn all the way
  // down — capture tracks stopped, room left — roughly 15 minutes in.
  // A share ends ONLY by the owner's four lawful endings, all of them
  // client-side: his booth Stop tap, the browser stop bar (the raw
  // track's ended event), a fresher same-account claim, or an explicit
  // stopAt an owner screen wrote. What the keeper may still do with a
  // stale heartbeat is HOLD: stamp the diag source-gone once, so
  // viewers hold the mix/poster slate instead of a corpse frame, while
  // on, meeting and stopAt stay exactly as the owner left them. When
  // the publisher wakes (or he taps Bring it back) the supervisor
  // proves the chain, re-stamps, and the same meeting carries on. A
  // truly abandoned share is closed down by the owner, never by this
  // clock. The write rides writeDoc like every other keeper mutation.
  if (S.vstream && S.vstream.on === true && now - (Number(S.vstream.at) || 0) > 900000) {
    const dg = (S.vstream.diag && typeof S.vstream.diag === "object" && !Array.isArray(S.vstream.diag)) ? S.vstream.diag : {};
    if (dg.stage !== "source-gone") {
      S.vstream.diag = { stage: "source-gone", at: +dg.at || 0, repairs: Math.max(0, Math.min(9999, +dg.repairs || 0)) };
      S.updatedAt = now; S.by = "keeper";
      await writeDoc(env, "radio/dj", "radio", S);
    }
  }

  // REQUESTS PLAYLIST HARVEST: fold any listener pick still waiting in
  // the line into station/rqplaylist (throttled per isolate; the fold
  // itself is once-per-pick via the doc seen list). Runs BEFORE the
  // booth-fresh stand-down below on purpose: requests must be saved
  // even while his booth is live at the tables.
  if (now - rqHvAt > 45000) {
    rqHvAt = now;
    try {
      const rr = await loadRequests(env, now);
      const picks = [];
      for (const r of rr) { let d = null; try { d = JSON.parse(r.data || "null"); } catch (_) {} if (d && d.kind === "pick" && !d.played) picks.push({ d, path: r.path }); }
      if (picks.length) await rqPlaylistAdd(env, picks);
    } catch (_) {}
  }

  // MEECHIE SELF-REVIEW (daily, quiet hours ET): judgment-data
  // bookkeeping only — see the SELF-REVIEW block. Checked at most every
  // 10 minutes per isolate; the pass itself gates on the quiet window,
  // one run per ET day, the owner's kill switch, and establishes its
  // baseline docs on first sight. It receives S read-only and writes
  // only its allowlisted brain docs. Wrapped like the doorbell: it may
  // never break the station ping.
  if (now - selfRevCheckAt > 600000) {
    selfRevCheckAt = now;
    try { await selfReviewPass({ env, readDoc, writeDoc, readTaste, tasteScore, aiDjValidBlocks, aiDjDefaultDayparts }, S, now); } catch (_) {}
  }

  // MW TV (Stage 1): the channel tick rides the same ping — it keeps
  // tv/now's segment window ahead of the clock and decides the hourly
  // radio news break. It runs BEFORE the booth stand-down on purpose:
  // the channel is programming, not decks, so it advances while Malik
  // is at the tables too (his share/live still outranks it on every
  // screen — precedence lives in the renderer, not here). Wrapped like
  // the doorbell: a channel failure may never break the station ping.
  let tvNewsFire = null;
  let tvSpotItem = null;
  /* D1 READ FIX: the tick lays a ~2h window and every decision it
     makes (news windows, quarter cadence, spot cadence, Guardian
     confirmations) lives on a minute scale, but it used to run —
     and re-read its ~20 docs — on every station ping from every
     tab. Per isolate it now runs at most once per 5s; a decision
     can land up to 5s later than the old every-ping tick, inside
     the jitter the 12s ping cadence already carries. The ping
     itself is never throttled: presence, the booth stand-down and
     the rotation below run on every request, on fresh radio/dj. */
  /* F6-MITIGATED (see TV_TICK_FULL_MS at the stamp declarations):
     the full pass runs on the 60s stamp; on the old 5s gate between
     full passes only the 3-doc light check runs, and a pending
     skip / Guardian action pulls the full pass forward so it is
     still answered within ~5s. */
  let tvRunTick = now - tvTickAt >= TV_TICK_FULL_MS;
  if (!tvRunTick && now - tvLightAt >= 5000) {
    tvLightAt = now;
    try { tvRunTick = await tvLightPending(env, now); } catch (_) { tvRunTick = false; }
  }
  if (tvRunTick) {
    tvTickAt = now;
    try { const tvd = await tvTick(env, S, now, origin, counts && counts.online); if (tvd && tvd.fire) tvNewsFire = tvd; if (tvd && tvd.spot && tvd.spot.fire) tvSpotItem = tvd.spot; } catch (_) {}
  }

  // The booth has the tables — hands off. DEADLOCK BREAKER (mwDeadDeck,
  // 2026-10-28): unless a deck is impossibly past its end — flagged playing
  // with a known duration, its timeline more than 60s beyond the end of the
  // song, while the station is live. A live booth never legitimately sits a
  // minute past a song's end; that state means the booth's own end detection
  // was fooled (a YouTube shim reporting "playing" forever) and the station
  // is silent, so the keeper falls through and advances the rotation anyway,
  // fresh booth or not.
  const deadDeck = S.live && ["A", "B"].some((k) => { const dk = S[k]; return dk && dk.playing && +dk.dur > 0 && dk.start && now > dk.start + (+dk.dur) * 1000 + 60000; });
  // SILENT-BOOTH BREAKER (mwSilentBreak, 2026-10-28): the mirror image of the
  // deadlock breaker above. There the booth failed to END a deck; here the
  // booth ended one cleanly (it parked at the end of the song) and then never
  // advanced, leaving the station silent while boothAt stays fresh, so every
  // other keeper path stands down. When the station is live with Auto-DJ on,
  // nothing is playing on any deck, no deliberate pause is stamped, and an
  // A/B deck timeline has run past its end, the keeper stamps S.silentSince,
  // persisted with the keeper by-stamp so the booth adopts the write and
  // carries the field in its own saves instead of wiping it. If that same
  // silence is still there 20 seconds later, the keeper falls through and
  // runs the rotation itself. Hard protections: a deliberate pause
  // (pausedAt set) never fires, Auto-DJ off never fires, any deck playing
  // never fires, and a deck stopped by hand mid-song (its timeline still in
  // the future) never fires -- only a song that ended and parked counts.
  const boothFreshSB = !!(S.boothAt && now - S.boothAt < BOOTH_FRESH);
  const anyPlayingSB = ["A", "B", "C", "D"].some((k) => S[k] && S[k].playing);
  const endedAB = ["A", "B"].some((k) => { const dk = S[k]; return dk && +dk.dur > 0 && +dk.start > 0 && now > +dk.start + (+dk.dur) * 1000; });
  const silentNow = !!(S.live && S.autodj && !S.pausedAt && !anyPlayingSB && endedAB);
  const ssValid = +S.silentSince > 0 && +S.silentSince <= now;
  let silentBreak = false;
  if (silentNow) {
    if (!ssValid) { if (boothFreshSB) { S.silentSince = now; S.updatedAt = now; S.by = "keeper"; await writeDoc(env, "radio/dj", "radio", S); } }
    else if (now - S.silentSince > 20000) { silentBreak = true; delete S.silentSince; }
  } else if (S.silentSince) {
    delete S.silentSince;
    if (boothFreshSB && !deadDeck) { S.updatedAt = now; S.by = "keeper"; await writeDoc(env, "radio/dj", "radio", S); }
  }
  // HANDOVER BREAKER (mwHandBreak, 2026-10-28): no dead air and no late
  // starts. When a playing A/B deck reaches its crossfade point (XF seconds
  // left, the booth XF window) and its pair deck is not playing, the keeper falls
  // through and starts the pair itself with the next item through the normal
  // rotation crossfade below, even while boothAt is fresh. The rotation loop
  // re-tests that the pair is still not playing at the moment it starts the
  // deck, so a booth that began its own handover in the meantime is never
  // double-started. Same gates as the silence backstop: station live,
  // Auto-DJ on, no deliberate pause stamped.
  const handBreak = !!(S.live && S.autodj && !S.pausedAt && ["A", "B"].some((k) => { const dk = S[k]; const pk = S[k === "A" ? "B" : "A"]; return dk && dk.playing && +dk.dur > 0 && +dk.start > 0 && now >= +dk.start + (+dk.dur) * 1000 - XF * 1000 && !(pk && pk.playing); }));
  // A due radio news break (tvNewsFire, decided by tvTick above) also
  // falls through this stand-down, exactly like the breakers: Malik's
  // standing rule (NEWS-BLOCK) is that the news cuts in even during
  // his own live booth sets — no booth exception. The rotation's fire
  // block below applies it with its own guards and stamps S.newsHour,
  // so the fall-through happens at most once per quarter hour.
  /* HANDS: TV-only drain — the wall means TV commands don't wait for
     the booth: a tv.skip asked while Malik is live at the tables still
     lands (and the one-time activation runs), while radio commands
     stay queued for the main drain below. Decks are never touched in
     this mode (startDeckItem stays null on purpose). */
  try { await handsDrain(env, { S, now, tvOnly: true, deps: { env, origin, readDoc, readTaste, tasteScore, cleanBrainEvent, fetchFn: fetch }, startDeckItem: null, cur: null, brainEvts: [] }); } catch (_) {}
  if (S.boothAt && now - S.boothAt < BOOTH_FRESH && !deadDeck && !silentBreak && !handBreak && !tvNewsFire) return json({ ok: true, mode: "booth", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
  // VMIX RESCUE (mwVmixRescue, 2026-10-29): past this line the booth is
  // stale or a breaker fell through; the helper re-tests staleness itself
  // (a breaker fall-through with a fresh booth must never move the
  // screen) and re-points a dead featured deck at a genuinely advancing
  // one. The write rides writeDoc like the ghost-share switch above,
  // stamped by the keeper; the rotation below then runs as normal, and
  // on the tick where no deck is advancing yet the helper simply waits
  // for a later one.
  if (mwVmixRescue(S, now, MW_VMIX_OBS)) { S.updatedAt = now; S.by = "keeper"; await writeDoc(env, "radio/dj", "radio", S); }
  // Auto-DJ off is Malik's setting: the keeper stays out and the playlist rules.
  if (!S.autodj) {
    if (S.live && now - (S.updatedAt || 0) > 180000) { S.live = false; S.updatedAt = now; S.by = "keeper"; /* mwFlapFix */ await writeDoc(env, "radio/dj", "radio", S); }
    return json({ ok: true, mode: "playlist", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
  }

  const { lib, byAsset } = await loadLib(env, now);
  if (!lib.length) return json({ ok: true, mode: "empty-lib", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
  const durOf = (deck) => { if (+deck.dur > 0) return +deck.dur; const t = lib.find((x) => deck.src && deck.src.includes(x.assetId)); return t ? +t.duration : 0; };
  const srcOf = (t) => origin + "/m/assets/" + t.assetId;

  // DJ BRAIN (PR-B1): the keeper teaches the brain what it plays while the
  // booth is away. Starts and consumed picks collect here and flush once at
  // the end of the tick through the shared writer (lib/brain-taste.js:
  // brain_events rows + the brain/taste fold). Best-effort like the
  // doorbell — a brain failure may never break the station ping.
  const brainEvts = [];
  const seedPlays = []; // SELF-REVIEW: aiQ seed phrases whose picks actually played this tick, flushed with the brain events below
  const brainPlay = (k, item) => {
    let artist = "";
    if (!item.yt && item.src) { const t = lib.find((x) => String(item.src).includes(x.assetId)); if (t && t.artist) artist = String(t.artist).slice(0, 80); }
    // pool and pick titles carry the artist after the middle dot ("Song · Johnny Cash")
    if (!artist && !item.yt) { const parts = String(item.title || "").split("·"); if (parts.length > 1) artist = parts[parts.length - 1].trim().slice(0, 80); }
    const ev = cleanBrainEvent({ type: "play", yt: item.yt || "", src: item.src || "", title: item.title || "", artist, deck: k, at: now, live: !!S.live }, "keeper");
    if (ev) brainEvts.push(ev);
  };
  const bagPick = async (avoidSrc) => {
    if (!Array.isArray(S.bag) || !S.bag.length) {
      // DJ BRAIN (PR-B1): the refill is a weighted shuffle over the taste
      // profile — favorites land where they are drawn sooner, but the bag
      // stays a permutation of the whole library drawn without replacement
      // (no-repeat-until-empty holds by construction), and with no profile
      // every weight is 1 and the order is the plain uniform shuffle this
      // replaces. Only this refill is weighted: listener picks, schedQ and
      // Malik's own queue draws are his word, never the brain's.
      let taste = null;
      try { taste = await readTaste(env); } catch (_) {}
      S.bag = weightedBagOrder(lib, taste);
    }
    let id = S.bag.pop();
    if (avoidSrc && id && avoidSrc.includes(id) && S.bag.length) { const other = S.bag.pop(); S.bag.push(id); id = other; }
    return byAsset.get(id) || lib[0];
  };
  const startDeckItem = (k, item, startMs) => {
    S[k] = { src: item.src || "", yt: item.yt || "", kind: item.kind || "", scUrl: item.scUrl || "", scId: item.scId || 0, title: item.title || "", cover: item.cover || "", start: startMs, pos: 0, playing: true, vol: S[k].vol ?? 0.9, rate: 1, dur: item.dur || 0 };
    if (item.shout) S.shout = item.shout; // a listener shout-out rides the station state while the requested song plays (painted by the stage shout lines)
    S.log = [{ t: item.title || "", at: now, live: true }].concat((S.log || []).filter((x) => x.t !== item.title)).slice(0, 30);
    brainPlay(k, item); // DJ BRAIN: the unattended start is a play the brain learns from
  };
  const startDeck = (k, t, startMs) => startDeckItem(k, { src: srcOf(t), title: t.title || "", cover: t.cover || "", dur: +t.duration || 0 }, startMs);
  /* listener picks (docs in the requests collection, kind:"pick") jump the queue:
     they play next, ahead of the library rotation. A pick is consumed (deleted)
     whether or not its file resolves, so a dead pick can never jam the station. */
  const takePick = async () => {
    let rows = [];
    try { rows = await loadRequests(env, now); } catch (_) { return null; }
    const picks = [];
    for (const r of rows) { try { const d = JSON.parse(r.data); if (d && d.kind === "pick" && !d.played) picks.push({ path: r.path, d }); } catch (_) {} }
    picks.sort((a, b) => (a.d.at || 0) - (b.d.at || 0));
    const shoutOf = (d, title) => d.shoutout ? { text: String(d.shoutout).slice(0, 140), by: String(d.by || "A listener").slice(0, 40), title, at: now } : null;
    for (const p of picks) {
      let src = p.d.src || "", iaDur = 0, ytItem = null;
      if (src && src.includes("supabase.co")) src = "";
      if (!src && !p.d.iaId && p.d.yt) {
        // a YouTube song request (Meechie AI found the video at the
        // request slot under the screen): it plays as a video deck,
        // exactly like a queued video, so its picture takes the master
        // screen. Only with a known length — an unknown-length video
        // could stall the unattended station.
        const yid = String(p.d.yt);
        if (/^[A-Za-z0-9_-]{11}$/.test(yid) && +p.d.dur > 0) ytItem = { src: "", yt: yid, title: p.d.title || "", cover: p.d.cover || ("https://i.ytimg.com/vi/" + yid + "/hqdefault.jpg"), dur: +p.d.dur };
        else {
          /* D1 BURN FIX F2 (2026-11-07, AUDIT3): this pick can never
           * play unattended — no usable file src, no archive id, and
           * the video fails the gate (an id no player can load, or a
           * length nobody knows). It used to sit in the waiting line
           * forever, re-read from D1 on every loadRequests pass while
           * the line behind it grew. It is now consumed exactly like
           * a dead pick below: folded into the saved Listener
           * Requests playlist first — the request itself is never
           * lost, and the booth can still load it from the playlist,
           * whose player learns the length as it loads — then
           * deleted, so the line drains. If the fold fails the pick
           * stays for a later pass, never deleted unsaved. Playable
           * and pending picks are untouched: same picks, same order,
           * same returns as before. */
          try { await rqPlaylistAdd(env, [{ d: p.d, path: p.path }]); } catch (_) { continue; }
          try { await env.DB.prepare("delete from docs where path = ?").bind(p.path).run(); await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", p.path, "requests", null, null, Date.now()).run(); rqMemo.at = 0; } catch (_) {}
          continue;
        }
      }
      if (!src && p.d.iaId) {
        try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(p.d.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) { src = "https://archive.org/download/" + encodeURIComponent(p.d.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"); iaDur = +f.length || 0; } } catch (_) {}
      }
      try { await env.DB.prepare("delete from docs where path = ?").bind(p.path).run(); await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", p.path, "requests", null, null, Date.now()).run(); rqMemo.at = 0; } catch (_) {}
      if (ytItem) { const ev = cleanBrainEvent({ type: "request", yt: ytItem.yt, title: ytItem.title, at: now, live: !!S.live }, "keeper"); if (ev) brainEvts.push(ev); const sh = shoutOf(p.d, ytItem.title); if (sh) ytItem.shout = sh; try { await rqPlaylistAdd(env, [{ d: p.d, path: p.path }]); } catch (_) {} return ytItem; }
      if (src) { const ev = cleanBrainEvent({ type: "request", src, title: p.d.title || "", at: now, live: !!S.live }, "keeper"); if (ev) brainEvts.push(ev); const item = { src, title: p.d.title || "", cover: p.d.cover || "", dur: iaDur || (+p.d.dur || 0) }; const sh = shoutOf(p.d, item.title); if (sh) item.shout = sh; try { await rqPlaylistAdd(env, [{ d: p.d, path: p.path }]); } catch (_) {} return item; }
    }
    return null;
  };
  /* the mixed rotation: like a real station, the Auto-DJ alternates Meechie's own
     tracks with real-artist music from the Internet Archive pool (free/CC). The
     pool lives in the station doc and refills itself when it runs dry. */
  const POOL_QUERIES = ['creator:"Johnny Cash"', 'creator:"Miles Davis"', 'creator:"Grateful Dead"', 'creator:"James Brown"', 'creator:"Bob Marley"', 'creator:"Duke Ellington"', 'creator:"John Coltrane"', '"hip hop" mixtape', '"soul" "live"', '"rock" "live" concert', '"reggae" "live"', '"jazz" "live"'];
  async function buildPool() {
    const out = [], seen = new Set();
    for (const q of POOL_QUERIES) {
      try {
        const u = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent("(" + q + ") AND mediatype:audio AND licenseurl:*creativecommons*") + "&fl[]=identifier&fl[]=title&fl[]=creator&sort[]=downloads+desc&rows=12&output=json";
        const j = await (await fetch(u)).json();
        for (const d of (j.response?.docs || [])) { const id = String(d.identifier); if (seen.has(id)) continue; seen.add(id); out.push({ iaId: id, title: [].concat(d.title || id)[0] + (d.creator ? " · " + [].concat(d.creator)[0] : ""), cover: "https://archive.org/services/img/" + encodeURIComponent(id) }); }
      } catch (_) {}
    }
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out.slice(0, 80);
  }
  async function poolItem() {
    if (!Array.isArray(S.pool) || !S.pool.length || (S.poolAt && now - S.poolAt > 24 * 3600e3)) { S.pool = await buildPool(); S.poolAt = now; }
    while (S.pool && S.pool.length) {
      const p = S.pool.pop();
      try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(p.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) return { src: "https://archive.org/download/" + encodeURIComponent(p.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"), title: p.title || "", cover: p.cover || "", dur: +f.length || 0 }; } catch (_) {}
    }
    return null;
  }
  // LISTENER REQUESTS LANE: draws from the saved requests playlist
  // (station/rqplaylist) with a no-repeat bag — S.rqBag holds the keys
  // not yet drawn this cycle and refills WEIGHTED when it empties
  // (rqWeightedOrder: a request asked for more often surfaces sooner;
  // the bag stays a permutation, so every request still plays each
  // cycle — the weighting the daily self-review maintains). Unattended rules
  // match the rest of the tail: a video needs a known length, dead
  // file hosts never play.
  const rqLaneItem = async () => {
    const doc = await readDoc(env, RQPL_PATH);
    const items = doc && Array.isArray(doc.items) ? doc.items : [];
    if (!items.length) return null;
    const playable = (r) => !!r && ((r.yt && +r.dur > 0) || (r.src && !/supabase/i.test(r.src)) || !!r.iaId);
    let bag = Array.isArray(S.rqBag) ? S.rqBag.filter((k) => items.some((r) => r.k === k)) : [];
    if (!bag.length) { bag = rqWeightedOrder(items.filter(playable), Math.random); }
    while (bag.length) {
      const k = bag.shift(); const r = items.find((x) => x.k === k);
      if (!r || !playable(r)) continue;
      if (r.yt) { S.rqBag = bag; return { src: "", yt: r.yt, title: r.title || "", cover: r.cover || ("https://i.ytimg.com/vi/" + r.yt + "/hqdefault.jpg"), dur: +r.dur || 0 }; }
      if (r.src && !/supabase/i.test(r.src)) { S.rqBag = bag; return { src: r.src, title: r.title || "", cover: r.cover || "", dur: +r.dur || 0 }; }
      if (r.iaId) { try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(r.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) { S.rqBag = bag; return { src: "https://archive.org/download/" + encodeURIComponent(r.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"), title: r.title || "", cover: r.cover || "", dur: +r.dur || Math.round(+f.length || 0) }; } } catch (_) {} }
    }
    S.rqBag = bag; return null;
  };

  const nextItem = async (avoidSrc) => {
    const pk = await takePick();
    if (pk) return pk;
    if (Array.isArray(S.schedQ) && S.schedQ.length) return S.schedQ.shift();
    /* the DJ's own queue (owner, 2026-10-27: "make my dj session continue even
       if im not on"): the booth mirrors its UP NEXT queue into S.queue, so when
       the booth closes the keeper plays HIS set through in order before falling
       back to the rotation. File items play as-is; video items play when their
       length is known (an unknown-length or unplayable video must never stall
       the unattended station — the booth can still play it when he is back). */
    if (Array.isArray(S.queue) && S.queue.length) {
      while (S.queue.length) {
        /* mwShufflePick: shuffle draw from the queue (Malik, 2026-10-28) --
           a random entry each draw instead of always the head of the list;
           the drawn entry is removed from the stored queue, so the list
           shuffles through the decks without repeats until it empties. */
        const it = S.queue.splice(Math.floor(Math.random() * S.queue.length), 1)[0]; changed = true;
        if (!it) continue;
        const title = String(it.title || "").slice(0, 120), cover = String(it.cover || "").slice(0, 300);
        if (it.yt) { if (+it.dur > 0) return { src: "", yt: String(it.yt), title, cover, dur: +it.dur }; continue; }
        /* SoundCloud queue items (2026-10-31): the same known-length rule as video — an unknown-length track must never stall the unattended station; the booth widget fills the length in when it loads. */
        if (it.kind === "sc" && it.scUrl) { if (+it.dur > 0) return { src: "", yt: "", kind: "sc", scUrl: String(it.scUrl), scId: +it.scId || 0, title, cover, dur: +it.dur }; continue; }
        const src = String(it.src || "");
        if (src && !src.includes("supabase.co")) return { src, title, cover, dur: +it.dur || 0 };
      }
    }
    /* AI DJ stock (PR-C1): Meechie AI picks, stocked by aiDjPass from
       the owner taste profile while he is away. The slot sits exactly here —
       listener picks, the schedule and every song Malik queued play
       first, always; AI stock plays only when his line is empty, ahead
       of the frozen pool/library rotation it exists to refresh. Items
       arrive pre-filtered (playable, known duration, deduped), and the
       draw re-checks the same known-duration rule the queue branch
       enforces, so an AI video can never stall the unattended station. */
    if (Array.isArray(S.aiQ) && S.aiQ.length) {
      while (S.aiQ.length) {
        const it = S.aiQ.shift(); changed = true;
        if (!it) continue;
        if (it.q) seedPlays.push(String(it.q).slice(0, 80));
        if (it.yt && +it.dur > 0) return { src: "", yt: String(it.yt), title: String(it.title || "").slice(0, 120), cover: String(it.cover || "").slice(0, 300), dur: +it.dur };
      }
    }
    /* MW TV SHOW SPOTS ON THE RADIO (Malik, 2026-11-03: "play them
       randomly, even on the radio"): a due spot (tvSpotDecision in
       tvTick — live Auto-DJ, ~15-minute cadence, media probed on
       the site, never the same spot twice in a row) is served
       HERE, at a song boundary, behind everything with a person
       behind it — listener picks, the schedule, Malik's own queue
       and AI stock all play first — and never while his booth is
       fresh (his live set is his; unlike the news, spots carry no
       cut-in order). Serving stamps S.spotAt / S.spotLast into the
       station doc this tick already writes. */
    if (tvSpotItem && !(S.boothAt && now - S.boothAt < BOOTH_FRESH)) {
      const sp = tvSpotItem; tvSpotItem = null;
      S.spotAt = now; S.spotLast = sp.spotId; changed = true;
      // Sponsor radio plays count too (the pool doc's radio tally),
      // with the same honest air-time online count.
      if (String(sp.spotId || "").indexOf("spn-") === 0) {
        try {
          const p = await readDoc(env, "tv/breakpool");
          const it = p && (p.items || []).find((x) => x && x.id === sp.spotId);
          if (it) {
            if (!it.tally || typeof it.tally !== "object") it.tally = { served: 0, radioServed: 0, lastAt: 0, lastOnline: 0, countedThrough: 0 };
            it.tally.radioServed = (+it.tally.radioServed || 0) + 1;
            it.tally.lastAt = now;
            if (counts && counts.online != null) it.tally.lastOnline = counts.online;
            p.updatedAt = now; await writeDoc(env, "tv/breakpool", "tv", p);
          }
        } catch (_) {}
      }
      return { src: sp.item.src, title: sp.item.title, dur: sp.item.dur };
    }
    // REQUESTS PLAYLIST LANE (2026-10-30): the tail of the rotation is
    // where nothing fresher is waiting, so the settled priority above
    // (listener picks, schedule, his queue, AI picks) is untouched.
    // Every third tail draw offers the saved Listener Requests
    // playlist a turn alongside the pool/bag; when the playlist is
    // empty or yields nothing playable the draw falls through to the
    // pool/bag alternation exactly as before, and the pool/bag order
    // between themselves never changes (mixAlt flips independently).
    S.rqTail = (S.rqTail | 0) + 1;
    if (S.rqTail % 3 === 0) { const rqItem = await rqLaneItem(); if (rqItem) return rqItem; }
    S.mixAlt = !S.mixAlt; // alternate: one of Meechie's, one from the world
    if (S.mixAlt) {
      /* WEB MIX (owner, 2026-11-08): inside the mixed daypart the
         "world" slot belongs to the collaboration web first (see the
         WEBMIX block above aiDjPass) — a web draw that yields
         nothing, and every draw outside the mixed block, falls
         through to the Archive pool exactly as before. */
      if (webMixActive(now)) { const wi = await webLaneItem({ origin, fetchFn: fetch }, S, now); if (wi) return wi; }
      const pi = await poolItem(); if (pi) return pi;
    }
    const t = await bagPick(avoidSrc);
    return { src: srcOf(t), title: t.title || "", cover: t.cover || "", dur: +t.duration || 0 };
  };

  // A deliberate pause by the DJ is not dead air: the booth stamps S.pausedAt
  // when Malik pauses with nothing else playing, and the keeper respects it for
  // up to 30 minutes instead of restarting deck A over him. (A track that ends
  // naturally never sets the stamp, so the rotation still never goes quiet.)
  // Park stale C/D decks: the keeper only ever runs A/B, so a C or D deck left
  // flagged "playing" by a closed booth or an ended guest set (its timeline
  // long past the end of the track) is a ghost — clients chase its position
  // past the end of the video forever, which sounds like skipping. Park it.
  let parked = false;
  for (const k of ["C", "D"]) { const dk = S[k]; if (dk && dk.playing) { const dur = +dk.dur || 0; if ((dur > 0 && now > (dk.start || 0) + dur * 1000 + 30000) || (!dur && now - (dk.start || 0) > 30 * 60e3)) { dk.playing = false; dk.pos = 0; parked = true; } } }
  // Park an orphaned A/B deck (2026-10-29): the rotation loop below picks A
  // first as cur, so a B->A crossfade leaves B flagged playing past its end
  // forever — once A starts, cur is A, A's own end is far off, and B is never
  // visited again, so clients chase B's ended video (skipping) under the live
  // deck. An A->B handoff self-cleans because A stays cur until its end, but
  // park either side symmetrically: a deck past its timeline cannot still be
  // playing, and the 30s grace keeps the 5s blend itself untouched.
  for (const k of ["A", "B"]) { const dk = S[k]; if (dk && dk.playing) { const dur = durOf(dk) || 0; if ((dur > 0 && now > (dk.start || 0) + dur * 1000 + 30000) || (!dur && now - (dk.start || 0) > 30 * 60e3)) { dk.playing = false; dk.pos = 0; parked = true; } } }
  if (S.pausedAt && now - S.pausedAt < 30 * 60e3 && !S.A.playing && !S.B.playing) {
    if (parked || now - (S.updatedAt || 0) > 20000) { S.updatedAt = now; S.by = "keeper"; /* mwFlapFix */ await writeDoc(env, "radio/dj", "radio", S); }
    return json({ ok: true, mode: "paused", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
  }
  if (S.pausedAt && (S.A.playing || S.B.playing)) S.pausedAt = 0;
  if (S.silentSince && anyPlayingSB) delete S.silentSince; // mwSilentBreak: a playing deck ends any silence episode

  let changed = parked;
  // schedule (owner, 2026-10-27): at a set time each day the station switches
  // to a saved playlist and plays it through in order. The booth writes the
  // entries to the station/schedule doc; ready items wait in S.schedQ and
  // nextItem serves them first. File items only — video items need a real
  // booth open, like every video deck. The 15-minute firing window means a
  // station nobody pinged at the exact minute still picks the show up.
  try {
    const sd = await readDoc(env, "station/schedule");
    const entries = sd && Array.isArray(sd.entries) ? sd.entries : [];
    if (entries.length) {
      const nowD = new Date(now);
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(nowD);
      const gp = (t) => +(parts.find((x) => x.type === t) || {}).value || 0;
      const nowMin = gp("hour") * 60 + gp("minute");
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(nowD);
      for (const en of entries) {
        const mm = /^(\d{1,2}):(\d{2})$/.exec(String(en.time || "")); if (!mm) continue;
        const atMin = (+mm[1]) * 60 + (+mm[2]);
        const key = en.id + "@" + day;
        if (nowMin >= atMin && nowMin < atMin + 15 && S.schedFired !== key) {
          S.schedQ = (en.items || []).filter((it) => it && it.src && !it.yt).map((it) => ({ src: String(it.src), title: String(it.title || ""), cover: String(it.cover || ""), dur: +it.dur || 0 }));
          S.schedFired = key; changed = true;
        }
      }
    }
  } catch (_) {}
  /* AI DJ pass (PR-C1): after the deliberate-pause return above and the
     schedule block, immediately before the rotation loop — a point this
     tick only reaches when the keeper is running the station itself.
     The pass re-tests every gate internally (kill switch, booth stale
     30 minutes, his queue empty, AI stock low, 10-minute throttle), so
     a breaker fall-through with a fresh booth can never trigger it.
     Fully wrapped: a pass failure leaves the rotation untouched, and
     anything it stocks rides this same tick write via the changed flag. */
  try {
    /* HANDS: Malik's hold (brain/control.aiHold — flipped from the
       booth BRAIN panel or by his word in chat) pauses Meechie's
       stocking without touching anything else; his queue and the
       library rotation still run the station. */
    const hctl = await handsCtlCached(env, now);
    const aidj = hctl.aiHold ? { changed: false, events: [], note: "hold" } : await aiDjPass({ env, origin, lib, readDoc, readTaste, tasteScore, cleanBrainEvent, fetchFn: fetch }, S, now);
    if (aidj && aidj.changed) changed = true;
    if (aidj && aidj.events && aidj.events.length) brainEvts.push(...aidj.events);
  } catch (_) {}
  const xfToward = (x, amt) => { const v = (x ?? 0.5) + Math.max(-amt, Math.min(amt, 0.5 - (x ?? 0.5))); return Math.round(v * 1000) / 1000; };
  let cur = S.A.playing ? "A" : S.B.playing ? "B" : null;
  if (!cur) { // dead air — start the rotation on deck A right now (fader home is CENTER, owner 2026-10-29)
    startDeckItem("A", await nextItem(""), now); S.xf = 0.5; changed = true; cur = "A";
  }
  /* MW TV NEWS INTERRUPT (NEWS-BLOCK.md, Malik 2026-11-01 ~21:16;
   * cadence 2026-11-03: every quarter hour): the Meechie's World
   * News radio cut, decided by tvTick for this quarter hour. A fresh edition takes the incoming deck now —
   * a hard programmed break, the way a real station cuts to news. The
   * current song parks honestly (playing flag off, pos stamped where
   * it stopped — its timeline is never falsified) and the rotation
   * resumes from the news deck's end through the loop below. The 10s
   * guard keeps a same-tick dead-air start from being consumed and
   * parked in the same breath. No fresh edition = tvNewsFire is null
   * and nothing here moves. */
  if (tvNewsFire && cur) {
    const otherN = cur === "A" ? "B" : "A";
    if (S[cur].playing && !S[otherN].playing && now - (S[cur].start || now) > 10000) {
      S[cur].playing = false; S[cur].pos = Math.max(0, Math.min(+S[cur].dur || 0, (now - (S[cur].start || now)) / 1000));
      startDeckItem(otherN, tvNewsFire.item, now);
      S.xf = 0.5; S.newsHour = tvNewsFire.hourKey; changed = true; cur = otherN;
    }
  }
  /* HANDS DRAIN (2026-11-03): Meechie's queued operator commands run
     here — after tvTick and the news interrupt, inside the keeper's
     own tick — so every radio action inherits the keeper's rules and
     rides this tick's write (see the HANDS block for the full shape). */
  try {
    const hd = await handsDrain(env, { S, now, tvOnly: false, deps: { env, origin, lib, readDoc, readTaste, tasteScore, cleanBrainEvent, fetchFn: fetch }, startDeckItem, cur, brainEvts });
    if (hd) { if (hd.changed) changed = true; if (hd.cur) cur = hd.cur; }
  } catch (_) {}
  for (let i = 0; i < 60; i++) {
    const other = cur === "A" ? "B" : "A";
    const dur = durOf(S[cur]) || 240;
    const endAt = (S[cur].start || now) + dur * 1000;
    if (now >= endAt) { // song fully over: stop it; the other deck (already started at the fade) takes the wheel
      if (S[cur].playing) { S[cur].playing = false; S[cur].pos = 0; changed = true; }
      if (S[other].playing) { cur = other; continue; }
      startDeckItem(other, await nextItem(S[cur].src), endAt); S.xf = 0.5; changed = true; cur = other; continue;
    }
    if (now >= endAt - XF * 1000 && !S[other].playing) { // crossfade point: bring the next song in under this one
      startDeckItem(other, await nextItem(S[cur].src), endAt - XF * 1000);
      /* mwHornStamp (2026-10-28): every automated crossfade start stamps
         fxHornAt; dj.js clients watch the field and fire one air-horn stab
         per new value, so an Auto-DJ transition sounds DJed on every device
         at the same moment. Only this crossfade branch stamps it — cold
         starts (dead air, silence-breaker rescues, schedule/pool starts
         with nothing playing) never do. */
      if (S.hornOn === true) S.fxHornAt = now; // horns OFF unless the owner turns them on (S.hornOn, owner 2026-10-29)
      S.xf = xfToward(S.xf, 0.34); changed = true; // no more slamming the fader to the edge (owner, 2026-10-29: "keeps jumping") — one step toward center; the settle below finishes the walk
    }
    break;
  }
  /* Crossfader home (owner, 2026-10-29): the fader rests at CENTER and
     follows what is playing. Each keeper pass walks it toward 0.5 — gently
     when the playing deck is audible, in one step when a playing deck is
     faded out (gain under 0.2: the station reads as off while a song
     plays). Booth away only; his hand on the pad outranks this entirely. */
  if (!boothFreshSB) {
    const gAB = (x, side) => Math.cos((side === "A" ? x : 1 - x) * Math.PI / 2);
    [["xf", "A", "B"], ["xf2", "C", "D"]].forEach(([key, a, b]) => {
      const pa = !!(S[a] && S[a].playing), pb = !!(S[b] && S[b].playing);
      if (pa === pb) return;
      const k = pa ? a : b, x = S[key] ?? 0.5;
      const step = gAB(x, k === "B" || k === "D" ? "B" : "A") < 0.2 ? 0.5 : 0.12;
      const nx = xfToward(x, step);
      if (nx !== x) { S[key] = nx; changed = true; }
    });
  }
  // station clock: about once an hour the unattended station IDs itself with
  // the first sound-board pad, the way a real station does at the top of the hour
  const pad0 = (S.pads || [])[0];
  if (pad0 && pad0.url && now - (S.clockAt || 0) > 50 * 60e3) { S.voice = { id: pad0.id || "", url: pad0.url, at: now }; S.clockAt = now; changed = true; }
  if (!S.live) { S.live = true; S.liveSince = now; changed = true; }
  // Unattended rule: while no booth is at the tables, the 24/7 station rests on the
  // clean broadcast profile. Performance FX a DJ left cranked (bitcrush grit, the
  // transformer chop, heavy flanger/reverb, a slammed boost) are for a live set —
  // left on the unattended rotation they just read as static and wash, and they
  // made the station sound like it kept "switching off" Pro Radio. The moment
  // Malik opens the booth (boothAt fresh, above) his settings rule again.
  if (S.fx && !boothFreshSB) { // breaker fall-throughs (mwHandBreak/mwSilentBreak/mwDeadDeck) can reach here with a fresh booth -- the clean profile below is for the unattended station only
    const fx = S.fx;
    if ((+fx.crush || 0) !== 0) { fx.crush = 0; changed = true; }
    if ((+fx.gate || 0) !== 0) { fx.gate = 0; changed = true; }
    if ((+fx.fla || 0) > 0.25) { fx.fla = 0.25; changed = true; }
    if ((+fx.verb || 0) > 0.3) { fx.verb = 0.3; changed = true; }
    if ((+fx.pha || 0) > 0.3) { fx.pha = 0.3; changed = true; }
    if ((+fx.noise || 0) > 0.5) { fx.noise = 0.5; changed = true; }
    if ((+fx.boost || 1) > 1.3) { fx.boost = 1.3; changed = true; }
  }
  if (now - (S.updatedAt || 0) > 20000) { S.updatedAt = now; changed = true; }
  // DJ BRAIN flush: one shared write for everything this tick started or
  // consumed (brain_events rows + the brain/taste fold). Best-effort — the
  // station answers the same whether or not the brain remembers.
  if (brainEvts.length) { try { await recordBrainEvents(env, brainEvts); } catch (_) {} }
  if (seedPlays.length) { try { await selfSeedNote(env, null, seedPlays); } catch (_) {} }
  if (changed) { S.by = "keeper"; /* mwFlapFix: keeper writes carry their own stamp, so a booth tab never mistakes a rescue for its own save echo */ await writeDoc(env, "radio/dj", "radio", S); }
  return json({ ok: true, mode: "autodj", changed, now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
}

/* Guest song requests: the picker in js/dj.js first tries the member write; when
 * that is refused (a visitor who is not signed in), it posts the pick here instead.
 * The pick lands as a normal requests doc that the booth and this keeper already
 * know how to play. Only picks with a resolved, trusted src and short text
 * requests are accepted, rate-limited per visitor. */
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  let b = null; try { b = await request.json(); } catch (_) {}
  if (!b) return json({ ok: false, error: "bad_body" }, 400);
  /* HANDS doors (2026-11-03): Meechie's operator actions, session-
   * checked server-side. kind "handsctl" flips the kill switch / the
   * stocking hold (owner only — the booth BRAIN panel rides this).
   * kind "hands" runs one intent through lib/meechie-hands.js
   * handsAct: owner sessions get the full hand; member sessions get
   * the member-safe subset (song requests + declines). Anonymous
   * callers get nothing. Authority lives in the registry + handsAct,
   * never in the client. */
  if (b.kind === "handsctl" || b.kind === "hands") {
    const me = await userFrom(request, env).catch(() => null);
    if (!me) return json({ ok: false, error: "sign_in_required" }, 401);
    const owner = await isAdmin(env, me.id).catch(() => false);
    if (b.kind === "handsctl") {
      if (!owner) return json({ ok: false, error: "owner_only" }, 403);
      const patch = {};
      if (typeof b.hands === "boolean") patch.hands = b.hands;
      if (typeof b.aiHold === "boolean") patch.aiHold = b.aiHold;
      if (!Object.keys(patch).length) return json({ ok: false, error: "nothing_to_set" }, 400);
      const ctl = await HANDS.handsSetControl(env, patch, me.id);
      await HANDS.handsLog(env, { action: "control." + (typeof b.hands === "boolean" ? "hands" : "hold"), target: "brain/control", summary: "Owner flipped " + Object.keys(patch).map((k) => k + " → " + patch[k]).join(", ") + " from the booth BRAIN panel.", by: me.name || "", uid: me.id, role: "owner" });
      handsCtlMemo = { at: 0, ctl: null };
      return json({ ok: true, control: { hands: ctl.hands, aiHold: ctl.aiHold } });
    }
    const intent = HANDS.handsIntent(String(b.text || ""));
    if (!intent) return json({ ok: false, error: "no_action_in_text" }, 400);
    const r = await HANDS.handsAct(env, { role: owner ? "owner" : "member", uid: me.id, name: me.name || "" }, intent, { origin: new URL(request.url).origin, fetchFn: fetch, cookie: request.headers.get("cookie") || "", aiText: (p) => HANDS.handsAiText(env, p) });
    return json({ ok: true, reply: r.reply, action: r.action || null, queued: r.queued || null, refused: !!r.refused });
  }
  /* guest DJ relay: a member Malik approved (S.djGuest in the station doc, set only
     by his own booth) performs on their sandboxed table and posts the performance
     here. The gate is strict: a live session, a grant naming that exact member,
     unexpired — and only performance fields are merged, each one sanitized, so a
     guest can never touch the station's own settings, log, show or grant. The
     write stamps boothAt, so the keeper treats a guest set exactly like Malik's
     own booth and keeps its hands off; Malik opening his booth overrides at once. */
  if (b.kind === "guestdj") {
    const user = await userFrom(request, env).catch(() => null);
    if (!user) return json({ ok: false, error: "no_session" }, 401);
    const S = await readDoc(env, "radio/dj");
    const g = S && S.djGuest;
    if (!S || !g || g.uid !== user.id || !(g.until > Date.now())) return json({ ok: false, error: "no_grant" }, 403);
    if (g.lastWrite && Date.now() - g.lastWrite < 1500) return json({ ok: true, skipped: true });
    const num = (v, lo, hi, dft) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dft; };
    const deck = (p) => { p = p || {}; const src = String(p.src || "").slice(0, 500); const yt = /^[A-Za-z0-9_-]{6,20}$/.test(p.yt || "") ? p.yt : ""; return { src: (src.startsWith("https://") || src.startsWith("/m/")) ? src : "", yt, title: String(p.title || "").slice(0, 120), cover: String(p.cover || "").slice(0, 300), start: num(p.start, 0, Date.now() + 60000, 0), pos: num(p.pos, 0, 7200, 0), playing: !!p.playing, vol: num(p.vol, 0, 2, 0.9), rate: num(p.rate, 0.5, 2, 1), dur: num(p.dur, 0, 7200, 0), eq: [0, 1, 2].map((i) => num((p.eq || [])[i], -15, 15, 0)), flt: num(p.flt, 0, 1, 1), bpm: num(p.bpm, 0, 300, 0), beat0: num(p.beat0, 0, 7200, 0), key: String(p.key || "").slice(0, 8), cam: String(p.cam || "").slice(0, 8), vcut: !!p.vcut, bcut: !!p.bcut, cues: [0, 1, 2].map((i) => num((p.cues || [])[i], 0, 7200, 0)), loop: (p.loop && typeof p.loop === "object") ? { a: num(p.loop.a, 0, 7200, 0), b: num(p.loop.b, 0, 7200, 0) } : null, loopBeats: num(p.loopBeats, 0, 64, 0) }; };
    S.A = deck(b.A); S.B = deck(b.B); S.C = deck(b.C); S.D = deck(b.D);
    S.xf = num(b.xf, 0, 1, S.xf ?? 0.5); S.xf2 = num(b.xf2, 0, 1, S.xf2 ?? 0.5); S.panY = num(b.panY, -1, 1, S.panY ?? 0);
    const fxIn = b.fx || {};
    // a guest's table starts from factory defaults — don't let their untouched
    // FX stomp the station's tuned sound. Their FX take over only once their
    // set is actually underway (a deck loaded or playing).
    const guestActive = ["A", "B", "C", "D"].some((k) => b[k] && (b[k].playing || b[k].src || b[k].yt));
    if (guestActive) S.fx = Object.assign({}, S.fx, { mf: num(fxIn.mf, 0, 100, 100), echo: num(fxIn.echo, 0, 0.6, 0), fb: num(fxIn.fb, 0, 0.6, 0.3), verb: num(fxIn.verb, 0, 0.3, 0.1), fla: num(fxIn.fla, 0, 0.25, 0), pha: num(fxIn.pha, 0, 0.3, 0), noise: num(fxIn.noise, 0, 0.5, 0), gate: 0, crush: num(fxIn.crush, 0, 12, 0), sync: fxIn.sync !== false, boost: num(fxIn.boost, 1, 1.3, 1) });
    S.voice = (b.voice && typeof b.voice === "object" && /^https:\/\/|\/m\//.test(String(b.voice.url || ""))) ? { id: String(b.voice.id || "").slice(0, 80), url: String(b.voice.url).slice(0, 300), at: num(b.voice.at, 0, Date.now() + 60000, Date.now()) } : null;
    S.updatedAt = Date.now(); S.boothAt = Date.now(); S.by = "guest:" + user.id; g.lastWrite = Date.now(); S.djGuest = g;
    await writeDoc(env, "radio/dj", "radio", S);
    return json({ ok: true });
  }
  const ipRaw = request.headers.get("CF-Connecting-IP") || "";
  let h = 0; for (let i = 0; i < ipRaw.length; i++) h = ((h * 31) + ipRaw.charCodeAt(i)) >>> 0;
  const ip = "g" + h.toString(36);
  const recent = await env.DB.prepare("select count(*) as n from docs where coll = 'requests' and data like ? and created_at > ?").bind("%" + ip + "%", new Date(Date.now() - 60000).toISOString()).first();
  if (recent && recent.n >= 3) return json({ ok: false, error: "slow_down" }, 429);
  const now = Date.now();
  let data = null;
  if (b.kind === "pick") {
    const title = String(b.title || "").slice(0, 120).trim();
    const src = String(b.src || "");
    const yt = /^[A-Za-z0-9_-]{11}$/.test(String(b.yt || "")) ? String(b.yt) : "";
    const okSrc = src.startsWith("https://archive.org/download/") || src.startsWith(new URL(request.url).origin + "/m/assets/");
    if (!title || (!okSrc && !yt)) return json({ ok: false, error: "bad_pick" }, 422);
    // one active request per visitor (owner rule, 2026-10-30): a pick
    // from this same visitor already waiting in the DJ queue line
    // blocks a second. Picks are deleted as they play, so any stored
    // pick carrying this ip is still active.
    // (2026-11-01) only picks from the last 2 hours count: an unknown-length
    // video pick waits for the live booth and would otherwise lock this
    // visitor out of requesting for as long as the owner is away.
    const mine = await env.DB.prepare("select count(*) as n from docs where coll = 'requests' and data like ? and data like ? and coalesce(json_extract(data, '$.at'), 0) > ?").bind('%"ip":"' + ip + '"%', '%"kind":"pick"%', now - 2 * 3600e3).first();
    if (mine && mine.n >= 1) return json({ ok: false, error: "one_at_a_time" }, 409);
    const extra = { shoutout: String(b.shoutout || "").slice(0, 140), by: String(b.by || "").slice(0, 40), rqid: /^[A-Za-z0-9-]{1,40}$/.test(String(b.rqid || "")) ? String(b.rqid) : "" };
    if (yt) data = { kind: "pick", yt, title, cover: String(b.cover || "").slice(0, 300), dur: Math.max(0, Math.min(3600, +b.dur || 0)), at: now, guest: true, ip, ...extra };
    else data = { kind: "pick", title, src, cover: String(b.cover || "").slice(0, 300), dur: Math.max(0, Math.min(3600, +b.dur || 0)), at: now, guest: true, ip, ...extra };
  } else if (b.kind === "text") {
    const text = String(b.text || "").slice(0, 120).trim();
    if (!text) return json({ ok: false, error: "bad_text" }, 422);
    data = { kind: "text", text, at: now, guest: true, ip };
  } else return json({ ok: false, error: "bad_kind" }, 422);
  const path = "requests/g" + now.toString(36) + Math.random().toString(36).slice(2, 8);
  await writeDoc(env, path, "requests", data);
  if (data && data.kind === "pick") { try { await rqPlaylistAdd(env, [{ d: data, path }]); } catch (_) {} }
  return json({ ok: true });
}
