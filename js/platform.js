/*
 * Meechie's World platform layer.
 * Gives the site the same small API it used while it lived on Claude
 * (claude.use("db" | "user" | "room" | "assets" | "sample")), backed by Supabase:
 *   db     -> table `docs` (path, coll, owner, data jsonb) + Realtime for live updates
 *   user   -> Supabase Auth (email + password)
 *   room   -> Supabase Realtime presence channels (live rooms, game, radio listeners)
 *   assets -> Supabase Storage bucket `assets` (radio tracks)
 *   sample -> AI assistant, off until an AI key is added (returns null so the page hides it)
 */
(function () {
  const cfg = window.MW_CONFIG || {};
  const ready = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const sb = ready ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 20 } }
  }) : null;
  window.MW = { sb, ready };

  let session = null, adminFlag = false;
  const sessionReady = (async () => {
    if (!sb) return;
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (session) {
      const r = await sb.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
      adminFlag = !!r.data;
    }
  })();
  if (sb) sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_IN" || evt === "SIGNED_OUT") setTimeout(() => location.reload(), 50); });

  const uid = () => session?.user?.id || null;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 20);
  const parentOf = (path) => path.split("/").slice(0, -1).join("/");
  const lastOf = (path) => path.split("/").pop();
  const fail = (error) => { const e = new Error(error?.message || "Something went wrong"); e.code = error?.code || "upstream_error"; return e; };

  /* ---------- snapshots ---------- */
  function docSnap(row, path) {
    return { id: row ? lastOf(row.path) : lastOf(path), exists: !!row, data: () => (row ? row.data : undefined), metadata: {} };
  }
  function querySnap(rows) {
    const docs = rows.map((r) => docSnap(r));
    return { docs, size: docs.length, empty: docs.length === 0, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: {} };
  }

  /* one realtime channel shared by every listener; each listener filters on its own path/collection */
  const listeners = new Set();
  let dbChannel = null;
  function ensureChannel() {
    if (dbChannel || !sb) return;
    dbChannel = sb.channel("mw-docs")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, (p) => {
        const row = p.new && p.new.path ? p.new : p.old;
        listeners.forEach((l) => { try { l(row || {}); } catch (_) {} });
      })
      .subscribe();
  }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  /* ---------- db ---------- */
  function query(coll, opts = {}) {
    const q = {
      orderBy: (field, dir = "asc") => query(coll, { ...opts, order: { field, dir } }),
      limit: (n) => query(coll, { ...opts, limit: n }),
      where: () => { throw fail({ message: "where() is not supported here", code: "invalid_argument" }); },
      async get() {
        let r = sb.from("docs").select("path,data").eq("coll", coll);
        if (opts.order) r = r.order("data->" + opts.order.field, { ascending: opts.order.dir !== "desc", nullsFirst: false });
        else r = r.order("created_at", { ascending: true });
        r = r.limit(opts.limit || 100);
        const { data, error } = await r;
        if (error) throw fail(error);
        return querySnap(data || []);
      },
      onSnapshot(next, onErr) {
        let alive = true;
        const run = () => q.get().then((s) => alive && next(s)).catch((e) => alive && onErr && onErr(e));
        const later = debounce(run, 120);
        const l = (row) => { if (row.coll === coll || (row.path && parentOf(row.path) === coll) || !row.path) later(); };
        ensureChannel(); listeners.add(l); run();
        return () => { alive = false; listeners.delete(l); };
      },
      doc: (id) => docRef(coll + "/" + (id || newId())),
      async add(data) {
        if (!uid()) throw fail({ message: "Sign in first.", code: "not_granted" });
        const path = coll + "/" + newId();
        const { error } = await sb.from("docs").insert({ path, coll, owner: uid(), data });
        if (error) throw fail(error);
        return docRef(path);
      }
    };
    return q;
  }
  function docRef(path) {
    const coll = parentOf(path);
    const ref = {
      id: lastOf(path), path,
      async get() {
        const { data, error } = await sb.from("docs").select("path,data").eq("path", path).maybeSingle();
        if (error) throw fail(error);
        return docSnap(data, path);
      },
      async set(data) {
        if (!uid()) throw fail({ message: "Sign in first.", code: "not_granted" });
        const { error } = await sb.rpc("set_doc", { p_path: path, p_coll: coll, p_data: data });
        if (error) throw fail(error);
      },
      async update(patch) {
        if (!uid()) throw fail({ message: "Sign in first.", code: "not_granted" });
        const { error } = await sb.rpc("merge_doc", { p_path: path, p_patch: patch });
        if (error) throw fail(error);
      },
      async delete() {
        const { error } = await sb.from("docs").delete().eq("path", path);
        if (error) throw fail(error);
      },
      onSnapshot(next, onErr) {
        let alive = true;
        const run = () => ref.get().then((s) => alive && next(s)).catch((e) => alive && onErr && onErr(e));
        const later = debounce(run, 80);
        const l = (row) => { if (!row.path || row.path === path) later(); };
        ensureChannel(); listeners.add(l); run();
        return () => { alive = false; listeners.delete(l); };
      },
      collection: (sub) => query(path + "/" + sub)
    };
    return ref;
  }
  const db = { collection: (p) => query(p), doc: (p) => docRef(p) };

  /* ---------- user ---------- */
  const user = {
    isOwner: () => adminFlag, canEdit: () => adminFlag, can: () => !!uid(),
    id: async () => uid(),
    me: async () => ({ id: uid(), name: session?.user?.email?.split("@")[0] || "" }),
    profiles: async (ids) => Object.fromEntries((ids || []).map((i) => [i, { id: i, name: "" }]))
  };

  /* ---------- rooms (presence) ---------- */
  const tabId = newId();
  function makeRoom(name) {
    const ch = sb.channel("room:" + name, { config: { presence: { key: tabId } } });
    let mine = {}, peers = Object.freeze([]), handlers = [], subscribed = false, pending = false, last = 0, timer = null;
    const toPeers = () => {
      const st = ch.presenceState(); const out = [];
      for (const key in st) {
        const m = st[key][st[key].length - 1] || {};
        out.push(Object.freeze({ peer: key, by: m.uid || null, isMe: m.uid && m.uid === uid(), sameTab: key === tabId, kind: "viewer", guest: false, presence: Object.freeze(key === tabId ? { ...mine } : (m.p || {})), updatedAt: Date.now() }));
      }
      return Object.freeze(out);
    };
    const emitPeers = () => { const prev = peers; peers = toPeers(); const pk = new Set(prev.map((p) => p.peer)), nk = new Set(peers.map((p) => p.peer));
      const change = { peers, joined: peers.filter((p) => !pk.has(p.peer)), left: prev.filter((p) => !nk.has(p.peer)), updated: peers.filter((p) => pk.has(p.peer)) };
      handlers.forEach((h) => { try { h(change); } catch (_) {} }); };
    const flush = () => { timer = null; if (!subscribed) { pending = true; return; } last = Date.now(); ch.track({ uid: uid(), p: mine }).catch(() => {}); };
    ch.on("presence", { event: "sync" }, emitPeers)
      .subscribe((status) => { if (status === "SUBSCRIBED") { subscribed = true; flush(); } });
    return {
      presence(patch) {
        for (const k in patch) { if (patch[k] === null) delete mine[k]; else mine[k] = patch[k]; }
        const wait = Math.max(0, 90 - (Date.now() - last));
        if (!timer) timer = setTimeout(flush, wait);
        emitPeers();
        return Promise.resolve();
      },
      onPeers(h) { handlers.push(h); setTimeout(emitPeers, 0); return () => { handlers = handlers.filter((x) => x !== h); }; },
      peers: () => peers,
      emit(topic, data) { return ch.send({ type: "broadcast", event: topic, payload: data }); },
      on(topic, fn) { ch.on("broadcast", { event: topic }, (m) => fn({ data: m.payload })); return () => {}; },
      leave() { ch.untrack().catch(() => {}); sb.removeChannel(ch); handlers = []; }
    };
  }
  let lobby = null;
  function roomApi() {
    if (!lobby) { const base = makeRoom("lobby"); lobby = { ...base, join: (n) => makeRoom(n) }; }
    return lobby;
  }

  /* ---------- assets (radio tracks) ---------- */
  const assets = {
    async upload(blob, opts = {}) {
      const id = newId(); const type = opts.type || blob.type || "application/octet-stream";
      const { error } = await sb.storage.from("assets").upload(id, blob, { contentType: type, upsert: false });
      if (error) throw fail(error);
      return { id, url: assetUrl(id), sizeBytes: blob.size, contentType: type };
    },
    async delete(id) { await sb.storage.from("assets").remove([id]); },
    async list() { return { assets: [], usage: {} }; }
  };
  function assetUrl(id) { return sb ? sb.storage.from("assets").getPublicUrl(id).data.publicUrl : ""; }
  window.MW.assetUrl = assetUrl;

  /* ---------- the claude.use() shim ---------- */
  window.claude = {
    async use(name) {
      if (!sb) return null;
      await sessionReady;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "room") return uid() ? roomApi() : null;
      if (name === "assets") return adminFlag ? assets : null;
      return null; // sample (AI) and anything else: not enabled yet
    }
  };

  /* ---------- auth helpers for the sign-in dialog ---------- */
  window.MW.signUp = (email, password) => sb.auth.signUp({ email, password });
  window.MW.signIn = (email, password) => sb.auth.signInWithPassword({ email, password });
  window.MW.signOut = () => sb.auth.signOut();
  window.MW.reset = (email) => sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  window.MW.session = () => session;
  window.MW.sessionReady = sessionReady;
})();
