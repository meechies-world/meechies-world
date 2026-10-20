/* POST /api/push  { to }  — free phone notifications ("Web Push") for new messages.
 * Called by the sender's browser right after it sends a message. Checks with Supabase that the sender
 * really just messaged that person, then sends a notification to that person's phones/computers.
 * The notification never includes the message itself, only who it's from.
 * Needs one Cloudflare setting: VAPID_PRIVATE (secret). The matching public key is below and in js/push.js. */
const SB = "https://yjouaysczttqbytksejq.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const PUB = { x: "-eWzdJurdzWhJofBeyOCUgH2QZCJoa7X1DJIscyupfQ", y: "kpjEAbUd7OZYhi9ZYM8WwOCrOczZ3f1jn4GMUNmFQCQ" };
const PUB_RAW = "BPnls3Sbq3c1oSaHwXsjglIB9kGQiaGu19QySLHMrqX0kpjEAbUd7OZYhi9ZYM8WwOCrOczZ3f1jn4GMUNmFQCQ";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const b = atob(s); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const cat = (...a) => { const n = a.reduce((t, x) => t + x.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const enc = (s) => new TextEncoder().encode(s);

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// RFC 8291 (aes128gcm) payload encryption
export async function encrypt(payload, p256dh, auth) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(secret, shared, cat(enc("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc(payload), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
export async function vapid(endpoint, d) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:meechiesworldinc@gmail.com" })));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: PUB.x, y: PUB.y, d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + PUB_RAW;
}
async function sendPush(sub, data, d) {
  const body = await encrypt(JSON.stringify(data), sub.keys.p256dh, sub.keys.auth);
  return fetch(sub.endpoint, { method: "POST", headers: { authorization: await vapid(sub.endpoint, d), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" }, body });
}

export async function onRequestPost({ request, env }) {
  if (!env.VAPID_PRIVATE) return json({ ok: false, error: "Notifications aren't switched on yet." }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false }, 401);
  let to; try { ({ to } = await request.json()); } catch (_) { return json({ ok: false }, 400); }
  if (!/^[0-9a-f-]{36}$/.test(to || "")) return json({ ok: false }, 400);
  const H = { apikey: ANON, authorization: "Bearer " + token };
  const u = await fetch(SB + "/auth/v1/user", { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!u || !u.id || u.id === to) return json({ ok: false }, 401);
  // the sender must have messaged this person in the last 2 minutes (they can only see their own messages)
  const last = await fetch(SB + "/rest/v1/dms?select=created_at&sender=eq." + u.id + "&recipient=eq." + to + "&order=created_at.desc&limit=1", { headers: H }).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(last) || !last[0] || Date.now() - new Date(last[0].created_at).getTime() > 120000) return json({ ok: false, error: "no recent message" }, 403);
  const rows = await fetch(SB + "/rest/v1/docs?select=owner,data,path&path=in.(push/" + to + ",members/" + u.id + ")", { headers: { apikey: ANON } }).then((r) => r.json()).catch(() => []);
  const pushDoc = rows.find((r) => r.path === "push/" + to && r.owner === to);
  const me = rows.find((r) => r.path === "members/" + u.id);
  const subs = (pushDoc && pushDoc.data && Array.isArray(pushDoc.data.subs) ? pushDoc.data.subs : []).filter((s) => s && /^https:\/\//.test(s.endpoint || "") && s.keys && s.keys.p256dh && s.keys.auth).slice(0, 6);
  if (!subs.length) return json({ ok: true, sent: 0 });
  const name = String((me && me.data && me.data.handle) || "Someone").slice(0, 40);
  const data = { title: "💬 " + name + " sent you a message", body: "Tap to read it on Meechie's World", url: "/#messages", tag: "dm-" + u.id };
  const res = await Promise.all(subs.map((s) => sendPush(s, data, env.VAPID_PRIVATE).then((r) => r.status).catch(() => 0)));
  return json({ ok: true, sent: res.filter((s) => s >= 200 && s < 300).length });
}
