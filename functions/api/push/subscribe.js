/* /api/push/subscribe — the DOORBELL subscription book (owner, 2026-10-29).
 * The owner taps the Doorbell control in the booth's Door panel once; his
 * phone's Web Push subscription lands here, and functions/api/station.js
 * rings it the second someone new lands on the site. Owner-session only:
 * the caller's site session must be Meechie himself. (Members' own message
 * notifications are a different book — the older push/<uid> docs, served by
 * /api/push — and are not touched by anything in this file.)
 * Storage: one doc per subscription at pushsubs/<sha256(endpoint)[:32]> in
 * D1, written with its changes row like every server doc write. POST adds
 * or refreshes one, DELETE removes one, GET counts them (the control
 * paints its on/off state from the count, never from a device-local
 * guess). The VAPID private half is never here — it stays in the Pages
 * secrets and is only ever read by the senders. */
import { json, setup, change, sha256hex, userFrom } from "../../../lib/cf.js";

const OWNER = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
const B64U = /^[A-Za-z0-9_-]+$/;

async function ownerOnly(request, env) {
  await setup(env);
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return { err: json({ ok: false, error: "no_session" }, 401) };
  if (me.id !== OWNER) return { err: json({ ok: false, error: "owner_only" }, 403) };
  return { me };
}
const subPath = async (endpoint) => "pushsubs/" + (await sha256hex(endpoint)).slice(0, 32);

function cleanSub(b) {
  const s = b && (b.subscription || b);
  const endpoint = String((s && s.endpoint) || "");
  const keys = (s && s.keys) || {};
  const p256dh = String(keys.p256dh || ""), auth = String(keys.auth || "");
  if (!/^https:\/\/[^\s]{10,990}$/.test(endpoint)) return null;
  if (!B64U.test(p256dh) || p256dh.length < 80 || p256dh.length > 120) return null;
  if (!B64U.test(auth) || auth.length < 16 || auth.length > 60) return null;
  return { endpoint, keys: { p256dh, auth } };
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const o = await ownerOnly(request, env); if (o.err) return o.err;
  let b = null; try { b = await request.json(); } catch (_) {}
  const sub = cleanSub(b);
  if (!sub) return json({ ok: false, error: "bad_subscription" }, 400);
  const path = await subPath(sub.endpoint);
  const nowIso = new Date().toISOString();
  const data = { endpoint: sub.endpoint, keys: sub.keys, ua: (request.headers.get("user-agent") || "").slice(0, 160), at: Date.now() };
  await env.DB.batch([
    env.DB.prepare("insert into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?) on conflict(path) do update set data = excluded.data, updated_at = excluded.updated_at").bind(path, "pushsubs", OWNER, JSON.stringify(data), nowIso, nowIso),
    change(env, "docs", path, "pushsubs"),
  ]);
  return json({ ok: true, path });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const o = await ownerOnly(request, env); if (o.err) return o.err;
  let b = null; try { b = await request.json(); } catch (_) {}
  const endpoint = String((b && (b.endpoint || (b.subscription && b.subscription.endpoint))) || "");
  if (!/^https:\/\/[^\s]{10,990}$/.test(endpoint)) return json({ ok: false, error: "bad_endpoint" }, 400);
  const path = await subPath(endpoint);
  await env.DB.batch([
    env.DB.prepare("delete from docs where path = ?").bind(path),
    change(env, "docs", path, "pushsubs"),
  ]);
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const o = await ownerOnly(request, env); if (o.err) return o.err;
  const r = await env.DB.prepare("select count(*) as n from docs where coll = 'pushsubs'").first();
  return json({ ok: true, subs: (r && r.n) || 0 });
}
