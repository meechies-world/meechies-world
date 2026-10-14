// ID verification with Stripe Identity (government ID + matching selfie, checked by Stripe).
// Turn it on by adding STRIPE_SECRET_KEY in Cloudflare (Settings -> Variables). Stripe charges per check.
// POST /api/idv           -> starts a check, returns Stripe's secure page to send the member to
// GET  /api/idv?id=vs_... -> the result of that member's check (verified / processing / requires_input)
// The member's ID images stay with Stripe; Meechie's World only saves "ID verified: yes".
import { SUPABASE_URL, SUPABASE_ANON } from "../../lib/brain.js";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function member(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? { id: u.id, token } : null;
}
const stripe = (env, path, init = {}) => fetch("https://api.stripe.com/v1/" + path, { ...init, headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded", ...(init.headers || {}) } }).then((r) => r.json());

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "not_set_up" }, 501);
  const m = await member(request); if (!m) return json({ error: "sign_in" }, 401);
  const origin = new URL(request.url).origin;
  const body = new URLSearchParams({ type: "document", "options[document][require_matching_selfie]": "true", "options[document][require_live_capture]": "true", "metadata[uid]": m.id, return_url: origin + "/?idv=done#home" });
  const vs = await stripe(env, "identity/verification_sessions", { method: "POST", body });
  if (!vs || !vs.url) return json({ error: "stripe", detail: vs && vs.error && vs.error.message }, 502);
  return json({ id: vs.id, url: vs.url });
}

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "not_set_up" }, 501);
  const m = await member(request); if (!m) return json({ error: "sign_in" }, 401);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^vs_[A-Za-z0-9]+$/.test(id)) return json({ error: "bad_id" }, 400);
  const vs = await stripe(env, "identity/verification_sessions/" + id);
  if (!vs || !vs.id || !vs.metadata || vs.metadata.uid !== m.id) return json({ error: "not_found" }, 404);
  if (vs.status === "verified") { // record it on the member's profile (no ID details are stored)
    await fetch(SUPABASE_URL + "/rest/v1/rpc/merge_doc", { method: "POST", headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + m.token, "content-type": "application/json" },
      body: JSON.stringify({ p_path: "members/" + m.id, p_patch: { idVerified: true, idVerifiedAt: Date.now() } }) }).catch(() => {});
  }
  return json({ status: vs.status });
}
