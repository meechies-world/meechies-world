/* Meechie's Fans: an 18+ creator platform (subscriptions, pay-per-view posts, tips, paid DMs come later).
 *
 * Safety first, because this is adult content:
 *  - Viewers: must be signed in and pass the 18+ check (date of birth + agreement) before seeing anything.
 *  - Creators: apply with a government photo ID, a selfie holding that ID and a signed creator agreement.
 *    Nobody can post until Meechie (owner) looks at the ID and approves them. ID files are private: only the owner can open them.
 *  - Every post: the creator confirms everyone shown is 18+ and consented. If anyone else appears, that person's ID and
 *    signed release are uploaded with the post (the records US law, 18 U.S.C. § 2257, requires).
 *  - Reports for "may be under 18" or "posted without consent" hide the post immediately until the owner reviews it.
 *  - Media is never public: files live under fans/ in KV and are only served through short-lived signed links,
 *    and only to the creator, the owner, subscribers, or people who unlocked that post. No caching.
 *
 * Money: buyers purchase Fans tokens (1 token = 1¢) through CCBill (an adult-approved processor). Stripe is never used here.
 * Every sale (subscription, unlock, tip) splits OWNER_SHARE to Meechie and the rest to the creator. Creators cash out by request.
 * Owner setup (Cloudflare → Pages → Settings → Variables and secrets), after CCBill approves the account:
 *   CCBILL_ACCOUNT, CCBILL_SUBACCOUNT, CCBILL_FLEX_ID, CCBILL_SALT
 *   and in CCBill set the webhook URL to https://meechiesworldinc.com/api/fans/ccbill
 * Until then the Fans section works (apply, approve, post, preview) but nobody can buy tokens. */
import { json, userFrom, isAdmin, setup, take, uuid, change } from "../../../lib/cf.js";

const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const OWNER_SHARE = 0.6;                 // owner: 60% of every Fans sale, creators 40%
const MIN_CASHOUT = 2000;                // $20
const PACKS = { t500: { tokens: 500, cents: 500 }, t1100: { tokens: 1100, cents: 1000 }, t2800: { tokens: 2800, cents: 2500 }, t6000: { tokens: 6000, cents: 5000 }, t12500: { tokens: 12500, cents: 10000 } };
const MAX_FILE = 25 * 1024 * 1024;
const SCHEMA = [
  "create table if not exists fans_viewers (uid text primary key, dob text not null, agreed_at integer not null)",
  "create table if not exists fans_creators (uid text primary key, status text not null default 'pending', name text, bio text, price_cents integer not null default 999, legal_name text, dob text, id_front text, id_selfie text, agreed_at integer, applied_at integer, reviewed_at integer, review_note text)",
  "create table if not exists fans_posts (id text primary key, creator text not null, caption text, media text not null, preview text, price_cents integer not null default 0, others integer not null default 0, status text not null default 'live', created_at integer not null)",
  "create index if not exists fans_posts_c on fans_posts (creator, created_at)",
  "create table if not exists fans_releases (id text primary key, post_id text not null, person_name text not null, dob text not null, id_key text not null, release_key text not null, at integer not null)",
  "create table if not exists fans_subs (fan text not null, creator text not null, until integer not null, primary key (fan, creator))",
  "create table if not exists fans_unlocks (fan text not null, post_id text not null, at integer not null, primary key (fan, post_id))",
  "create table if not exists fans_wallet (uid text primary key, tokens integer not null default 0, earned_cents integer not null default 0, paid_cents integer not null default 0)",
  "create table if not exists fans_tx (id text primary key, uid text not null, kind text not null, tokens integer not null default 0, cents integer not null default 0, other text, ref text, at integer not null)",
  "create table if not exists fans_orders (id text primary key, uid text not null, pack text not null, tokens integer not null, cents integer not null, status text not null default 'open', at integer not null)",
  "create table if not exists fans_reports (id integer primary key autoincrement, post_id text not null, reporter text not null, reason text not null, details text, status text not null default 'open', at integer not null)",
  "create table if not exists fans_cashouts (id integer primary key autoincrement, uid text not null, cents integer not null, method text, handle text, status text not null default 'requested', at integer not null, paid_at integer)",
];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const err = (m, s = 400) => json({ error: m }, s);
const now = () => Date.now();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const md5 = async (s) => hex(await crypto.subtle.digest("MD5", new TextEncoder().encode(s)));
const ageOf = (dob) => { const d = new Date(dob + "T00:00:00Z"); if (isNaN(d)) return -1; const t = new Date(); let a = t.getUTCFullYear() - d.getUTCFullYear(); const m = t.getUTCMonth() - d.getUTCMonth(); if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) a--; return a; };
const handleOf = async (env, uid) => ((await env.DB.prepare("select json_extract(data,'$.handle') h, json_extract(data,'$.photo') p from docs where path = ?").bind("members/" + uid).first()) || {});

// signed, short-lived media links (images/videos can't send a sign-in header)
async function secret(env) {
  let r = await env.DB.prepare("select v from kv where k = 'fans_secret'").first();
  if (!r) { const s = hex(crypto.getRandomValues(new Uint8Array(32))); await env.DB.prepare("insert or ignore into kv (k, v) values ('fans_secret', ?)").bind(s).run(); r = await env.DB.prepare("select v from kv where k = 'fans_secret'").first(); }
  return r.v;
}
async function sign(env, key, uid, mins = 30) {
  const exp = now() + mins * 60e3, k = await crypto.subtle.importKey("raw", new TextEncoder().encode(await secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(key + "|" + uid + "|" + exp))).slice(0, 40);
  return `/api/fans/m/${encodeURIComponent(key)}?u=${uid}&e=${exp}&s=${mac}`;
}
async function verify(env, key, uid, exp, mac) {
  if (!(+exp > now())) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(await secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(key + "|" + uid + "|" + exp))).slice(0, 40);
  return want.length === String(mac).length && [...want].every((c, i) => c === String(mac)[i]);
}
const isViewer = async (env, uid) => !!(await env.DB.prepare("select 1 from fans_viewers where uid = ?").bind(uid).first());
const creator = (env, uid) => env.DB.prepare("select * from fans_creators where uid = ?").bind(uid).first();
const subscribed = async (env, fan, c) => { const r = await env.DB.prepare("select until from fans_subs where fan = ? and creator = ?").bind(fan, c).first(); return !!(r && r.until > now()); };
const unlocked = async (env, fan, pid) => !!(await env.DB.prepare("select 1 from fans_unlocks where fan = ? and post_id = ?").bind(fan, pid).first());
const wallet = async (env, uid) => (await env.DB.prepare("select * from fans_wallet where uid = ?").bind(uid).first()) || { tokens: 0, earned_cents: 0, paid_cents: 0 };
const canSee = async (env, uid, admin, p) => admin || p.creator === uid || (p.price_cents > 0 ? await unlocked(env, uid, p.id) : await subscribed(env, uid, p.creator));

// spend tokens from fan → creator, splitting with the owner. One atomic batch; refuses if the fan doesn't have enough.
async function charge(env, fan, to, tokens, kind, ref) {
  const t = now(), id = uuid(), mine = Math.round(tokens * (1 - OWNER_SHARE));
  const r = await env.DB.prepare("update fans_wallet set tokens = tokens - ? where uid = ? and tokens >= ?").bind(tokens, fan, tokens).run();
  if (!r.meta.changes) return false;
  await env.DB.batch([
    env.DB.prepare("insert into fans_wallet (uid, earned_cents) values (?, ?) on conflict(uid) do update set earned_cents = earned_cents + excluded.earned_cents").bind(to, mine),
    env.DB.prepare("insert into fans_tx (id, uid, kind, tokens, cents, other, ref, at) values (?,?,?,?,?,?,?,?)").bind("s:" + id, fan, kind, -tokens, 0, to, ref, t),
    env.DB.prepare("insert into fans_tx (id, uid, kind, tokens, cents, other, ref, at) values (?,?,?,?,?,?,?,?)").bind("e:" + id, to, kind + "_earn", 0, mine, fan, ref, t),
    env.DB.prepare("insert into fans_tx (id, uid, kind, tokens, cents, other, ref, at) values (?,?,?,?,?,?,?,?)").bind("o:" + id, OWNER_ID, kind + "_fee", 0, tokens - mine, fan, ref, t),
  ]);
  return true;
}
const dm = (env, from, to, body) => env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(from, to, body, new Date().toISOString());
const ping = (env, from, to) => change(env, "dms", null, null, from, to); // so the message shows up right away

export async function onRequest({ request, env, params }) {
  if (!env.DB || !env.MEDIA) return err("Storage isn't connected.", 503);
  await setup(env); await ensure(env);
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/"), method = request.method, url = new URL(request.url);
  const payOn = !!(env.CCBILL_FLEX_ID && env.CCBILL_SUBACCOUNT && env.CCBILL_SALT);

  /* ---------- media (signed links) ---------- */
  if (parts[0] === "m" && method === "GET") {
    const key = decodeURIComponent(parts.slice(1).join("/"));
    if (!/^fans(id)?\/[\w\-/]+$/.test(key) || !(await verify(env, key, url.searchParams.get("u"), url.searchParams.get("e"), url.searchParams.get("s")))) return new Response("Link expired. Refresh the page.", { status: 403 });
    const got = await env.MEDIA.getWithMetadata(key, { type: "stream" }); if (!got || !got.value) return new Response("Not found", { status: 404 });
    return new Response(got.value, { headers: { "content-type": (got.metadata && got.metadata.type) || "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "x-robots-tag": "noindex" } });
  }

  /* ---------- CCBill → us (purchase approved) ---------- */
  if (route === "ccbill" && method === "POST") {
    if (!payOn) return err("off", 404);
    const ct = request.headers.get("content-type") || "";
    const body = ct.includes("json") ? await request.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await request.text()));
    const ev = url.searchParams.get("eventType") || body.eventType || "";
    if (ev && ev !== "NewSaleSuccess") return json({ ok: true });
    const sub = String(body.subscriptionId || body.subscription_id || ""), digest = String(body.dynamicPricingValidationDigest || body.responseDigest || "");
    if (!sub || digest !== (await md5(sub + "1" + env.CCBILL_SALT))) return err("bad digest", 400);
    const order = String(body.X_order || body["X-order"] || body.order || "");
    const o = await env.DB.prepare("select * from fans_orders where id = ? and status = 'open'").bind(order).first(); if (!o) return json({ ok: true, note: "unknown or done" });
    // credit once: the order must still be open AND this CCBill sale must be new (stops retries/replays double-crediting)
    const claim = await env.DB.prepare("update fans_orders set status = 'paid' where id = ? and status = 'open'").bind(o.id).run();
    if (!claim.meta.changes) return json({ ok: true, note: "done" });
    const fresh = await env.DB.prepare("insert or ignore into fans_tx (id, uid, kind, tokens, cents, ref, at) values (?,?,?,?,?,?,?)").bind("b:" + sub, o.uid, "buy", o.tokens, o.cents, o.id, now()).run();
    if (!fresh.meta.changes) return json({ ok: true, note: "sale already used" });
    await env.DB.prepare("insert into fans_wallet (uid, tokens) values (?, ?) on conflict(uid) do update set tokens = tokens + excluded.tokens").bind(o.uid, o.tokens).run();
    return json({ ok: true });
  }

  const me = await userFrom(request, env);
  if (route === "status" && method === "GET") {
    if (!me) return json({ signedIn: false, payOn });
    const c = await creator(env, me.id), w = await wallet(env, me.id);
    return json({ signedIn: true, viewer: await isViewer(env, me.id), creator: c ? { status: c.status, name: c.name, bio: c.bio, price_cents: c.price_cents, review_note: c.review_note } : null, tokens: w.tokens, earned: w.earned_cents - w.paid_cents, owner: await isAdmin(env, me.id), payOn, packs: PACKS, ownerShare: OWNER_SHARE });
  }
  if (!me) return err("Sign in first.", 401);
  const admin = await isAdmin(env, me.id);

  /* ---------- 18+ gate ---------- */
  if (route === "gate" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.agree) return err("You have to agree to enter.");
    const a = ageOf(String(b.dob || "")); if (a < 18 || a > 110) return err("Meechie's Fans is for adults 18 and older only.", 403);
    await env.DB.prepare("insert into fans_viewers (uid, dob, agreed_at) values (?,?,?) on conflict(uid) do update set dob = excluded.dob, agreed_at = excluded.agreed_at").bind(me.id, String(b.dob), now()).run();
    return json({ ok: true });
  }
  if (!(await isViewer(env, me.id)) && !admin) return err("adults_only", 451);

  /* ---------- uploads (private) ---------- */
  if (route === "upload" && method === "POST") {
    const kind = url.searchParams.get("kind"); // post | id
    const type = request.headers.get("content-type") || "";
    if (!/^(image\/(jpeg|png|webp|heic)|video\/(mp4|quicktime|webm))$/.test(type) && !(kind === "id" && type === "application/pdf")) return err("Use a photo (JPG/PNG) or a video (MP4/MOV).");
    if (kind === "post") { const c = await creator(env, me.id); if (!c || c.status !== "approved") return err("Only approved creators can upload."); }
    else if (kind !== "id") return err("Bad upload.");
    if (!(await take(env, "fup:" + me.id, 86400, 120))) return err("Upload limit reached for today.", 429);
    const buf = await request.arrayBuffer(); if (buf.byteLength > MAX_FILE) return err("Files must be under 25 MB.", 413);
    const key = (kind === "id" ? "fansid/" : "fans/") + me.id + "/" + hex(crypto.getRandomValues(new Uint8Array(12))) + (type.startsWith("video") ? "-v" : "-i");
    await env.MEDIA.put(key, buf, { metadata: { type, size: buf.byteLength, owner: me.id } });
    return json({ key, url: await sign(env, key, me.id) });
  }

  /* ---------- become a creator ---------- */
  if (route === "apply" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const own = (k) => typeof k === "string" && k.startsWith("fansid/" + me.id + "/");
    if (!own(b.idFront) || !own(b.idSelfie)) return err("Add a photo of your ID and a selfie holding your ID.");
    if (ageOf(String(b.dob || "")) < 18) return err("Creators must be 18 or older.", 403);
    if (String(b.legalName || "").trim().length < 4) return err("Type your full legal name as it appears on your ID.");
    if (!b.agree) return err("You have to agree to the creator terms.");
    const name = String(b.name || "").trim().slice(0, 40) || (await handleOf(env, me.id)).h || "Creator";
    const price = Math.max(300, Math.min(5000, Math.round(+b.price_cents || 999)));
    await env.DB.prepare("insert into fans_creators (uid, status, name, bio, price_cents, legal_name, dob, id_front, id_selfie, agreed_at, applied_at) values (?,?,?,?,?,?,?,?,?,?,?) on conflict(uid) do update set status = 'pending', name = excluded.name, bio = excluded.bio, price_cents = excluded.price_cents, legal_name = excluded.legal_name, dob = excluded.dob, id_front = excluded.id_front, id_selfie = excluded.id_selfie, agreed_at = excluded.agreed_at, applied_at = excluded.applied_at, review_note = null")
      .bind(me.id, "pending", name, String(b.bio || "").slice(0, 300), price, String(b.legalName).trim().slice(0, 100), String(b.dob), b.idFront, b.idSelfie, now(), now()).run();
    await env.DB.batch([ping(env, me.id, OWNER_ID), dm(env, me.id, OWNER_ID, "🔞 New Meechie's Fans creator application from " + name + ". Review their ID in Fans → Owner.")]);
    return json({ ok: true });
  }
  if (route === "profile" && method === "POST") {
    const c = await creator(env, me.id); if (!c || c.status !== "approved") return err("Only approved creators.");
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare("update fans_creators set name = ?, bio = ?, price_cents = ? where uid = ?").bind(String(b.name || c.name).slice(0, 40), String(b.bio || "").slice(0, 300), Math.max(300, Math.min(5000, Math.round(+b.price_cents || c.price_cents))), me.id).run();
    return json({ ok: true });
  }

  /* ---------- posting ---------- */
  if (route === "post" && method === "POST") {
    const c = await creator(env, me.id); if (!c || c.status !== "approved") return err("Only approved creators can post.");
    if (!(await take(env, "fpost:" + me.id, 86400, 60))) return err("Post limit reached for today.", 429);
    const b = await request.json().catch(() => ({}));
    const media = (Array.isArray(b.media) ? b.media : []).filter((k) => typeof k === "string" && k.startsWith("fans/" + me.id + "/")).slice(0, 10);
    if (!media.length) return err("Add at least one photo or video.");
    if (!b.allAdults || !b.consent) return err("Confirm everyone shown is 18+ and agreed to be in it.");
    const releases = Array.isArray(b.releases) ? b.releases.slice(0, 6) : [];
    if (b.others && !releases.length) return err("Someone else is in this post: add their ID and signed release.");
    for (const r of releases) {
      if (String(r.name || "").trim().length < 4 || ageOf(String(r.dob || "")) < 18) return err("Each person in the post must be 18+ with their full legal name.");
      if (!String(r.id || "").startsWith("fansid/" + me.id + "/") || !String(r.release || "").startsWith("fansid/" + me.id + "/")) return err("Upload each person's ID and signed release.");
    }
    const id = uuid(), t = now(), price = Math.max(0, Math.min(20000, Math.round(+b.price_cents || 0)));
    const preview = typeof b.preview === "string" && /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]{20,6000}$/.test(b.preview) ? b.preview : "";
    await env.DB.batch([
      env.DB.prepare("insert into fans_posts (id, creator, caption, media, preview, price_cents, others, created_at) values (?,?,?,?,?,?,?,?)").bind(id, me.id, String(b.caption || "").slice(0, 1000), JSON.stringify(media), preview, price, releases.length ? 1 : 0, t),
      ...releases.map((r) => env.DB.prepare("insert into fans_releases (id, post_id, person_name, dob, id_key, release_key, at) values (?,?,?,?,?,?,?)").bind(uuid(), id, String(r.name).trim().slice(0, 100), String(r.dob), r.id, r.release, t)),
    ]);
    return json({ ok: true, id });
  }
  if (route === "post/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const p = await env.DB.prepare("select * from fans_posts where id = ?").bind(String(b.id)).first(); if (!p) return err("Not found", 404);
    if (p.creator !== me.id && !admin) return err("Not yours.", 403);
    await env.DB.prepare("update fans_posts set status = 'removed' where id = ?").bind(p.id).run();
    return json({ ok: true });
  }

  /* ---------- browsing ---------- */
  if (route === "creators" && method === "GET") {
    const rows = (await env.DB.prepare("select c.uid, c.name, c.bio, c.price_cents, (select count(*) from fans_posts p where p.creator = c.uid and p.status = 'live') posts from fans_creators c where c.status = 'approved' order by posts desc limit 100").all()).results || [];
    for (const r of rows) { const h = await handleOf(env, r.uid); r.photo = h.p || ""; r.subscribed = await subscribed(env, me.id, r.uid); }
    return json({ creators: rows });
  }
  if (route === "feed" && method === "GET") {
    const who = url.searchParams.get("creator");
    const sql = "select * from fans_posts where status = 'live'" + (who ? " and creator = ?" : "") + " order by created_at desc limit 60";
    const rows = (await (who ? env.DB.prepare(sql).bind(who) : env.DB.prepare(sql)).all()).results || [];
    const names = {}; const out = [];
    for (const p of rows) {
      if (!names[p.creator]) { const c = await creator(env, p.creator); const h = await handleOf(env, p.creator); names[p.creator] = { name: (c && c.name) || h.h || "Creator", photo: h.p || "", price_cents: c ? c.price_cents : 0 }; }
      const see = await canSee(env, me.id, admin, p), media = JSON.parse(p.media || "[]");
      out.push({ id: p.id, creator: p.creator, by: names[p.creator], caption: p.caption, price_cents: p.price_cents, created_at: p.created_at, mine: p.creator === me.id, locked: !see, count: media.length, preview: p.preview, media: see ? await Promise.all(media.map(async (k) => ({ url: await sign(env, k, me.id), video: k.endsWith("-v") }))) : [] });
    }
    return json({ posts: out });
  }

  /* ---------- buying ---------- */
  if (route === "buy" && method === "POST") {
    if (!payOn) return err("Payments for Meechie's Fans open as soon as Meechie's adult payment account is approved.", 501);
    const b = await request.json().catch(() => ({})); const pk = PACKS[b.pack]; if (!pk) return err("Pick a pack.");
    const id = uuid(), price = (pk.cents / 100).toFixed(2), period = "2", cur = "840";
    await env.DB.prepare("insert into fans_orders (id, uid, pack, tokens, cents, at) values (?,?,?,?,?,?)").bind(id, me.id, b.pack, pk.tokens, pk.cents, now()).run();
    const digest = await md5(price + period + cur + env.CCBILL_SALT);
    const q = new URLSearchParams({ clientSubacc: env.CCBILL_SUBACCOUNT, initialPrice: price, initialPeriod: period, currencyCode: cur, formDigest: digest, order: id });
    return json({ url: `https://api.ccbill.com/wap-frontflex/flexforms/${encodeURIComponent(env.CCBILL_FLEX_ID)}?${q}` });
  }
  if (route === "subscribe" && method === "POST") {
    const b = await request.json().catch(() => ({})); const c = await creator(env, String(b.creator)); if (!c || c.status !== "approved") return err("That creator isn't available.");
    if (c.uid === me.id) return err("That's you.");
    if (!(await charge(env, me.id, c.uid, c.price_cents, "sub", c.uid))) return err("not_enough", 402);
    const cur = await env.DB.prepare("select until from fans_subs where fan = ? and creator = ?").bind(me.id, c.uid).first();
    const until = Math.max(now(), (cur && cur.until) || 0) + 30 * 864e5;
    await env.DB.prepare("insert into fans_subs (fan, creator, until) values (?,?,?) on conflict(fan, creator) do update set until = excluded.until").bind(me.id, c.uid, until).run();
    return json({ ok: true, until });
  }
  if (route === "unlock" && method === "POST") {
    const b = await request.json().catch(() => ({})); const p = await env.DB.prepare("select * from fans_posts where id = ? and status = 'live'").bind(String(b.id)).first();
    if (!p || !p.price_cents) return err("Nothing to unlock.");
    if (await canSee(env, me.id, admin, p)) return json({ ok: true });
    if (!(await charge(env, me.id, p.creator, p.price_cents, "unlock", p.id))) return err("not_enough", 402);
    await env.DB.prepare("insert or ignore into fans_unlocks (fan, post_id, at) values (?,?,?)").bind(me.id, p.id, now()).run();
    return json({ ok: true });
  }
  if (route === "tip" && method === "POST") {
    const b = await request.json().catch(() => ({})); const c = await creator(env, String(b.creator)); const n = Math.round(+b.tokens || 0);
    if (!c || c.status !== "approved" || c.uid === me.id || n < 100 || n > 50000) return err("Tips are 100 to 50,000 tokens.");
    if (!(await charge(env, me.id, c.uid, n, "tip", String(b.post || "")))) return err("not_enough", 402);
    return json({ ok: true });
  }
  if (route === "wallet" && method === "GET") {
    const w = await wallet(env, me.id), pend = ((await env.DB.prepare("select coalesce(sum(cents),0) n from fans_cashouts where uid = ? and status = 'requested'").bind(me.id).first()) || {}).n || 0;
    const subs = (await env.DB.prepare("select s.creator, s.until, c.name from fans_subs s join fans_creators c on c.uid = s.creator where s.fan = ? and s.until > ?").bind(me.id, now()).all()).results || [];
    return json({ tokens: w.tokens, earnedCents: w.earned_cents, paidCents: w.paid_cents, pendingCents: pend, availableCents: w.earned_cents - w.paid_cents - pend, subs, payOn, packs: PACKS });
  }
  if (route === "cashout" && method === "POST") {
    const b = await request.json().catch(() => ({})); const m = String(b.method || ""), h = String(b.handle || "").trim().slice(0, 80);
    if (!["Cash App", "PayPal", "Zelle", "Venmo"].includes(m) || h.length < 3) return err("Tell us where to send it.");
    if (/\b\d{3}-?\d{2}-?\d{4}\b|\b\d{12,19}\b/.test(h)) return err("Never send your Social Security or card number.");
    const w = await wallet(env, me.id), pend = ((await env.DB.prepare("select coalesce(sum(cents),0) n from fans_cashouts where uid = ? and status = 'requested'").bind(me.id).first()) || {}).n || 0, avail = w.earned_cents - w.paid_cents - pend;
    if (avail < MIN_CASHOUT) return err("You can cash out once you have $20.");
    const ask = await env.DB.prepare("insert into fans_cashouts (uid, cents, method, handle, at) select ?,?,?,?,? where (select earned_cents - paid_cents from fans_wallet where uid = ?) - (select coalesce(sum(cents),0) from fans_cashouts where uid = ? and status = 'requested') >= ?").bind(me.id, avail, m, h, now(), me.id, me.id, avail).run();
    if (!ask.meta.changes) return err("That cash-out is already on its way.");
    await env.DB.batch([ping(env, me.id, OWNER_ID), dm(env, me.id, OWNER_ID, `💸 Meechie's Fans cash-out: $${(avail / 100).toFixed(2)} by ${m} to ${h}. Pay it, then mark it paid in Fans → Owner.`)]);
    return json({ ok: true, cents: avail });
  }

  /* ---------- safety ---------- */
  if (route === "report" && method === "POST") {
    const b = await request.json().catch(() => ({})); const reason = String(b.reason || "");
    if (!["minor", "consent", "stolen", "other"].includes(reason)) return err("Pick a reason.");
    const p = await env.DB.prepare("select * from fans_posts where id = ?").bind(String(b.id)).first(); if (!p) return err("Not found", 404);
    const st = [env.DB.prepare("insert into fans_reports (post_id, reporter, reason, details, at) values (?,?,?,?,?)").bind(p.id, me.id, reason, String(b.details || "").slice(0, 500), now())];
    if (reason === "minor" || reason === "consent") st.push(env.DB.prepare("update fans_posts set status = 'held' where id = ? and status = 'live'").bind(p.id));
    st.push(ping(env, me.id, OWNER_ID), dm(env, me.id, OWNER_ID, `🚨 Meechie's Fans report (${reason}) on a post. ${reason === "minor" || reason === "consent" ? "It was hidden right away." : ""} Review it in Fans → Owner.`));
    await env.DB.batch(st);
    return json({ ok: true });
  }

  /* ---------- owner ---------- */
  if (parts[0] === "admin") {
    if (!admin) return err("owner_only", 403);
    if (route === "admin" && method === "GET") {
      const apps = (await env.DB.prepare("select * from fans_creators where status = 'pending' order by applied_at").all()).results || [];
      for (const a of apps) { a.id_front_url = await sign(env, a.id_front, me.id, 20); a.id_selfie_url = await sign(env, a.id_selfie, me.id, 20); const h = await handleOf(env, a.uid); a.handle = h.h; a.photo = h.p; }
      const reports = (await env.DB.prepare("select r.*, p.creator, p.status post_status from fans_reports r join fans_posts p on p.id = r.post_id where r.status = 'open' order by r.at desc limit 50").all()).results || [];
      const cash = (await env.DB.prepare("select c.*, f.name from fans_cashouts c left join fans_creators f on f.uid = c.uid where c.status = 'requested' order by c.at").all()).results || [];
      const sum = await env.DB.prepare("select coalesce(sum(case when kind='buy' then cents end),0) sold, coalesce(sum(case when kind like '%_fee' then cents end),0) yours, coalesce(sum(case when kind like '%_earn' then cents end),0) creators from fans_tx").first();
      const creators = (await env.DB.prepare("select uid, name, status, legal_name, dob, applied_at, reviewed_at from fans_creators where status != 'pending' order by reviewed_at desc limit 100").all()).results || [];
      return json({ apps, reports, cashouts: cash, sum, creators, payOn });
    }
    const b = await request.json().catch(() => ({}));
    if (route === "admin/review" && method === "POST") {
      const ok = b.decision === "approve";
      await env.DB.batch([env.DB.prepare("update fans_creators set status = ?, reviewed_at = ?, review_note = ? where uid = ?").bind(ok ? "approved" : "rejected", now(), String(b.note || "").slice(0, 200), String(b.uid)),
        ping(env, OWNER_ID, String(b.uid)), dm(env, OWNER_ID, String(b.uid), ok ? "✅ You're approved as a Meechie's Fans creator! Open Meechie's Fans to set your price and post." : "Your Meechie's Fans application wasn't approved." + (b.note ? " Reason: " + String(b.note).slice(0, 200) : "") + " You can apply again.")]);
      return json({ ok: true });
    }
    if (route === "admin/report" && method === "POST") {
      const r = await env.DB.prepare("select * from fans_reports where id = ?").bind(+b.id).first(); if (!r) return err("Not found", 404);
      await env.DB.batch([env.DB.prepare("update fans_reports set status = 'closed' where post_id = ?").bind(r.post_id), env.DB.prepare("update fans_posts set status = ? where id = ?").bind(b.action === "remove" ? "removed" : "live", r.post_id)]);
      return json({ ok: true });
    }
    if (route === "admin/records" && method === "POST") { // 2257 records for one post (the owner is custodian of records)
      const rel = (await env.DB.prepare("select * from fans_releases where post_id = ?").bind(String(b.post)).all()).results || [];
      for (const r of rel) { r.id_url = await sign(env, r.id_key, me.id, 20); r.release_url = await sign(env, r.release_key, me.id, 20); }
      return json({ releases: rel });
    }
    if (route === "admin/view-post" && method === "POST") {
      const p = await env.DB.prepare("select * from fans_posts where id = ?").bind(String(b.post)).first(); if (!p) return err("Not found", 404);
      return json({ caption: p.caption, media: await Promise.all(JSON.parse(p.media || "[]").map(async (k) => ({ url: await sign(env, k, me.id, 20), video: k.endsWith("-v") }))) });
    }
    if (route === "admin/paid" && method === "POST") {
      const c = await env.DB.prepare("select * from fans_cashouts where id = ? and status = 'requested'").bind(+b.id).first(); if (!c) return err("Not found", 404);
      await env.DB.batch([env.DB.prepare("update fans_cashouts set status = 'paid', paid_at = ? where id = ?").bind(now(), c.id), env.DB.prepare("update fans_wallet set paid_cents = paid_cents + ? where uid = ?").bind(c.cents, c.uid), ping(env, OWNER_ID, c.uid), dm(env, OWNER_ID, c.uid, `✅ Your Meechie's Fans cash-out of $${(c.cents / 100).toFixed(2)} was sent by ${c.method}.`)]);
      return json({ ok: true });
    }
  }
  return err("Not found", 404);
}
