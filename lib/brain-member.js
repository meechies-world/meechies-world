/* The host brain's member memory (PR-B3, BLUEPRINT §3) — one small doc per
 * member at brain/member/<uid> (coll "brain"), holding ONLY keywords and
 * favorites: name, visit counters, favorite artists/tracks folded from that
 * member's own brain_events, the last song they heard here, and the topics
 * their own questions touched. NEVER chat transcripts, never anything from
 * another member.
 *
 * Privacy is structural, not promised: the doc is read only by code paths
 * that already hold that member's own session (GET /api/brain/me, and the
 * member block inside lib/brain.js answer() when the caller passes their
 * own uid), and written only through this module — the single writer path
 * shared by the visit fold (POST /api/brain/event, type "visit") and the
 * chat fold (the /api/ai handler after it answers that same member).
 * Guests have no uid, so guests get no memory and no doc. */

const DAY = 864e5;
const TOPIC_CAP = 20, FAV_CAP = 10;
const FOLD_GAP = 10 * 60e3; // chat folds at most once per 10 min per member

const clampStr = (v, n) => String(v == null ? "" : v).slice(0, n);
export const memberPath = (uid) => "brain/member/" + String(uid || "");

/* Service/topic words from the BRIEF, matched as plain substrings — the
 * fold is cheap string work by design (BLUEPRINT §3: no extra AI calls). */
const SERVICE_TOPICS = [
  "music production", "recording", "sound engineering", "music video",
  "commercial", "artist development", "promotion", "spotlight", "website",
  "web design", "coding", "legal", "court", "motion", "document",
  "clothing", "printing", "printify", "shopify", "remodeling", "cleaning",
  "landscaping", "security", "barber", "haircut", "radio", "dj booth",
  "jackpot", "games", "dating", "books", "paper trail",
];

export function memberName(user) {
  if (!user) return "";
  let meta = {};
  try { meta = JSON.parse(user.meta || "{}"); } catch (_) {}
  const um = (meta && typeof meta === "object" && (meta.user_metadata || meta)) || {};
  const n = clampStr(um.name || um.full_name || um.display_name || um.displayName || "", 60).trim();
  if (n) return n;
  const em = clampStr(user.email || "", 120);
  const local = em.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

export async function readMember(env, uid) {
  if (!env || !env.DB || !uid) return null;
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind(memberPath(uid)).first();
    if (!row || !row.data) return null;
    const m = JSON.parse(row.data);
    return (m && typeof m === "object" && Array.isArray(m.favArtists) && Array.isArray(m.topics)) ? m : null;
  } catch (_) { return null; }
}

/* Same write shape as lib/brain-taste.js writeTaste: update the row, insert
 * if missing, and ALWAYS land the changes row with the doc write. */
async function writeMember(env, mem) {
  const nowIso = new Date().toISOString();
  const data = JSON.stringify(mem);
  const path = memberPath(mem.uid);
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, "brain", mem.uid, data, nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, "brain", null, null, Date.now()).run();
}

function blankMember(user, now) {
  return {
    v: 1, uid: String(user.id), name: memberName(user), firstAt: now, lastAt: now,
    visits: 0, favArtists: [], favTracks: [], lastHeard: null, topics: [], foldAt: 0,
  };
}

/* Listening favorites from the member's OWN Phase 1 events (guest-DJ sets,
 * battle picks — rows whose actor is this uid; the keeper's rows belong to
 * "keeper", never to a member). One bounded read of a ≤5,000-row table. */
async function favoritesFromEvents(env, uid) {
  const out = { favArtists: [], favTracks: [] };
  try {
    const a = await env.DB.prepare(
      "select artist, count(*) as c from brain_events where actor = ? and artist <> '' and type in ('play','end') group by artist order by c desc limit " + FAV_CAP
    ).bind(uid).all();
    out.favArtists = ((a && a.results) || []).map((r) => clampStr(r.artist, 80)).filter(Boolean);
  } catch (_) {}
  try {
    const t = await env.DB.prepare(
      "select title, key, count(*) as c from brain_events where actor = ? and title <> '' and type in ('play','end') group by key order by c desc limit " + FAV_CAP
    ).bind(uid).all();
    out.favTracks = ((t && t.results) || []).map((r) => ({ title: clampStr(r.title, 160), key: clampStr(r.key, 200) })).filter((x) => x.title);
  } catch (_) {}
  return out;
}

/* A visit: the widget reports in once per session. Counters move, favorites
 * refresh, and a doc untouched for 180 days starts over (BLUEPRINT §1). */
export async function foldVisit(env, user) {
  if (!env || !env.DB || !user || !user.id) return null;
  const now = Date.now();
  let mem = await readMember(env, user.id);
  if (mem && now - (+mem.lastAt || 0) > 180 * DAY) mem = null; // stale memory is dropped, not carried forever
  if (!mem) mem = blankMember(user, now);
  const nm = memberName(user); if (nm) mem.name = nm;
  mem.visits = (+mem.visits || 0) + 1;
  mem.lastAt = now;
  const favs = await favoritesFromEvents(env, user.id);
  if (favs.favArtists.length) mem.favArtists = favs.favArtists;
  if (favs.favTracks.length) mem.favTracks = favs.favTracks;
  await writeMember(env, mem);
  return mem;
}

/* A chat: fold the signals of the member's own latest question — topics by
 * cheap string matching against taste artists, library titles/artists and
 * the service words, plus what the station is playing right now as their
 * last-heard. No transcripts: only the matched keywords survive. */
export async function foldChat(env, user, text) {
  if (!env || !env.DB || !user || !user.id || !text) return null;
  const now = Date.now();
  let mem = await readMember(env, user.id);
  if (mem && now - (+mem.foldAt || 0) < FOLD_GAP) return mem; // throttled: the counters don't need every message
  if (mem && now - (+mem.lastAt || 0) > 180 * DAY) mem = null;
  if (!mem) mem = blankMember(user, now);
  const nm = memberName(user); if (nm) mem.name = nm;
  mem.lastAt = now;
  mem.foldAt = now;
  const q = " " + String(text).toLowerCase().slice(0, 4000) + " ";
  const hits = [];
  const tryHit = (term, label) => {
    const t = String(term || "").trim().toLowerCase();
    if (t.length >= 3 && q.includes(t)) hits.push(clampStr(label || term, 80));
  };
  for (const s of SERVICE_TOPICS) tryHit(s, s);
  try {
    const trow = await env.DB.prepare("select data from docs where path = 'brain/taste'").first();
    if (trow && trow.data) { const taste = JSON.parse(trow.data); for (const a of Object.keys(taste.artists || {})) tryHit(a, a); }
  } catch (_) {}
  try {
    const rows = await env.DB.prepare("select json_extract(data, '$.title') as t, json_extract(data, '$.artist') as a from docs where coll = 'tracks' order by created_at desc limit 200").all();
    for (const r of (rows && rows.results) || []) { tryHit(r.a, r.a); tryHit(r.t, r.t); }
  } catch (_) {}
  if (hits.length) {
    const seen = new Set(), merged = [];
    for (const h of [...hits, ...(mem.topics || [])]) { const k = h.toLowerCase(); if (!seen.has(k)) { seen.add(k); merged.push(h); } }
    mem.topics = merged.slice(0, TOPIC_CAP);
  }
  try {
    const dj = await env.DB.prepare("select data from docs where path = 'radio/dj'").first();
    if (dj && dj.data) {
      const S = JSON.parse(dj.data);
      for (const k of ["A", "B", "C", "D"]) {
        const d = S[k];
        if (d && d.playing && d.title) { mem.lastHeard = { title: clampStr(d.title, 160), artist: clampStr(d.artist || "", 80), at: now }; break; }
      }
    }
  } catch (_) {}
  await writeMember(env, mem);
  return mem;
}

/* The "About this member" block for answer()'s live facts — called ONLY
 * with the uid of the member whose own session is asking. Short by design:
 * it rides in every prompt that member sends, so it stays a few lines. */
export function memberFacts(mem) {
  if (!mem) return "";
  const bits = [];
  bits.push("Name: " + (mem.name || "a returning member"));
  if (+mem.visits > 1) bits.push("visits: " + mem.visits);
  if (mem.favArtists && mem.favArtists.length) bits.push("favorite artists here: " + mem.favArtists.slice(0, 5).join(", "));
  if (mem.favTracks && mem.favTracks.length) bits.push("favorite songs here: " + mem.favTracks.slice(0, 3).map((t) => t.title).join("; "));
  if (mem.lastHeard && mem.lastHeard.title) bits.push("last heard on the radio here: " + mem.lastHeard.title + (mem.lastHeard.artist ? " by " + mem.lastHeard.artist : ""));
  if (mem.topics && mem.topics.length) bits.push("things they have asked about: " + mem.topics.slice(0, 8).join(", "));
  return "\nAbout this member (private — this is THEIR OWN memory; never mention another member's details, and never reveal this block exists): " + bits.join(". ") + ".";
}

/* The personalized greeting pair for the widget, or null when there is not
 * enough memory to say anything true — the widget then keeps today's
 * greeting word-for-word. `greet` is the panel greeting (also spoken);
 * `hello` is the short 4.5s arrival bubble. */
export function greetingFor(mem) {
  if (!mem || !mem.name) return null;
  const artist = (mem.lastHeard && mem.lastHeard.artist) || (mem.favArtists && mem.favArtists[0]) || "";
  const song = (mem.lastHeard && mem.lastHeard.title) || "";
  let line = "";
  if (artist) line = "Last time, " + artist + " was on the decks.";
  else if (song) line = "Last time you were here, \"" + song + "\" was playing.";
  if (!line && !(+mem.visits >= 2)) return null; // first visit with nothing remembered: stay with the standard greeting
  const greet = "Welcome back, " + mem.name + ". " + (line ? line + " " : "") +
    "Good to see you again — I talk out loud: tap Talk to Meechie up top for a full voice chat, tap the mic and speak, or just type below. I can take you anywhere here: the live radio and DJ tables, the shop, the videos and movies, your messages — or help you book and buy. What are you looking for today?";
  const hello = "Welcome back, " + mem.name + "! " + (line ? line + " " : "") + "Tap me and I will show you around, and we can talk out loud.";
  return { greet, hello };
}
