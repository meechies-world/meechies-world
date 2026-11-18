/* Paid sponsor commercials for MW TV (Malik, 2026-11-03: "put paid
 * commercials on my TV channel — I get paid every time people see
 * commercials"). This is the claim → pay → upload → owner-approval
 * pipeline behind /promote and the owner queue at /sponsors.html.
 *
 * Design, plainly:
 * - Claims live in their own D1 table (sponsor_claims), NOT in the
 *   public docs table: a claim carries the sponsor's contact details,
 *   and those are nobody's business but the owner's.
 * - Payment rides the site's EXISTING Stripe rails (the same
 *   STRIPE_SECRET_KEY the Coins checkout uses). A one-time $25/$50
 *   Checkout session per week — weekly is by re-claim, no
 *   subscription was built. Card data never touches this code.
 * - Payment is VERIFIED by reading the Checkout session back from
 *   Stripe server-side (the coins webhook only credits coins and
 *   ignores these sessions by design — they carry no coins metadata).
 *   paidVerified is set ONLY by that read-back.
 * - NOTHING airs from here. Approving a claim (owner-only, below)
 *   moves it to status "approved"; the station keeper
 *   (functions/api/station.js, tvSponsorMaintain) promotes approved
 *   claims into the tv/breakpool rotation after re-checking the gate
 *   (approved + verified payment + real media file) and starts the
 *   paid week at promotion time.
 * - Sponsor media lands in the same Cloudflare KV media store the
 *   site's own upload path uses, under media/sponsors/<claim>.<ext>,
 *   served at /m/media/sponsors/<claim>.<ext>. KV values cap at
 *   25 MB, so uploads cap just under that.
 */
import { json, userFrom, isAdmin, setup, take, uuid, randToken } from "../../../lib/cf.js";
import { creditPurse } from "../../../lib/purse.js";

const err = (m, s = 400) => json({ error: m }, s);
export const SPONSOR_TIERS = {
  free: { cents: 0, label: "Free Week" },
  starter: { cents: 2500, label: "Starter — $25/week" },
  featured: { cents: 5000, label: "Featured — $50/week" },
};
const VIDEO_TYPES = { "video/mp4": "mp4", "video/webm": "webm" };
const AUDIO_TYPES = { "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav" };
const MAX_VIDEO = 24 * 1024 * 1024, MAX_AUDIO = 12 * 1024 * 1024;
const SCHEMA = [
  "create table if not exists sponsor_claims (id text primary key, status text not null, data text not null, created_at integer, updated_at integer)",
  "create index if not exists sponsor_claims_status on sponsor_claims (status, created_at)",
];
let ready = null;
const ensure = (env) => (ready = ready || env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));

const readClaim = async (env, id) => {
  const r = await env.DB.prepare("select data from sponsor_claims where id = ?").bind(id).first();
  if (!r) return null;
  try { return JSON.parse(r.data || "{}"); } catch (_) { return null; }
};
const writeClaim = async (env, c) => {
  await env.DB.prepare("insert into sponsor_claims (id, status, data, created_at, updated_at) values (?, ?, ?, ?, ?) on conflict(id) do update set status = excluded.status, data = excluded.data, updated_at = excluded.updated_at")
    .bind(c.id, c.status, JSON.stringify(c), c.createdAt || Date.now(), Date.now()).run();
};
const authedClaim = async (env, id, token) => {
  if (!id || !token) return null;
  const c = await readClaim(env, id);
  if (!c || !c.token || c.token !== token) return null;
  return c;
};

/* Stripe over fetch, same shape as the Coins function's helper. */
async function stripePost(env, path, form) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((out.error && out.error.message) || ("Stripe " + r.status));
  return out;
}
async function stripeGet(env, path) {
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((out.error && out.error.message) || ("Stripe " + r.status));
  return out;
}

/* If this claim has a Checkout session, read it back from Stripe and
 * fold a completed payment into the claim. The ONLY place
 * paidVerified is ever set. */
async function verifyPayment(env, c) {
  if (!c || c.paidVerified || !c.checkoutSession || !env.STRIPE_SECRET_KEY) return c;
  const tier = SPONSOR_TIERS[c.tier];
  if (!tier || !tier.cents) return c;
  try {
    const s = await stripeGet(env, "checkout/sessions/" + encodeURIComponent(c.checkoutSession));
    if (s && s.payment_status === "paid" && +s.amount_total === tier.cents && s.metadata && s.metadata.claimId === c.id) {
      c.paidVerified = true;
      c.paidAt = Date.now();
      c.amountTotal = +s.amount_total;
      if (c.status === "awaiting-payment") c.status = "awaiting-approval";
      // the purse IS the coin account (Malik, 2026-11-05): this verified
      // sponsor receipt lands in Meechie's purse (1 coin = 1¢ of value).
      // Credited BEFORE the claim write, keyed by the claim id under
      // insert-or-ignore — a retry can never credit the same week twice,
      // and a failed claim write simply re-verifies next read.
      await creditPurse(env, { coins: c.amountTotal, cents: c.amountTotal, source: "sponsor-" + c.tier, ref: "claim:" + c.id, data: { business: c.business, tier: c.tier } });
      await writeClaim(env, c);
    }
  } catch (_) {}
  return c;
}

const publicView = (c) => ({
  claimId: c.id, status: c.status, tier: c.tier, business: c.business, title: c.title || "",
  paidVerified: !!c.paidVerified, hasVideo: !!c.mediaUrl, hasAudio: !!c.audioSrc,
  production: !!c.production, promoted: !!c.poolItemId,
});

export async function onRequest({ request, env, params }) {
  if (!env.DB) return err("Database not connected.", 503);
  await setup(env); await ensure(env);
  const parts = Array.isArray(params.path) ? params.path : [params.path || ""];
  const route = parts.join("/"), method = request.method;
  const url = new URL(request.url);
  const origin = url.origin;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";

  /* ---------- seller: create a claim ---------- */
  if (route === "claim" && method === "POST") {
    if (!(await take(env, "spnclaim:" + ip, 3600, 10))) return err("Too many claims — slow down and try again in a bit.", 429);
    const b = await request.json().catch(() => ({}));
    const business = String(b.business || "").trim().slice(0, 80);
    const contact = String(b.contact || "").trim().slice(0, 120);
    const title = String(b.title || "").trim().slice(0, 120);
    const pitch = String(b.pitch || "").trim().slice(0, 300);
    const tier = SPONSOR_TIERS[b.tier] ? b.tier : null;
    if (!business) return err("Tell us your business name.");
    if (!contact) return err("Give us an email or phone so we can reach you about your spot.");
    if (!tier) return err("Pick a tier: Free Week, Starter or Featured.");
    const c = {
      id: uuid().replace(/-/g, "").slice(0, 16), token: randToken(18),
      business, contact, tier, title, pitch, production: !!b.production,
      status: "created", mediaUrl: "", audioSrc: "", dur: 0, audioDur: 0,
      checkoutSession: "", paidVerified: false, paidAt: 0, amountTotal: 0,
      createdAt: Date.now(), approvedAt: 0, approvedBy: "", promotedAt: 0, poolItemId: "", note: "",
    };
    await writeClaim(env, c);
    return json({ claimId: c.id, token: c.token, status: c.status, tier: c.tier });
  }

  /* ---------- seller: upload the spot (video / optional radio cut) ---------- */
  if (route === "upload" && method === "POST") {
    const c = await authedClaim(env, url.searchParams.get("claim"), url.searchParams.get("token"));
    if (!c) return err("That claim link doesn't check out — start again from /promote.", 403);
    if (["approved", "live", "rejected"].includes(c.status)) return err("This claim is already " + c.status + " — email us to change a live spot.");
    if (!env.MEDIA) return err("File storage isn't connected yet.", 503);
    const kind = url.searchParams.get("kind") === "audio" ? "audio" : "video";
    const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = (kind === "audio" ? AUDIO_TYPES : VIDEO_TYPES)[type];
    if (!ext) return err(kind === "audio" ? "Audio must be MP3, M4A, OGG or WAV." : "Video must be MP4 or WebM.");
    const len = +request.headers.get("content-length") || 0;
    const max = kind === "audio" ? MAX_AUDIO : MAX_VIDEO;
    if (len > max) return err("That file is too big for the upload (" + Math.round(max / 1048576) + " MB max) — export your spot at web quality and try again.");
    const buf = new Uint8Array(await request.arrayBuffer());
    if (!buf.byteLength) return err("Empty file.");
    if (buf.byteLength > max) return err("That file is too big for the upload (" + Math.round(max / 1048576) + " MB max).");
    if (!(await take(env, "spnupl:" + c.id, 3600, 30))) return err("Too many uploads for this claim — slow down.", 429);
    const key = "media/sponsors/" + c.id + (kind === "audio" ? "-audio" : "") + "." + ext;
    await env.MEDIA.put(key, buf, { metadata: { type, size: buf.byteLength } });
    const dur = Math.max(0, Math.min(600, +url.searchParams.get("dur") || 0));
    if (kind === "audio") { c.audioSrc = "/m/" + key; if (dur) c.audioDur = dur; }
    else {
      c.mediaUrl = "/m/" + key; if (dur) c.dur = dur;
      if (c.status === "created") c.status = c.tier === "free" ? "awaiting-approval" : "awaiting-payment";
    }
    await writeClaim(env, c);
    return json({ ok: true, status: c.status, url: "/m/" + key });
  }

  /* ---------- seller: pay for a paid tier (existing Stripe rails) ---------- */
  if (route === "checkout" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const c = await authedClaim(env, b.claimId, b.token);
    if (!c) return err("That claim doesn't check out.", 403);
    const tier = SPONSOR_TIERS[c.tier];
    if (!tier || !tier.cents) return err("The Free Week has no checkout — your spot goes straight to the approval queue once your video is in.");
    if (!c.mediaUrl) return err("Upload your commercial video first, then pay.");
    if (c.paidVerified) return err("This claim is already paid.");
    if (!env.STRIPE_SECRET_KEY) return err("Card payment isn't switched on yet — email meechiesworldinc@gmail.com or call (301) 988-1469 and we'll set your week up by hand.", 501);
    if (!(await take(env, "spnbuy:" + c.id, 3600, 10))) return err("Too many tries — slow down.", 429);
    const s = await stripePost(env, "checkout/sessions", {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(tier.cents),
      "line_items[0][price_data][product_data][name]": "MW TV Sponsor Week — " + (c.tier === "featured" ? "Featured" : "Starter") + " (" + c.business + ")",
      "metadata[claimId]": c.id, "metadata[mw_kind]": "sponsor",
      client_reference_id: c.id,
      success_url: origin + "/promote.html?paid=" + c.id,
      cancel_url: origin + "/promote.html?cancelled=" + c.id,
    }).catch((e) => ({ error: e.message }));
    if (!s || s.error || !s.url) return err("Stripe checkout couldn't start" + (s && s.error ? ": " + s.error : "") + " — try again, or reach us by email/phone.", 502);
    c.checkoutSession = s.id;
    if (c.status === "created" || c.status === "awaiting-approval") c.status = "awaiting-payment";
    await writeClaim(env, c);
    return json({ url: s.url });
  }

  /* ---------- seller: where is my claim? (also folds in payment) ---------- */
  if (route === "status" && method === "GET") {
    let c = await authedClaim(env, url.searchParams.get("claim"), url.searchParams.get("token"));
    if (!c) return err("That claim doesn't check out.", 403);
    c = await verifyPayment(env, c);
    return json(publicView(c));
  }

  /* ---------- owner: approval queue + play tallies ---------- */
  if (route === "admin") {
    const u = await userFrom(request, env);
    if (!u) return err("Sign in first.", 401);
    if (!(await isAdmin(env, u.id))) return err("Owner only.", 403);
    if (method === "GET") {
      const rows = ((await env.DB.prepare("select data from sponsor_claims order by created_at desc limit 200").all()).results) || [];
      const claims = [];
      for (const r of rows) { try { const c = JSON.parse(r.data || "{}"); delete c.token; claims.push(c); } catch (_) {} }
      let poolItems = [];
      const pr = await env.DB.prepare("select data from docs where path = 'tv/breakpool'").first();
      if (pr) { try { const pool = JSON.parse(pr.data || "{}"); poolItems = (pool.items || []).filter((x) => x && x.kind === "sponsor"); } catch (_) {} }
      return json({ claims, poolItems });
    }
    if (method === "POST") {
      const b = await request.json().catch(() => ({}));
      let c = await readClaim(env, String(b.claimId || ""));
      if (!c) return err("No such claim.", 404);
      if (b.action === "approve") {
        c = await verifyPayment(env, c);
        if (c.status !== "awaiting-approval") return err("This claim isn't waiting for approval (status: " + c.status + ").");
        if (!c.mediaUrl) return err("No video uploaded yet — nothing to air.");
        const dur = +b.dur || +c.dur || 0;
        if (!(dur > 0)) return err("Set the spot's length in seconds first (the keeper needs it to schedule the break).");
        c.dur = dur;
        c.status = "approved"; c.approvedAt = Date.now(); c.approvedBy = u.id;
        await writeClaim(env, c);
        return json({ ok: true, status: c.status, note: "Approved. The station keeper puts it into rotation on its next pass and starts its week then." });
      }
      if (b.action === "reject") {
        c.status = "rejected"; c.note = String(b.note || "").slice(0, 300);
        await writeClaim(env, c);
        return json({ ok: true, status: c.status });
      }
      return err("Unknown action.");
    }
  }

  return err("Not found.", 404);
}
