/* ============================================================================
   v2 PLATFORM FACADE (Phase 5) — the doc-store shape the live site's
   feature files think in (collection/doc, get/set/update/add, watch),
   implemented over the shell's ONE gateway (MAP §4.4): rest reads and
   inserts, set_doc / merge_doc rpc writes, and a changes-feed watch
   in the cf-client pattern (prime on max seq, then stream rows; a
   change in a watched collection re-lists it). The social layer
   (social.js) is the Book family's door; this facade serves the
   commerce/rest-of-house views so they never grow a second data
   path either. Rooms ride the same changes call, as in social.js.
   ============================================================================ */

export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 20);
export const lastOf = (path) => String(path || "").split("/").pop();
export const parentOf = (path) => String(path || "").split("/").slice(0, -1).join("/");

export function createDb(ctx) {
  const gw = ctx.gateway, session = ctx.session;
  const me = () => { const u = session.user(); return u ? u.id : null; };

  /* ---- changes-feed watch (prime + poll, cf-client pattern) ---- */
  const watchers = new Set();
  let seq = null, timer = null, stopped = false;
  const rooms = new Map();
  function kick(ms) { if (stopped) return; clearTimeout(timer); timer = setTimeout(poll, ms == null ? 40 : ms); }
  async function poll() {
    if (stopped) return;
    try {
      let body;
      if (rooms.size) { const rb = {}; for (const [n, r] of rooms) rb[n] = r.out(); body = { since: seq === null ? "" : seq, rooms: rb }; }
      const j = body ? await gw.call("changes", body) : await gw.call("changes" + (seq === null ? "" : "?since=" + seq));
      if (stopped) return;
      if (j && j.rooms) for (const [n, d] of Object.entries(j.rooms)) { const r = rooms.get(n); if (r) r.in(d); }
      if (j && seq !== null && Array.isArray(j.rows)) {
        const hit = new Set();
        for (const row of j.rows) if (row && row.tbl === "docs" && row.coll) hit.add(row.coll);
        if (hit.size) watchers.forEach((w) => { if (hit.has(w.coll)) { try { w.cb(); } catch (_) {} } });
      }
      if (j && typeof j.seq === "number") {
        if (seq === null) { seq = j.seq; watchers.forEach((w) => { try { w.cb(); } catch (_) {} }); }
        else if (j.seq > seq) seq = j.seq;
      }
    } catch (_) {}
    if (!stopped) timer = setTimeout(poll, document.hidden ? 20000 : 6000);
  }
  kick(60);

  /* ---- a room over the changes feed (cfRoom semantics, as social.js) ---- */
  function room(name) {
    let r = rooms.get(name);
    if (r) return r;
    r = {
      peer: ("p" + Math.random().toString(36).slice(2, 12)).replace(/[^\w-]/g, "").slice(0, 60).padEnd(4, "x"),
      mine: undefined, dirty: false, lastSent: 0, since: 0, gotFirst: false, state: {}, outbox: [], left: false,
      pHandlers: [], bHandlers: {},
      out() {
        if (this.left) { rooms.delete(name); return { peer: this.peer, leave: true }; }
        const o = { peer: this.peer, since: this.since };
        if (this.mine !== undefined && (this.dirty || Date.now() - this.lastSent > 25000)) { o.p = this.mine; this.dirty = false; this.lastSent = Date.now(); }
        if (this.outbox.length) o.send = this.outbox.splice(0, 30);
        return o;
      },
      in(d) {
        const next = {}; (d.peers || []).forEach((x) => { next[x.peer] = [x.p || {}]; });
        const changed = JSON.stringify(next) !== JSON.stringify(this.state); this.state = next;
        if (changed || !this.gotFirst) this.pHandlers.forEach((h) => { try { h({}); } catch (_) {} });
        if (!this.gotFirst) { this.since = d.last || 0; this.gotFirst = true; return; }
        for (const m of d.msgs || []) { this.since = Math.max(this.since, m.id); if (m.peer === this.peer) continue; (this.bHandlers[m.ev] || []).forEach((fn) => { try { fn({ event: m.ev, payload: m.payload }); } catch (_) {} }); }
        if (d.last > this.since && !(d.msgs || []).length) this.since = d.last;
      },
      peers(meId) { const out = []; for (const key in this.state) { const m = this.state[key][this.state[key].length - 1] || {}; out.push({ peer: key, by: m.uid || null, isMe: !!m.uid && m.uid === meId, presence: m.p || {} }); } return out; },
      track(p) { this.mine = p; this.dirty = true; kick(60); },
      send(ev, payload) { this.outbox.push({ ev, payload }); kick(60); },
      onPresence(cb) { this.pHandlers.push(cb); },
      onBroadcast(ev, cb) { (this.bHandlers[ev] = this.bHandlers[ev] || []).push(cb); },
      leave() { if (this.left) return; this.left = true; kick(30); },
    };
    rooms.set(name, r);
    kick(30);
    return r;
  }

  return {
    me,
    user: () => session.user(),
    isOwner: () => me() === OWNER_ID,
    room,
    async getDoc(path) { return gw.readDoc(path); },
    async setDoc(path, data) {
      const { error } = await gw.call("rpc", { name: "set_doc", args: { p_path: path, p_coll: parentOf(path), p_data: data } });
      if (error) throw new Error(error.message || "Could not save.");
    },
    async mergeDoc(path, patch) {
      const { error } = await gw.call("rpc", { name: "merge_doc", args: { p_path: path, p_patch: patch } });
      if (error) throw new Error(error.message || "Could not save.");
    },
    async addDoc(coll, data) {
      const id = me(); if (!id) throw new Error("Sign in first.");
      const path = coll + "/" + newId();
      const { error } = await gw.call("rest", { table: "docs", op: "insert", values: { path, coll, owner: id, data } });
      if (error) throw new Error(error.message || "Could not save.");
      return lastOf(path);
    },
    async delDoc(path) {
      const { error } = await gw.call("rest", { table: "docs", op: "delete", filters: [["path", "eq", path]] });
      if (error) throw new Error(error.message || "Could not delete.");
    },
    async listDocs(coll, opts = {}) {
      const { data, error } = await gw.rest({
        table: "docs", select: "path,data", filters: [["coll", "eq", coll]],
        order: { col: "data->" + (opts.field || "createdAt"), asc: opts.asc === true },
        limit: opts.limit || 100,
      });
      if (error || !data) return [];
      return data.filter((r) => r && r.data && typeof r.data === "object").map((r) => ({ id: lastOf(r.path), ...r.data }));
    },
    /* media uploads, the gateway door (same endpoint + shape the
       social layer uses: POST /api/cf/upload/media/<uid>/<id>.<ext>,
       served back at /m/media/<path>); library assets read at
       /m/assets/<id> (the station's own asset route) */
    assetUrl(id) { return location.origin + "/m/assets/" + id; },
    uploadMedia(blob, opts = {}) {
      const id = me(); if (!id) return Promise.reject(new Error("Sign in first."));
      const type = opts.type || blob.type || "application/octet-stream";
      const ext = opts.ext || "bin";
      const path = id + "/" + newId() + "." + ext;
      return new Promise((res, rej) => {
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
    /* cb fires once primed and again whenever the changes feed shows
       a write in this collection (the onSnapshot stand-in) */
    watchDocs(coll, cb) { const w = { coll, cb }; watchers.add(w); kick(30); return () => watchers.delete(w); },
    stop() { stopped = true; clearTimeout(timer); rooms.forEach((r) => r.leave()); },
  };
}

/* ============================================================================
   firestore(ctx) — the Firestore-shaped facade the live feature files
   were written against (db.collection(...).orderBy().limit()
   .onSnapshot(), db.doc(path).set/update/get/delete), implemented
   over the same gateway through createDb. Snapshots re-list on
   changes-feed hits, the way the live compat layer behaves.
   ============================================================================ */
export function firestore(ctx) {
  const base = createDb(ctx);
  const snapOf = (rows) => ({
    empty: !rows.length, size: rows.length,
    docs: rows.map((r) => ({ id: r.id, data: () => { const { id, ...d } = r; return d; } })),
    forEach(fn) { this.docs.forEach(fn); },
  });
  const applyQ = (rows, q) => {
    let out = rows.slice();
    for (const [f, op, v] of q.wheres) out = out.filter((r) => op === "==" ? r[f] === v : op === "!=" ? r[f] !== v : op === ">" ? r[f] > v : op === "<" ? r[f] < v : op === ">=" ? r[f] >= v : op === "<=" ? r[f] <= v : true);
    if (q.order) out.sort((a, b) => { const d = (a[q.order[0]] || 0) < (b[q.order[0]] || 0) ? -1 : (a[q.order[0]] || 0) > (b[q.order[0]] || 0) ? 1 : 0; return q.order[1] === "desc" ? -d : d; });
    if (q.lim) out = out.slice(0, q.lim);
    return out;
  };
  const query = (coll, q) => ({
    where: (f, op, v) => query(coll, { ...q, wheres: [...q.wheres, [f, op, v]] }),
    orderBy: (f, dir) => query(coll, { ...q, order: [f, dir || "asc"] }),
    limit: (n) => query(coll, { ...q, lim: n }),
    async get() { return snapOf(applyQ(await base.listDocs(coll, { limit: 500 }), q)); },
    onSnapshot(cb, err) {
      let dead = false;
      const run = async () => { if (dead) return; try { cb(await this.get()); } catch (e) { if (err) err(e); } };
      run();
      const un = base.watchDocs(coll, run);
      return () => { dead = true; un(); };
    },
  });
  const docRef = (path) => ({
    id: lastOf(path),
    async get() { const d = await base.getDoc(path); return { exists: d != null, id: lastOf(path), data: () => d || undefined }; },
    set: (data) => base.setDoc(path, data),
    update: (patch) => base.mergeDoc(path, patch),
    delete: () => base.delDoc(path),
    collection: (sub) => query(path + "__" + sub, { wheres: [] }),
    onSnapshot(cb) {
      let dead = false;
      const run = async () => { if (dead) return; try { cb(await this.get()); } catch (_) {} };
      run();
      const un = base.watchDocs(parentOf(path), run);
      return () => { dead = true; un(); };
    },
  });
  return {
    base,
    collection: (name) => ({
      ...query(name, { wheres: [] }),
      add: async (data) => ({ id: await base.addDoc(name, data) }),
      doc: (id) => docRef(name + "/" + id),
    }),
    doc: docRef,
  };
}

/* videoSound(engine) — the view-video courtesy (live MW_videoSound):
   while a view's video plays with its own sound, the station steps
   aside on THIS seat, and comes back 1.5s after the video stops.
   v2's seat sound switch is the engine's listening flag: capture
   the prior state, mute, restore. If the visitor was not listening,
   both calls are no-ops. */
export function videoSound(engine) {
  let back = null, t = 0;
  return {
    start() { clearTimeout(t); if (back === null) back = engine.listening; if (back) engine.setListening(false); },
    end() { clearTimeout(t); t = setTimeout(() => { const b = back; back = null; if (b) engine.setListening(true); }, 1500); },
    holding: () => back !== null,
  };
}

/* socUrl(k, v) — the live profile-setup.js link builder, verbatim
   rules: a full https link passes through; LINK_ONLY apps need one;
   WhatsApp becomes a wa.me number; bare names get the app's base.
   Used by Connect, the profile page and Edit profile alike. */
const SOC_BASE = { facebook: "https://facebook.com/", snapchat: "https://snapchat.com/add/", instagram: "https://instagram.com/", tiktok: "https://tiktok.com/@", youtube: "https://youtube.com/@", x: "https://x.com/", whatsapp: "https://wa.me/", cashapp: "https://cash.app/$", threads: "https://threads.net/@", linkedin: "https://linkedin.com/in/", soundcloud: "https://soundcloud.com/", twitch: "https://twitch.tv/", kick: "https://kick.com/", telegram: "https://t.me/", pinterest: "https://pinterest.com/", reddit: "https://reddit.com/user/", venmo: "https://venmo.com/u/", paypal: "https://paypal.me/", linktree: "https://linktr.ee/", patreon: "https://patreon.com/", bluesky: "https://bsky.app/profile/", tumblr: "https://tumblr.com/", vimeo: "https://vimeo.com/", rumble: "https://rumble.com/c/", lemon8: "https://www.lemon8-app.com/@", triller: "https://triller.co/@", audiomack: "https://audiomack.com/", bandcamp: "https://{v}.bandcamp.com", substack: "https://{v}.substack.com", medium: "https://medium.com/@", etsy: "https://etsy.com/shop/", depop: "https://depop.com/", poshmark: "https://poshmark.com/closet/", truthsocial: "https://truthsocial.com/@", clubhouse: "https://clubhouse.com/@", bereal: "https://bere.al/", messenger: "https://m.me/" };
const SOC_LINK_ONLY = new Set(["spotify", "applemusic", "discord", "other", "mastodon", "signal", "tidal", "amazonmusic", "onlinestore"]);
export function socUrl(k, v) {
  v = String(v || "").trim(); if (!v) return "";
  if (/^https:\/\//i.test(v)) { try { const u = new URL(v); return u.protocol === "https:" ? u.href : ""; } catch (_) { return ""; } }
  if (SOC_LINK_ONLY.has(k)) return "";
  if (k === "whatsapp") { const d = v.replace(/\D/g, ""); return d.length >= 10 ? SOC_BASE.whatsapp + (d.length === 10 ? "1" + d : d) : ""; }
  const base = SOC_BASE[k]; if (!base) return "";
  v = v.replace(/^(https?:\/\/)?(www\.)?[a-z.]*\.(com|me|app)\/(add\/|@)?/i, "").replace(/^[@$]/, "").replace(/[^\w.\-]/g, "");
  return v ? (base.includes("{v}") ? base.replace("{v}", v) : base + v) : "";
}
