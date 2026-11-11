/* Owner's locked API keys (owner, 2026-11-10: "add a place for api secrets").
 * The owner types a key on the API Keys page; it is encrypted here (AES-256-GCM) before it
 * touches the database, and it is NEVER sent back to any browser — pages only ever see the
 * name and the last 4 characters. Server code reads a key with getSecret(env, "NAME").
 * The lock's master key is a Cloudflare secret: SECRETS_KEY if the owner set one, otherwise
 * the existing ID_SALT secret. Without either, nothing is saved (fail closed). */

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const NAME_RE = /^[A-Z][A-Z0-9_]{1,47}$/;

const SCHEMA = `create table if not exists owner_secrets (name text primary key, iv text not null, ct text not null, last4 text not null, note text, updated_at integer not null)`;
let ready = false;
async function setup(env) { if (!ready) { await env.DB.prepare(SCHEMA).run(); ready = true; } }

async function lockKey(env) {
  const master = env.SECRETS_KEY || env.ID_SALT;
  if (!master || String(master).length < 12) throw new Error("no_master_key");
  const base = await crypto.subtle.importKey("raw", enc.encode(String(master)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("meechies-world/owner-secrets/v1"), info: enc.encode("aes-gcm") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function putSecret(env, name, value, note = "") {
  if (!NAME_RE.test(name)) throw new Error("bad_name");
  const v = String(value || "").trim();
  if (v.length < 8 || v.length > 4000) throw new Error("bad_value");
  await setup(env);
  const key = await lockKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // the name is bound in as extra data, so a stored key can't be swapped onto another name
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(name) }, key, enc.encode(v)));
  await env.DB.prepare("insert into owner_secrets (name, iv, ct, last4, note, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(name) do update set iv = excluded.iv, ct = excluded.ct, last4 = excluded.last4, note = excluded.note, updated_at = excluded.updated_at")
    .bind(name, b64(iv), b64(ct), v.slice(-4), String(note || "").slice(0, 120), Date.now()).run();
}

/* Server-side only. A Cloudflare environment secret with the same name wins, so anything the
 * owner already entered in the Cloudflare dashboard keeps working unchanged. */
export async function getSecret(env, name) {
  if (env[name]) return String(env[name]);
  if (!NAME_RE.test(name)) return "";
  await setup(env);
  const row = await env.DB.prepare("select iv, ct from owner_secrets where name = ?").bind(name).first();
  if (!row) return "";
  try {
    const key = await lockKey(env);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv), additionalData: enc.encode(name) }, key, unb64(row.ct));
    return dec.decode(pt);
  } catch (_) { return ""; }
}

/* Hand server code an env where keys the owner locked in on the API Keys page fill any gap
 * the Cloudflare dashboard leaves. Dashboard secrets always win. One small query per request. */
export async function withVault(env, names) {
  try {
    const missing = names.filter((n) => !env[n] && NAME_RE.test(n));
    if (!missing.length || !env.DB) return env;
    const extra = {};
    for (const n of missing) { const v = await getSecret(env, n); if (v) extra[n] = v; }
    return Object.keys(extra).length ? { ...env, ...extra } : env;
  } catch (_) { return env; }
}

export async function listSecrets(env) {
  await setup(env);
  const { results } = await env.DB.prepare("select name, last4, note, updated_at from owner_secrets order by name").all();
  return (results || []).map((r) => ({ name: r.name, hint: "••••" + r.last4, note: r.note || "", updated_at: r.updated_at, where: "vault" }));
}

export async function deleteSecret(env, name) {
  if (!NAME_RE.test(name)) throw new Error("bad_name");
  await setup(env);
  await env.DB.prepare("delete from owner_secrets where name = ?").bind(name).run();
}

/* Names the site knows how to use, shown as suggestions on the API Keys page. Values are
 * never listed — only whether each one is set, and where (vault or Cloudflare dashboard). */
export const KNOWN = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)", use: "Turns on Meechie's deep-thinking brain and Double-check." },
  { name: "TAVILY_API_KEY", label: "Tavily search", use: "Sharper web search for Meechie's answers." },
  { name: "OPENAI_API_KEY", label: "OpenAI (ChatGPT)", use: "Saved for a ChatGPT brain. Not wired up yet." },
  { name: "ELEVENLABS_API_KEY", label: "ElevenLabs", use: "Saved for studio voiceovers. Not wired up yet." },
  { name: "TWILIO_AUTH_TOKEN", label: "Twilio auth token", use: "Meechie's business phone line." },
];
