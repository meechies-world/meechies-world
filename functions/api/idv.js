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
  // ID checks are PAUSED (2026-10-27): this endpoint still authenticates through
  // the retired Supabase backend, so with the site on Cloudflare-native sessions
  // every start failed (401) and members were trapped at the check with no way
  // through. Until idv is migrated to lib/cf.js auth + D1, report not_set_up so
  // verify.js takes its designed path: age step done = member is all set.
  return json({ error: "not_set_up" }, 501);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "not_set_up" }, 501);
  const m = await member(request); if (!m) return json({ error: "sign_in" }, 401);
  const origin = new URL(request.url).origin;
  const body = new URLSearchParams({ type: "document", "options[document][require_matching_selfie]": "true", "options[document][require_live_capture]": "true", "metadata[uid]": m.id, return_url: origin + "/?idv=done#home" });
  const vs = await stripe(env, "identity/verification_sessions", { method: "POST", body });
  if (!vs || !vs.url) return json({ error: "stripe", detail: vs && vs.error && vs.error.message }, 502);
  return json({ id: vs.id, url: vs.url });
}

export async function onRequestGet({ request, env }) {
  // ID checks are PAUSED (2026-10-27): this endpoint still authenticates through
  // the retired Supabase backend, so with the site on Cloudflare-native sessions
  // every start failed (401) and members were trapped at the check with no way
  // through. Until idv is migrated to lib/cf.js auth + D1, report not_set_up so
  // verify.js takes its designed path: age step done = member is all set.
  return json({ error: "not_set_up" }, 501);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "not_set_up" }, 501);
  const m = await member(request); if (!m) return json({ error: "sign_in" }, 401);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^vs_[A-Za-z0-9]+$/.test(id)) return json({ error: "bad_id" }, 400);
  const vs = await stripe(env, "identity/verification_sessions/" + id);
  if (!vs || !vs.id || !vs.metadata || vs.metadata.uid !== m.id) return json({ error: "not_found" }, 404);
  if (vs.status === "verified") {
    // Only the server may set the badge (supabase/lockdown.sql), so this needs the SUPABASE_SERVICE_ROLE_KEY secret in Cloudflare.
    // (Until that secret is added, it falls back to the member's own sign-in, which works only before lockdown.sql is run.)
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    const H = key ? { apikey: key, authorization: "Bearer " + key } : { apikey: SUPABASE_ANON, authorization: "Bearer " + m.token };
    // One account per person: a one-way fingerprint of the ID (country + type + document number, or name + birthday)
    // is kept. The fingerprint can't be turned back into the ID. If the same ID was already used on another account,
    // this account is not verified.
    const fp = await fingerprint(env, vs).catch(() => null);
    if (fp && key) {
      const lock = "idlocks/" + fp;
      const got = await fetch(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq." + encodeURIComponent(lock), { headers: H }).then((r) => r.json()).catch(() => []);
      const owner = Array.isArray(got) && got[0] && got[0].data && got[0].data.uid;
      if (owner && owner !== m.id) {
        await patch(H, m.id, { idVerified: false, idDuplicate: true, idDuplicateAt: Date.now() });
        return json({ status: "duplicate" });
      }
      if (!owner) await fetch(SUPABASE_URL + "/rest/v1/rpc/set_doc", { method: "POST", headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ p_path: lock, p_coll: "idlocks", p_data: { uid: m.id, at: Date.now() } }) }).catch(() => null);
    }
    const w = await patch(H, m.id, { idVerified: true, idVerifiedAt: Date.now(), idDuplicate: false });
    return json({ status: vs.status, saved: !!(w && w.ok) });
  }
  return json({ status: vs.status });
}

const patch = (H, uid, p) => fetch(SUPABASE_URL + "/rest/v1/rpc/merge_doc", { method: "POST", headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify({ p_path: "members/" + uid, p_patch: p }) }).catch(() => null);

// A salted SHA-256 of the ID details Stripe verified. Uses the document number when Stripe returns it, otherwise name + birthday.
async function fingerprint(env, vs) {
  const rid = vs.last_verification_report; if (!rid) return null;
  const rep = await stripe(env, "identity/verification_reports/" + (typeof rid === "string" ? rid : rid.id) + "?expand[]=document.number&expand[]=document.dob");
  const d = rep && rep.document; if (!d) return null;
  const n = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const dob = d.dob ? [d.dob.year, d.dob.month, d.dob.day].join("-") : "";
  const raw = d.number ? ["doc", n(d.issuing_country), n(d.type), n(d.number)].join("|") : (d.last_name && dob ? ["person", n(d.first_name), n(d.last_name), dob].join("|") : "");
  if (!raw) return null;
  const salt = env.ID_SALT || env.SUPABASE_SERVICE_ROLE_KEY || "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
