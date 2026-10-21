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
  let seq = 0, polling = false, pollTimer = null;
  async function poll() {
    pollTimer = null;
    if (!watchers.size) { polling = false; return; }
    if (!document.hidden) {
      try {
        const r = await fetch(API + "changes?since=" + seq, { headers: headers(), cache: "no-store" });
        const j = await r.json();
        if (seq && Array.isArray(j.rows) && j.rows.length) {
          for (const row of j.rows) watchers.forEach((w) => { if (w.table === row.tbl) { try { w.cb(row.tbl === "docs" ? { new: { path: row.path, coll: row.coll } } : { new: {} }); } catch (_) {} } });
        }
        if (typeof j.seq === "number") seq = j.seq;
      } catch (_) {}
    }
    pollTimer = setTimeout(poll, document.hidden ? 30000 : 6000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && polling && pollTimer) { clearTimeout(pollTimer); poll(); } });
  function startPolling() { if (polling) return; polling = true; poll(); }

  // Live rooms, presence and typing: use Supabase's live channels if they work; otherwise quietly do nothing.
  let rt = null;
  function realtime() {
    if (rt !== null) return rt;
    try { rt = window.supabase && cfg.SUPABASE_URL ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : false; } catch (_) { rt = false; }
    return rt;
  }
  function channel(name, opts) {
    const tableWatch = [];
    let inner = null; const r = realtime();
    try { if (r) inner = r.channel(name, opts); } catch (_) { inner = null; }
    const ch = {
      on(type, filter, cb) {
        if (type === "postgres_changes") { tableWatch.push({ table: filter && filter.table, cb }); return ch; }
        if (inner) try { inner.on(type, filter, cb); } catch (_) {}
        return ch;
      },
      subscribe(cb) {
        tableWatch.forEach((w) => watchers.add(w)); if (tableWatch.length) startPolling();
        if (inner) { try { inner.subscribe(cb); } catch (_) { cb && cb("SUBSCRIBED"); } } else if (cb) setTimeout(() => cb("SUBSCRIBED"), 0);
        return ch;
      },
      presenceState: () => { try { return inner ? inner.presenceState() : {}; } catch (_) { return {}; } },
      track: (p) => (inner ? inner.track(p).catch(() => {}) : Promise.resolve()),
      untrack: () => (inner ? inner.untrack().catch(() => {}) : Promise.resolve()),
      send: (m) => (inner ? inner.send(m).catch(() => {}) : Promise.resolve()),
      _unwatch() { tableWatch.forEach((w) => watchers.delete(w)); try { if (inner && r) r.removeChannel(inner); } catch (_) {} },
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
