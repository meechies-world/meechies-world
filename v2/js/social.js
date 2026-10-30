/* ============================================================================
   v2 SOCIAL DATA LAYER — the Book + social core's shared half (MAP §4.2/§4.4).

   Every social view (Book, Friends, Messages, Chat, Clips) talks to the
   server through this module and the shell's gateway — the SAME live
   backend the site runs today, the same collections, the same document
   shapes, the same REST ops and RPCs the live platform layer
   (js/platform.js + js/cf-client.js) uses:

     docs store   table "docs" {path, coll, owner, data}; a collection is
                  docs with coll = <name>; a subcollection's coll is the
                  full parent path + "/" + name (posts/<id>/replies,
                  chat/<channel>/msgs)
     writes       insert via REST; doc set via rpc "set_doc"; partial
                  update via rpc "merge_doc"; delete via REST
     DMs          the real `dms` TABLE (sender set server-side), with the
                  ⟦tag⟧ body protocol js/messages.js speaks
     live refresh the public changes feed (GET/POST /api/cf/changes),
                  polled like cf-client.js polls it (~6 s; ~2 s while a
                  room with broadcast handlers is open)
     rooms        the changes-feed room protocol (presence + broadcast)
                  cf-client.js rides on the same poll
     uploads      POST /api/cf/upload/media/<uid>/<id>.<ext>; public URL
                  <origin>/m/media/<path>; videos are converted in the
                  browser first (the live uploadVideo rule: nothing
                  unplayable gets posted)

   The pure logic (feed ranking, the count rules, the DM tag protocol,
   thread grouping, story grouping, the clip filter) is exported bare so
   the harness can fixture it without a DOM.
   ============================================================================ */

export const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
export const SHOW_MIN = 25;    // Law 11: like counts under 25 stay hidden
export const COMMENT_MIN = 3;  // the owner's matching comment-count rule
export const GIFTS = [["rose", "🌹", "Rose"], ["mic", "🎤", "Mic"], ["gold", "🪙", "Gold Coin"], ["crown", "👑", "Crown"], ["fire", "🔥", "Fire"], ["diamond", "💎", "Diamond"]];

/* ---------------- pure helpers (live app-core.js, verbatim rules) -------- */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || "").trim()) ? String(u).trim() : "#");
export const safeImg = (u) => (/^https:\/\/[^\s"'()<>\\]+$/i.test(String(u || "")) ? String(u) : "");
export const initial = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
export function ago(ms) { if (!ms) return "just now"; const s = (Date.now() - ms) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return new Date(ms).toLocaleDateString(); }
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 20);
export const lastOf = (path) => String(path || "").split("/").pop();
export const parentOf = (path) => String(path || "").split("/").slice(0, -1).join("/");

/* The live platform layer drops rows whose id or author fields aren't
   plain ids, so nothing user-made can sneak HTML into the page
   (platform.js cleanRow). Same rule, same key list. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ID_KEYS = ["authorId", "from", "to", "uid", "by"];
export const cleanRow = (r) => !!r && SAFE_ID.test(lastOf(r.path || "")) && !!r.data && typeof r.data === "object" && ID_KEYS.every((k) => r.data[k] == null || (typeof r.data[k] === "string" && SAFE_ID.test(r.data[k])));

/* ---------------- the feed (live renderFeed's ordering + counts) -------- */
/* rank: announcements, promoted, then people you follow, then everyone */
export const feedRank = (p, following) => (p.announce ? 4 : 0) + (p.sponsored ? 2 : 0) + (following && following.has(p.authorId) ? 1 : 0);
export function sortFeed(posts, following) {
  return [...posts].sort((a, b) => feedRank(b, following) - feedRank(a, following) || (b.createdAt || 0) - (a.createdAt || 0));
}
/* 🔥 Trending: the 3 posts from the last 7 days with the most real
   likes and comments (score = likes + 2×comments, needs score ≥ 3) */
export function trendingIds(posts, now) {
  const wk = now - 7 * 864e5, sc = (p) => (p.likes || []).length + 2 * (+p.replyCount || 0);
  return new Set(posts.filter((p) => (p.createdAt || 0) > wk && sc(p) >= 3).sort((a, b) => sc(b) - sc(a)).slice(0, 3).map((p) => p.id));
}
/* Law 11 + its comment twin: small counts stay hidden until they're
   worth showing; the owner/admin seat always sees them. */
export const likeCountVisible = (n, isAdmin) => !!n && (n >= SHOW_MIN || !!isAdmin);
export const commentCountVisible = (n, isAdmin) => !!n && (n >= COMMENT_MIN || !!isAdmin);

/* ---------------- clips (live clips.js filter) -------------------------- */
/* community posts that have a video; the old Supabase storage is shut
   off — its clips are dead for everyone, keep them out entirely */
export function clipList(posts) {
  return posts.filter((p) => /^https:\/\//.test(p.video || "") && !/supabase\.co/.test(p.video)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* ---------------- stories (live stories.js grouping) -------------------- */
export const STORY_DAY = 864e5;
export const STORY_BGS = { gold: "linear-gradient(160deg,#fff1b8,#e3ad3c 45%,#8a5a12)", night: "radial-gradient(120% 90% at 50% 0%,#3a2a0c,#050505 70%)", royal: "linear-gradient(160deg,#2b0a3d,#7b3fb0 55%,#e3ad3c)", fire: "linear-gradient(160deg,#ffcc4d,#ff5a1f 55%,#5a0d0d)", ocean: "linear-gradient(160deg,#56ccf2,#2f80ed 55%,#0b1a3a)", rose: "linear-gradient(160deg,#ffd1dc,#e0559a 55%,#3a0a24)" };
export function storyLive(stories, now) {
  return stories.filter((s) => s.createdAt > now - STORY_DAY && (s.url || s.text)).sort((a, b) => a.createdAt - b.createdAt);
}
/* "Your story" first, then unseen, then friends, then the latest */
export function storyGroups(stories, seen, me, friendIds, now) {
  const by = new Map();
  for (const s of storyLive(stories, now)) { if (!by.has(s.authorId)) by.set(s.authorId, []); by.get(s.authorId).push(s); }
  const fr = friendIds || new Set();
  return [...by.entries()].map(([uid, list]) => ({ uid, list, unseen: list.some((s) => !seen.has(s.id)), last: list[list.length - 1].createdAt }))
    .sort((a, b) => (b.uid === me) - (a.uid === me) || b.unseen - a.unseen || fr.has(b.uid) - fr.has(a.uid) || b.last - a.last);
}

/* ---------------- the DM body protocol (live messages.js) --------------- */
/* Bodies carry bracket tags in any order, stripped before display:
   ⟦g:<groupId>⟧ group copy · ⟦m:<msgId>⟧ one shared id on every group
   copy · ⟦x:<epochMs>⟧ disappearing expiry · ⟦q:<id>⟧ quote ·
   ⟦react:…⟧ reaction (a tail, not a prefix) */
const DM_TAG_RES = [["g", /^⟦g:([a-z0-9-]{1,48})⟧/i], ["m", /^⟦m:([a-z0-9-]{6,48})⟧/i], ["x", /^⟦x:(\d{10,16})⟧/], ["q", /^⟦q:([a-z0-9-]+)⟧/i]];
const DM_REACT_TAIL = /^⟦react:(@?)([a-z0-9-]+):(❤️|😂|😮|😢|😡|👍|🔥)⟧$/;
export function dmTags(b) {
  const t = {}; let s = String(b || ""); let again = true;
  while (again) { again = false; for (const [k, re] of DM_TAG_RES) { const m = re.exec(s); if (m) { t[k] = m[1]; s = s.slice(m[0].length); again = true; } } }
  return { t, s };
}
export const bareText = (b) => dmTags(b).s;
export const quoteOf = (b) => dmTags(b).t.q || null;
export const groupOfRow = (r) => dmTags(r.body).t.g || null;
export const muidOf = (r) => dmTags(r.body).t.m || null;
export const dmExpired = (r) => { const x = +dmTags(r.body).t.x || 0; return x > 0 && x <= Date.now(); };
export function reactOf(b) { const m = DM_REACT_TAIL.exec(dmTags(b).s); return m ? { target: m[2], emoji: m[3] } : null; }
export const isReact = (b) => !!reactOf(b);
/* Voice/photo bodies: the legacy form points at the retired Supabase
   store; the current send path (platform uploadMedia) writes the same
   sentence around an /m/media/ URL on this site's own origin. The live
   reader only matches the legacy form — see the Phase 3 differences
   list; this reader accepts both, which is the intent. */
const DM_STORE = "https:\\/\\/yjouaysczttqbytksejq\\.supabase\\.co\\/storage\\/v1\\/object\\/public\\/media\\/[A-Za-z0-9_\\-\\/]+";
const DM_MEDIA = "(?:https?:\\/\\/[^\\s⟦⟧\"'<>]+\\/m\\/media\\/[A-Za-z0-9_\\-\\/]+|" + DM_STORE + ")";
const DM_VOICE_RE = new RegExp("^🎙️ Voice message ⟦(" + DM_MEDIA + "\\.(?:webm|m4a|mp4|ogg))⟧$");
const DM_PHOTO_RE = new RegExp("^📷 Photo ⟦(" + DM_MEDIA + "\\.(?:jpg|png|webp))⟧$");
export const voiceUrl = (b) => (DM_VOICE_RE.exec(b || "") || [])[1] || "";
export const photoUrl = (b) => (DM_PHOTO_RE.exec(b || "") || [])[1] || "";
export function dmPreview(r) {
  const b = bareText(r.body);
  if (voiceUrl(b)) return "🎙️ Voice message";
  if (photoUrl(b)) return "📷 Photo";
  const m = reactOf(r.body);
  if (m) return "Reacted " + m.emoji + " to a message";
  return b;
}
/* Conversation list: rows arrive newest-first (the live load order).
   Group copies fan out one per member; my own sent copies share a
   ⟦m:⟧ id and count once. Reactions never count as unread. */
export function groupConvos(rows, uid, groups) {
  const m = new Map(), gm = new Map();
  for (const r of rows) {
    const gid = groupOfRow(r);
    if (gid) {
      if (!groups || !groups[gid]) continue;
      let c = gm.get(gid); if (!c) { c = { id: "g:" + gid, gid, group: true, last: r, unread: 0 }; gm.set(gid, c); }
      if (r.recipient === uid && !r.read_at && !isReact(r.body)) c.unread++;
      continue;
    }
    const o = r.sender === uid ? r.recipient : r.sender;
    let c = m.get(o); if (!c) { c = { id: o, last: r, unread: 0 }; m.set(o, c); }
    if (r.recipient === uid && !r.read_at && !isReact(r.body)) c.unread++;
  }
  return [...gm.values(), ...m.values()].sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
}
/* One thread's rows, oldest-first, split into messages + the reaction
   map (the latest reaction from each person on each message; group
   messages key on their shared ⟦m:⟧ id). */
export function threadSplit(rows, uid, other, gid) {
  const pair = (gid
    ? rows.filter((r) => groupOfRow(r) === gid)
    : rows.filter((r) => !groupOfRow(r) && ((r.sender === uid && r.recipient === other) || (r.sender === other && r.recipient === uid)))
  ).slice().reverse();
  const reacts = {};
  pair.filter((r) => isReact(r.body)).forEach((r) => { const mm = reactOf(r.body); if (mm) (reacts[mm.target] = reacts[mm.target] || {})[r.sender] = mm.emoji; });
  return { msgs: pair.filter((r) => !isReact(r.body)), reacts };
}
export const msgKey = (r, gid) => (gid ? (muidOf(r) || String(r.id)) : String(r.id));

/* ================= the live data layer (stateful) ====================== */

/* A toast in the live shape (one gold pill, bottom center; the shell's
   stylesheet already carries the live .toast rules). */
let toastEl = null, toastTimer = null;
export function say(text) {
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; toastEl.hidden = true; document.body.appendChild(toastEl); }
  toastEl.textContent = text; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

/* Image compression — the live compress(): JPEG data URL, quality walks
   down until the data URL fits ~200 KB. Post photos ride inline in the
   post doc exactly like the live site. */
export function compress(file, max = 1080) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      let q = .8, w = img.width, h = img.height; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      let d = c.toDataURL("image/jpeg", q); while (d.length > 200000 && q > .35) { q -= .1; d = c.toDataURL("image/jpeg", q); }
      if (d.length > 200000) { c.width = Math.round(w * .6); c.height = Math.round(h * .6); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); d = c.toDataURL("image/jpeg", .6); }
      res(d);
    };
    img.onerror = () => rej(new Error("That file isn't an image we can read."));
    img.src = url;
  });
}
export const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

/* Find people by email without anyone's email being visible (live
   email-find.js): SHA-256 of "meechies-world:" + the lowercased email,
   matched against the fingerprint on member docs. */
export async function emailHash(email) {
  const e = String(email || "").trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "";
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("meechies-world:" + e));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

/* One changes-feed poll shared by a view's doc watchers and rooms —
   cf-client.js's pattern: prime on the max seq, then stream rows;
   rooms ride the same request. */
class LiveBus {
  constructor(gw) { this.gw = gw; this.seq = null; this.watchers = new Set(); this.rooms = new Map(); this.timer = null; this.stopped = false; this.kick(60); }
  /* colls: an array of docs-collection names to match on row.coll, or
     null to receive EVERY row (table changes like `dms` carry tbl, not
     coll — the live messages screen refreshes off those). */
  watch(colls, cb) { const w = { colls: colls ? new Set(colls) : null, cb }; this.watchers.add(w); this.kick(30); return () => this.watchers.delete(w); }
  kick(ms) { if (this.stopped) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.poll(), ms == null ? 0 : ms); }
  room(name) { let r = this.rooms.get(name); if (!r) { r = new Room(this, name); this.rooms.set(name, r); this.kick(30); } return r; }
  async poll() {
    if (this.stopped) return;
    try {
      let body;
      if (this.rooms.size) { const rb = {}; for (const [n, r] of this.rooms) rb[n] = r.out(); body = { since: this.seq === null ? "" : this.seq, rooms: rb }; }
      const j = body ? await this.gw.call("changes", body) : await this.gw.call("changes" + (this.seq === null ? "" : "?since=" + this.seq));
      if (this.stopped) return;
      if (j && j.rooms) for (const [n, d] of Object.entries(j.rooms)) { const r = this.rooms.get(n); if (r) r.in(d); }
      if (j && this.seq !== null && Array.isArray(j.rows)) {
        for (const row of j.rows) this.watchers.forEach((w) => { if (!w.colls || w.colls.has(row.coll)) { try { w.cb(row); } catch (_) {} } });
      }
      if (j && this.seq === null && typeof j.seq === "number") { this.seq = j.seq; this.watchers.forEach((w) => { try { w.cb(null); } catch (_) {} }); }
      else if (j && typeof j.seq === "number" && j.seq > (this.seq || 0)) this.seq = j.seq;
    } catch (_) { /* the next tick retries; a dead poll never breaks a view */ }
    if (this.stopped) return;
    const hot = [...this.rooms.values()].some((r) => r.hot());
    this.timer = setTimeout(() => this.poll(), hot ? 2000 : document.hidden ? 20000 : 6000);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); for (const r of this.rooms.values()) r.leave(); }
}

/* A room over the changes feed — cf-client.js's cfRoom semantics:
   presence values are {uid, p}; my own messages never come back to me;
   nothing from before I joined is delivered. */
class Room {
  constructor(bus, name) {
    this.bus = bus; this.name = name;
    this.peer = ("p" + Math.random().toString(36).slice(2, 12)).replace(/[^\w-]/g, "").slice(0, 60).padEnd(4, "x");
    this.mine = undefined; this.dirty = false; this.lastSent = 0;
    this.since = 0; this.gotFirst = false; this.state = {}; this.outbox = [];
    this.left = false; this.pHandlers = []; this.bHandlers = {};
  }
  hot() { return !this.left && Object.keys(this.bHandlers).length > 0; }
  out() {
    if (this.left) { this.bus.rooms.delete(this.name); return { peer: this.peer, leave: true }; }
    const o = { peer: this.peer, since: this.since };
    if (this.mine !== undefined && (this.dirty || Date.now() - this.lastSent > 25000)) { o.p = this.mine; this.dirty = false; this.lastSent = Date.now(); }
    if (this.outbox.length) o.send = this.outbox.splice(0, 30);
    return o;
  }
  in(d) {
    const next = {}; (d.peers || []).forEach((x) => { next[x.peer] = [x.p || {}]; });
    const changed = JSON.stringify(next) !== JSON.stringify(this.state); this.state = next;
    if (changed || !this.gotFirst) this.pHandlers.forEach((h) => { try { h({}); } catch (_) {} });
    if (!this.gotFirst) { this.since = d.last || 0; this.gotFirst = true; return; }
    for (const m of d.msgs || []) { this.since = Math.max(this.since, m.id); if (m.peer === this.peer) continue; (this.bHandlers[m.ev] || []).forEach((fn) => { try { fn({ event: m.ev, payload: m.payload }); } catch (_) {} }); }
    if (d.last > this.since && !(d.msgs || []).length) this.since = d.last;
  }
  /* peers in the live roomApi shape: {peer, by, isMe, presence} */
  peers(meId) {
    const out = [];
    for (const key in this.state) { const m = this.state[key][this.state[key].length - 1] || {}; out.push({ peer: key, by: m.uid || null, isMe: !!m.uid && m.uid === meId, presence: m.p || {} }); }
    return out;
  }
  track(p) { this.mine = p; this.dirty = true; this.bus.kick(60); }
  send(ev, payload) { this.outbox.push({ ev, payload }); this.bus.kick(60); }
  onPresence(cb) { this.pHandlers.push(cb); }
  onBroadcast(ev, cb) { (this.bHandlers[ev] = this.bHandlers[ev] || []).push(cb); }
  leave() { if (this.left) return; this.left = true; this.bus.kick(30); }
}

export function createSocial(ctx) {
  const gw = ctx.gateway, session = ctx.session;
  const bus = new LiveBus(gw);
  const S = {
    bus,
    me() { const u = session.user(); return u ? u.id : null; },
    user() { return session.user(); },
    _admin: null,
    async isAdmin() {
      if (this._admin !== null) return this._admin;
      const id = this.me(); if (!id) return (this._admin = false);
      if (id === OWNER_ID) return (this._admin = true);
      const { data } = await gw.rest({ table: "admins", select: "user_id", filters: [["user_id", "eq", id]], limit: 1 });
      return (this._admin = !!(data && data.length));
    },

    /* ---- docs store, the platform layer's exact ops ---- */
    async docs(coll, opts = {}) {
      const { data, error } = await gw.rest({
        table: "docs", select: "path,data", filters: [["coll", "eq", coll]],
        order: { col: "data->" + (opts.field || "createdAt"), asc: opts.asc === true },
        limit: opts.limit || 100,
      });
      if (error || !data) return [];
      return data.filter(cleanRow).map((r) => ({ id: lastOf(r.path), ...r.data }));
    },
    async doc(path) {
      const { data, error } = await gw.rest({ table: "docs", select: "path,data", filters: [["path", "eq", path]], limit: 1 });
      if (error || !data || !data[0]) return null;
      return data[0].data;
    },
    async addDoc(coll, data) {
      const id = this.me(); if (!id) throw new Error("Sign in first.");
      const path = coll + "/" + newId();
      const { error } = await gw.call("rest", { table: "docs", op: "insert", values: { path, coll, owner: id, data } });
      if (error) throw new Error(error.message || "Could not save.");
      return lastOf(path);
    },
    async setDoc(path, data) {
      if (!this.me()) throw new Error("Sign in first.");
      const { error } = await gw.call("rpc", { name: "set_doc", args: { p_path: path, p_coll: parentOf(path), p_data: data } });
      if (error) throw new Error(error.message || "Could not save.");
    },
    async mergeDoc(path, patch) {
      if (!this.me()) throw new Error("Sign in first.");
      const { error } = await gw.call("rpc", { name: "merge_doc", args: { p_path: path, p_patch: patch } });
      if (error) throw new Error(error.message || "Could not save.");
    },
    async delDoc(path) {
      const { error } = await gw.call("rest", { table: "docs", op: "delete", filters: [["path", "eq", path]] });
      if (error) throw new Error(error.message || "Could not delete.");
    },

    /* ---- the dms table (sender is set server-side) ---- */
    async dmLoad() {
      const { data, error } = await gw.rest({ table: "dms", select: "*", order: { col: "created_at", asc: false }, limit: 800 });
      return error || !data ? [] : data;
    },
    async dmInsert(recipient, body) {
      const { error } = await gw.call("rest", { table: "dms", op: "insert", values: { recipient, body } });
      if (error) throw new Error(error.message || "Could not send.");
    },
    async dmMarkRead(fromUid) {
      const id = this.me(); if (!id) return;
      await gw.call("rest", { table: "dms", op: "update", values: { read_at: new Date().toISOString() }, filters: [["recipient", "eq", id], ["sender", "eq", fromUid], ["read_at", "is", null]] }).catch(() => {});
    },
    async dmDelete(id) { await gw.call("rest", { table: "dms", op: "delete", filters: [["id", "eq", id]] }).catch(() => {}); },

    /* ---- member directory ---- */
    members: {},
    myDoc: null,
    async loadMembers() {
      const list = await this.docs("members", { field: "joinedAt", limit: 500 });
      this.members = {}; list.forEach((m) => { this.members[m.id] = m; });
      const id = this.me(); this.myDoc = id ? (this.members[id] || null) : null;
      return this.members;
    },
    handleOf(id) { return (this.members[id] || {}).handle || "Member"; },
    avatarOf(id) {
      const m = this.members[id] || {}, ph = safeImg(m.photo), pp = /^\d{1,3}% \d{1,3}%$/.test(m.photoPos || "") ? m.photoPos : "";
      return `<span class="avatar" data-uid="${esc(id)}">${esc(initial(m.handle))}${ph ? `<img class="avimg" src="${esc(ph)}" alt="" loading="lazy"${pp ? ` style="object-position:${pp}"` : ""}>` : ""}</span>`;
    },
    shopLinks(m) { return [["Printify", m.printify], ["Shopify", m.shopify], ["Store", m.store]].filter((x) => x[1]); },

    /* ---- follows + friends (one list doc per member, full replace) ---- */
    follows: {}, friends: {},
    async loadLists() {
      const [fw, fr] = await Promise.all([this.docs("follows", { limit: 5000 }), this.docs("friends", { limit: 2000 })]);
      const pick = (rows) => { const o = {}; rows.forEach((r) => { o[r.id] = Array.isArray(r.list) ? r.list.filter((i) => typeof i === "string") : []; }); return o; };
      this.follows = pick(fw); this.friends = pick(fr);
      return { follows: this.follows, friends: this.friends };
    },
    following() { return new Set(this.follows[this.me()] || []); },
    async ensureList(kind) {
      const id = this.me(); if (!id) return false;
      if (this[kind][id]) return true;
      const d = await this.doc(kind + "/" + id);
      if (!this[kind][id]) this[kind][id] = d && Array.isArray(d.list) ? d.list.filter((i) => typeof i === "string") : [];
      return true;
    },
    async setList(kind, arr) {
      const id = this.me(); if (!id) return;
      const clean = [...new Set(arr)].slice(0, kind === "follows" ? 5000 : 2000);
      this[kind][id] = clean;
      await this.setDoc(kind + "/" + id, { list: clean });
      if (kind === "follows") this.follows[id] = clean; else this.friends[id] = clean;
    },
    friendIds() {
      const id = this.me(); if (!id) return [];
      const mine = new Set(this.friends[id] || []);
      return [...mine].filter((x) => (this.friends[x] || []).includes(id) && this.members[x]);
    },
    friendRequests() {
      const id = this.me(); if (!id) return [];
      const mine = new Set(this.friends[id] || []);
      return Object.keys(this.friends).filter((x) => x !== id && (this.friends[x] || []).includes(id) && !mine.has(x) && this.members[x]);
    },
    friendStatus(id) {
      const meId = this.me(); if (!meId) return "none";
      const mine = new Set(this.friends[meId] || []), they = (this.friends[id] || []).includes(meId);
      return mine.has(id) && they ? "friends" : mine.has(id) ? "sent" : they ? "request" : "none";
    },

    /* ---- uploads (bucket "media", each member's own folder) ---- */
    VIDEO_MAX: 25 * 1024 * 1024,
    uploadMedia(blob, opts = {}) {
      const id = this.me();
      return new Promise((res, rej) => {
        if (!id) return rej(new Error("Sign in first."));
        if (blob.size > S.VIDEO_MAX) return rej(new Error("That file is too big (over " + Math.round(S.VIDEO_MAX / 1048576) + " MB)."));
        const type = opts.type || blob.type || "application/octet-stream";
        if (!/^(audio|image|video)\//.test(type)) return rej(new Error("That file type isn't supported."));
        const ext = opts.ext || ({ "audio/wav": "wav", "audio/mpeg": "mp3", "audio/webm": "webm", "audio/mp4": "m4a", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type] || "bin");
        const path = id + "/" + newId() + "." + ext;
        const x = new XMLHttpRequest();
        x.open("POST", "/api/cf/upload/media/" + path);
        const s = session.get();
        x.setRequestHeader("authorization", "Bearer " + (s && s.access_token));
        x.setRequestHeader("content-type", type);
        x.upload.onprogress = (e) => { if (e.lengthComputable && opts.onProg) opts.onProg(e.loaded / e.total); };
        x.onload = () => { if (x.status >= 200 && x.status < 300) return res({ path, url: location.origin + "/m/media/" + path }); let m = "Upload failed (" + x.status + ")"; try { const j = JSON.parse(x.responseText); m = j.message || j.error || m; } catch (_) {} rej(new Error(m)); };
        x.onerror = () => rej(new Error("Network problem. Check your connection and try again."));
        x.send(blob);
      });
    },
    /* Every video is converted to a browser-safe format (720p, H.264
       MP4 or WebM) in the browser before uploading — the live rule, so
       nothing unplayable gets posted (platform.js shrinkVideo). */
    shrinkVideo(file, onProg) {
      return new Promise((res, rej) => {
        const v = document.createElement("video"); v.muted = false; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
        v.onerror = () => rej(new Error("This phone can't read that video. Try a shorter clip."));
        v.onloadedmetadata = async () => {
          try {
            const dur = v.duration || 60, scale = Math.min(1, 720 / Math.min(v.videoWidth || 720, v.videoHeight || 720));
            const W = Math.round((v.videoWidth || 720) * scale / 2) * 2, H = Math.round((v.videoHeight || 1280) * scale / 2) * 2;
            const kbps = Math.max(450, Math.min(2500, Math.floor((21 * 8 * 1024) / dur)));
            const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const g = cv.getContext("2d");
            const vs = cv.captureStream(30); let as = null;
            try { const AC = window.AudioContext || window.webkitAudioContext, ac = new AC(), src = ac.createMediaElementSource(v), dst = ac.createMediaStreamDestination(); src.connect(dst); as = dst.stream; } catch (_) {}
            const stream = new MediaStream([...vs.getVideoTracks(), ...(as ? as.getAudioTracks() : [])]);
            const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
            const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: kbps * 1000, audioBitsPerSecond: 128000 }); const chunks = [];
            rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
            rec.onstop = () => { URL.revokeObjectURL(v.src); const t = (rec.mimeType || "video/webm").split(";")[0]; res(new File(chunks, "clip." + (/mp4/.test(t) ? "mp4" : "webm"), { type: t })); };
            const draw = () => { if (v.ended || v.paused) return; g.drawImage(v, 0, 0, W, H); if (onProg) onProg(Math.min(0.99, v.currentTime / dur)); requestAnimationFrame(draw); };
            v.onended = () => { try { rec.stop(); } catch (_) {} };
            rec.start(1000); await v.play(); draw();
          } catch (err) { rej(new Error("Couldn't shrink that video: " + (err.message || err))); }
        };
      });
    },
    async uploadVideo(file, onProg) {
      if (!this.me()) throw new Error("Sign in first.");
      try { file = await this.shrinkVideo(file, (f) => onProg && onProg(f * 0.5)); if (onProg) { const p0 = onProg; onProg = (f) => p0(0.5 + f * 0.5); } }
      catch (err) { throw new Error("That video couldn't be converted on this device, so it wasn't posted. " + (err.message || "")); }
      if (file.size > this.VIDEO_MAX) throw new Error("That video is still too big after converting. Post a shorter clip (under about 2 minutes).");
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const VTYPES = { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", mkv: "video/x-matroska" };
      let type = file.type || VTYPES[ext] || "video/mp4";
      if (!/^video\//.test(type)) throw new Error("Pick a video file (MP4, MOV or WebM).");
      return this.uploadMedia(file, { type, ext: VTYPES[ext] ? ext : "mp4", onProg });
    },
    async deleteMedia(path) {
      if (!path) return;
      try { await fetch("/api/cf/upload/media/" + path, { method: "DELETE", headers: gw.headers() }); } catch (_) {}
    },

    /* needMember, the live gate: signed in AND joined (a member doc) */
    needMember() {
      if (!this.me()) { say("Join free first — sign in from the main site, then pick a handle."); return false; }
      if (!this.myDoc) { say("Join free first. Pick a handle in Meechie's Book."); if (location.hash !== "#community") location.hash = "#community"; return false; }
      return true;
    },
    destroy() { bus.stop(); },
  };
  return S;
}
