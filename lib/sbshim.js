/* After the move to Cloudflare, the site's server helpers (AI chat, legal helper, phone notifications, visitor alerts…)
 * still ask "Supabase" who is signed in and read a few rows. This answers those same requests from the new free
 * database instead, so none of them had to be rewritten. Installed once by functions/_middleware.js. */
import { setup, userFrom, isAdmin, publicUser, checkInsert, checkUpdate, change } from "./cf.js";

const SB = "https://yjouaysczttqbytksejq.supabase.co";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
let live = null, liveAt = 0;
async function moved(env) { // true once the old data has been copied over
  if (live !== null && Date.now() - liveAt < 60e3) return live;
  try { await setup(env); live = !!(await env.DB.prepare("select 1 from kv where k = 'import_done'").first()); } catch (_) { live = false; }
  liveAt = Date.now(); return live;
}
const parseRow = (r) => { if (r && typeof r.data === "string") { try { r.data = JSON.parse(r.data); } catch (_) { r.data = {}; } } return r; };

export function install(getEnv) {
  if (globalThis.__mwShim) return; globalThis.__mwShim = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input && input.url;
    const env = getEnv();
    if (!url || !url.startsWith(SB + "/") || !env || !env.DB || !(await moved(env))) return real(input, init);
    const u = new URL(url), method = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    const h = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
    const token = (h.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const service = !!env.SUPABASE_SERVICE_ROLE_KEY && token === env.SUPABASE_SERVICE_ROLE_KEY;
    const me = token.startsWith("mw_") ? await userFrom(new Request("https://x/", { headers: { authorization: "Bearer " + token } }), env) : null;
    const P = u.pathname, q = u.searchParams;
    const eq = (k) => { const v = q.get(k); return v && v.startsWith("eq.") ? v.slice(3) : null; };

    if (P === "/auth/v1/user") return me ? J(publicUser(me)) : J({ msg: "not signed in" }, 401);
    if (P === "/auth/v1/health") return J({ ok: true });
    if (P === "/rest/v1/admins" && method === "GET") {
      const one = eq("user_id");
      const { results } = one ? await env.DB.prepare("select user_id from admins where user_id = ?").bind(one).all() : await env.DB.prepare("select user_id from admins limit ?").bind(Math.min(+q.get("limit") || 50, 100)).all();
      return J(results);
    }
    if (P === "/rest/v1/docs" && method === "GET") {
      const where = [], args = [];
      for (const c of ["path", "coll", "owner"]) { const v = eq(c); if (v) { where.push(c + " = ?"); args.push(v); } }
      const inn = q.get("path"); if (inn && inn.startsWith("in.(")) { const list = inn.slice(4, -1).split(",").slice(0, 20); where.push("path in (" + list.map(() => "?").join(",") + ")"); args.push(...list); }
      for (const [k, v] of q) { const m = /^data->>([A-Za-z0-9_]{1,40})$/.exec(k); if (m && v.startsWith("eq.")) { where.push(`json_extract(data, '$.${m[1]}') = ?`); args.push(v.slice(3)); } }
      const sel = q.get("select") || "*", title = /^data->>([A-Za-z0-9_]{1,40})$/.exec(sel);
      const order = /^created_at\.desc/.test(q.get("order") || "") ? " order by created_at desc" : "";
      const { results } = await env.DB.prepare("select path, coll, owner, data, created_at from docs" + (where.length ? " where " + where.join(" and ") : "") + order + " limit ?").bind(...args, Math.min(+q.get("limit") || 100, 500)).all();
      const rows = results.map(parseRow);
      if (title) return J(rows.map((r) => ({ [title[1]]: r.data ? r.data[title[1]] : null })));
      return J(rows.map((r) => { if (sel === "*") return r; const o = {}; sel.split(",").forEach((c) => { c = c.trim(); if (c in r) o[c] = r[c]; }); return o; }));
    }
    if (P === "/rest/v1/dms" && method === "GET") {
      if (!me && !service) return J([]);
      const where = [], args = [];
      for (const c of ["sender", "recipient"]) { const v = eq(c); if (v) { where.push(c + " = ?"); args.push(v); } }
      const since = q.get("created_at"); if (since && since.startsWith("gte.")) { where.push("created_at >= ?"); args.push(since.slice(4)); }
      const like = q.get("body"); if (like && like.startsWith("like.")) { where.push("body like ?"); args.push(like.slice(5).replace(/\*/g, "%")); }
      if (!service) { where.push("(sender = ? or recipient = ?)"); args.push(me.id, me.id); }
      const { results } = await env.DB.prepare("select id, sender, recipient, created_at, read_at from dms where " + where.join(" and ") + " order by created_at desc limit ?").bind(...args, Math.min(+q.get("limit") || 50, 200)).all();
      return J(results);
    }
    // server-side writes (ID verification, radio sync): same rules as the site; the server key counts as Meechie
    if (method === "POST" && (P === "/rest/v1/rpc/set_doc" || P === "/rest/v1/rpc/merge_doc" || P === "/rest/v1/docs")) {
      const uid = service ? "service" : me && me.id; if (!uid) return J({ message: "not signed in" }, 401);
      const admin = service || (await isAdmin(env, uid)); const b = JSON.parse(init.body || "{}"); const now = new Date().toISOString();
      try {
        if (P === "/rest/v1/docs") {
          const rows = Array.isArray(b) ? b : [b];
          for (const r of rows.slice(0, 50)) { checkInsert(r.path, r.coll, r.data, uid, admin); await env.DB.batch([env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(r.path, r.coll, service ? r.owner || null : uid, JSON.stringify(r.data), now, now), change(env, "docs", r.path, r.coll)]); }
          return J(null, 201);
        }
        const row = await env.DB.prepare("select * from docs where path = ?").bind(b.p_path).first();
        if (!row) {
          if (P.endsWith("merge_doc")) return J({ message: "That item no longer exists." }, 400);
          const coll = b.p_coll || String(b.p_path).split("/").slice(0, -1).join("/");
          checkInsert(b.p_path, coll, b.p_data, uid, admin);
          await env.DB.batch([env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(b.p_path, coll, service ? null : uid, JSON.stringify(b.p_data), now, now), change(env, "docs", b.p_path, coll)]);
          return J(null, 204);
        }
        const next = P.endsWith("merge_doc") ? { ...JSON.parse(row.data || "{}"), ...(b.p_patch || {}) } : b.p_data;
        checkUpdate(row, next, uid, admin);
        await env.DB.batch([env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(next), now, b.p_path), change(env, "docs", b.p_path, row.coll)]);
        return J(null, 204);
      } catch (e) { return J({ message: e.message }, 403); }
    }
    return real(input, init);
  };
}
