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
import { userFrom } from "../../lib/cf.js";
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
 * the fallback below is the owner spec of 2026-10-29 transcribed as-is
 * (his hours, his lanes), nothing invented. */
function aiDjDefaultDayparts() {
  return [
    { start: "18:00", end: "03:00", name: "night", seeds: ["trap music mix", "female rappers mix", "sexy r&b slow jams", "hip hop mix"] },
    { start: "03:00", end: "05:30", name: "rnb", seeds: ["r&b slow jams", "90s r&b mix", "r&b love songs mix"] },
    { start: "05:30", end: "06:30", name: "morning", seeds: ["good morning mix", "feel good music mix", "upbeat pop mix"] },
    { start: "06:30", end: "09:00", name: "weed", seeds: ["weed smoking music mix", "chill hip hop mix", "stoner music mix"] },
    { start: "09:00", end: "17:00", name: "mixed", seeds: ["hip hop mix", "r&b mix", "country hits mix", "pop hits mix", "edm mix", "metal mix"] },
    { start: "17:00", end: "18:00", name: "bridge", seeds: ["trap mix", "r&b mix", "trap r&b mix"] },
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
  const gate = aiDjGateCore(S, now);
  if (gate) return { changed: false, events: [], note: gate };
  const prevAt = +S.aiDjAt || 0;
  S.aiDjAt = now; // stamped on every attempt, so a dead relay is not retried on the next 12s ping
  let changed = true;
  if (Array.isArray(S.aiQ)) { // expire stale stock before topping up: current taste, not last month leftovers
    const keep = S.aiQ.filter((it) => it && now - (+it.at || 0) < AIDJ_DAY);
    if (keep.length !== S.aiQ.length) S.aiQ = keep;
  }
  const sg = aiDjGateStock(S);
  if (sg) return { changed, events: [], note: sg };
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
  const events = [];
  for (const sv of survivors) {
    S.aiQ.push({ yt: sv.id, title: String(sv.title || "").slice(0, 120), cover: "", dur: sv.dur, ai: 1, q: sv.q, at: now });
    const ev = deps.cleanBrainEvent ? deps.cleanBrainEvent({ type: "draw", yt: sv.id, title: sv.title || "", artist: sv.anchor || "", at: now, live: !!S.live }, "aidj") : null;
    if (ev) events.push(ev);
  }
  return { changed: true, events, note: "stocked " + survivors.length };
}
/* AIDJ-END */

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
 * The RADIO interrupt is decided by tvRadioDecision: at the top of the
 * hour, a fresh edition (<= 2h old, produced for this hour, with a
 * radio cut) fires; anything missing or stale skips silently and the
 * music never breaks. While the booth is fresh this keeper stands
 * down before the rotation, so the decision names that case
 * ("booth-fresh") for the booth-side consumer that ships with edition
 * production — the unattended lane below is what fires today. */
const TV_CHAIN_SEC = 720;          // short programs chain until a run reaches 12 min, then a break (SPEC §2.1)
const TV_NEWS_STALE = 2 * 3600e3;  // an edition older than 2 hours may not air as news (NEWS-BLOCK)
const TV_NEWS_LEN = 600;           // the TV news window: :50-:00, ten minutes
const TV_HORIZON = 2 * 3600e3;     // segments are generated this far ahead of now
const TV_KEEP = 3600e3;            // aired segments are kept this long behind now
const TV_BASES = ["own", "embed", "pd", "cc", "grant", "submission"];

function tvEtParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
  const gp = (t) => +(parts.find((x) => x.type === t) || {}).value || 0;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  return { hour: gp("hour") % 24, minute: gp("minute"), dayKey: day };
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
function tvProgSeg(it, start, dur, off) {
  return { k: it.kind === "house" ? "house" : "prog", id: it.id, src: it.src, yt: it.yt || "", url: it.url || "", iaId: it.iaId || "", title: it.title || "", show: it.show || "", start, dur, off };
}
function tvDrawBreak(pool) {
  const cleared = (pool.items || []).filter(tvCleared);
  if (!cleared.length) return null;
  if (!Array.isArray(pool.bag) || !(pool.bagIx >= 0) || pool.bagIx >= pool.bag.length) {
    pool.bag = cleared.map((x) => x.id);
    for (let i = pool.bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool.bag[i]; pool.bag[i] = pool.bag[j]; pool.bag[j] = t; }
    pool.bagIx = 0; pool._dirty = true;
  }
  const id = pool.bag[pool.bagIx++]; pool._dirty = true;
  return cleared.find((x) => x.id === id) || null;
}
/* Lay segments from the cursor (at = next segment start ms, ix/off =
 * where the cycle's current program resumes, run = seconds of
 * programming since the last break) out to horizonMs. News windows
 * cut programs mid-item; the item resumes after the window from the
 * offset it reached — a split program is two segments sharing an id. */
function tvGen(chan, pool, cursor, horizonMs) {
  const items = Array.isArray(chan.items) ? chan.items : [];
  const segs = [];
  let t = cursor.at, ix = cursor.ix || 0, off = +cursor.off || 0, run = +cursor.run || 0;
  let guard = 0, skips = 0;
  while (t < horizonMs && guard++ < 600) {
    const win = tvNewsWin(t);
    if (win.inside) { const dur = Math.max(1, Math.round((win.end - t) / 1000)); segs.push({ k: "news", start: t, dur, edWin: win.start }); t = win.end; skips = 0; continue; }
    const it = items[ix];
    if (!it) break;
    if (!tvCleared(it)) { ix = (ix + 1) % items.length; off = 0; if (++skips > items.length) break; continue; }
    skips = 0;
    const remain = Math.round((+it.dur - off) * 10) / 10;
    if (!(remain > 0)) { ix = (ix + 1) % items.length; off = 0; continue; }
    const progEnd = t + remain * 1000;
    if (win.start < progEnd) {
      const cutSec = Math.round((win.start - t) / 100) / 10;
      if (cutSec > 0.05) { segs.push(tvProgSeg(it, t, cutSec, off)); run += cutSec; off += cutSec; }
      t = win.start;
      continue;
    }
    segs.push(tvProgSeg(it, t, remain, off)); run += remain; t = progEnd; ix = (ix + 1) % items.length; off = 0;
    if (run >= (chan.chainSec > 0 ? +chan.chainSec : TV_CHAIN_SEC)) {
      const b = tvDrawBreak(pool);
      if (b) { segs.push({ k: b.kind === "house" ? "house" : "break", id: b.id, src: b.src, yt: b.yt || "", url: b.url || "", iaId: b.iaId || "", title: b.title || "", show: "", start: t, dur: +b.dur, off: 0 }); t += +b.dur * 1000; }
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
/* The radio news gate (NEWS-BLOCK): fire only at the top of the hour
 * (:00-:04), only with an edition produced for this hour (within the
 * last hour) that is still fresh (<= 2h) and carries a radio cut,
 * only once per hour, only on a live Auto-DJ station. Every other
 * state is a named skip — no fresh edition, no break, ever. */
function tvRadioDecision(S, newsDoc, now) {
  const ed = newsDoc && newsDoc.current;
  if (!ed || !ed.radioUrl || !(+ed.radioDur > 0)) return { fire: false, why: "no-edition" };
  if (now - (+ed.at || 0) > TV_NEWS_STALE) return { fire: false, why: "stale-edition" };
  const et = tvEtParts(now), sec = Math.floor((now % 60000) / 1000);
  if (et.minute > 4) return { fire: false, why: "outside-window" };
  const hourKey = et.dayKey + "T" + et.hour;
  if (S.newsHour === hourKey) return { fire: false, why: "already-fired" };
  const hourStart = now - (et.minute * 60 + sec) * 1000;
  if ((+ed.at || 0) < hourStart - 3600e3 || (+ed.at || 0) > now) return { fire: false, why: "edition-not-for-this-hour" };
  if (S.boothAt && now - S.boothAt < 90000) return { fire: false, why: "booth-fresh" };
  if (!S.live || !S.autodj || S.pausedAt) return { fire: false, why: "station-not-live" };
  return { fire: true, hourKey, item: { src: String(ed.radioUrl), title: "📰 Meechie's World News", dur: Math.min(300, Math.max(60, Math.round(+ed.radioDur))) } };
}
function tvSeedChannel(now) {
  const R = (basis, evidence, simulcast) => ({ basis, evidence, clearedBy: basis === "own" ? "owner" : "keeper-check", at: now, simulcast: !!simulcast });
  return {
    on: true, epoch: now, breakEvery: 1, chainSec: TV_CHAIN_SEC,
    breakMix: { video: 3, house: 1, legal: 1 },
    items: [
      { id: "own-anthem", kind: "house", src: "file", url: "/media/the-world-gone-be.mp4", title: "The World Gone Be — Official Video", show: "Meechie's World", dur: 266, block: "anytime", rights: R("own", "Malik's own song and video, hosted on his own site media (/media/the-world-gone-be.mp4, HTTP 200 video/mp4 verified at seed time); he is the artist and rights holder", true) },
      { id: "ia-betty-snowwhite", kind: "show", src: "ia", iaId: "bb_snow_white", url: "https://archive.org/download/bb_snow_white/bb_snow_white_512kb.mp4", title: "Betty Boop — Snow White (1933)", show: "Classic Cartoons", dur: 424, block: "morning", rights: R("pd", "Internet Archive item bb_snow_white: metadata licenseurl http://creativecommons.org/licenses/publicdomain/ read at seed time; file playback verified (206 video/mp4)", true) },
      { id: "ia-superman-1941", kind: "show", src: "ia", iaId: "superman-1941_202406", url: "https://archive.org/download/superman-1941_202406/Superman%20(1941).mp4", title: "Superman (1941) — Fleischer Cartoon", show: "Classic Cartoons", dur: 628, block: "morning", rights: R("pd", "Internet Archive item superman-1941_202406: metadata licenseurl https://creativecommons.org/publicdomain/mark/1.0/ read at seed time; file playback verified (206 video/mp4)", true) },
      { id: "ia-dragnet-18", kind: "show", src: "ia", iaId: "DragnetEpisode18TheBigSeventeenwcommercials", url: "https://archive.org/download/DragnetEpisode18TheBigSeventeenwcommercials/dragnet_bigseventeen_512kb.mp4", title: "Dragnet — The Big Seventeen (Ep. 18)", show: "Dragnet", dur: 1837, block: "anytime", rights: R("pd", "Internet Archive item DragnetEpisode18TheBigSeventeenwcommercials: metadata licenseurl http://creativecommons.org/licenses/publicdomain/ read at seed time", true) },
      { id: "ia-hillbillies-02", kind: "show", src: "ia", iaId: "Beverly_Hillbillies_Ep02_Getting_Settled", url: "https://archive.org/download/Beverly_Hillbillies_Ep02_Getting_Settled/BH02_Getting_Settled_512kb.mp4", title: "The Beverly Hillbillies — Getting Settled (Ep. 2)", show: "The Beverly Hillbillies", dur: 1494, block: "anytime", rights: R("pd", "Internet Archive item Beverly_Hillbillies_Ep02_Getting_Settled: metadata licenseurl http://creativecommons.org/licenses/publicdomain/ read at seed time", true) },
      { id: "ia-little-shop", kind: "show", src: "ia", iaId: "The_Little_Shop_of_Horrors_60", url: "https://archive.org/download/The_Little_Shop_of_Horrors_60/The_Little_Shop_of_Horrors_60.mp4", title: "The Little Shop of Horrors (1960)", show: "MW Cinema", dur: 4386, block: "primetime", rights: R("cc", "Internet Archive item The_Little_Shop_of_Horrors_60: metadata licenseurl https://creativecommons.org/publicdomain/zero/1.0/ (CC0) read at seed time", true) },
      { id: "ia-charade", kind: "show", src: "ia", iaId: "charade-1963-cary-grant-audrey-hepburn-comedy-mystery-romance-thriller-full-movie", url: "https://archive.org/download/charade-1963-cary-grant-audrey-hepburn-comedy-mystery-romance-thriller-full-movie/Charade_READY.mp4", title: "Charade (1963)", show: "MW Cinema", dur: 6785, block: "primetime", rights: R("pd", "Internet Archive item charade-1963-cary-grant-audrey-hepburn-comedy-mystery-romance-thriller-full-movie: metadata licenseurl https://creativecommons.org/publicdomain/mark/1.0/ read at seed time", true) }
    ],
    updatedAt: now, by: "keeper-seed"
  };
}
function tvSeedPool(now) {
  const R = (evidence) => ({ basis: "embed", evidence, clearedBy: "keeper-check", at: now, simulcast: false });
  const Y = (id, yt, title, dur, lane, evidence) => ({ id, kind: "break", src: "yt", yt, title, dur, lane, rights: R(evidence) });
  const items = [
    Y("brk-usher-yeah", "GxBSyx85Kp8", "Usher — Yeah! (Official Video) ft. Lil Jon, Ludacris", 253, "rb", "Passed the site embed gate (/api/ytsearch) at seed time; uploader UsherVEVO (artist's official VEVO channel) per YouTube oEmbed"),
    Y("brk-nelly-herre", "GeZZr_p6vB8", "Nelly — Hot In Herre (Official Music Video)", 245, "hiphop", "Passed the site embed gate (/api/ytsearch) at seed time; uploader NellyVEVO (artist's official VEVO channel) per YouTube oEmbed"),
    Y("brk-outkast-heyya", "PWgvGjAhvIw", "Outkast — Hey Ya! (Official HD Video)", 304, "hiphop", "Passed the site embed gate (/api/ytsearch) at seed time; uploader OutkastVEVO (artist's official VEVO channel) per YouTube oEmbed"),
    Y("brk-cash-hurt", "8AHCfZTRGiI", "Johnny Cash — Hurt", 229, "country", "Passed the site embed gate (/api/ytsearch) at seed time; uploader JohnnyCashVEVO (artist's official VEVO channel) per YouTube oEmbed"),
    Y("brk-nirvana-teen", "hTWKbfoikeg", "Nirvana — Smells Like Teen Spirit (Official Music Video)", 279, "rock", "Passed the site embed gate (/api/ytsearch) at seed time; uploader NirvanaVEVO (artist's official VEVO channel) per YouTube oEmbed"),
    Y("brk-maryj-family", "znlFu_lemsU", "Mary J. Blige — Family Affair (Official Music Video)", 225, "rb", "Passed the site embed gate (/api/ytsearch) at seed time; uploader MaryJBligeVEVO (artist's official VEVO channel) per YouTube oEmbed"),
    Y("brk-ti-whatever", "Kgdr2uytpDI", "T.I. — Whatever You Like (Official Video)", 253, "trap", "Passed the site embed gate (/api/ytsearch) at seed time; uploader Atlantic Records (the releasing label) per YouTube oEmbed"),
    Y("brk-liljon-getlow", "IYH7_GzP4Tg", "Lil Jon & The East Side Boyz — Get Low (Official Music Video)", 271, "trap", "Passed the site embed gate (/api/ytsearch) at seed time; uploader Radial by The Orchard (the distributor) per YouTube oEmbed"),
    { id: "brk-house-anthem", kind: "house", src: "file", url: "/media/the-world-gone-be.mp4", title: "Meechie's World — The World Gone Be", dur: 266, lane: "house", rights: { basis: "own", evidence: "Malik's own song and video on his own site media; he is the artist and rights holder", clearedBy: "owner", at: now, simulcast: true } }
  ];
  const bag = items.map((x) => x.id);
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
  return { items, bag, bagIx: 0, updatedAt: now, by: "keeper-seed" };
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
    await writeDoc(env, "tv/channel", "tv", chan);
    return it.id;
  }
  return "";
}
async function tvTick(env, S, now, origin) {
  let chan = await readDoc(env, "tv/channel");
  if (!chan || !Array.isArray(chan.items) || !chan.items.length) { chan = tvSeedChannel(now); await writeDoc(env, "tv/channel", "tv", chan); }
  let pool = await readDoc(env, "tv/breakpool");
  if (!pool || !Array.isArray(pool.items) || !pool.items.length) { pool = tvSeedPool(now); await writeDoc(env, "tv/breakpool", "tv", pool); }
  const newsDoc = await readDoc(env, "tv/news");
  const decision = tvRadioDecision(S, newsDoc, now);
  if (chan.on === false) {
    const nw0 = await readDoc(env, "tv/now");
    if (!nw0 || !nw0.off) await writeDoc(env, "tv/now", "tv", { off: true, segs: [], updatedAt: now });
    return decision;
  }
  if (!(chan.items || []).some(tvCleared)) {
    const nw0 = await readDoc(env, "tv/now");
    if (!nw0 || !nw0.down) await writeDoc(env, "tv/now", "tv", { down: true, segs: [], updatedAt: now });
    return decision;
  }
  let nw = await readDoc(env, "tv/now");
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
  if (dirty) {
    await writeDoc(env, "tv/now", "tv", { segs, cursor, chanAt: chan.updatedAt || 0, curStart: curSeg ? curSeg.start : 0, checked: (nw && nw.checked) || {}, skipNote, genAt: now, updatedAt: now });
  }
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

  // MW TV (Stage 1): the channel tick rides the same ping — it keeps
  // tv/now's segment window ahead of the clock and decides the hourly
  // radio news break. It runs BEFORE the booth stand-down on purpose:
  // the channel is programming, not decks, so it advances while Malik
  // is at the tables too (his share/live still outranks it on every
  // screen — precedence lives in the renderer, not here). Wrapped like
  // the doorbell: a channel failure may never break the station ping.
  let tvNewsFire = null;
  try { const tvd = await tvTick(env, S, now, origin); if (tvd && tvd.fire) tvNewsFire = tvd; } catch (_) {}

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
  if (S.boothAt && now - S.boothAt < BOOTH_FRESH && !deadDeck && !silentBreak && !handBreak) return json({ ok: true, mode: "booth", now, online: counts.online, listening: counts.listening, users: counts.users, guestSince: counts.guestSince || 0 });
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
  // not yet drawn this cycle and refills shuffled when it empties, the
  // same bag discipline as the library rotation. Unattended rules
  // match the rest of the tail: a video needs a known length, dead
  // file hosts never play.
  const rqLaneItem = async () => {
    const doc = await readDoc(env, RQPL_PATH);
    const items = doc && Array.isArray(doc.items) ? doc.items : [];
    if (!items.length) return null;
    const playable = (r) => !!r && ((r.yt && +r.dur > 0) || (r.src && !/supabase/i.test(r.src)) || !!r.iaId);
    let bag = Array.isArray(S.rqBag) ? S.rqBag.filter((k) => items.some((r) => r.k === k)) : [];
    if (!bag.length) { bag = items.filter(playable).map((r) => r.k); for (let i = bag.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = bag[i]; bag[i] = bag[j]; bag[j] = t; } }
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
        if (it.yt && +it.dur > 0) return { src: "", yt: String(it.yt), title: String(it.title || "").slice(0, 120), cover: String(it.cover || "").slice(0, 300), dur: +it.dur };
      }
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
    const aidj = await aiDjPass({ env, origin, lib, readDoc, readTaste, tasteScore, cleanBrainEvent, fetchFn: fetch }, S, now);
    if (aidj && aidj.changed) changed = true;
    if (aidj && aidj.events && aidj.events.length) brainEvts.push(...aidj.events);
  } catch (_) {}
  const xfToward = (x, amt) => { const v = (x ?? 0.5) + Math.max(-amt, Math.min(amt, 0.5 - (x ?? 0.5))); return Math.round(v * 1000) / 1000; };
  let cur = S.A.playing ? "A" : S.B.playing ? "B" : null;
  if (!cur) { // dead air — start the rotation on deck A right now (fader home is CENTER, owner 2026-10-29)
    startDeckItem("A", await nextItem(""), now); S.xf = 0.5; changed = true; cur = "A";
  }
  /* MW TV NEWS INTERRUPT (NEWS-BLOCK.md, Malik 2026-11-01 ~21:16):
   * the hourly Meechie's World News radio cut, decided by tvTick at
   * the top of the hour. A fresh edition takes the incoming deck now —
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
