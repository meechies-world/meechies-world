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
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
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
  // Reload only when the signed-in person actually changes (sign in / sign out),
  // never on the session-restored or token-refresh events that fire on every load.
  if (sb) sb.auth.onAuthStateChange((evt, s) => {
    const next = s?.user?.id || null;
    sessionReady.then(() => {
      const cur = session?.user?.id || null;
      if (evt !== "PASSWORD_RECOVERY" && next !== cur && (evt === "SIGNED_IN" || evt === "SIGNED_OUT")) setTimeout(() => location.reload(), 50);
      else if (s && next === cur) session = s; // keep the fresh token after auto-refresh
      if (evt === "PASSWORD_RECOVERY") { session = s; window.MW.recovery = true; if (typeof window.MW.onRecovery === "function") window.MW.onRecovery(); }
    });
  });

  const uid = () => session?.user?.id || null;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 20);
  const parentOf = (path) => path.split("/").slice(0, -1).join("/");
  const lastOf = (path) => path.split("/").pop();
  const fail = (error) => { const e = new Error(error?.message || "Something went wrong"); e.code = error?.code || "upstream_error"; return e; };

  /* ---------- snapshots ---------- */
  function docSnap(row, path) {
    return { id: row ? lastOf(row.path) : lastOf(path), exists: !!row, data: () => (row ? row.data : undefined), metadata: {} };
  }
  // Drop rows whose id or author fields aren't plain ids, so nothing user-made can sneak HTML into the page.
  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const ID_KEYS = ["authorId", "from", "to", "uid", "by"];
  const cleanRow = (r) => r && SAFE_ID.test(lastOf(r.path || "")) && r.data && typeof r.data === "object" && ID_KEYS.every((k) => r.data[k] == null || (typeof r.data[k] === "string" && SAFE_ID.test(r.data[k])));
  function querySnap(rows) {
    const docs = rows.filter(cleanRow).map((r) => docSnap(r));
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

  /* ---------- member videos (bucket "media", each member's own folder) ---------- */
  const VTYPES = { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", mkv: "video/x-matroska" };
  window.MW.VIDEO_MAX = 50 * 1024 * 1024;
  /* Big phone videos (over 50 MB) get shrunk to 720p in the browser before uploading, so any clip can be posted. */
  window.MW.shrinkVideo = (file, onProg) => new Promise((res, rej) => {
    const v = document.createElement("video"); v.muted = false; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
    v.onerror = () => rej(new Error("This phone can't read that video. Try a shorter clip."));
    v.onloadedmetadata = async () => {
      try {
        const dur = v.duration || 60, scale = Math.min(1, 720 / Math.min(v.videoWidth || 720, v.videoHeight || 720));
        const W = Math.round((v.videoWidth || 720) * scale / 2) * 2, H = Math.round((v.videoHeight || 1280) * scale / 2) * 2;
        const kbps = Math.max(600, Math.min(2500, Math.floor((40 * 8 * 1024) / dur))); // aim under ~40 MB
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
  window.MW.uploadVideo = (file, onProg) => new Promise(async (res, rej) => {
    if (!session) return rej(new Error("Sign in first."));
    if (file.size > window.MW.VIDEO_MAX) {
      try { file = await window.MW.shrinkVideo(file, (f) => onProg && onProg(f * 0.5)); const p0 = onProg; onProg = p0 ? (f) => p0(0.5 + f * 0.5) : null; }
      catch (err) { return rej(err); }
      if (file.size > window.MW.VIDEO_MAX) return rej(new Error("That video is still over 50 MB after shrinking. Post a shorter clip (under about 3 minutes)."));
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    let type = file.type || VTYPES[ext] || "video/mp4";
    if (!/^video\//.test(type)) return rej(new Error("Pick a video file (MP4, MOV or WebM)."));
    const path = session.user.id + "/" + newId() + "." + (VTYPES[ext] ? ext : "mp4");
    const x = new XMLHttpRequest();
    x.open("POST", cfg.SUPABASE_URL + "/storage/v1/object/media/" + path);
    x.setRequestHeader("authorization", "Bearer " + session.access_token);
    x.setRequestHeader("apikey", cfg.SUPABASE_ANON_KEY);
    x.setRequestHeader("content-type", type);
    x.setRequestHeader("x-upsert", "false");
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProg) onProg(e.loaded / e.total); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return res({ path, url: sb.storage.from("media").getPublicUrl(path).data.publicUrl });
      let m = "Upload failed (" + x.status + ")"; try { const j = JSON.parse(x.responseText); m = j.message || j.error || m; } catch (_) {}
      if (/mime|type/i.test(m)) m = "That video type isn't supported. Use MP4, MOV or WebM.";
      if (/size|large|exceed/i.test(m)) m = "That video is over 50 MB. Trim it or record a shorter clip.";
      rej(new Error(m));
    };
    x.onerror = () => rej(new Error("Network problem. Check your connection and try again."));
    x.send(file);
  });
  // Any member file (song mixdowns, dating photos): same private-folder rules as videos.
  window.MW.uploadMedia = (blob, opts = {}) => new Promise((res, rej) => {
    if (!session) return rej(new Error("Sign in first."));
    if (blob.size > window.MW.VIDEO_MAX) return rej(new Error("That file is over 50 MB."));
    const type = opts.type || blob.type || "application/octet-stream";
    if (!/^(audio|image|video)\//.test(type)) return rej(new Error("That file type isn't supported."));
    const ext = opts.ext || ({ "audio/wav": "wav", "audio/mpeg": "mp3", "audio/webm": "webm", "audio/mp4": "m4a", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type] || "bin");
    const path = session.user.id + "/" + newId() + "." + ext;
    const x = new XMLHttpRequest();
    x.open("POST", cfg.SUPABASE_URL + "/storage/v1/object/media/" + path);
    x.setRequestHeader("authorization", "Bearer " + session.access_token);
    x.setRequestHeader("apikey", cfg.SUPABASE_ANON_KEY);
    x.setRequestHeader("content-type", type);
    x.upload.onprogress = (e) => { if (e.lengthComputable && opts.onProg) opts.onProg(e.loaded / e.total); };
    x.onload = () => { if (x.status >= 200 && x.status < 300) return res({ path, url: sb.storage.from("media").getPublicUrl(path).data.publicUrl }); let m = "Upload failed (" + x.status + ")"; try { const j = JSON.parse(x.responseText); m = j.message || j.error || m; } catch (_) {} rej(new Error(m)); };
    x.onerror = () => rej(new Error("Network problem. Check your connection and try again."));
    x.send(blob);
  });
  window.MW.deleteVideo = (path) => (sb && path ? sb.storage.from("media").remove([path]).catch(() => {}) : Promise.resolve());

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
  window.MW.setPassword = (password) => sb.auth.updateUser({ password });
  window.MW.reset = (email) => sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  window.MW.session = () => session;
  window.MW.sessionReady = sessionReady;
})();
