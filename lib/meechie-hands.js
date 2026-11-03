// lib/meechie-hands.js — MEECHIE'S HANDS: real operator actions for
// Meechie AI on the radio, the TV, the Book and the Show Studio desk
// (Malik, 2026-11-03: "I want him to be able to touch the tv and radio
// or do anything you can do to his site" + "Make tv shows and all").
//
// THE AUTHORITY SHAPE (owner's order, as framed to him — do not widen):
//  - OWNER SUPREMACY: Malik's booth/hand wins instantly. Queued radio
//    actions stand down while his booth is fresh (the station keeper
//    enforces it in functions/api/station.js, same gate shape as the
//    Auto-DJ pass). The KILL SWITCH (brain/control.hands === false,
//    flipped from the booth BRAIN panel or by the owner's word in chat)
//    halts every Meechie action immediately.
//  - EVERY ACTION LOGGED: each action — done, refused or expired —
//    appends one entry to brain/selflog with actor "Meechie", so Malik
//    can read everything his AI did, tried, or was stopped from doing.
//  - THE WALL HOLDS: radio actions never write tv/* docs; TV actions
//    never write radio/* docs. TV inserts go through the same cleared-
//    item shape tvTick honors (rights basis + evidence, embed-gated);
//    nothing uncleared ever airs.
//  - HARD EXCLUSIONS — THERE IS NO DOOR: money (coins, charges,
//    refunds, gifts, entitlements, prices), member account changes or
//    deletion, member private data, site code changes, the daypart
//    clock. Asked in chat, Meechie declines and (for the owner) files
//    a proposal in brain/proposals instead.
//  - SHOW STUDIO TRUTH: Meechie can create scripts, write outlines,
//    approve scripts, build toward the desk's stages and queue filming
//    handoffs — but he never marks filmed what isn't filmed, and
//    premieres still need Malik's approval tap at the desk. Filming
//    itself stays Amani's pipeline (show/handoffs).
//
// This module is the shared core: doc doors, the control doc, the log,
// the command queue, the chat intent parser, the authority registry and
// the executor for IMMEDIATE actions. Actions that must run inside the
// station keeper's timeline (radio queue surgery, the quarter-news
// interrupt, the TV lineup skip) are QUEUED here and executed by the
// keeper's drain in functions/api/station.js — through the keeper's
// own mechanisms, never around them.
//
// COST: free tier only. Text generation rides the same Workers AI
// default chat model the site chat already uses.

import { DEFAULT_CHAT_MODEL } from "./ai-catalog.js";

export const HANDS_CMD_TTL = 10 * 60e3;   // a queued command older than this stands down
export const HANDS_LOG_MAX = 300;         // selflog entries kept
export const MEECHIE_UID = "meechie-ai";  // his author identity on the Book

/* ------------------------------------------------------------------ */
/* doc doors (same D1 docs-table family as station.js / lib/cf.js)     */
/* ------------------------------------------------------------------ */

export async function hRead(env, path) {
  try {
    const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
    if (!row) return null;
    const d = JSON.parse(row.data || "{}");
    return d && typeof d === "object" && !Array.isArray(d) ? d : null;
  } catch (_) { return null; }
}

export async function hWrite(env, path, coll, data) {
  const now = Date.now();
  const s = JSON.stringify(data);
  await env.DB.prepare("insert into docs (path, coll, data, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict(path) do update set data = excluded.data, updated_at = excluded.updated_at")
    .bind(path, coll, s, now, now).run();
  try { await env.DB.prepare('insert into changes (path, coll, data, at) values (?, ?, ?, ?) on conflict(path) do update set data = excluded.data, at = excluded.at').bind(path, coll, s, now).run(); } catch (_) {}
  return data;
}

export async function hDelete(env, path, coll) {
  try { await env.DB.prepare("delete from docs where path = ?").bind(path).run(); } catch (_) {}
  try { await env.DB.prepare('insert into changes (path, coll, data, at) values (?, ?, ?, ?) on conflict(path) do update set data = excluded.data, at = excluded.at').bind(path, coll, JSON.stringify({ __deleted: 1 }), Date.now()).run(); } catch (_) {}
}

async function hListColl(env, coll, limit) {
  try {
    const res = await env.DB.prepare("select path, data from docs where coll = ? order by path desc limit ?").bind(coll, limit || 200).all();
    return ((res && res.results) || []).map((r) => { try { return { path: r.path, data: JSON.parse(r.data || "{}") }; } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/* ------------------------------------------------------------------ */
/* the control doc — the kill switch + the AI-stocking hold            */
/* brain/control: { hands: false === OFF (absent/true = on),           */
/*                  aiHold: true = Auto-DJ stocking paused by hand,    */
/*                  announced: activation post made, updatedAt, by }   */
/* ------------------------------------------------------------------ */

export async function handsControl(env) {
  const doc = await hRead(env, "brain/control");
  if (!doc) return { exists: false, hands: true, aiHold: false, announced: false };
  return { exists: true, hands: doc.hands !== false, aiHold: !!doc.aiHold, announced: !!doc.announced, updatedAt: doc.updatedAt || 0, by: doc.by || "" };
}

export async function handsSetControl(env, patch, by) {
  const cur = (await hRead(env, "brain/control")) || {};
  const next = { ...cur, ...patch, updatedAt: Date.now(), by: String(by || "") };
  await hWrite(env, "brain/control", "brain", next);
  return { exists: true, hands: next.hands !== false, aiHold: !!next.aiHold, announced: !!next.announced, updatedAt: next.updatedAt, by: next.by };
}

/* ------------------------------------------------------------------ */
/* the log — brain/selflog, shared with the self-review loop           */
/* ------------------------------------------------------------------ */

export async function handsLog(env, entry) {
  try {
    const now = Date.now();
    const doc = (await hRead(env, "brain/selflog")) || { v: 1, createdAt: now, lastRunDay: "", lastRunAt: 0, entries: [] };
    const entries = Array.isArray(doc.entries) ? doc.entries : [];
    entries.push({ at: now, actor: "Meechie", kind: "action", ...entry });
    doc.entries = entries.slice(-HANDS_LOG_MAX);
    doc.updatedAt = now;
    await hWrite(env, "brain/selflog", "brain", doc);
  } catch (_) { /* the log must never break the action it records */ }
}

export async function handsPropose(env, item) {
  try {
    const now = Date.now();
    const doc = (await hRead(env, "brain/proposals")) || { v: 1, items: [] };
    const items = Array.isArray(doc.items) ? doc.items : [];
    if (items.some((p) => p && p.id === item.id && now - (+p.at || 0) < 7 * 864e5)) return false;
    items.push({ at: now, id: item.id, title: String(item.title || "").slice(0, 120), why: String(item.why || "").slice(0, 400), status: "open" });
    doc.items = items.slice(-20);
    doc.updatedAt = now;
    await hWrite(env, "brain/proposals", "brain", doc);
    return true;
  } catch (_) { return false; }
}

/* ------------------------------------------------------------------ */
/* the command queue — brain/commands                                  */
/* Chat/POST doors enqueue keeper-timeline actions here; the station   */
/* keeper drains them on its own cycles (owner-supremacy gate inside). */
/* ------------------------------------------------------------------ */

export async function handsQueue(env, cmd) {
  const doc = (await hRead(env, "brain/commands")) || { v: 1, items: [] };
  const items = (Array.isArray(doc.items) ? doc.items : []).filter((c) => c && (c.status === "queued" || Date.now() - (+c.at || 0) < 3600e3));
  const full = { id: "hc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), status: "queued", ...cmd };
  items.push(full);
  doc.items = items.slice(-24);
  doc.updatedAt = Date.now();
  await hWrite(env, "brain/commands", "brain", doc);
  return full;
}

export async function handsCommandsRead(env) {
  const doc = await hRead(env, "brain/commands");
  return doc && Array.isArray(doc.items) ? doc : { v: 1, items: [] };
}

export async function handsCommandsWrite(env, doc) {
  doc.updatedAt = Date.now();
  await hWrite(env, "brain/commands", "brain", doc);
}

/* ------------------------------------------------------------------ */
/* the authority registry — the whole matrix in one place              */
/* role: "owner" = Malik's session only. "member" = any signed-in      */
/* member (the member-safe subset). mode: "now" = executed by the      */
/* doors through handsAct; "queue" = drained by the station keeper.    */
/* Excluded topics have NO entry here on purpose — there is no door.   */
/* ------------------------------------------------------------------ */

export const HANDS_ACTIONS = {
  "control.hands":    { role: "owner", lane: "site", mode: "now", label: "Kill switch: hands on/off" },
  "control.hold":     { role: "owner", lane: "radio", mode: "now", label: "Pause/resume Auto-DJ stocking" },
  "radio.stock":      { role: "owner", lane: "radio", mode: "queue", label: "Stock the AI queue now" },
  "radio.skipAi":     { role: "owner", lane: "radio", mode: "queue", label: "Remove an AI pick from the queue" },
  "radio.pickNext":   { role: "owner", lane: "radio", mode: "queue", label: "Put a track first in the AI line" },
  "radio.newsNow":    { role: "owner", lane: "radio", mode: "queue", label: "Fire this quarter's fresh news piece on the radio now" },
  "tv.skip":          { role: "owner", lane: "tv", mode: "queue", label: "Skip the current MW TV segment" },
  "tv.insert":        { role: "owner", lane: "tv", mode: "now", label: "Play a cleared video on MW TV next" },
  "tv.break":         { role: "owner", lane: "tv", mode: "now", label: "Trigger a commercial break on MW TV" },
  "site.announce":    { role: "owner", lane: "site", mode: "now", label: "Post a Meechie announcement to the Book" },
  "site.pin":         { role: "owner", lane: "site", mode: "now", label: "Pin Meechie's latest announcement" },
  "site.unpin":       { role: "owner", lane: "site", mode: "now", label: "Unpin Meechie's latest announcement" },
  "site.modRoad":     { role: "owner", lane: "site", mode: "now", label: "Remove a road-report pin" },
  "show.genScript":   { role: "owner", lane: "show", mode: "now", label: "Create an episode script + write its outline" },
  "show.approveScript": { role: "owner", lane: "show", mode: "now", label: "Approve an episode script at the desk" },
  "show.film":        { role: "owner", lane: "show", mode: "now", label: "Hand an approved script to Amani's filming queue" },
  "show.advance":     { role: "owner", lane: "show", mode: "now", label: "Advance a board stage (truthfully only)" },
  "show.scheduleDraft": { role: "owner", lane: "show", mode: "now", label: "Draft a premiere schedule (Malik's tap still airs it)" },
  "member.request":   { role: "member", lane: "site", mode: "now", label: "File a song request with the booth" },
};

export function handsAllowed(role, action) {
  const meta = HANDS_ACTIONS[action];
  if (!meta) return false;
  if (role === "owner") return true;
  if (role === "member") return meta.role === "member";
  return false;
}

/* ------------------------------------------------------------------ */
/* the intent parser — plain words in chat become action requests.     */
/* Pure and exported so the harness can pin the matrix down. Returns:  */
/*   { kind: "action", action, args } | { kind: "excluded", topic }    */
/*   | null (not an action ask — normal chat)                          */
/* ------------------------------------------------------------------ */

/* Exclusions are ACTION asks, not topics of conversation: a money word
   only counts with an action verb in the sentence, so "what's the
   price of the DJ setup?" stays a normal chat question while "charge
   his card" / "give everyone coins" hit the wall. */
const ACTION_VERB = /\b(refund|charge|charging|change|set|lower|raise|update|send|give|grant|add|remove|delete|make|move|pay)\b/i;
const EXCLUDED = [
  { topic: "money", re: /\b(stripe|coins?|payout|cash ?out|withdraw|discount|coupon|entitlement|gift card|buy coins|price|pricing|refund)\b/i, needsVerb: true },
  { topic: "member accounts", re: /\b(delete|remove|ban|block|kick|suspend)\b[^.?!]{0,24}\b(member|account|user|profile)\b|\bchange\b[^.?!]{0,18}\b(email|password)\b/i },
  { topic: "site code", re: /\b(change|edit|rewrite|deploy|patch)\b[^.?!]{0,18}\b(code|station\.js|dj\.js|website code|site code)\b/i },
  { topic: "the daypart clock", re: /\b(change|move|shift|set|extend)\b[^.?!]{0,24}\b(daypart|music hours|trap hours|wake[- ]?up hours|schedule hours)\b/i },
];

function epRef(t) {
  let m = t.match(/\bs\s*(\d)\s*e\s*(\d{1,2})\b/i);
  if (m) return { season: +m[1], ep: +m[2] };
  m = t.match(/\bseason\s*(\d)\b[^.?!]{0,16}\bepisode\s*(\d{1,2})\b/i);
  if (m) return { season: +m[1], ep: +m[2] };
  m = t.match(/\bepisode\s*(\d{1,2})\b/i);
  if (m) return { season: 1, ep: +m[1] };
  return null;
}

export function handsIntent(raw) {
  const t = String(raw || "").trim();
  if (!t || t.length > 600) return null;
  for (const x of EXCLUDED) if (x.re.test(t) && (!x.needsVerb || ACTION_VERB.test(t))) return { kind: "excluded", topic: x.topic };

  // kill switch + hold toggles (owner words)
  if (/\b(hands off|kill switch|stop your hands|turn your hands off|disable your hands)\b/i.test(t)) return { kind: "action", action: "control.hands", args: { on: false } };
  if (/\b(hands on|turn your hands on|enable your hands|use your hands|you can use your hands)\b/i.test(t)) return { kind: "action", action: "control.hands", args: { on: true } };
  if (/\b(pause|hold|stop)\b[^.?!]{0,14}\b(ai[- ]?dj|ai stocking|stocking|digging)\b/i.test(t)) return { kind: "action", action: "control.hold", args: { hold: true } };
  if (/\b(resume|restart|start|unhold)\b[^.?!]{0,14}\b(ai[- ]?dj|ai stocking|stocking|digging)\b/i.test(t)) return { kind: "action", action: "control.hold", args: { hold: false } };

  // radio
  if (/\b(play|run|air|do)\b[^.?!]{0,12}\bnews\b|\bnews now\b/i.test(t)) return { kind: "action", action: "radio.newsNow", args: {} };
  if (/\b(stock|dig|fill)\b[^.?!]{0,22}\b(queue|picks|music|aiq)\b|\bstock up\b/i.test(t)) return { kind: "action", action: "radio.stock", args: {} };
  let m = t.match(/\b(?:skip|remove|drop|pull)\b[^.?!]{0,30}\b(?:ai )?(?:pick|song|track)\b/i);
  if (m) return { kind: "action", action: "radio.skipAi", args: {} };

  // tv (before pickNext: "play a commercial" / "play X on tv" are TV)
  if (/\b(commercial break|run a break|play a commercial|play an ad|take a break)\b/i.test(t)) return { kind: "action", action: "tv.break", args: {} };
  if (/\bskip\b[^.?!]{0,28}\btv\b/i.test(t) || /\btv\b[^.?!]{0,16}\bskip\b/i.test(t)) return { kind: "action", action: "tv.skip", args: {} };
  m = t.match(/\b(?:play|put|show)\b\s+(.+?)\s+on\s+(?:the\s+)?tv\b/i);
  if (m) return { kind: "action", action: "tv.insert", args: { query: m[1].trim() } };

  // radio pick-next (the chat example from the order: "play more country")
  m = t.match(/\bplay more\s+(.+)$/i);
  if (m) return { kind: "action", action: "radio.pickNext", args: { query: m[1].trim() } };
  m = t.match(/\b(?:play|put|queue)\s+(.+?)\s+(?:next|up next|right now)\b/i);
  if (m && !/\bnews\b/i.test(m[1])) return { kind: "action", action: "radio.pickNext", args: { query: m[1].trim() } };

  // site
  m = t.match(/\b(?:announce|post an announcement|tell everyone|tell the site|tell members)\b[:\s]*(.+)$/i);
  if (m && m[1] && m[1].trim().length >= 3) return { kind: "action", action: "site.announce", args: { text: m[1].trim().slice(0, 500) } };
  if (/\bunpin\b/i.test(t)) return { kind: "action", action: "site.unpin", args: {} };
  if (/\bpin\b[^.?!]{0,20}\b(announcement|post)\b/i.test(t)) return { kind: "action", action: "site.pin", args: {} };
  m = t.match(/\bremove\b[^.?!]{0,20}\b(police|crash|hazard|traffic|road ?work|closed)\b[^.?!]{0,12}\b(pin|report)\b/i);
  if (m) return { kind: "action", action: "site.modRoad", args: { type: m[1].toLowerCase().replace(/\s+/g, "") } };

  // show studio
  const ref = epRef(t);
  if (ref) {
    if (/\b(schedule|premiere)\b/i.test(t)) return { kind: "action", action: "show.scheduleDraft", args: ref };
    if (/\bapprove\b[^.?!]{0,14}\bscript\b/i.test(t)) return { kind: "action", action: "show.approveScript", args: ref };
    if (/\b(film|hand)\b/i.test(t) && /\b(amani|film|handoff|filming)\b/i.test(t)) return { kind: "action", action: "show.film", args: ref };
    const adv = t.match(/\bmove\b[^.?!]{0,22}\bto\b[^.?!]{0,10}\b(shot ?list|filming|assembly|approval|scheduled)\b/i);
    if (adv) return { kind: "action", action: "show.advance", args: { ...ref, to: adv[1].toLowerCase().replace(/\s+/g, "") } };
    if (/\b(write|create|start|make|draft)\b[^.?!]{0,26}\b(script|episode|outline)\b/i.test(t)) return { kind: "action", action: "show.genScript", args: ref };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* immediate-action helpers                                            */
/* ------------------------------------------------------------------ */

const CLOCK = [
  ["A", "Cold Open — The Chair", "00:00–01:15", 16], ["T", "Main Titles", "01:15–01:45", 0],
  ["B", "The Shop", "01:45–04:45", 44], ["C", "The Booth", "04:45–07:15", 34],
  ["D", "The Hustle", "07:15–09:45", 34], ["E", "The Music", "09:45–12:00", 22],
  ["F", "The Build", "12:00–13:15", 18], ["G", "Family Table", "13:15–14:30", 24],
  ["H", "Closing Word + Hook", "14:30–15:00", 8],
];
const iso = (ms) => new Date(ms).toISOString();
const epCode = (a) => "S" + (a.season || 1) + "E" + (a.ep || 1);
const epId = (a) => "s" + (a.season || 1) + "e" + (a.ep || 1);

async function ensureMeechieMember(env) {
  const cur = await hRead(env, "members/" + MEECHIE_UID);
  if (cur && cur.name) return;
  await hWrite(env, "members/" + MEECHIE_UID, "members", {
    ...(cur || {}), name: "Meechie AI", handle: "meechie-ai", ai: true,
    about: "Malik's AI partner at Meechie's World. I run the radio, MW TV and the Show Studio desk for him — every action I take is logged where he can read it.",
    createdAt: (cur && cur.createdAt) || Date.now(),
  });
}

export async function handsAnnounce(env, text, opts) {
  await ensureMeechieMember(env);
  const id = "meechie-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const post = { authorId: MEECHIE_UID, text: String(text || "").slice(0, 500), photo: "", likes: [], replyCount: 0, announce: true, ai: true, createdAt: Date.now(), ...(opts && opts.extra ? opts.extra : {}) };
  await hWrite(env, "posts/" + id, "posts", post);
  return { id, post };
}

async function myLatestPost(env) {
  const rows = await hListColl(env, "posts", 200);
  const mine = rows.filter((r) => r.data && r.data.authorId === MEECHIE_UID).sort((a, b) => (+b.data.createdAt || 0) - (+a.data.createdAt || 0));
  return mine[0] || null;
}

const ROAD_TYPE_WORDS = { police: "police", crash: "crash", hazard: "hazard", traffic: "traffic", roadwork: "roadwork", closed: "closed" };

/* The embed gate: the same /api/ytsearch relay the Auto-DJ pass and the
   satellite channels trust — age-restricted, region-blocked and
   non-embeddable videos never come back from it. An insert is cleared
   ONLY when the exact video comes back through that gate. */
async function gateResolve(env, deps, query) {
  if (!deps || !deps.origin || typeof deps.fetchFn !== "function") return null;
  try {
    const r = await deps.fetchFn(deps.origin + "/api/ytsearch?q=" + encodeURIComponent(query), { headers: { cookie: deps.cookie || "" } });
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    const rows = (j && Array.isArray(j.results) ? j.results : []).filter((x) => x && x.id && +x.dur > 0);
    if (!rows.length) return null;
    const idm = String(query).match(/^[A-Za-z0-9_-]{11}$/);
    if (idm) { const exact = rows.find((x) => x.id === query); return exact ? { yt: exact.id, title: String(exact.title || "").slice(0, 160), dur: +exact.dur, exact: true } : null; }
    const top = rows[0];
    return { yt: top.id, title: String(top.title || "").slice(0, 160), dur: +top.dur, exact: false };
  } catch (_) { return null; }
}

async function insertDoorFree(env) {
  const doc = await hRead(env, "tv/insert");
  if (!doc) return { free: true };
  if (doc.consumedAt) return { free: true };
  const items = Array.isArray(doc.items) ? doc.items : null;
  const first = items && items.length ? items[0] : doc;
  const title = String((first && first.title) || "an insert");
  const when = doc.startAt ? new Date(+doc.startAt).toLocaleString("en-US", { timeZone: "America/New_York" }) : "";
  return { free: false, why: "an insert Malik already ordered is still waiting in the tv/insert door (“" + title + "”" + (when ? ", set for " + when : "") + ") — I won't step on his programming" };
}

async function writeInsert(env, items, show) {
  const now = Date.now();
  await hWrite(env, "tv/insert", "tv", { progV: 3, at: now, updatedAt: now, by: "meechie-hands", show: show || "Meechie AI Pick", items });
}

/* ------------------------------------------------------------------ */
/* handsAct — the one executor every door calls.                       */
/*   env, who: { role: "owner"|"member", uid, name },                  */
/*   intent: handsIntent() output, deps: { origin, fetchFn, cookie,    */
/*   aiText } (aiText optional — script outlines degrade honestly).    */
/* Returns { reply, action?, refused? }. Every outcome is logged.      */
/* ------------------------------------------------------------------ */

export async function handsAct(env, who, intent, deps) {
  deps = deps || {};
  const role = who && who.role === "owner" ? "owner" : "member";
  const by = { by: (who && who.name) || "", uid: (who && who.uid) || "", role };
  const done = async (action, target, summary, reply, extra) => { await handsLog(env, { action, target, summary, ...by, ...(extra || {}) }); return { reply, action }; };
  const refused = async (action, target, summary, reply) => { await handsLog(env, { action, target, summary: "Refused: " + summary, refused: true, ...by }); return { reply, action, refused: true }; };

  if (!intent) return { reply: "" };
  if (intent.kind === "excluded") {
    if (role === "owner") {
      await handsPropose(env, { id: "hands-excluded-" + intent.topic.replace(/\W+/g, "-"), title: "Owner asked Meechie for: " + intent.topic, why: "Meechie has no door for " + intent.topic + " (hard exclusion in his hands spec). Asked in chat " + iso(Date.now()) + ". Amani: pick this up with Malik if he wants it done by hand." });
      return refused("excluded." + intent.topic, intent.topic, "no door exists; proposal filed", "I can't touch " + intent.topic + " — that door doesn't exist for me, on purpose. I filed it as a proposal so Amani can pick it up with you.");
    }
    return { reply: "That's not something I can do — money, accounts and site settings sit with Malik and Amani only. I can take a song request for the booth, though.", refused: true };
  }

  const action = intent.action, args = intent.args || {}, meta = HANDS_ACTIONS[action];
  if (!meta) return { reply: "" };

  /* a member asking for an owner's action: the one downgrade is a
     pick-next phrased as a request — it becomes a booth request, the
     member-safe lane. Everything else is a plain, logged decline. */
  if (!handsAllowed(role, action)) {
    if (role === "member" && action === "radio.pickNext" && args.query) {
      const text = "Song request: " + String(args.query).slice(0, 160);
      const id = "rq" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await hWrite(env, "requests/" + id, "requests", { kind: "text", text, at: Date.now(), by: by.by || "member", uid: by.uid });
      return done("member.request", "requests/" + id, "member song request filed with the booth: “" + String(args.query).slice(0, 80) + "”", "Got it — I put your request in with the booth: “" + String(args.query).slice(0, 80) + "”. Malik's queue runs the station; requests ride his line.");
    }
    return refused(action, action, "authority: " + role + " cannot run owner actions", "That one's above my pay grade for members — station and site controls are Malik's hands only. I can take a song request for the booth if you'd like.");
  }

  const ctl = await handsControl(env);

  /* the kill switch: only the owner's own toggle words get through */
  if (action === "control.hands") {
    const next = await handsSetControl(env, { hands: !!args.on }, by.uid || "owner");
    return done("control.hands", "brain/control", "kill switch flipped: hands " + (next.hands ? "ON" : "OFF"), next.hands ? "My hands are ON — I can run the radio, the TV, the Book and the Show Studio desk for you. Every move lands in the log." : "My hands are OFF. I won't touch the radio, the TV, the Book or the desk until you turn them back on. The switch also lives in your booth's BRAIN panel.");
  }
  if (!ctl.hands) {
    return refused(action, action, "kill switch is OFF", "My hands are off right now (kill switch). Say “hands on” and I'll get back to work — the switch also lives in your booth's BRAIN panel.");
  }
  if (action === "control.hold") {
    const next = await handsSetControl(env, { aiHold: !!args.hold }, by.uid || "owner");
    return done("control.hold", "brain/control", "Auto-DJ stocking hold " + (next.aiHold ? "ON — stocking paused" : "OFF — stocking resumed"), next.aiHold ? "Auto-DJ stocking is on hold — I won't dig for new picks until you say resume. Your queue and the rotation keep the station running." : "Auto-DJ stocking resumed — I'll dig while the booth is away, inside your daypart grid as always.");
  }

  /* keeper-timeline actions: enqueue; the keeper's drain executes
     them under the booth-fresh stand-down and writes the log entry
     that records what actually happened. */
  if (meta.mode === "queue") {
    if (ctl.aiHold && (action === "radio.stock" || action === "radio.pickNext")) {
      return refused(action, action, "AI stocking is on hold", "AI stocking is on hold right now — say “resume stocking” first, then ask me again.");
    }
    const cmd = await handsQueue(env, { action, args, by: by.by, uid: by.uid, role });
    const soon = "It'll land on the next station cycle (seconds, while the station is live) and the result goes in the log.";
    const replies = {
      "radio.stock": "On it — I'm digging for fresh picks in your taste now. " + soon,
      "radio.skipAi": "On it — that AI pick comes out of the line. " + soon,
      "radio.pickNext": "On it — “" + String(args.query || "").slice(0, 60) + "” goes first in my AI line, right behind your queue and listener picks. " + soon,
      "radio.newsNow": "On it — if this quarter's news piece is still fresh, it plays on the radio at the next safe moment. " + soon,
      "tv.skip": "On it — the current TV segment gets skipped at the next keeper tick. " + soon,
    };
    return { reply: replies[action] || "On it. " + soon, action, queued: cmd.id };
  }

  /* ---------------- immediate actions ---------------- */
  try {
    if (action === "tv.insert" || action === "tv.break") {
      const door = await insertDoorFree(env);
      if (!door.free) return refused(action, "tv/insert", door.why, "I held off: " + door.why + ".");
      if (action === "tv.break") {
        const pool = await hRead(env, "tv/breakpool");
        const spots = (pool && Array.isArray(pool.items) ? pool.items : []).filter((s) => s && s.src && +s.dur > 0);
        if (!spots.length) return refused(action, "tv/breakpool", "commercial pool is empty", "I couldn't trigger a break — the commercial pool is empty right now.");
        const spot = spots[Math.floor(Math.random() * spots.length)];
        const now = Date.now();
        await writeInsert(env, [{ id: "spot-" + (spot.id || "x"), kind: "spot", src: "file", url: String(spot.src), title: String(spot.title || "Commercial"), show: "Commercial Break", dur: +spot.dur, rights: { basis: "own", evidence: "Malik's own commercial pool (tv/breakpool), triggered by Meechie AI " + iso(now), clearedBy: "meechie-ai", at: now, simulcast: false } }], "Commercial Break");
        return done(action, "tv/insert", "break triggered: “" + String(spot.title || spot.id) + "” plays at the end of the current TV segment", "Break coming up on MW TV — “" + String(spot.title || "Commercial") + "” plays when the current segment ends. I logged it.");
      }
      const q = String(args.yt || args.query || "").trim();
      if (!q) return refused(action, "tv/insert", "no video named", "Tell me which video and I'll put it on the TV — a name or a YouTube link works.");
      const hit = await gateResolve(env, deps, q);
      if (!hit) return refused(action, "tv/insert", "gate could not verify “" + q.slice(0, 60) + "”", "I couldn't verify that video through the site's embed gate, so it doesn't air — nothing uncleared goes on your TV. Give me another one and I'll check it the same way.");
      const now = Date.now();
      await writeInsert(env, [{ id: "meechie-" + hit.yt, kind: "show", src: "yt", yt: hit.yt, title: hit.title, show: "Meechie AI Pick", dur: hit.dur, rights: { basis: "embed", evidence: "Passed the site embed gate (/api/ytsearch)" + (hit.exact ? " with an exact-id match" : " as the gate's top match") + " at insert time, placed by Meechie AI " + iso(now), clearedBy: "meechie-ai", at: now, simulcast: false } }], "Meechie AI Pick");
      return done(action, "tv/insert", "“" + hit.title + "” (" + hit.yt + ") cleared through the embed gate; plays at the end of the current TV segment", "Cleared and queued on MW TV: “" + hit.title + "” plays when the current segment ends. Logged, as always.");
    }

    if (action === "site.announce") {
      const text = String(args.text || "").trim();
      if (!text) return refused(action, "posts", "announcement with no words", "What should the announcement say? Give me the words and I'll post them as me, badged as the AI.");
      const { id } = await handsAnnounce(env, text);
      return done(action, "posts/" + id, "announcement posted to the Book: “" + text.slice(0, 120) + "”", "Posted to Meechie's Book as me, badged as the AI: “" + text.slice(0, 120) + "” — you can delete it any time.");
    }
    if (action === "site.pin" || action === "site.unpin") {
      const mine = await myLatestPost(env);
      if (!mine) return refused(action, "posts", "no Meechie post exists to " + (action === "site.pin" ? "pin" : "unpin"), "I don't have a post of my own up there yet — ask me to announce something first.");
      const data = { ...mine.data, announce: action === "site.pin" };
      await hWrite(env, mine.path, "posts", data);
      return done(action, mine.path, (action === "site.pin" ? "pinned" : "unpinned") + " my latest announcement (“" + String(mine.data.text || "").slice(0, 80) + "”)", action === "site.pin" ? "Pinned — my latest announcement rides the top of the Book until you unpin it." : "Unpinned — the announcement goes back to being a regular post.");
    }
    if (action === "site.modRoad") {
      const want = ROAD_TYPE_WORDS[String(args.type || "").toLowerCase()] || "";
      const rows = await hListColl(env, "roadreports", 200);
      const live = rows.filter((r) => r.data && (!want || r.data.type === want) && (!r.data.expiresAt || +r.data.expiresAt > Date.now()));
      if (!live.length) return refused(action, "roadreports", "no live " + (want || "road") + " report to remove", "There's no live " + (want || "road") + " report on the map to take down.");
      const victim = live.sort((a, b) => (+b.data.at || 0) - (+a.data.at || 0))[0];
      await hDelete(env, victim.path, "roadreports");
      return done(action, victim.path, "removed a " + (victim.data.type || "road") + " report pin near " + (victim.data.town || "Fayette County"), "Done — I took that " + (victim.data.type || "road") + " pin off the road map. It's in the log.");
    }

    if (action === "show.genScript" || action === "show.approveScript" || action === "show.film" || action === "show.advance" || action === "show.scheduleDraft") {
      const code = epCode(args), id = epId(args);
      const spath = "show/script-" + id;
      if (action === "show.genScript") {
        const existing = await hRead(env, spath);
        if (existing) return done(action, spath, code + " script already exists (status " + (existing.status || "draft") + ") — left untouched", code + " already has a script at the desk (status: " + (existing.status || "draft") + "). I didn't overwrite a word of it.");
        const title = String(args.title || "Untitled Episode").slice(0, 80);
        const sc = { id, code, title, season: args.season || 1, ep: args.ep || 1, premise: String(args.premise || "").slice(0, 400), song: String(args.song || "").slice(0, 120), status: "draft", outline: "", segments: CLOCK.map(([k, n, s]) => ({ key: k, name: n, span: s, text: "" })), shots: null, versions: [], createdAt: iso(Date.now()), updatedAt: iso(Date.now()), byMeechie: true };
        let outlineNote = "The outline is still blank — the AI writer wasn't reachable from here, so the desk has the empty script ready for words.";
        if (typeof deps.aiText === "function") {
          try {
            const txt = await deps.aiText("Write the segment-by-segment outline for MY EMPIRE " + code + " — “" + title + "”.\nPremise: " + (sc.premise || "(not set — invent one that fits the season arc)") + "\nSong placement (plays once): " + (sc.song || "pick a fitting one of Malik's songs and name it") + "\nGive one short block per segment (A, Titles, B, C, D, E, F, G, H): what happens, who is in it, the joke or the turn, and end with the cliffhanger hook in H. Plain text, no markdown tables.");
            if (txt && txt.trim().length > 40) { sc.outline = txt.trim().slice(0, 6000); outlineNote = "I wrote the outline too — it's waiting at the desk for your read."; }
          } catch (_) {}
        }
        await hWrite(env, spath, "show", sc);
        const board = (await hRead(env, "show/board")) || { episodes: [] };
        const eps = Array.isArray(board.episodes) ? board.episodes : [];
        if (!eps.some((e) => e && e.id === code)) { eps.push({ id: code, title, season: sc.season, ep: sc.ep, scriptId: id, stage: "script", premiere: "held", mediaUrl: "/media/my-empire-ep" + sc.ep + ".mp4", dur: 900, notes: "New episode, born on the Script Desk (created by Meechie AI). Premiere HELD until Malik approves the finished episode.", updatedAt: iso(Date.now()) }); board.episodes = eps; await hWrite(env, "show/board", "show", board); }
        return done(action, spath, code + " “" + title + "” script created at the desk; board stage: script; premiere HELD", code + " is on the desk — script created, premiere held. " + outlineNote);
      }
      const sc = await hRead(env, spath);
      if (!sc) return refused(action, spath, "no script exists for " + code, "There's no script for " + code + " at the desk yet — say “write the script for " + code + "” and I'll create it.");
      const board = (await hRead(env, "show/board")) || { episodes: [] };
      const eps = Array.isArray(board.episodes) ? board.episodes : [];
      const ep = eps.find((e) => e && e.id === code);
      if (action === "show.approveScript") {
        if (sc.status === "approved") return done(action, spath, code + " script was already approved", code + "'s script is already approved — no change.");
        if (sc.status === "handed-off") return refused(action, spath, code + " already handed off", code + " is already with Amani for filming — approving again would rewrite history, so I left it.");
        sc.status = "approved"; sc.updatedAt = iso(Date.now());
        await hWrite(env, spath, "show", sc);
        return done(action, spath, code + " script approved at the desk", code + " script approved ✓ It can be handed to Amani for filming now.");
      }
      if (action === "show.film") {
        if (sc.status !== "approved") return refused(action, spath, code + " script status is " + (sc.status || "draft") + ", not approved", "I won't hand " + code + " to Amani until its script is approved — that's the desk's rule and it keeps filming honest. Approve the script first.");
        if (!Array.isArray(sc.shots) || !sc.shots.length) return refused(action, spath, code + " has no shot list yet", code + " has no shot list yet — the desk builds it from the segment text. Once it's built, I'll queue the handoff.");
        const hand = (await hRead(env, "show/handoffs")) || { queue: [] };
        const queue = Array.isArray(hand.queue) ? hand.queue : [];
        queue.push({ id: "h" + Date.now().toString(36), scriptId: id, code, title: sc.title, at: iso(Date.now()), shots: sc.shots.length, status: "waiting for Amani", by: "Meechie AI" });
        hand.queue = queue;
        await hWrite(env, "show/handoffs", "show", hand);
        sc.status = "handed-off"; sc.updatedAt = iso(Date.now());
        await hWrite(env, spath, "show", sc);
        if (ep && (ep.stage === "script" || ep.stage === "shotlist")) { ep.stage = "filming"; ep.notes = (ep.notes ? ep.notes + " " : "") + "Handed to Amani by Meechie AI — filming in her pipeline."; ep.updatedAt = iso(Date.now()); board.episodes = eps; await hWrite(env, "show/board", "show", board); }
        return done(action, "show/handoffs", code + " handed to Amani's filming queue (" + sc.shots.length + " shots); board stage: filming", code + " is in Amani's hands 🎬 Filming happens in her pipeline — the board will tell the truth about where it is.");
      }
      if (action === "show.advance") {
        const to = String(args.to || "");
        if (!ep) return refused(action, "show/board", "no board row for " + code, code + " isn't on the production board yet.");
        if (to === "shotlist") {
          if (ep.stage !== "script") return refused(action, "show/board", code + " is at " + ep.stage + ", not script", code + " is already past the script stage (it's at “" + ep.stage + "”) — I don't move boards backwards.");
          if (!Array.isArray(sc.shots) || !sc.shots.length) return refused(action, "show/board", code + " has no shot list to advance to", "There's no shot list for " + code + " yet, so “shot list” stage would be a lie. The desk builds it from the segment text first.");
          ep.stage = "shotlist"; ep.updatedAt = iso(Date.now()); board.episodes = eps;
          await hWrite(env, "show/board", "show", board);
          return done(action, "show/board", code + " advanced script → shotlist (" + sc.shots.length + " shots on file)", code + " moved to Shot List — the shots are really on file, so the stage is true.");
        }
        if (to === "filming") return refused(action, "show/board", "filming starts only through the handoff", "Filming starts through the handoff, not a stage flip — say “hand " + code + " to Amani” once the script is approved and has a shot list.");
        return refused(action, "show/board", "stage “" + to + "” is not Meechie's to set", "I can't move " + code + " to “" + to + "” — assembly comes from Amani's pipeline and approval/scheduling are your tap at the desk. I won't mark done what isn't done.");
      }
      if (action === "show.scheduleDraft") {
        const sched = (await hRead(env, "show/schedule")) || { actions: [] };
        const acts = Array.isArray(sched.actions) ? sched.actions : [];
        acts.push({ at: iso(Date.now()), draft: true, by: "Meechie AI", text: "DRAFT by Meechie AI: " + code + " (“" + (sc.title || "") + "”) for the 8 PM premiere + 10 PM rerun slots. NOT LIVE — it airs only when Malik approves the finished episode and flips the premiere at the desk." });
        sched.actions = acts.slice(-50);
        await hWrite(env, "show/schedule", "show", sched);
        return done(action, "show/schedule", code + " premiere schedule DRAFT prepared (8 PM + 10 PM rerun); nothing aired", "Draft ready: " + code + " penciled for 8 PM with the 10 PM rerun. Nothing airs until you approve the finished episode and flip it at the desk — that tap stays yours.");
      }
    }
  } catch (e) {
    return refused(action, action, "error: " + String((e && e.message) || e).slice(0, 120), "That action hit a snag on my side — I logged it and changed nothing. Amani can see it in the log.");
  }
  return { reply: "" };
}

/* Default aiText for doors that have a Workers AI binding. */
export async function handsAiText(env, prompt) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return "";
  const out = await env.AI.run(DEFAULT_CHAT_MODEL, { messages: [{ role: "user", content: String(prompt).slice(0, 4000) }], max_tokens: 1100 });
  return String((out && out.response) || "").trim();
}
