/* Meechie's World's own free backend (Cloudflare), shaped like the parts of the Supabase client the site uses,
 * so every page (feed, Messenger, profiles, books, radio…) keeps working unchanged.
 * Turned on by MW_CONFIG.BACKEND = "cf". Live rooms/typing still use Supabase's live channels when they're reachable. */
(function () {
  "use strict";
  const cfg = window.MW_CONFIG || {};
  if (cfg.BACKEND !== "cf") return;
  const API = "/api/cf/";
  const KEY = "mw-cf-session";
  let session = null; try { session = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) {}
  const authCbs = new Set();
  const save = (s) => { session = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (_) {} };
  const emit = (evt) => authCbs.forEach((cb) => { try { cb(evt, session); } catch (_) {} });
  const headers = (extra) => ({ "content-type": "application/json", ...(session ? { authorization: "Bearer " + session.access_token } : {}), ...(extra || {}) });
  async function call(path, body, method) {
    try {
      const r = await fetch(API + path, { method: method || (body === undefined ? "GET" : "POST"), headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
      const j = await r.json().catch(() => ({ error: { message: "Server error (" + r.status + ")" } }));
      if (r.status === 401 && session && /not_signed_in/.test((j.error && j.error.code) || "") && path !== "auth/signout") { save(null); emit("SIGNED_OUT"); }
      if (!r.ok && !j.error) j.error = { message: "Server error (" + r.status + ")", code: String(r.status) };
      return j;
    } catch (e) { return { data: null, error: { message: "Network problem. Check your connection and try again.", code: "network" } }; }
  }

  /* ---------- tables: sb.from("docs").select(...).eq(...).order(...).limit(...) ---------- */
  function from(table) {
    const q = { table, op: "select", select: "*", filters: [], order: null, limit: null, values: null, count: false, head: false, single: false, maybe: false };
    const b = {
      select(cols, opts) { if (q.op === "select") { q.select = cols || "*"; if (opts && opts.count) q.count = true; if (opts && opts.head) q.head = true; } return b; },
      insert(values) { q.op = "insert"; q.values = values; return b; },
      update(values) { q.op = "update"; q.values = values; return b; },
      delete() { q.op = "delete"; return b; },
      eq(col, val) { q.filters.push([col, "eq", val]); return b; },
      is(col, val) { q.filters.push([col, "is", val]); return b; },
      order(col, opts) { q.order = { col, asc: !(opts && opts.ascending === false) }; return b; },
      limit(n) { q.limit = n; return b; },
      maybeSingle() { q.maybe = true; return b; },
      single() { q.single = true; return b; },
      then(ok, bad) {
        return call("rest", q).then((j) => {
          let data = j.data == null ? null : j.data;
          if ((q.maybe || q.single) && Array.isArray(data)) data = data[0] || null;
          return { data, error: j.error || null, count: j.count == null ? null : j.count, status: j.error ? 400 : 200 };
        }).then(ok, bad);
      },
    };
    return b;
  }

  /* ---------- live refresh: one light check every few seconds while the page is open ---------- */
  const watchers = new Set();
  let seq = null, polling = false, pollTimer = null;
  async function poll() {
    pollTimer = null;
    if (!watchers.size && !roomsOpen.size) { polling = false; return; }
    const hot = [...roomsOpen.values()].some((c) => c.hot());
    if (!document.hidden || hot) {
      try {
        const rbody = roomsBody();
        const r = rbody
          ? await fetch(API + "changes", { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ since: seq === null ? "" : seq, rooms: rbody }), cache: "no-store" })
          : await fetch(API + "changes" + (seq === null ? "" : "?since=" + seq), { headers: headers(), cache: "no-store" });
        const j = await r.json();
        if (j.rooms) roomsIn(j.rooms);
        if (seq !== null && Array.isArray(j.rows) && j.rows.length) {
          for (const row of j.rows) watchers.forEach((w) => { if (w.table === row.tbl) { try { w.cb(row.tbl === "docs" ? { new: { path: row.path, coll: row.coll } } : { new: {} }); } catch (_) {} } });
        }
        // first check: remember where we are, and refresh once in case something changed while the page was starting
        if (seq === null && typeof j.seq === "number") { seq = j.seq; watchers.forEach((w) => { try { w.cb({ new: {} }); } catch (_) {} }); }
        else if (typeof j.seq === "number" && j.seq > seq) seq = j.seq;
      } catch (_) {}
    }
    // every 6 s normally; every 1.5 s while you're in a Live/battle/game room (so video connects fast); slow when hidden
    const fast = [...roomsOpen.values()].some((c) => c.hot());
    pollTimer = setTimeout(poll, fast ? 1500 : document.hidden ? 30000 : 6000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && polling && pollTimer) { clearTimeout(pollTimer); poll(); } });
  function startPolling() { if (polling) return; polling = true; poll(); }
  const kick = () => { if (!polling) return startPolling(); if (pollTimer) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 120); } };

  /* ---------- live rooms (free, on our own Cloudflare database) ----------
   * Same shape as Supabase realtime channels: presence (track/untrack/presenceState + "sync" events) and broadcast
   * (send/on). Everything rides along with the regular check above. */
  const roomsOpen = new Map(); // name -> room
  function roomsBody() {
    if (!roomsOpen.size) return null; const b = {};
    for (const [name, c] of roomsOpen) b[name] = c.out();
    return b;
  }
  function roomsIn(all) { for (const [name, data] of Object.entries(all)) { const c = roomsOpen.get(name); if (c) c.in(data); } }
  function cfRoom(name, opts) {
    const key = (opts && opts.config && opts.config.presence && opts.config.presence.key) || ("p" + Math.random().toString(36).slice(2, 12));
    const peer = String(key).replace(/[^\w-]/g, "").slice(0, 60).padEnd(4, "x");
    const handlers = { presence: [], broadcast: {} };
    let mine = undefined, dirty = false, lastSent = 0, since = 0, gotFirst = false, state = {}, outbox = [], left = false, subscribed = false;
    const room = {
      hot: () => subscribed && name !== "room:lobby" && Object.keys(handlers.broadcast).length > 0,
      out() {
        if (left) { roomsOpen.delete(name); return { peer, leave: true }; }
        const o = { peer, since };
        if (mine !== undefined && (dirty || Date.now() - lastSent > 25000)) { o.p = mine; dirty = false; lastSent = Date.now(); }
        if (outbox.length) { o.send = outbox.splice(0, 30); }
        return o;
      },
      in(d) {
        // who's here
        const next = {}; (d.peers || []).forEach((x) => { next[x.peer] = [x.p || {}]; });
        const changed = JSON.stringify(next) !== JSON.stringify(state); state = next;
        if (changed || !gotFirst) handlers.presence.forEach((h) => { try { h({}); } catch (_) {} });
        // messages since last time (skip our own, and anything from before we joined)
        if (!gotFirst) { since = d.last || 0; gotFirst = true; return; }
        for (const m of d.msgs || []) { since = Math.max(since, m.id); if (m.peer === peer) continue; (handlers.broadcast[m.ev] || []).forEach((fn) => { try { fn({ event: m.ev, payload: m.payload }); } catch (_) {} }); }
        if (d.last > since && !(d.msgs || []).length) since = d.last;
      },
    };
    const ch = {
      on(type, filter, cb) {
        if (type === "presence") handlers.presence.push(cb);
        else if (type === "broadcast") { const ev = (filter && filter.event) || "*"; (handlers.broadcast[ev] = handlers.broadcast[ev] || []).push(cb); }
        return ch;
      },
      subscribe(cb) { subscribed = true; roomsOpen.set(name, room); kick(); if (cb) setTimeout(() => cb("SUBSCRIBED"), 0); return ch; },
      presenceState: () => state,
      track(p) { mine = p; dirty = true; kick(); return Promise.resolve("ok"); },
      untrack() { mine = undefined; left = true; kick(); return Promise.resolve("ok"); },
      send(m) { if (m && m.type === "broadcast" && m.event) { outbox.push({ ev: m.event, payload: m.payload }); kick(); } return Promise.resolve("ok"); },
      _unwatch() { left = true; kick(); },
    };
    return ch;
  }

  // table changes come from the regular check; presence and broadcast use our own free live rooms (cfRoom)
  function channel(name, opts) {
    const tableWatch = []; let inner = null; const getInner = () => (inner = inner || cfRoom(name, opts));
    const ch = {
      on(type, filter, cb) {
        if (type === "postgres_changes") { tableWatch.push({ table: filter && filter.table, cb }); return ch; }
        getInner().on(type, filter, cb); return ch;
      },
      subscribe(cb) {
        tableWatch.forEach((w) => watchers.add(w)); if (tableWatch.length) startPolling();
        if (inner) inner.subscribe(cb); else if (cb) setTimeout(() => cb("SUBSCRIBED"), 0);
        return ch;
      },
      presenceState: () => (inner ? inner.presenceState() : {}),
      track: (p) => getInner().track(p),
      untrack: () => (inner ? inner.untrack() : Promise.resolve()),
      send: (m) => getInner().send(m),
      _unwatch() { tableWatch.forEach((w) => watchers.delete(w)); if (inner) inner._unwatch(); },
    };
    return ch;
  }

  /* ---------- files ---------- */
  const storage = {
    from(bucket) {
      return {
        async upload(path, blob, opts) {
          if (!session) return { data: null, error: { message: "Sign in first." } };
          try {
            const r = await fetch(API + "upload/" + bucket + "/" + path, { method: "POST", headers: { authorization: "Bearer " + session.access_token, "content-type": (opts && opts.contentType) || blob.type || "application/octet-stream" }, body: blob });
            const j = await r.json().catch(() => ({}));
            return r.ok ? { data: { path }, error: null } : { data: null, error: j.error || { message: "Upload failed (" + r.status + ")" } };
          } catch (_) { return { data: null, error: { message: "Network problem." } }; }
        },
        async remove(paths) { for (const p of paths || []) await fetch(API + "upload/" + bucket + "/" + p, { method: "DELETE", headers: headers() }).catch(() => {}); return { data: null, error: null }; },
        getPublicUrl(path) { return { data: { publicUrl: location.origin + "/m/" + bucket + "/" + path } }; },
      };
    },
  };

  /* ---------- accounts ---------- */
  const ok = (j) => ({ data: j.data || {}, error: j.error || null });
  const auth = {
    async getSession() { return { data: { session }, error: null }; },
    async refreshSession() {
      if (!session) return { data: { session: null }, error: null };
      const j = await call("auth/session");
      if (j.data && j.data.session) { save(j.data.session); window.MW_CF_ADMIN = !!j.admin; }
      return { data: { session }, error: j.error || null };
    },
    async getUser() { const j = await call("auth/user"); return { data: { user: j.data ? j.data.user : null }, error: j.error || null }; },
    onAuthStateChange(cb) { authCbs.add(cb); setTimeout(() => cb(session ? "INITIAL_SESSION" : "INITIAL_SESSION", session), 0); return { data: { subscription: { unsubscribe: () => authCbs.delete(cb) } } }; },
    async signUp({ email, password, options }) {
      const j = await call("auth/signup", { email, password, data: options && options.data });
      if (j.data && j.data.session) { save(j.data.session); emit("SIGNED_IN"); }
      return ok(j);
    },
    async signInWithPassword({ email, password }) {
      const j = await call("auth/signin", { email, password });
      if (j.data && j.data.session) { save(j.data.session); emit("SIGNED_IN"); }
      return ok(j);
    },
    async signInWithIdToken({ token }) {
      const j = await call("auth/google", { credential: token });
      if (j.data && j.data.session) { save(j.data.session); emit("SIGNED_IN"); }
      return ok(j);
    },
    async signInWithOAuth({ provider }) {
      if (provider === "google" && window.MW_googleSignIn) { window.MW_googleSignIn(); return { data: {}, error: null }; }
      return { data: null, error: { message: "That sign-in isn't available yet. Use email or Google." } };
    },
    async signOut() { await call("auth/signout", {}); save(null); emit("SIGNED_OUT"); return { error: null }; },
    async updateUser(attrs) {
      const j = await call("auth/user", attrs || {});
      if (j.data && j.data.user && session) { session.user = j.data.user; save(session); emit("USER_UPDATED"); }
      return ok(j);
    },
    async resetPasswordForEmail() { return { data: null, error: { message: "Forgot your password? Tap “Continue with Google” with the same email, then set a new password in your profile. Or message Meechie for help." } }; },
  };

  // check the saved sign-in is still good (and whether it's an admin) once per load
  const checked = session ? auth.refreshSession() : Promise.resolve();

  window.MW_CF = {
    createClient() {
      return { auth, from, storage, channel, removeChannel(ch) { try { ch && ch._unwatch && ch._unwatch(); } catch (_) {} }, rpc: (name, args) => call("rpc", { name, args }).then((j) => ({ data: j.data == null ? null : j.data, error: j.error || null })) };
    },
    session: () => session, checked, api: API,
  };
})();
