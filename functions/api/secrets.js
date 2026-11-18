// /api/secrets — the owner's API Keys page. Owner only. Saves and removes keys; never returns one.
import { userFrom, isAdmin, take } from "../../lib/cf.js";
import { putSecret, listSecrets, deleteSecret, KNOWN, NAME_RE } from "../../lib/secrets.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function owner(request, env) {
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return { err: json({ error: "sign_in" }, 401) };
  if (!(await isAdmin(env, me.id).catch(() => false))) return { err: json({ error: "owner_only" }, 403) };
  return { me };
}

export async function onRequestGet({ request, env }) {
  const o = await owner(request, env); if (o.err) return o.err;
  const vault = await listSecrets(env);
  const have = new Set(vault.map((s) => s.name));
  const known = KNOWN.map((k) => ({ ...k, set: have.has(k.name) ? "vault" : env[k.name] ? "cloudflare" : "" }));
  return json({ keys: vault, known, lock: !!(env.SECRETS_KEY || env.ID_SALT) });
}

export async function onRequestPost({ request, env }) {
  const o = await owner(request, env); if (o.err) return o.err;
  if (!(await take(env, "secrets:" + o.me.id, 3600, 30))) return json({ error: "limit", message: "Too many changes this hour. Try again later." }, 429);
  let b; try { b = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const name = String(b && b.name || "").trim().toUpperCase();
  if (!NAME_RE.test(name)) return json({ error: "bad_name", message: "Use capital letters, numbers and _ only, like OPENAI_API_KEY." }, 400);
  try {
    if (b.remove === true) { await deleteSecret(env, name); return json({ ok: true, removed: name }); }
    await putSecret(env, name, b.value, b.note);
    return json({ ok: true, saved: name });
  } catch (e) {
    const m = String(e && e.message || e);
    if (m === "no_master_key") return json({ error: "no_lock", message: "The lock isn't set up yet. In Cloudflare → meechies-world → Settings → Variables and secrets, add a secret named SECRETS_KEY (any long random phrase), then try again." }, 503);
    if (m === "bad_value") return json({ error: "bad_value", message: "That key looks too short or too long." }, 400);
    return json({ error: "save_failed" }, 500);
  }
}
