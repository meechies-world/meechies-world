/* Meechie's World — DJ setup subscriptions. Members pay for their own DJ
 * setup tiers (Tables $10/mo, +YouTube search $15/mo, +Save sessions
 * $20/mo) through the SAME Stripe rails the coin shop already runs on:
 * this Pages Function calls Stripe's API directly with the owner's
 * STRIPE_SECRET_KEY (entered by him in Cloudflare in Oct 2026 for Coins).
 * No connector, no Payment Links, no CCBill. The DJ Video Package ($35)
 * stays "coming soon" by the owner's ruling (2026-11-02): there is
 * deliberately NO checkout for tier 35 in this file.
 *
 * Owner setup (Cloudflare → Pages → meechies-world → Settings → Variables and secrets):
 *   STRIPE_SECRET_KEY        already set for Coins — reused as-is.
 *   STRIPE_DJ_WEBHOOK_SECRET optional. The webhook endpoint itself is created
 *                            from INSIDE the site (POST /api/dj/setup-webhook,
 *                            owner session only — the "Connect the Stripe
 *                            signal" button on the plans card), because the
 *                            owner cannot sign in to the Stripe Dashboard
 *                            from his browser. No dashboard step exists.
 *
 * Webhook verification has two modes, chosen by what the environment holds:
 *   (a) a signing secret is set (STRIPE_DJ_WEBHOOK_SECRET, falling back to
 *       STRIPE_WEBHOOK_SECRET) → classic HMAC signature verification;
 *   (b) no signing secret → RE-FETCH verification: the posted body is
 *       trusted for its event id ONLY; the event is fetched back from
 *       Stripe with STRIPE_SECRET_KEY and only the FETCHED object is
 *       processed. A forged post can name only an id Stripe itself must
 *       confirm exists, so the two modes are equally forgery-proof.
 * Until STRIPE_SECRET_KEY is set, checkout refuses cleanly (501), exactly
 * like the coin shop.
 *
 * Trial conversion v1 = PAY-TO-CONTINUE (DJ_CONFIG.trial_conversion):
 * nobody is ever auto-charged when the 7-day free trial ends; the member
 * picks a plan to keep the tier. The flag is data, so the owner can rule
 * it flipped later without hunting through behavior code.
 *
 * Entitlement discipline: setup_tier on members/<uid> is a server-locked
 * field (lib/cf.js lockFields) — a member can never write it from the
 * client; ONLY this webhook writes it, always with the mandatory changes
 * row (change() in lib/cf.js), and every applied Stripe event lands in
 * the dj_sub_events ledger first so a replayed delivery can never
 * re-apply stale state.
 *
 * Failed-payment policy (v1): the tier follows the subscription's own
 * Stripe status. past_due keeps the plan while Stripe retries the card
 * (the status is recorded on the member doc); unpaid / canceled /
 * incomplete_expired / subscription deleted take the tier back to free. */
import { json, userFrom, setup, take, change } from "../../../lib/cf.js";

export const DJ_TIERS = {
  10: { cents: 1000, name: "Meechie's World DJ Setup — Tables" },
  15: { cents: 1500, name: "Meechie's World DJ Setup — Tables + YouTube Search" },
  20: { cents: 2000, name: "Meechie's World DJ Setup — Tables + YouTube Search + Save Sessions" },
};
export const DJ_CONFIG = { trial_conversion: "pay-to-continue" };
export const OWNER_UID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9"; // Meechie — the only session that may connect the Stripe signal
export const WEBHOOK_URL = "https://meechiesworldinc.com/api/dj/webhook";
export const WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed"];
const SUB_LIVE = ["active", "trialing", "past_due"]; // a subscription in one of these states blocks a second checkout
const SCHEMA = [
  "create table if not exists dj_sub_events (id text primary key, uid text, kind text, at integer not null)",
];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));
const err = (m, s = 400) => json({ error: m }, s);

/* ---------- Stripe helpers: the coin shop's pattern, verbatim shape ---------- */
async function stripe(env, path, form) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { method: "POST", headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error " + r.status); return j;
}
async function stripeGet(env, path) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error " + r.status); return j;
}
const webhookSecret = (env) => env.STRIPE_DJ_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET || null;
// Stripe signs each webhook: "t=<time>,v1=<hmac-sha256 of `${t}.${body}`>"
async function stripeSigned(env, body, header) {
  const secret = webhookSecret(env);
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")).filter((x) => x.length === 2 && x[0] !== "v1").map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  const t = +parts.t; if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === mac.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ mac.charCodeAt(i)), 0) === 0);
}

/* ---------- member doc: the one door that writes setup_tier ---------- */
const memberDoc = async (env, uid) => {
  const r = await env.DB.prepare("select data from docs where path = ?").bind("members/" + uid).first();
  if (!r) return null;
  try { return JSON.parse(r.data || "{}"); } catch (_) { return null; }
};
// doc update + the mandatory changes row, in one batch
async function applySub(env, uid, patch) {
  const path = "members/" + uid;
  const data = await memberDoc(env, uid); if (!data) return false;
  Object.assign(data, patch);
  await env.DB.batch([
    env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), new Date().toISOString(), path),
    change(env, "docs", path, "members"),
  ]);
  return true;
}
// idempotency ledger: true only the first time an event key is seen
const ledger = async (env, id, uid, kind) => {
  const r = await env.DB.prepare("insert or ignore into dj_sub_events (id, uid, kind, at) values (?,?,?,?)").bind(id, uid || null, kind, Date.now()).run();
  return !!(r.meta && r.meta.changes);
};

/* ---------- Stripe → us: subscription lifecycle ---------- */
// Applies one VERIFIED Stripe event. Both verification modes below hand
// this function an event object that came from Stripe itself — either the
// HMAC-signed body or the event re-fetched from Stripe's API — never raw
// unverified post data.
async function processEvent(env, ev) {
  const obj = (ev.data && ev.data.object) || {};

  if (ev.type === "checkout.session.completed") {
    const md = obj.metadata || {};
    // only DJ setup sessions are ours; anything else (coin packs, if an
    // event ever lands here by mistake) is acknowledged and ignored
    if (md.kind === "dj_setup" && obj.payment_status === "paid") {
      const uid = md.uid || obj.client_reference_id, tier = +md.tier || 0;
      if (uid && DJ_TIERS[tier] && (await ledger(env, "cs:" + obj.id, uid, "checkout"))) {
        await applySub(env, uid, { setup_tier: tier, dj_customer: obj.customer || null, dj_sub_id: obj.subscription || null, dj_sub_status: "active" });
      }
    }
    return json({ received: true });
  }

  if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
    const md = obj.metadata || {};
    if (md.kind === "dj_setup" && md.uid) {
      const tier = +md.tier || 0;
      const st = ev.type === "customer.subscription.deleted" ? "canceled" : String(obj.status || "");
      // one ledger row per (subscription, status, tier): replays are no-ops,
      // but a real later transition (past_due → active, active → canceled) applies
      if (await ledger(env, "sub:" + obj.id + ":" + st + ":" + tier, md.uid, ev.type)) {
        if ((st === "active" || st === "trialing") && DJ_TIERS[tier]) {
          await applySub(env, md.uid, { setup_tier: tier, dj_customer: obj.customer || null, dj_sub_id: obj.id, dj_sub_status: st });
        } else if (st === "past_due") {
          // Stripe is still retrying the card: record it, keep the plan
          await applySub(env, md.uid, { dj_customer: obj.customer || null, dj_sub_id: obj.id, dj_sub_status: st });
        } else {
          // canceled / unpaid / incomplete_expired / paused / ended: back to free
          await applySub(env, md.uid, { setup_tier: 0, dj_customer: obj.customer || null, dj_sub_id: obj.id, dj_sub_status: st || "ended" });
        }
      }
    }
    return json({ received: true });
  }

  if (ev.type === "invoice.payment_failed") {
    // Recorded for the trail only — the tier itself follows the
    // subscription's status, delivered by customer.subscription.updated.
    if (obj.id) await ledger(env, "invfail:" + obj.id, null, ev.type);
    return json({ received: true });
  }

  return json({ received: true });
}

async function onWebhook(env, request) {
  const body = await request.text();
  // Mode (a): a signing secret is configured — classic HMAC verification,
  // exactly as this endpoint has always worked.
  if (webhookSecret(env)) {
    if (!(await stripeSigned(env, body, request.headers.get("stripe-signature")))) return err("bad signature", 400);
    let ev; try { ev = JSON.parse(body); } catch (_) { return err("bad event", 400); }
    return processEvent(env, ev);
  }
  // Mode (b): RE-FETCH verification. The posted body is read for its event
  // id ONLY; the event is then fetched back from Stripe with the secret
  // key and only the FETCHED object is processed. A forged post can name
  // only an id Stripe itself must confirm exists, and a tampered body
  // changes nothing — the body is never processed.
  if (!env.STRIPE_SECRET_KEY) return err("webhook not configured", 400);
  let posted; try { posted = JSON.parse(body); } catch (_) { return err("bad event", 400); }
  const id = posted && typeof posted.id === "string" ? posted.id : "";
  if (!/^evt_[A-Za-z0-9_]+$/.test(id)) return err("unknown event", 404);
  let ev; try { ev = await stripeGet(env, "events/" + encodeURIComponent(id)); } catch (_) { return err("unknown event", 404); }
  if (!ev || ev.id !== id || !WEBHOOK_EVENTS.includes(ev.type)) return err("unknown event", 404);
  return processEvent(env, ev);
}

/* ---------- inside-out webhook setup (owner tap, no dashboard) ---------- */
// The setup state doc + its mandatory changes row (writeDoc pattern from
// station.js: update, insert-if-missing, change feed row — one batch here).
async function recordSetupDoc(env, state) {
  const path = "dj/webhook", nowIso = new Date().toISOString();
  const data = JSON.stringify(state);
  await env.DB.batch([
    env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, "dj", null, data, nowIso, nowIso),
    env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, path),
    change(env, "docs", path, "dj"),
  ]);
}
// Owner-only: make sure the Stripe webhook endpoint for this site exists
// with exactly our four events, talking to Stripe with the site key.
// The endpoint secret Stripe returns at creation is deliberately discarded
// — re-fetch verification never needs it, and no secret is ever stored,
// returned, or logged by this route.
async function onSetupWebhook(env, me) {
  if (me.id !== OWNER_UID) return err("Only Meechie can connect the Stripe signal.", 403);
  if (!env.STRIPE_SECRET_KEY) return err("DJ plan payments aren't switched on yet.", 501);
  const mode = webhookSecret(env) ? "env-secret" : "refetch";
  let list; try { list = await stripeGet(env, "webhook_endpoints?limit=100"); } catch (_) { return err("Payments didn't answer — tap it once more.", 502); }
  const found = ((list && list.data) || []).find((e) => e && e.url === WEBHOOK_URL);
  const eventForm = Object.fromEntries(WEBHOOK_EVENTS.map((e, i) => [`enabled_events[${i}]`, e]));
  let endpointId, created = false, updated = false;
  try {
    if (found) {
      endpointId = found.id;
      const have = Array.isArray(found.enabled_events) ? found.enabled_events : [];
      if (!(have.includes("*") || WEBHOOK_EVENTS.every((e) => have.includes(e)))) {
        await stripe(env, "webhook_endpoints/" + encodeURIComponent(found.id), eventForm);
        updated = true;
      }
    } else {
      const ep = await stripe(env, "webhook_endpoints", { url: WEBHOOK_URL, description: "Meechie's World DJ setup subscriptions", ...eventForm });
      endpointId = ep.id; created = true; // ep.secret intentionally not read
    }
  } catch (_) { return err("Payments didn't answer — tap it once more.", 502); }
  await recordSetupDoc(env, { endpointId, mode, at: Date.now() });
  return json({ ok: true, connected: true, already: !created, created, updated, endpointId, mode });
}

export async function onRequest({ request, env, params }) {
  if (!env.DB) return err("Database not connected.", 503);
  await setup(env); await ensure(env);
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/"), method = request.method;
  const paid = !!env.STRIPE_SECRET_KEY;

  // public: are DJ plan payments on, what the tiers cost, the conversion rule
  if (route === "info") return json({ paid, tiers: Object.fromEntries(Object.entries(DJ_TIERS).map(([t, v]) => [t, v.cents])), conversion: DJ_CONFIG.trial_conversion });

  if (route === "webhook" && method === "POST") return onWebhook(env, request);

  const me = await userFrom(request, env);
  if (!me) return err("Sign in first.", 401);

  if (route === "checkout" && method === "POST") {
    if (!paid) return err("DJ plan payments aren't switched on yet.", 501);
    if (!(await take(env, "djbuy:" + me.id, 3600, 20))) return err("Too many tries. Wait a little.", 429);
    const b = await request.json().catch(() => ({}));
    const tier = +b.tier || 0, T = DJ_TIERS[tier];
    if (!T) return err("Pick a plan."); // tier 35 lands here too: coming soon means no checkout, by the owner's ruling
    const doc = await memberDoc(env, me.id);
    if (doc && (+doc.setup_tier || 0) >= 10 && SUB_LIVE.includes(String(doc.dj_sub_status || ""))) return err("already_on_a_plan", 409);
    const origin = new URL(request.url).origin;
    let s;
    try {
      s = await stripe(env, "checkout/sessions", {
        mode: "subscription", "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(T.cents),
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": T.name,
        "metadata[uid]": me.id, "metadata[tier]": String(tier), "metadata[kind]": "dj_setup",
        "subscription_data[metadata][uid]": me.id, "subscription_data[metadata][tier]": String(tier), "subscription_data[metadata][kind]": "dj_setup",
        client_reference_id: me.id, success_url: origin + "/?playdj=1#radio", cancel_url: origin + "/?playdj=1#radio",
      });
    } catch (_) { return err("Payments didn't answer — tap it once more.", 502); }
    return json({ url: s.url });
  }

  if (route === "portal" && method === "POST") {
    if (!paid) return err("DJ plan payments aren't switched on yet.", 501);
    const doc = await memberDoc(env, me.id);
    if (!doc || !doc.dj_customer) return err("No plan to manage yet.", 404);
    const origin = new URL(request.url).origin;
    let s;
    try {
      s = await stripe(env, "billing_portal/sessions", { customer: doc.dj_customer, return_url: origin + "/?playdj=1#radio" });
    } catch (_) { return err("Payments didn't answer — tap it once more.", 502); }
    return json({ url: s.url });
  }

  // owner-only one-time setup: create/confirm the Stripe webhook endpoint
  // from inside the site (no dashboard — see onSetupWebhook)
  if (route === "setup-webhook" && method === "POST") return onSetupWebhook(env, me);

  return err("Not found", 404);
}
