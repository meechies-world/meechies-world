/* /api/cf/* — Meechie's World's own free sign-in + database (Cloudflare D1 + KV). See lib/cf.js for the rules. */
import { json, setup, hashPass, checkPass, newSession, publicUser, sessionOut, userFrom, isAdmin, take, change, checkInsert, checkUpdate, RuleError, verifyGoogle, sha256hex, uuid } from "../../../lib/cf.js";

// Google "Sign in with Google" client id (public; the Google Cloud project the site already uses)
const GOOGLE_CLIENT_ID = (env) => env.GOOGLE_CLIENT_ID || "";
// one-time move from the old database: only a request carrying the key whose hash is below is accepted, once
const IMPORT_HASH = "1bfa482be0f068058d5b130298722a309e115245181f62870c5f0ad9c7010080";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const ip = (r) => r.headers.get("cf-connecting-ip") || "0";
const err = (message, status = 400, code = "bad_request") => json({ data: null, error: { message, code } }, status);
const parse = (row) => { if (!row) return row; const o = { ...row }; if (typeof o.data === "string") { try { o.data = JSON.parse(o.data); } catch (_) { o.data = {}; } } return o; };

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  if (!env.DB) return err("The new database isn't connected yet.", 503, "not_ready");
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/");
  try {
    await setup(env);
    if (route === "health") return json({ ok: true });
    if (parts[0] === "auth") return await auth(parts[1], request, env);
    if (route === "rest" && request.method === "POST") return await rest(request, env);
    if (route === "rpc" && request.method === "POST") return await rpc(request, env);
    if (route === "changes") return await changes(request, env);
    if (parts[0] === "upload") return await upload(parts.slice(1), request, env);
    if (route === "import" && request.method === "POST") return await doImport(request, env);
    return err("Not found", 404, "not_found");
  } catch (e) {
    if (e instanceof RuleError) return err(e.message, 403, e.code);
    return err("Something went wrong: " + String(e && e.message || e).slice(0, 160), 500, "server_error");
  }
}

/* ---------------- accounts ---------------- */
async function auth(what, request, env) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  if (what === "settings") return json({ google: GOOGLE_CLIENT_ID(env) || null });

  if (what === "signup") {
    const email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || "");
    if (!EMAIL.test(email)) return err("Enter a real email address.");
    if (pw.length < 6 || pw.length > 200) return err("Use a password with at least 6 characters.");
    if (!(await take(env, "signup:" + ip(request), 3600, 8))) return err("Too many new accounts from here. Try again in an hour.", 429, "rate_limited");
    if (await env.DB.prepare("select 1 from users where email = ?").bind(email).first()) return err("That email already has an account. Sign in instead.", 400, "user_already_exists");
    const meta = body.data && typeof body.data === "object" ? { full_name: String(body.data.full_name || "").slice(0, 30) } : {};
    const u = { id: uuid(), email, name: meta.full_name || "", pass: await hashPass(pw), meta: JSON.stringify(meta), created_at: new Date().toISOString() };
    await env.DB.prepare("insert into users (id, email, name, pass, meta, created_at) values (?,?,?,?,?,?)").bind(u.id, u.email, u.name, u.pass, u.meta, u.created_at).run();
    const session = await newSession(env, u);
    return json({ data: { user: session.user, session }, error: null });
  }

  if (what === "signin") {
    const email = String(body.email || "").trim().toLowerCase(), pw = String(body.password || "");
    if (!(await take(env, "signin:" + ip(request), 900, 20))) return err("Too many tries. Wait 15 minutes and try again.", 429, "rate_limited");
    const u = await env.DB.prepare("select * from users where email = ?").bind(email).first();
    if (!u || !u.pass) return err(u ? "This account uses Google. Tap “Continue with Google”, or sign in with Google and set a password in your profile." : "Wrong email or password.", 400, "invalid_credentials");
    if (!(await checkPass(pw, u.pass))) return err("Wrong email or password.", 400, "invalid_credentials");
    const session = await newSession(env, u);
    return json({ data: { user: session.user, session }, error: null });
  }

  if (what === "google") {
    const cid = GOOGLE_CLIENT_ID(env); if (!cid) return err("Google sign-in isn't set up yet.", 501);
    const g = await verifyGoogle(body.credential, cid);
    if (!g) return err("Google sign-in didn't work. Try again.", 401, "invalid_credentials");
    const email = String(g.email || "").toLowerCase();
    const link = await env.DB.prepare("select v from kv where k = ?").bind("gsub:" + g.sub).first();
    let u = link ? await env.DB.prepare("select * from users where id = ?").bind(link.v).first() : null;
    if (!u) {
      const h = await sha256hex("meechies-world:" + email);
      const owner = await env.DB.prepare("select v from kv where k = ?").bind("owner-email:" + h).first();
      const byEmail = await env.DB.prepare("select * from users where email = ?").bind(email).first();
      // bring back the member's old profile: their saved find-by-email code matches this (Google-verified) email
      const old = await env.DB.prepare("select owner from docs where coll = 'members' and json_extract(data, '$.emailHash') = ? and owner not in (select id from users) limit 1").bind(h).first();
      const id = (owner && owner.v) || (byEmail && byEmail.id) || (old && old.owner) || uuid();
      u = await env.DB.prepare("select * from users where id = ?").bind(id).first();
      const st = [];
      // Google proved this email. Anyone else who signed up with it (no proof) loses it and gets signed out,
      // and a password set on this account before Google proved it is cleared, so nobody else can keep access.
      if (byEmail && byEmail.id !== id) st.push(env.DB.prepare("update users set email = null where id = ?").bind(byEmail.id), env.DB.prepare("delete from sessions where uid = ?").bind(byEmail.id));
      if (u && u.pass && !(await env.DB.prepare("select 1 from kv where k like 'gsub:%' and v = ?").bind(id).first())) st.push(env.DB.prepare("update users set pass = null where id = ?").bind(id), env.DB.prepare("delete from sessions where uid = ?").bind(id));
      if (st.length) await env.DB.batch(st);
      if (!u) {
        const meta = { full_name: String(g.name || "").slice(0, 30), avatar_url: g.picture || "" };
        u = { id, email, name: meta.full_name, meta: JSON.stringify(meta), created_at: new Date().toISOString() };
        await env.DB.prepare("insert into users (id, email, name, meta, created_at) values (?,?,?,?,?)").bind(u.id, u.email, u.name, u.meta, u.created_at).run();
      } else if (!u.email) { await env.DB.prepare("update users set email = ? where id = ?").bind(email, id).run(); u.email = email; }
      await env.DB.prepare("insert or replace into kv (k, v) values (?, ?)").bind("gsub:" + g.sub, id).run();
      u = await env.DB.prepare("select * from users where id = ?").bind(id).first();
    }
    const session = await newSession(env, u);
    return json({ data: { user: session.user, session }, error: null });
  }

  const me = await userFrom(request, env);
  if (what === "signout") {
    if (me) await env.DB.prepare("delete from sessions where token_hash = ?").bind(await sha256hex(me.token)).run();
    return json({ error: null });
  }
  if (!me) return err("Signed out", 401, "not_signed_in");
  if (what === "user" && request.method === "GET") return json({ data: { user: publicUser(me) }, error: null, admin: await isAdmin(env, me.id) });
  if (what === "session") return json({ data: { session: sessionOut(me.token, me, me.expires) }, error: null, admin: await isAdmin(env, me.id) });
  if (what === "user" && request.method === "POST") {
    if (body.password != null) {
      const pw = String(body.password); if (pw.length < 6 || pw.length > 200) return err("Use a password with at least 6 characters.");
      await env.DB.prepare("update users set pass = ? where id = ?").bind(await hashPass(pw), me.id).run();
    }
    if (body.data && typeof body.data === "object") {
      let meta = {}; try { meta = JSON.parse(me.meta || "{}"); } catch (_) {}
      for (const [k, v] of Object.entries(body.data).slice(0, 20)) if (/^[a-z_]{1,30}$/.test(k)) meta[k] = typeof v === "string" ? v.slice(0, 300) : v;
      const s = JSON.stringify(meta); if (s.length > 4000) return err("Too much profile info.");
      await env.DB.prepare("update users set meta = ? where id = ?").bind(s, me.id).run(); me.meta = s;
    }
    return json({ data: { user: publicUser(me) }, error: null });
  }
  return err("Not found", 404, "not_found");
}

/* ---------------- tables ---------------- */
const DOC_COLS = ["path", "coll", "owner", "data", "created_at", "updated_at"];
async function rest(request, env) {
  const q = await request.json().catch(() => null);
  if (!q || typeof q !== "object") return err("Bad request");
  const me = await userFrom(request, env), uid = me && me.id;
  const F = Array.isArray(q.filters) ? q.filters.slice(0, 6) : [];
  const f = (col, op = "eq") => { const x = F.find((r) => r[0] === col && r[1] === op); return x ? x[2] : undefined; };
  const limit = Math.max(1, Math.min(+q.limit || 100, 1000));

  if (q.table === "docs") {
    if (q.op === "select") {
      const cols = String(q.select || "path,data").split(",").map((c) => c.trim()).filter((c) => DOC_COLS.includes(c));
      const where = [], args = [];
      for (const c of ["coll", "path", "owner"]) { const v = f(c); if (v !== undefined) { where.push(c + " = ?"); args.push(String(v)); } }
      const W = where.length ? " where " + where.join(" and ") : "";
      if (q.count && q.head) { const r = await env.DB.prepare("select count(*) n from docs" + W).bind(...args).first(); return json({ data: null, count: r ? r.n : 0, error: null }); }
      let order = " order by created_at asc";
      if (q.order && q.order.col) {
        const m = /^data->([A-Za-z0-9_]{1,40})$/.exec(q.order.col), dir = q.order.asc === false ? "desc" : "asc";
        if (m) order = ` order by json_extract(data, '$.${m[1]}') is null, json_extract(data, '$.${m[1]}') ${dir}`;
        else if (["created_at", "updated_at", "path"].includes(q.order.col)) order = ` order by ${q.order.col} ${dir}`;
      }
      const { results } = await env.DB.prepare("select " + (cols.length ? cols.join(",") : "path,data") + " from docs" + W + order + " limit ?").bind(...args, limit).all();
      return json({ data: results.map(parse), error: null });
    }
    if (q.op === "insert") {
      const rows = Array.isArray(q.values) ? q.values : [q.values];
      if (rows.length !== 1) return err("One at a time.");
      const r = rows[0] || {}, path = String(r.path || ""), coll = String(r.coll || "");
      checkInsert(path, coll, r.data, uid, await isAdmin(env, uid));
      const now = new Date().toISOString();
      const res = await env.DB.batch([
        env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, uid, JSON.stringify(r.data), now, now),
        change(env, "docs", path, coll),
      ]);
      if (!res[0].meta.changes) return err("That already exists.", 409, "duplicate");
      if (Math.random() < 0.02) await env.DB.prepare("delete from changes where at < ?").bind(Date.now() - 864e5).run();
      return json({ data: null, error: null }, 201);
    }
    if (q.op === "delete") {
      const path = f("path"); if (typeof path !== "string") return err("Say which one.");
      const row = await env.DB.prepare("select owner, coll from docs where path = ?").bind(path).first();
      if (!row) return json({ data: null, error: null });
      if (!uid || !((row.owner === uid && row.coll !== "members") || (await isAdmin(env, uid)))) throw new RuleError("You can only delete your own.");
      await env.DB.batch([env.DB.prepare("delete from docs where path = ?").bind(path), change(env, "docs", path, row.coll)]);
      return json({ data: null, error: null });
    }
  }

  if (q.table === "dms") {
    if (!uid) return err("Sign in first.", 401, "not_signed_in");
    if (q.op === "select") {
      const { results } = await env.DB.prepare("select * from (select * from dms where sender = ? union all select * from dms where recipient = ? and sender <> ?) order by created_at desc limit ?").bind(uid, uid, uid, Math.min(limit, 800)).all();
      return json({ data: results, error: null });
    }
    if (q.op === "insert") {
      const r = (Array.isArray(q.values) ? q.values[0] : q.values) || {};
      const to = String(r.recipient || ""), body = String(r.body || "");
      if (!UUID.test(to) || to === uid) return err("You can't message that person.");
      if (!body.trim() || body.length > 20000) return err("Type a message first.");
      if (!(await take(env, "dm:" + uid, 60, 40))) return err("Slow down a little — too many messages in a minute.", 429, "rate_limited");
      const now = new Date().toISOString();
      const res = await env.DB.batch([
        env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(uid, to, body, now),
        change(env, "dms", null, null, uid, to),
      ]);
      return json({ data: [{ id: res[0].meta.last_row_id, sender: uid, recipient: to, body, created_at: now, read_at: null }], error: null }, 201);
    }
    if (q.op === "update") {
      if (f("recipient") !== uid) throw new RuleError("You can only mark your own messages as read.");
      const sender = f("sender"); const now = new Date().toISOString();
      const sql = "update dms set read_at = ? where recipient = ? and read_at is null" + (typeof sender === "string" ? " and sender = ?" : "");
      const st = env.DB.prepare(sql); const b = typeof sender === "string" ? st.bind(now, uid, sender) : st.bind(now, uid);
      await env.DB.batch([b, change(env, "dms", null, null, typeof sender === "string" ? sender : uid, uid)]);
      return json({ data: null, error: null });
    }
  }

  if (q.table === "admins" && q.op === "select") {
    const one = f("user_id");
    const { results } = one !== undefined ? await env.DB.prepare("select user_id from admins where user_id = ?").bind(String(one)).all() : await env.DB.prepare("select user_id from admins limit ?").bind(limit).all();
    return json({ data: results, error: null });
  }
  if (q.table === "plays" && q.op === "select") {
    const { results } = await env.DB.prepare("select id, n from plays limit ?").bind(Math.min(limit, 2000)).all();
    return json({ data: results, error: null });
  }
  return err("That isn't allowed.", 403, "permission_denied");
}

async function rpc(request, env) {
  const { name, args = {} } = (await request.json().catch(() => ({}))) || {};
  const me = await userFrom(request, env), uid = me && me.id;
  if (name === "set_doc" || name === "merge_doc") {
    if (!uid) return err("Sign in first.", 401, "not_signed_in");
    const path = String(args.p_path || ""), admin = await isAdmin(env, uid);
    const row = await env.DB.prepare("select * from docs where path = ?").bind(path).first();
    const now = new Date().toISOString();
    if (!row) {
      if (name === "merge_doc") return err("That item no longer exists.", 404, "not_found");
      const coll = String(args.p_coll || "");
      checkInsert(path, coll, args.p_data, uid, admin);
      await env.DB.batch([env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, uid, JSON.stringify(args.p_data), now, now), change(env, "docs", path, coll)]);
      return json({ data: null, error: null });
    }
    let next;
    if (name === "set_doc") next = args.p_data;
    else { const patch = args.p_patch; if (!patch || typeof patch !== "object" || Array.isArray(patch)) return err("Bad change."); next = { ...JSON.parse(row.data || "{}"), ...patch }; }
    checkUpdate(row, next, uid, admin);
    await env.DB.batch([env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(next), now, path), change(env, "docs", path, row.coll)]);
    return json({ data: null, error: null });
  }
  if (name === "bump_play") {
    const id = String(args.p_id || "");
    if (!uid || !/^[A-Za-z0-9:_-]{1,80}$/.test(id)) return json({ data: null, error: null });
    const day = new Date().toISOString().slice(0, 10);
    const r = await env.DB.prepare("insert or ignore into plays_seen (uid, id, day) values (?,?,?)").bind(uid, id, day).run();
    if (r.meta.changes) await env.DB.prepare("insert into plays (id, n, updated_at) values (?, 1, ?) on conflict(id) do update set n = n + 1, updated_at = excluded.updated_at").bind(id, new Date().toISOString()).run();
    return json({ data: null, error: null });
  }
  return err("Unknown action", 404, "not_found");
}

/* ---------------- live refresh: "what changed since N?" ---------------- */
async function changes(request, env) {
  const raw = new URL(request.url).searchParams.get("since"); const since = raw === null || raw === "" ? -1 : Math.max(0, +raw || 0);
  const me = await userFrom(request, env), uid = (me && me.id) || "-";
  const top = await env.DB.prepare("select max(seq) s from changes").first();
  const last = (top && top.s) || 0;
  if (since < 0 || since >= last) return json({ seq: last, rows: [] }); // first check just says where things are
  const { results } = await env.DB.prepare("select seq, tbl, path, coll from changes where seq > ? and (tbl <> 'dms' or a = ? or b = ?) order by seq limit 200").bind(since, uid, uid).all();
  return json({ seq: last, rows: results });
}

/* ---------------- uploads (Cloudflare KV, free) ---------------- */
const MAX = 25 * 1024 * 1024;
async function upload(parts, request, env) {
  const bucket = parts[0], path = parts.slice(1).join("/");
  if (!["media", "assets"].includes(bucket) || !/^[A-Za-z0-9._/-]{3,200}$/.test(path) || path.includes("..")) return err("Bad file name.");
  if (!env.MEDIA) return err("File storage isn't connected yet.", 503, "not_ready");
  const me = await userFrom(request, env); if (!me) return err("Sign in first.", 401, "not_signed_in");
  const admin = await isAdmin(env, me.id);
  if (bucket === "assets" ? !admin : !(path.split("/")[0] === me.id || admin)) throw new RuleError("You can only change your own files.");
  const key = bucket + "/" + path;
  if (request.method === "DELETE") { await env.MEDIA.delete(key); return json({ error: null }); }
  if (request.method !== "POST" && request.method !== "PUT") return err("Not allowed", 405);
  const type = request.headers.get("content-type") || "application/octet-stream";
  if (!/^(audio|image|video)\//.test(type) && bucket === "media") return err("That file type isn't supported.");
  const len = +request.headers.get("content-length") || 0; if (len > MAX) return err("That file is over 25 MB. Post a shorter clip.", 413);
  if (!(await take(env, "up:" + me.id, 86400, 60))) return err("Upload limit reached for today. Try again tomorrow.", 429, "rate_limited");
  const buf = await request.arrayBuffer(); if (buf.byteLength > MAX) return err("That file is over 25 MB. Post a shorter clip.", 413);
  await env.MEDIA.put(key, buf, { metadata: { type, size: buf.byteLength } });
  return json({ Key: key, error: null });
}

/* ---------------- one-time move from the old database ---------------- */
async function doImport(request, env) {
  const key = request.headers.get("x-import-key") || "";
  if ((await sha256hex(key)) !== IMPORT_HASH) return err("Not allowed", 403);
  if (await env.DB.prepare("select 1 from kv where k = 'import_done'").first()) return err("Already moved.", 409);
  const b = await request.json().catch(() => ({}));
  const st = [];
  for (const d of (Array.isArray(b.docs) ? b.docs : []).slice(0, 500)) {
    if (!d || typeof d.path !== "string" || typeof d.coll !== "string") continue;
    st.push(env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(d.path, d.coll, d.owner || null, JSON.stringify(d.data || {}), d.created_at || new Date().toISOString(), d.updated_at || d.created_at || new Date().toISOString()));
  }
  for (const m of (Array.isArray(b.dms) ? b.dms : []).slice(0, 500)) {
    if (!m || !UUID.test(m.sender || "") || !UUID.test(m.recipient || "")) continue;
    st.push(env.DB.prepare("insert or ignore into dms (id, sender, recipient, body, created_at, read_at) values (?,?,?,?,?,?)").bind(+m.id, m.sender, m.recipient, String(m.body || ""), m.created_at, m.read_at || null));
  }
  for (const p of (Array.isArray(b.plays) ? b.plays : []).slice(0, 2000)) if (p && typeof p.id === "string") st.push(env.DB.prepare("insert or ignore into plays (id, n, updated_at) values (?,?,?)").bind(p.id, +p.n || 0, p.updated_at || null));
  for (const a of (Array.isArray(b.admins) ? b.admins : [])) if (UUID.test(a || "")) st.push(env.DB.prepare("insert or ignore into admins (user_id) values (?)").bind(a));
  for (const o of (Array.isArray(b.owners) ? b.owners : [])) if (o && /^[0-9a-f]{64}$/.test(o.h || "") && UUID.test(o.id || "")) st.push(env.DB.prepare("insert or ignore into kv (k, v) values (?, ?)").bind("owner-email:" + o.h, o.id));
  if (b.done) st.push(env.DB.prepare("insert or ignore into kv (k, v) values ('import_done', ?)").bind(new Date().toISOString()));
  for (let i = 0; i < st.length; i += 100) await env.DB.batch(st.slice(i, i + 100));
  const n = await env.DB.prepare("select (select count(*) from docs) d, (select count(*) from dms) m").first();
  return json({ ok: true, wrote: st.length, docs: n.d, dms: n.m });
}
