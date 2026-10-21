/* Meechie's World Coins: members buy coins (Stripe Checkout), send paid gifts, and the person who
 * receives a gift earns 40% of its value; Meechie keeps 60%. Members ask to cash out their earnings and
 * Meechie pays them himself (Cash App / PayPal / Zelle), then marks the request paid.
 *
 * Owner setup (he enters these himself in Cloudflare → Pages → meechies-world → Settings → Variables and secrets):
 *   STRIPE_SECRET_KEY      his Stripe secret key (sk_live_… or sk_test_… to try it first)
 *   STRIPE_WEBHOOK_SECRET  from Stripe → Developers → Webhooks, endpoint https://meechiesworldinc.com/api/coins/webhook,
 *                          event checkout.session.completed
 * Until STRIPE_SECRET_KEY is set, gifts stay free like before.
 *
 * 1 coin = 1 cent of value. Stripe's card fee comes out of Meechie's 60%. */
import { json, userFrom, isAdmin, setup, take, change, uuid } from "../../../lib/cf.js";

export const PACKS = { p100: { coins: 100, cents: 100 }, p550: { coins: 550, cents: 500 }, p1150: { coins: 1150, cents: 1000 }, p3000: { coins: 3000, cents: 2500 }, p6250: { coins: 6250, cents: 5000 } };
export const GIFT_COINS = { rose: 10, mic: 50, gold: 100, fire: 200, crown: 500, diamond: 1000 };
const MEMBER_SHARE = 0.4;          // the person who receives the gift
const MIN_CASHOUT_CENTS = 2000;    // $20
const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const SCHEMA = [
  "create table if not exists wallets (uid text primary key, coins integer not null default 0, earned_cents integer not null default 0, paid_cents integer not null default 0, updated_at integer)",
  "create table if not exists coin_tx (id text primary key, uid text not null, kind text not null, coins integer not null default 0, cents integer not null default 0, other text, at integer not null)",
  "create index if not exists coin_tx_uid on coin_tx (uid, at)",
  "create table if not exists cashouts (id integer primary key autoincrement, uid text not null, cents integer not null, method text, handle text, status text not null default 'requested', at integer not null, paid_at integer)",
];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const err = (m, s = 400) => json({ error: m }, s);
const wallet = async (env, uid) => (await env.DB.prepare("select coins, earned_cents, paid_cents from wallets where uid = ?").bind(uid).first()) || { coins: 0, earned_cents: 0, paid_cents: 0 };
const pending = async (env, uid) => ((await env.DB.prepare("select coalesce(sum(cents),0) n from cashouts where uid = ? and status = 'requested'").bind(uid).first()) || {}).n || 0;

async function stripe(env, path, form) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { method: "POST", headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error " + r.status); return j;
}
// Stripe signs each webhook: "t=<time>,v1=<hmac-sha256 of `${t}.${body}`>"
async function stripeSigned(env, body, header) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")).filter((x) => x.length === 2 && x[0] !== "v1").map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  const t = +parts.t; if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === mac.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0);
}

export async function onRequest({ request, env, params }) {
  if (!env.DB) return err("Database not connected.", 503);
  await setup(env); await ensure(env);
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/"), method = request.method;
  const paid = !!env.STRIPE_SECRET_KEY;

  // public: is the coin shop on, what things cost
  if (route === "info") return json({ paid, packs: PACKS, gifts: GIFT_COINS, memberShare: MEMBER_SHARE, minCashout: MIN_CASHOUT_CENTS });

  // Stripe → us: a purchase finished
  if (route === "webhook" && method === "POST") {
    const body = await request.text();
    if (!(await stripeSigned(env, body, request.headers.get("stripe-signature")))) return err("bad signature", 400);
    const ev = JSON.parse(body);
    if (ev.type === "checkout.session.completed") {
      const s = ev.data.object, uid = s.metadata && s.metadata.uid, coins = +(s.metadata && s.metadata.coins) || 0;
      if (uid && coins > 0 && s.payment_status === "paid") {
        const now = Date.now();
        const r = await env.DB.prepare("insert or ignore into coin_tx (id, uid, kind, coins, cents, at) values (?,?,?,?,?,?)").bind("cs:" + s.id, uid, "buy", coins, s.amount_total || 0, now).run();
        if (r.meta.changes) await env.DB.prepare("insert into wallets (uid, coins, updated_at) values (?,?,?) on conflict(uid) do update set coins = coins + excluded.coins, updated_at = excluded.updated_at").bind(uid, coins, now).run();
      }
    }
    return json({ received: true });
  }

  const me = await userFrom(request, env);
  if (!me) return err("Sign in first.", 401);
  const admin = await isAdmin(env, me.id);

  if (route === "me" && method === "GET") {
    const w = await wallet(env, me.id), p = await pending(env, me.id);
    const recent = (await env.DB.prepare("select kind, coins, cents, other, at from coin_tx where uid = ? order by at desc limit 30").bind(me.id).all()).results || [];
    const outs = (await env.DB.prepare("select id, cents, method, status, at, paid_at from cashouts where uid = ? order by at desc limit 10").bind(me.id).all()).results || [];
    return json({ paid, coins: w.coins, earnedCents: w.earned_cents, paidOutCents: w.paid_cents, pendingCents: p, availableCents: w.earned_cents - w.paid_cents - p, recent, cashouts: outs });
  }

  if (route === "checkout" && method === "POST") {
    if (!paid) return err("The coin shop isn't switched on yet.", 501);
    if (!(await take(env, "buy:" + me.id, 3600, 20))) return err("Too many tries. Wait a little.", 429);
    const b = await request.json().catch(() => ({})); const pk = PACKS[b.pack]; if (!pk) return err("Pick a coin pack.");
    const origin = new URL(request.url).origin;
    const s = await stripe(env, "checkout/sessions", {
      mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(pk.cents),
      "line_items[0][price_data][product_data][name]": pk.coins + " Meechie's World Coins", "metadata[uid]": me.id, "metadata[coins]": String(pk.coins),
      client_reference_id: me.id, success_url: origin + "/#coins-thanks", cancel_url: origin + "/#coins",
    });
    return json({ url: s.url });
  }

  if (route === "gift" && method === "POST") {
    if (!paid) return err("free_mode", 409);
    if (!(await take(env, "gift:" + me.id, 60, 30))) return err("Slow down a little.", 429);
    const b = await request.json().catch(() => ({}));
    const to = String(b.to || ""), kind = String(b.kind || ""), cost = GIFT_COINS[kind];
    if (!cost) return err("Pick a gift.");
    if (!/^[0-9a-f-]{36}$/.test(to) || to === me.id) return err("You can't send a gift to that person.");
    if (!(await env.DB.prepare("select 1 from docs where path = ?").bind("members/" + to).first())) return err("That member doesn't exist.");
    const note = String(b.note || "").slice(0, 80), now = Date.now(), id = uuid();
    const earn = Math.floor(cost * MEMBER_SHARE);           // coins are cents of value
    // take the coins only if they have enough (one statement, so two taps can't spend the same coins twice)
    const spent = await env.DB.prepare("update wallets set coins = coins - ?, updated_at = ? where uid = ? and coins >= ?").bind(cost, now, me.id, cost).run();
    if (!spent.meta.changes) return err("not_enough_coins", 402);
    const gift = { from: me.id, to, kind, note, coins: cost, paid: true, context: String(b.context || "").slice(0, 20), createdAt: now };
    const gp = "gifts/" + id, iso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare("insert into wallets (uid, earned_cents, updated_at) values (?,?,?) on conflict(uid) do update set earned_cents = earned_cents + excluded.earned_cents, updated_at = excluded.updated_at").bind(to, earn, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gs:" + id, me.id, "gift_sent", -cost, 0, to, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("gr:" + id, to, "gift_received", 0, earn, me.id, now),
      env.DB.prepare("insert into coin_tx (id, uid, kind, coins, cents, other, at) values (?,?,?,?,?,?,?)").bind("go:" + id, OWNER_ID, "gift_fee", 0, cost - earn, me.id, now),
      env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(gp, "gifts", me.id, JSON.stringify(gift), iso, iso),
      change(env, "docs", gp, "gifts"),
    ]);
    const w = await wallet(env, me.id);
    return json({ ok: true, coins: w.coins, gift });
  }

  if (route === "cashout" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const methodName = String(b.method || "").slice(0, 20), handle = String(b.handle || "").trim().slice(0, 80);
    if (!["Cash App", "PayPal", "Zelle", "Venmo"].includes(methodName) || handle.length < 3) return err("Tell us where to send it (Cash App, PayPal, Zelle or Venmo).");
    if (/\b\d{3}-?\d{2}-?\d{4}\b|\b\d{12,19}\b/.test(handle)) return err("Never send your Social Security or card number. Just your $cashtag, PayPal email or Zelle phone/email.");
    const w = await wallet(env, me.id), avail = w.earned_cents - w.paid_cents - (await pending(env, me.id));
    if (avail < MIN_CASHOUT_CENTS) return err("You can cash out once you've earned $" + (MIN_CASHOUT_CENTS / 100).toFixed(0) + ".");
    const now = Date.now();
    await env.DB.prepare("insert into cashouts (uid, cents, method, handle, at) values (?,?,?,?,?)").bind(me.id, avail, methodName, handle, now).run();
    // let Meechie know privately
    await env.DB.batch([
      env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(me.id, OWNER_ID, `💸 Cash-out request: $${(avail / 100).toFixed(2)} by ${methodName} to ${handle}. Pay it, then mark it paid in Coins → Payouts.`, new Date(now).toISOString()),
      change(env, "dms", null, null, me.id, OWNER_ID),
    ]);
    return json({ ok: true, cents: avail });
  }

  // owner only: everything that's been bought and earned, and payouts to make
  if (route === "admin" && method === "GET") {
    if (!admin) return err("owner_only", 403);
    const reqs = (await env.DB.prepare("select c.id, c.uid, c.cents, c.method, c.handle, c.status, c.at, c.paid_at, json_extract(d.data, '$.handle') name from cashouts c left join docs d on d.path = 'members/' || c.uid order by c.status = 'requested' desc, c.at desc limit 100").all()).results || [];
    const sum = await env.DB.prepare("select coalesce(sum(case when kind='buy' then cents end),0) sold, coalesce(sum(case when kind='gift_fee' then cents end),0) yours, coalesce(sum(case when kind='gift_received' then cents end),0) members from coin_tx").first();
    return json({ paid, cashouts: reqs, soldCents: sum.sold, yourShareCents: sum.yours, memberShareCents: sum.members });
  }
  if (route === "admin/paid" && method === "POST") {
    if (!admin) return err("owner_only", 403);
    const b = await request.json().catch(() => ({})); const id = +b.id;
    const row = await env.DB.prepare("select * from cashouts where id = ? and status = 'requested'").bind(id).first(); if (!row) return err("Not found or already paid.", 404);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("update cashouts set status = 'paid', paid_at = ? where id = ?").bind(now, id),
      env.DB.prepare("update wallets set paid_cents = paid_cents + ?, updated_at = ? where uid = ?").bind(row.cents, now, row.uid),
      env.DB.prepare("insert into dms (sender, recipient, body, created_at) values (?,?,?,?)").bind(OWNER_ID, row.uid, `✅ Your cash-out of $${(row.cents / 100).toFixed(2)} was sent by ${row.method}. Thanks for being part of Meechie's World!`, new Date(now).toISOString()),
      change(env, "dms", null, null, OWNER_ID, row.uid),
    ]);
    return json({ ok: true });
  }
  return err("Not found", 404);
}
