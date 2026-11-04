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

const XF = 5; // crossfade lead in seconds: the next song starts this long before the current one ends, so the two are audibly playing together with no pause (Malik, 2026-10-28: widened from 3.5; the booth lead in dj.js matches)
const BOOTH_FRESH = 90000; // booth heartbeat window — while it's fresh the TABLES own the radio, the keeper never touches a deck
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readDoc(env, path) {
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
    const fresh = cands.find((c) => !recent(c.id));
    if (fresh) { props.items.push({ at: now, id: fresh.id, title: fresh.title, why: fresh.why, status: "open" }); props.items = props.items.slice(-20); await selfWrite(deps, "brain/proposals", props); changes.push("proposal filed: \"" + fresh.title + "\" (brain/proposals — for Amani's review; Meechie does not edit his own code)"); }
  } catch (_) {}
  const summary = "Daily self-review: last 24h " + metrics.plays24 + " plays, " + metrics.ends24 + " completions, " + metrics.skips24 + " skips, " + metrics.requests24 + " requests; Auto-DJ stocked picks that went on to play: " + metrics.drawnPlayed7 + " of the distinct videos drawn in 7d. " + changes.length + " change(s) made, all logged below.";
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

/* K = { S, now, tvOnly, deps, startDeckItem, cur, brainEvts }.
 * Returns { changed, cur } for the tick to fold in. */
async function handsDrain(env, K) {
  const S = K.S, now = K.now;
  let changed = false, cur = K.cur || null;
  try {
    let ctl = await HANDS.handsControl(env);
    if (!ctl.exists) { await handsActivate(env); ctl = await HANDS.handsControl(env); }
    const doc = await HANDS.handsCommandsRead(env);
    const items = Array.isArray(doc.items) ? doc.items : [];
    if (!items.some((c) => c && c.status === "queued")) return { changed, cur };
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
    if (dirty) { try { await HANDS.handsCommandsWrite(env, doc); } catch (_) {} }
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
 * The RADIO interrupt is decided by tvRadioDecision: every quarter
 * hour (Malik, 2026-11-03: news+traffic on the radio every 15
 * minutes), a fresh edition (<= 2h old — the NEWS-BLOCK freshness
 * law — with a radio cut) fires; anything missing or stale skips
 * silently and the music never breaks. A due fire falls through the
 * booth stand-down like the breakers do — Malik's standing rule is
 * that the break cuts in even during his own live booth sets, so
 * there is no booth exception. */
const TV_CHAIN_SEC = 720;          // short programs chain until a run reaches 12 min, then a break (SPEC §2.1)
const TV_PROGRAM_V = 10;              // lineup generation: tvSeedChannel/tvSeedPool carry progV; tvTick reseeds any stored lineup older than this (v2 = the 2026-11-02 music-video network — PD classics retired; v3 = the MY EMPIRE premiere commercial joins the break pool; v4 = the Uniontown Local Update break spot joins the pool, held by age from tv/localupdate; v5 = the MY EMPIRE done-by-10 commercial joins the break pool; v6 = the MY EMPIRE every-day-at-8 commercial joins the break pool; v7 = the MY EMPIRE show-spot pool grows (v2 + the three 2026-11-03 spots join the break pool) and the 15-minute rail draws the whole show-spot pool in seeded random rotation, radio spots join the Auto-DJ rotation — Malik, 2026-11-03: play the show commercials randomly, on MW TV and on the radio; v8 = the 2026-11-03 schedule build: stand-up comedy features, TV One Unsung full episodes, Opry Live and WildBrain family clusters join the cycle; v9 = the 5-minute news+traffic update rail (tvUpdSpans) retired (Malik, 2026-11-03 ~14:57: 'no more interruptions every 5 minutes') — the quarter-hour cadence (commercial + chained fresh update) is the only news interruption on the channel; the bump forces the one-time re-lay that clears rail hits already laid in tv/now; v10 = the quarter-freshness build (Malik, 2026-11-03 ~14:54: 'new news every time — 60 seconds of it every 15 minutes with my commercials'): the cadence chains only THIS quarter's fresh update — the character-hosted clip when produced inside the freshness window (TV_QUARTER_FRESH_MS), else the produced quarter piece from tv/quarternews, else nothing; the hourly edition's local update no longer chains at quarters and its radio cut no longer feeds the radio hit — the radio hit plays the quarter piece's own radio cut; the bump forces the re-lay that clears chains laid under the old rules)
const TV_PREM_V = 1;                 // MY EMPIRE premiere slot doc generation (tv/premiere)
const TV_RERUN_V = 1;                // MY EMPIRE 10 PM rerun slot doc generation (tv/rerun)
const TV_MOVIE_V = 2;                // post-premiere movie block doc generation (tv/movieblock)
const TV_INSERT_V = 3;               // one-shot owner-ordered insert doc generation (tv/insert) (v2 = short playlist with an ordered startAt and a hard endBy; v3 = tonight's Comedy Hour Thanksgiving movie, 2026-11-03)
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
const TV_SHOW_SPOT_IDS = ["brk-my-empire-ad", "brk-my-empire-v2", "brk-my-empire-by10", "brk-my-empire-8oclock", "brk-my-empire-shop", "brk-my-empire-family", "brk-my-empire-12"];
const TV_SPOT_GATE_IDS = ["brk-my-empire-v2", "brk-my-empire-shop", "brk-my-empire-family", "brk-my-empire-12"]; // pooled spots whose files were not on the site when this landed (v1 / done-by-10 / 8-o-clock files were verified live at their seed times and are not gated)
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
    day: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }),
    memo: new Map(),
  });
  const bucket = Math.floor(ms / 60000);
  let v = F.memo.get(bucket);
  if (!v) {
    const parts = F.hm.formatToParts(new Date(ms));
    const gp = (t) => +(parts.find((x) => x.type === t) || {}).value || 0;
    v = { hour: gp("hour") % 24, minute: gp("minute"), dayKey: F.day.format(new Date(ms)) };
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
function tvDrawBreak(pool) {
  const cleared = (pool.items || []).filter(tvCleared);
  if (!cleared.length) return null;
  if (!Array.isArray(pool.bag) || !(pool.bagIx >= 0) || pool.bagIx >= pool.bag.length) {
    // Paid sponsors ride the same bag; a Featured sponsor's spot sits
    // in the bag twice (its ~2x rotation weight — the cadence rail
    // weights it the same way, tvAdCadItems).
    pool.bag = [];
    for (const x of cleared) { pool.bag.push(x.id); if (x.kind === "sponsor" && x.sponsor && x.sponsor.tier === "featured") pool.bag.push(x.id); }
    for (let i = pool.bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool.bag[i]; pool.bag[i] = pool.bag[j]; pool.bag[j] = t; }
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
  pool.bagIx++; pool._dirty = true;
  pool.recentBreaks = [...recent.slice(-1), !!(item && item.kind === "sponsor")];
  return item;
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
  if (chan._queue) chan._queue._st = { cad, prem: chan._prem, anch: chan._anchor, ins: chan._insert, char: chan._char, lu: chan._lu, rerun: chan._rerun, qtr: chan._qtr };
  const segs = [];
  let t = cursor.at, ix = cursor.ix || 0, off = +cursor.off || 0, run = +cursor.run || 0;
  let guard = 0, skips = 0;
  while (t < horizonMs && guard++ < 600) {
    const win = tvNewsWin(t);
    const pwin = tvPremWin(t, chan._prem);
    const rwin = tvPremWin(t, chan._rerun);
    const awin = tvAnchorWin(t, chan._anchor);
    const mwin = tvMovieWin(t, chan._movies);
    const iwin = tvInsertWin(t, chan._insert);
    const cadwin = tvAdWin(t, cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr);
    const qwin = tvQueueWin(t, chan._queue);
    if (win.inside && !(chan._qCut && chan._qCut.news === win.start)) { const dur = Math.max(1, Math.round((win.end - t) / 1000)); segs.push({ k: "news", start: t, dur, edWin: win.start }); t = win.end; skips = 0; continue; }
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
      let slotOff = (t - mwin.start) / 1000, segIt = null, segOff = 0;
      // An insert that cut into this block froze it: once the
      // insert window has run, positions sit behind the wall clock
      // by the frozen span (tvInsertFrozen, stamped in tvTick).
      if (chan._movies.insShift > 0 && isFinite(chan._movies.insEnd) && t >= chan._movies.insEnd) slotOff -= chan._movies.insShift;
      if (chan._movies.qShift > 0 && isFinite(chan._movies.qEnd) && t >= chan._movies.qEnd) slotOff -= chan._movies.qShift;
      // The ad cadence froze the block at every spot inside it:
      // positions likewise sit behind the wall clock by the spot
      // time laid between the window start and here.
      if (cad) slotOff -= tvAdTimeIn(cad, chan._prem, chan._anchor, chan._insert, mwin.start, t, chan._char, chan._lu, chan._rerun, chan._qtr);
      if (chan._movies.skipShift > 0 && t >= chan._movies.skipAt) slotOff += chan._movies.skipShift;
      for (const sit of chan._movies.items) { if (slotOff < +sit.dur) { segIt = sit; segOff = slotOff; break; } slotOff -= +sit.dur; }
      if (segIt) { const d = Math.min(Math.round((+segIt.dur - segOff) * 10) / 10, Math.round((cap - t) / 100) / 10); if (d > 0.05) { segs.push(tvProgSeg(segIt, t, d, segOff)); t += Math.round(d * 1000); skips = 0; continue; } }
      t = cap; continue;
    }
    const it = items[ix];
    if (!it) break;
    if (!tvCleared(it)) { ix = (ix + 1) % items.length; off = 0; if (++skips > items.length) break; continue; }
    skips = 0;
    const remain = Math.round((+it.dur - off) * 10) / 10;
    if (!(remain > 0)) { ix = (ix + 1) % items.length; off = 0; continue; }
    const progEnd = t + remain * 1000;
    let boundary = win.start;
    if (pwin && !pwin.inside && pwin.start > t && pwin.start < boundary) boundary = pwin.start;
    if (rwin && !rwin.inside && rwin.start > t && rwin.start < boundary) boundary = rwin.start;
    if (awin && !awin.inside && awin.start > t && awin.start < boundary) boundary = awin.start;
    if (mwin && !mwin.inside && mwin.start > t && mwin.start < boundary) boundary = mwin.start;
    if (iwin && !iwin.inside && iwin.start > t && iwin.start < boundary) boundary = iwin.start;
    if (cadwin && !cadwin.inside && cadwin.start > t && cadwin.start < boundary) boundary = cadwin.start;
    if (qwin && !qwin.inside && qwin.start > t && qwin.start < boundary) boundary = qwin.start;
    if (boundary < progEnd) {
      const cutSec = Math.round((boundary - t) / 100) / 10;
      if (cutSec > 0.05) { segs.push(tvProgSeg(it, t, cutSec, off)); run += cutSec; off += cutSec; }
      t = boundary;
      continue;
    }
    segs.push(tvProgSeg(it, t, remain, off)); run += remain; t = progEnd; ix = (ix + 1) % items.length; off = 0;
    if (run >= (chan.chainSec > 0 ? +chan.chainSec : TV_CHAIN_SEC)) {
      const b = tvDrawBreak(pool);
      if (b) {
        // A break never overruns a slot start: premiere, anchor and
        // movie-block windows begin on time, so a break that would
        // cross one is cut at its edge (and skipped if only a sliver
        // would remain). News windows keep their long-standing
        // behaviour — the window simply starts when the break ends.
        let bd = +b.dur, capS = Infinity;
        for (const w of [tvPremWin(t, chan._prem), tvPremWin(t, chan._rerun), tvAnchorWin(t, chan._anchor), tvMovieWin(t, chan._movies), tvInsertWin(t, chan._insert), tvAdWin(t, cad, chan._prem, chan._anchor, chan._insert, chan._char, chan._lu, chan._rerun, chan._qtr), tvQueueWin(t, chan._queue)]) { if (w && !w.inside && w.start > t && w.start < capS) capS = w.start; }        if (capS < t + bd * 1000) bd = Math.round((capS - t) / 100) / 10;
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
 * by epoch math over the CLEARED items only (held items never air). */
function tvCyclePos(chan, now) {
  const items = (chan.items || []).map((it, i) => ({ it, i })).filter((x) => tvCleared(x.it));
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
  return {
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
      { id: "show-johnny-test", kind: "show", src: "yt", yt: "EqEyFCgQXtA", title: "1 Hour of Johnny Test: The Lost Web Series | Full Episodes | Cartoons For Kids", show: "MW Family", dur: 3603, block: "family", rights: RE("Passed the site embed gate (/api/ytsearch) and YouTube oEmbed verification at schedule build time (2026-11-03): embeddable, uploader Johnny Test - WildBrain (the distributor's official channel); keeper-recheck simulation (gate search by exact title returns this id) passed") }
    ],
    updatedAt: now, by: "keeper-seed"
  };
}
function tvSeedPool(now) {
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  const Y = (id, yt, title, dur, lane, evidence) => ({ id, kind: "break", src: "yt", yt, title, dur, lane, rights: R(evidence) });
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
    { id: "brk-house-anthem", kind: "house", src: "file", url: "/media/the-world-gone-be.mp4", title: "Meechie's World — The World Gone Be", dur: 266, lane: "house", rights: { basis: "own", evidence: "Malik's own song and video, hosted on his own site media (/media/the-world-gone-be.mp4, HTTP 200 video/mp4 verified at seed time); he is the artist and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-ad", kind: "house", src: "file", url: "/media/my-empire-commercial.mp4", title: "MY EMPIRE — Premiere Commercial", dur: 42, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE, his business and himself, hosted on his own site media (/media/my-empire-commercial.mp4, HTTP 200 video/mp4 verified at seed time); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-by10", kind: "house", src: "file", url: "/media/my-empire-by10.mp4", title: "MY EMPIRE — Done by 10 Tonight", dur: 15, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE, hosted on his own site media (/media/my-empire-by10.mp4, HTTP 200 video/mp4 verified at seed time); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-8oclock", kind: "house", src: "file", url: "/media/my-empire-8oclock.mp4", title: "MY EMPIRE — Every Day at 8, Rerun at 10", dur: 15, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE, hosted on his own site media (/media/my-empire-8oclock.mp4, HTTP 200 video/mp4 verified at seed time); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-v2", kind: "house", src: "file", url: "/media/my-empire-commercial-v2.mp4", title: "MY EMPIRE — The Don (Show Commercial)", dur: 42, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (v2 — his character on camera, the premieres-at-8 announcement), hosted on his own site media (/media/my-empire-commercial-v2.mp4); he is the creator and rights holder. Joins the pool under his 2026-11-03 order to play the show commercials in random rotation on MW TV and radio", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-shop", kind: "house", src: "file", url: "/media/my-empire-shop-station-family.mp4", title: "MY EMPIRE — The Shop, The Station, The Family", dur: 10, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (the shop-opened, station-signed-on, family line), supplied by Malik on 2026-11-03 for the random show-spot rotation and hosted on his own site media (/media/my-empire-shop-station-family.mp4); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-family", kind: "house", src: "file", url: "/media/my-empire-family-foundation.mp4", title: "MY EMPIRE — Family Is the Foundation", dur: 10, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (the family-is-the-foundation line), supplied by Malik on 2026-11-03 for the random show-spot rotation and hosted on his own site media (/media/my-empire-family-foundation.mp4); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-my-empire-12", kind: "house", src: "file", url: "/media/my-empire-12-shirts.mp4", title: "MY EMPIRE — 12 Shirts, Zero Excuses", dur: 10, lane: "house", rights: { basis: "own", evidence: "Malik's own commercial for his show MY EMPIRE (the 12-shirts, zero-excuses line), supplied by Malik on 2026-11-03 for the random show-spot rotation and hosted on his own site media (/media/my-empire-12-shirts.mp4); he is the creator and rights holder", clearedBy: "owner", at: now, simulcast: true } },
    { id: "brk-local-update", kind: "house", src: "file", url: "/m/media/local-update.mp4", title: "Uniontown Local Update — News & Traffic", dur: 51, lane: "house", rights: { basis: "own", evidence: "Produced in-house by the site news producer from attributed public sources (Herald-Standard headlines, PennDOT 511PA traffic, NWS alerts); Malik is the publisher and rights holder of the produced spot", clearedBy: "owner", at: now, simulcast: true } }
  ];
  const bag = items.map((x) => x.id);
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
  // MW Movie Night (schedule build v2, 2026-11-03; owner orders
  // 2026-11-02: hood movie after the show + NEWEST movies possible):
  // the chain runs newest-first — the 2025/2024 official uploads lead,
  // the Thanksgiving title rides mid-chain in season, The Harder They
  // Come stays (Malik's keeper), and the remaining marathon titles
  // close the chain. Every title is a full-length upload on the
  // distributor's own channel (Maverick Movies / Breaking Glass
  // Pictures / Shout! Studios), embedding verified per title (YouTube
  // oEmbed HTTP 200); durations pinned from the actual uploads through
  // the site embed-gate relay (/api/ytsearch, id-matched). Research
  // records: mwtv-reprogram-2026-11-02/HOOD-MOVIES.md and
  // NEWEST-MOVIES.md; schedule: mwtv-channel/SCHEDULE.md.
  const MV = (id, yt, title, dur, evidence) => ({ id, kind: "show", src: "yt", yt, title, show: "MW Movie Night", dur, rights: R(evidence) });
  return { on: true, progV: TV_MOVIE_V, items: [
    MV("mov-kitty-hallow-killer", "ttUoIcWUUUw", "The Kitty Hallow Killer", 5554, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 5554 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-nowhere-to-be-found", "pSaGCWffxy4", "Nowhere to Be Found", 6291, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6291 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-inthralled", "3oFzMFPV7Rk", "Inthralled", 6777, "Full-length upload on Breaking Glass Pictures (official free-movie channel), the distributor Breaking Glass Pictures' official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6777 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-bad-visitor-2", "FPnOXPSqJ4c", "The Bad Visitor 2", 5420, "Full-length upload on Breaking Glass Pictures (official free-movie channel), the distributor Breaking Glass Pictures' official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 5420 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-curfew", "HziWdpePIhw", "Curfew: Sins of the Father", 4829, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 4829 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-ebony-hustle-2", "4IuRIKoWwPY", "Ebony Hustle 2: Ballistic Protection", 5729, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 5729 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-nothing-even-matters", "eRrvpe0S_I0", "Nothing Even Matters", 6781, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6781 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-grit", "fdb6ofP2ViM", "GRIT", 6636, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6636 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-lady-thug", "bIfQnBzEggk", "Lady Thug", 6333, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6333 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-fist-of-vengence", "yIK9eyZUqcI", "Fist of Vengence", 4986, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 4986 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-american-girl", "FqKqowcTESY", "American Girl", 6003, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6003 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-judge-knott", "3tqGJ67GzwY", "Judge Knott", 4527, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 4527 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-giving-thanks", "8-ngS-WjqJw", "Giving Thanks", 4233, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 4233 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-night-in-compton", "uo6GRLmhgms", "A Night in Compton", 6780, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6780 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-harder-they-come", "TWe60ZC6icc", "The Harder They Come", 6168, "Full-length upload on Shout! Studios, the distributor Shout! Studios' official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6168 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-blood-4-blood", "rvph5KLOPBk", "Blood 4 Blood", 4701, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 4701 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-conflict-of-interest", "VAP2TpkjrF4", "Conflict of Interest", 6888, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 6888 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-the-hills", "zxE0GGl-tJA", "The Hills", 5041, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 5041 pinned from the actual upload via the site embed-gate relay (2026-11-03)"),
    MV("mov-the-next-day", "okLDf_ge2oQ", "The Next Day", 4522, "Full-length upload on Maverick Movies, the distributor Maverick Entertainment's official channel; embedding verified via YouTube oEmbed (HTTP 200) at research time (2026-11-02, NEWEST-MOVIES.md / HOOD-MOVIES.md) and re-verified 2026-11-03; duration 4522 pinned from the actual upload via the site embed-gate relay (2026-11-03)")
  ], updatedAt: now, by: "keeper-seed" };
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
  if (st.insert && isFinite(st.insert.start) && (st.insert.dur || 0) > 0) sub(st.insert.start, st.insert.start + st.insert.dur * 1000);
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
  if ((sc = slotCut(tvAnchorWin(now, chan._anchor), chan._anchor ? [chan._anchor.item] : null, "anchor", "anchor edition"))) { out.qCut = sc.qCut; out.note = sc.note; return out; }
  if (cadNow && cadNow.inside && cur.start >= cadNow.start && cur.start < cadNow.end && ((cadNow.item && cur.id === cadNow.item.id) || (cadNow.upd && cur.id === cadNow.upd.id))) { out.qCut = { cad: cadNow.start }; out.note = "cut the break short — back to the program"; return out; }
  // The owner's queue: jump the anchor past the item on air, so
  // the next item in the list starts at the cut.
  if (cur.qid && chan._queue) {
    const el = tvQueueElapsed(chan._queue, now);
    const at = tvQueueAt(chan._queue, el);
    if (at && at.it.qid === cur.qid) {
      out.qJump = { anchor: Math.round(chan._queue.anchor + (at.before + (+at.it.dur || 0) - el) * 1000) };
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
function tvAdSpans(cad, prem, anch, ins, fromMs, toMs, char, lu, rer, qtr) {  if (!cad || !cad.length) return [];
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
      for (const w of [tvNewsWin(s), tvPremWin(s, prem), tvAnchorWin(s, anch), tvInsertWin(s, ins), tvPremWin(s, rer)]) {
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
function tvAdWin(ms, cad, prem, anch, ins, char, lu, rer, qtr) {  if (!cad || !cad.length) return null;
  for (const sp of tvAdSpans(cad, prem, anch, ins, ms, ms + TV_HORIZON, char, lu, rer, qtr)) {
    if (ms >= sp.start && ms < sp.end) return { start: sp.start, end: sp.end, inside: true, item: sp.item, upd: sp.upd || null };
    if (sp.start > ms) return { start: sp.start, end: sp.end, inside: false, item: sp.item, upd: sp.upd || null };  }
  return null;
}
/* How much cadence time falls inside [fromMs, toMs): the span the
 * movie block freezes for the spots laid inside it (the insert
 * freeze rule — the block resumes from the offset it reached and
 * its window runs long by this much). */
function tvAdTimeIn(cad, prem, anch, ins, fromMs, toMs, char, lu, rer, qtr) {  let sec = 0;
  for (const sp of tvAdSpans(cad, prem, anch, ins, fromMs, toMs, char, lu, rer, qtr)) sec += (Math.min(sp.end, toMs) - Math.max(sp.start, fromMs)) / 1000;  return Math.round(sec * 10) / 10;
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
 * four newest pool videos + all seven radio cuts) exactly like the
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
  const urls = ["/media/my-empire-commercial-v2.mp4", "/media/my-empire-shop-station-family.mp4", "/media/my-empire-family-foundation.mp4", "/media/my-empire-12-shirts.mp4"].concat(RADIO_SPOTS.map((sp) => sp.src));
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
  let movies = await readDoc(env, "tv/movieblock");
  if (!movies || !Array.isArray(movies.items) || !movies.items.length || (+movies.progV || 0) < TV_MOVIE_V) { movies = tvSeedMovieBlock(now); await writeDoc(env, "tv/movieblock", "tv", movies); }
  let insDoc = await readDoc(env, "tv/insert");
  if (!insDoc || (+insDoc.progV || 0) < TV_INSERT_V) { insDoc = tvSeedInsert(now); await writeDoc(env, "tv/insert", "tv", insDoc); }
  const newsDoc = await readDoc(env, "tv/news");
  const luDoc = await readDoc(env, "tv/localupdate");
  const anchorDoc = await readDoc(env, "tv/anchor");
  const charDoc = await readDoc(env, "tv/charnews");
  const qDoc = await readDoc(env, "tv/quarternews");
  const quDoc0 = await readDoc(env, "tv/queue");
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
  const qStampSeen = qtrState.qtr ? qtrState.qtr.forQuarter : 0;
  chan._movies = tvMovieState(movies, prem, premState);
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
  if ((+((nw || {}).charStamp) || 0) !== charStamp) {
    dirty = true; // persist the new stamp in this tick's tv/now write
    if (segs && cursor) {
      const cadCut = tvAdCadItems(pool);
      const spansCut = cadCut ? tvAdSpans(cadCut, chan._prem, chan._anchor, chan._insert, now, now + TV_HORIZON, charState.char, luState.lu, chan._rerun, qtrState.qtr) : [];
      const nextOcc = spansCut.find((sp) => sp.start > now);
      if (nextOcc) {
        const cut = tvCharCut(chan, segs, cursor, nextOcc.start);
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
      const mark = (Math.floor(now / TV_RELAY_GRID_MS) + 1) * TV_RELAY_GRID_MS;
      if (mark < cursor.at) {
        const cut = tvCharCut(chan, segs, cursor, mark);
        if (cut) { segs = cut.segs; cursor = cut.cursor; }
      }
    }
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
  let quDoc = quDoc0 && (+quDoc0.progV || 0) >= TV_QUEUE_V ? quDoc0 : null;
  let qState = tvQueueState(quDoc);
  const qSt = { cad: tvAdCadItems(pool), prem: chan._prem, anch: chan._anchor, ins: chan._insert, char: chan._char, lu: chan._lu, rerun: chan._rerun, qtr: chan._qtr };
  if (qState) qState._st = qSt;
  chan._queue = qState;
  let qCut = nw && nw.qCut && typeof nw.qCut === "object" ? { ...nw.qCut } : {};
  chan._qCut = qCut;
  let qSkipAtDone = (nw && +nw.qSkipAt) || 0;
  let qSkipNote = nw && nw.qSkipNote && now - nw.qSkipNote.at < 3600e3 ? nw.qSkipNote : null;
  let movSkipState = nw && nw.movSkip && (+nw.movSkip.shift || 0) > 0 ? nw.movSkip : null;
  if (chan._movies) {
    if (movSkipState) {
      const mwN = tvMovieWin(now, chan._movies);
      if (mwN && movSkipState.at >= mwN.start && movSkipState.at < mwN.end) { chan._movies.skipShift = movSkipState.shift; chan._movies.skipAt = movSkipState.at; chan._movies.skipStart = mwN.start; }
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
  // Consumption: retire the items whose content has fully aired
  // (position is content time — a preemption never consumes).
  if (qState && quDoc) {
    const el = tvQueueElapsed(qState, now);
    let cum = 0; const gone = new Set();
    for (const it of qState.items) { cum += +it.dur || 0; if (cum <= el + 0.05) gone.add(it.qid); }
    if (gone.size) {
      const keptItems = (quDoc.items || []).filter((r) => !(r && gone.has(String(r.qid))));
      quDoc = { ...quDoc, items: keptItems, updatedAt: now };
      if (!keptItems.length) quDoc = { ...quDoc, anchor: 0 };
      await writeDoc(env, "tv/queue", "tv", quDoc);
      qState = tvQueueState(quDoc); if (qState) qState._st = qSt; chan._queue = qState;
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
  if (premState.cacheChanged) dirty = true;
  if (rerunState.cacheChanged) dirty = true;
  if (luState.cacheChanged) dirty = true;
  if (spotState.cacheChanged) dirty = true;
  delete chan._prem;
  delete chan._rerun;
  delete chan._anchor;
  delete chan._char;
  delete chan._lu;
  delete chan._movies;
  delete chan._insert;
  delete chan._queue;
  delete chan._qCut;
  if (dirty) {
    await writeDoc(env, "tv/now", "tv", { segs, cursor, chanAt: chan.updatedAt || 0, curStart: curSeg ? curSeg.start : 0, checked: (nw && nw.checked) || {}, skipNote, premProbe: premState.cache, rerunProbe: rerunState.cache, anchorProbe: anchorState.cache, anchAt: anchStamp, charProbe: charState.cache, charStamp, luProbe: luState.cache, luStamp, qProbe: qtrState.cache, qStamp: qStampSeen, spotProbe: spotState.cache, insWin: insWin || null, qSkipAt: qSkipAtDone, qSkipNote, qCut, movSkip: movSkipState, qTouched: !!((nw && nw.qTouched) || (segs || []).some((s) => s && s.qid)), genAt: now, updatedAt: now });
  }
  // Play tally for sponsor spots (segments that aired this tick).
  try { await tvSponsorTally(env, pool, segs, now, online); } catch (_) {}
  return decision;
}
/* MWTV-END */

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
    await env.DB.prepare("delete from pings where at < ?").bind(now - 45000).run();
    const row = await env.DB.prepare("select count(*) as n, coalesce(sum(listening), 0) as l from pings where at > ?").bind(now - 35000).first();
    if (row) { counts.online = row.n || 0; counts.listening = row.l || 0; }
    // who's online: signed-in members identify themselves on the ping, so every
    // counter on the site (header chip, Book strip, booth) reads this ONE list
    counts.users = [];
    try { const ur = await env.DB.prepare("select uid, name, max(at) as at, min(first) as since from pings where at > ? and uid is not null and uid != '' group by uid order by at desc limit 60").bind(now - 35000).all(); counts.users = (ur.results || []).map((r) => ({ uid: r.uid, name: r.name || "", since: r.since || 0 })); } catch (_) {}
    try { const gr = await env.DB.prepare("select min(first) as f from pings where at > ? and (uid is null or uid = '')").bind(now - 35000).first(); counts.guestSince = (gr && gr.f) || 0; } catch (_) {}
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
      const rr = await env.DB.prepare("select path, data from docs where coll = 'requests'").all();
      const picks = [];
      for (const r of rr.results || []) { let d = null; try { d = JSON.parse(r.data || "null"); } catch (_) {} if (d && d.kind === "pick" && !d.played) picks.push({ d, path: r.path }); }
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
  try { const tvd = await tvTick(env, S, now, origin, counts && counts.online); if (tvd && tvd.fire) tvNewsFire = tvd; if (tvd && tvd.spot && tvd.spot.fire) tvSpotItem = tvd.spot; } catch (_) {}

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

  const { results } = await env.DB.prepare("select data from docs where coll = 'tracks'").all();
  const lib = (results || []).map((r) => { try { return JSON.parse(r.data); } catch (_) { return null; } })
    .filter((t) => t && t.assetId && +t.duration > 3 && !String(t.assetId).includes("supabase"));
  if (!lib.length) return json({ ok: true, mode: "empty-lib", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
  const byAsset = new Map(lib.map((t) => [t.assetId, t]));
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
    try { rows = (await env.DB.prepare("select path, data from docs where coll = 'requests'").all()).results || []; } catch (_) { return null; }
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
        // could stall the unattended station, so that pick is NOT
        // deleted here; it waits in the line for the live booth, whose
        // player learns the length as it loads.
        const yid = String(p.d.yt);
        if (/^[A-Za-z0-9_-]{11}$/.test(yid) && +p.d.dur > 0) ytItem = { src: "", yt: yid, title: p.d.title || "", cover: p.d.cover || ("https://i.ytimg.com/vi/" + yid + "/hqdefault.jpg"), dur: +p.d.dur };
        else continue;
      }
      if (!src && p.d.iaId) {
        try { const mj = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(p.d.iaId))).json(); const f = (mj.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (mj.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name)); if (f) { src = "https://archive.org/download/" + encodeURIComponent(p.d.iaId) + "/" + f.name.split("/").map(encodeURIComponent).join("/"); iaDur = +f.length || 0; } } catch (_) {}
      }
      try { await env.DB.prepare("delete from docs where path = ?").bind(p.path).run(); await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", p.path, "requests", null, null, Date.now()).run(); } catch (_) {}
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
    if (S.mixAlt) { const pi = await poolItem(); if (pi) return pi; }
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
