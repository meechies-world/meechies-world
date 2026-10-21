/* Meechie's World accounts + data on Cloudflare (free plan: D1 database + KV storage).
 * Replaces Supabase for sign-in, posts/profiles ("docs"), private messages ("dms") and play counts.
 * Same rules as the old database:
 *   - anyone can read docs; members write their own; only Meechie (admins) can do owner-only things
 *   - private messages are only readable by the two people in them
 * Bindings (set in Cloudflare Pages → Settings → Bindings): DB = D1 database, MEDIA = KV namespace. */

export const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export const uuid = () => crypto.randomUUID();

/* ---------- schema (created automatically on first use) ---------- */
const SCHEMA = [
  `create table if not exists users (id text primary key, email text unique, name text, pass text, google_sub text unique, meta text not null default '{}', created_at text not null, last_sign_in text)`,
  `create table if not exists sessions (token_hash text primary key, uid text not null, created_at integer not null, expires integer not null)`,
  `create index if not exists sessions_uid on sessions(uid)`,
  `create table if not exists docs (path text primary key, coll text not null, owner text, data text not null, created_at text not null, updated_at text not null)`,
  `create index if not exists docs_coll on docs(coll, created_at)`,
  `create table if not exists dms (id integer primary key autoincrement, sender text not null, recipient text not null, body text not null, created_at text not null, read_at text)`,
  `create index if not exists dms_sender on dms(sender, created_at)`,
  `create index if not exists dms_recipient on dms(recipient, created_at)`,
  `create table if not exists admins (user_id text primary key)`,
  `create table if not exists plays (id text primary key, n integer not null default 0, updated_at text)`,
  `create table if not exists plays_seen (uid text not null, id text not null, day text not null, primary key (uid, id, day))`,
  `create table if not exists changes (seq integer primary key autoincrement, tbl text not null, path text, coll text, a text, b text, at integer not null)`,
  `create table if not exists usage (k text not null, at integer not null)`,
  `create index if not exists usage_k on usage(k, at)`,
  `create table if not exists kv (k text primary key, v text)`,
];
// Meechie and Malik (the site admins) keep admin rights after the move.
const SEED_ADMINS = ["9c4f7de6-bd82-46f9-88af-7fac069fe0e9", "e5aaace5-4272-4817-8f3c-883b24006026"];
let ready = null;
export function setup(env) {
  if (!ready) ready = (async () => {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    await env.DB.batch(SEED_ADMINS.map((id) => env.DB.prepare("insert or ignore into admins (user_id) values (?)").bind(id)));
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const nowIso = () => new Date().toISOString();

/* ---------- passwords (PBKDF2, built into Cloudflare) ---------- */
const ITER = 20000;
export async function hashPass(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64u(salt)}$${b64u(bits)}`;
}
export async function checkPass(pw, stored) {
  const [kind, it, s, h] = String(stored || "").split("$");
  if (kind !== "pbkdf2") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64u(s), iterations: +it }, key, 256);
  const a = b64u(bits); if (a.length !== h.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ h.charCodeAt(i); return d === 0;
}

/* ---------- sessions ---------- */
const DAY = 864e5, SESSION_DAYS = 365; // stays signed in on that device; each visit pushes it out again (owner: never sign in again)
export async function newSession(env, user) {
  const token = "mw_" + randToken(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("insert into sessions (token_hash, uid, created_at, expires) values (?,?,?,?)").bind(await sha256hex(token), user.id, now, now + SESSION_DAYS * DAY),
    env.DB.prepare("update users set last_sign_in = ? where id = ?").bind(nowIso(), user.id),
    env.DB.prepare("delete from sessions where expires < ?").bind(now),
  ]);
  return sessionOut(token, user, now + SESSION_DAYS * DAY);
}
export function publicUser(u) {
  let meta = {}; try { meta = JSON.parse(u.meta || "{}"); } catch (_) {}
  return { id: u.id, email: u.email || "", user_metadata: meta, app_metadata: { provider: u.google_sub && !u.pass ? "google" : "email" }, created_at: u.created_at };
}
export const sessionOut = (token, u, exp) => ({ access_token: token, refresh_token: token, token_type: "bearer", expires_at: Math.floor(exp / 1000), user: publicUser(u) });
export async function userFrom(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^mw_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  await setup(env);
  const row = await env.DB.prepare("select u.*, s.expires from sessions s join users u on u.id = s.uid where s.token_hash = ?").bind(await sha256hex(token)).first();
  if (!row || row.expires < Date.now()) return null;
  row.token = token;
  if (row.expires - Date.now() < (SESSION_DAYS - 1) * DAY) { // at most once a day: renew for another full year
    row.expires = Date.now() + SESSION_DAYS * DAY;
    await env.DB.prepare("update sessions set expires = ? where token_hash = ?").bind(row.expires, await sha256hex(token)).run();
  }
  return row;
}
export async function isAdmin(env, uid) {
  if (!uid) return false;
  return !!(await env.DB.prepare("select 1 from admins where user_id = ?").bind(uid).first());
}

/* ---------- simple rate limits ---------- */
export async function take(env, key, windowSec, max) {
  const now = Date.now();
  const r = await env.DB.prepare("select count(*) n from usage where k = ? and at > ?").bind(key, now - windowSec * 1000).first();
  if (r && r.n >= max) return false;
  await env.DB.batch([
    env.DB.prepare("insert into usage (k, at) values (?, ?)").bind(key, now),
    env.DB.prepare("delete from usage where at < ?").bind(now - 2 * DAY),
  ]);
  return true;
}

/* ---------- change feed (lets open pages refresh without a paid live connection) ---------- */
export const change = (env, tbl, path, coll, a = null, b = null) =>
  env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind(tbl, path, coll, a, b, Date.now());

/* ---------- doc rules (same as the old database's) ---------- */
const ADMIN_COLLS = ["tracks", "radio", "site", "books", "bookpages"];
const OWN_COLLS = ["members", "scores", "live", "friends", "dating", "datelikes", "follows"];
const OWNER_FLAGS = ["announce", "host", "sponsored", "featured"];
const OPEN_KEYS = ["likes", "votes", "replyCount", "giftsReceived"];
const SAFE_COLL = /^[A-Za-z0-9_/-]{1,200}$/, SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const truthy = (v) => v != null && v !== false;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
class RuleError extends Error { constructor(m) { super(m); this.code = "permission_denied"; } }
export { RuleError };

export function checkInsert(path, coll, data, uid, admin) {
  if (!uid) throw new RuleError("Sign in first.");
  if (!SAFE_COLL.test(coll) || !path.startsWith(coll + "/") || !SAFE_ID.test(path.slice(coll.length + 1))) throw new RuleError("That address isn't allowed.");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new RuleError("Bad data.");
  if (JSON.stringify(data).length >= 400000) throw new RuleError("That's too big to save.");
  if (admin) return;
  if (ADMIN_COLLS.includes(coll)) throw new RuleError("Only Meechie can change that.");
  if (OWN_COLLS.includes(coll) && path !== coll + "/" + uid) throw new RuleError("You can only change your own.");
  if ((data.authorId != null && data.authorId !== uid) || (data.from != null && data.from !== uid)) throw new RuleError("You can only post as yourself.");
  if (OWNER_FLAGS.some((k) => truthy(data[k]))) throw new RuleError("Only Meechie can change that.");
  if (truthy(data.pro)) throw new RuleError("Only Meechie can unlock plugins.");
}
function onlyMeChanged(a, b, uid) {
  const A = new Set(Array.isArray(a) ? a.map(String) : []), B = new Set(Array.isArray(b) ? b.map(String) : []);
  for (const x of A) if (!B.has(x) && x !== uid) return false;
  for (const x of B) if (!A.has(x) && x !== uid) return false;
  return true;
}
export function checkUpdate(oldRow, newData, uid, admin) {
  if (!uid) throw new RuleError("Sign in first.");
  if (!newData || typeof newData !== "object" || Array.isArray(newData)) throw new RuleError("Bad data.");
  if (JSON.stringify(newData).length >= 400000) throw new RuleError("That's too big to save.");
  if (admin) return;
  const old = JSON.parse(oldRow.data || "{}");
  if (OWNER_FLAGS.some((k) => !same(newData[k] ?? false, old[k] ?? false)) || !same(newData.authorId, old.authorId) || !same(newData.from, old.from)) throw new RuleError("Only Meechie can change that.");
  if (!same(newData.pro ?? false, old.pro ?? false)) throw new RuleError("Only Meechie can unlock plugins.");
  if (oldRow.owner === uid) return;
  const strip = (o) => { const c = { ...o }; OPEN_KEYS.forEach((k) => delete c[k]); return c; };
  if (!same(sortKeys(strip(newData)), sortKeys(strip(old)))) throw new RuleError("You can only like, vote on, or react to other people's posts.");
  if (!onlyMeChanged(old.likes, newData.likes, uid) || !onlyMeChanged(old.votes, newData.votes, uid)) throw new RuleError("You can only add or remove your own like or vote.");
  const rc = (+newData.replyCount || 0) - (+old.replyCount || 0), g0 = +old.giftsReceived || 0, g1 = +newData.giftsReceived || 0;
  if (Math.abs(rc) > 1 || (g1 !== g0 && g1 !== g0 + 1)) throw new RuleError("Counters can only change by one.");
}
function sortKeys(o) { if (Array.isArray(o)) return o.map(sortKeys); if (o && typeof o === "object") return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])); return o; }

/* ---------- Google sign-in (ID token from Google's button; no secret needed) ---------- */
let jwks = null, jwksAt = 0;
export async function verifyGoogle(credential, clientId) {
  const [h, p, s] = String(credential || "").split(".");
  if (!h || !p || !s) return null;
  const head = JSON.parse(new TextDecoder().decode(fromB64u(h))), body = JSON.parse(new TextDecoder().decode(fromB64u(p)));
  if (head.alg !== "RS256") return null;
  if (!jwks || Date.now() - jwksAt > 3600e3) { jwks = (await fetch("https://www.googleapis.com/oauth2/v3/certs").then((r) => r.json())).keys; jwksAt = Date.now(); }
  const jwk = jwks.find((k) => k.kid === head.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64u(s), enc.encode(h + "." + p));
  if (!ok) return null;
  if (body.aud !== clientId || !["accounts.google.com", "https://accounts.google.com"].includes(body.iss) || body.exp * 1000 < Date.now() || !body.email_verified) return null;
  return body;
}
