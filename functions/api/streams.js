// OBS streaming for members, powered by Cloudflare RealtimeKit "independent livestreams".
// This gateway asks Cloudflare for a private RTMPS address + stream key, the streamer pastes
// them into OBS (Stream -> Custom), and viewers watch the HLS playback URL on the Live page.
// The stream key is a secret: it is only ever returned to the member who created it.
//
// The OWNER switches this on by setting three Pages environment variables in the Cloudflare
// dashboard (never in code): REALTIME_ACCOUNT_ID, REALTIME_KIT_APP_ID, REALTIME_API_TOKEN
// (the token needs the Realtime Admin permission). Until then GET answers {configured:false}.
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
import { userFrom, take } from "../../lib/cf.js";

const cfg = (env) => (env.REALTIME_ACCOUNT_ID && env.REALTIME_KIT_APP_ID && env.REALTIME_API_TOKEN)
  ? { base: "https://api.cloudflare.com/client/v4/accounts/" + env.REALTIME_ACCOUNT_ID + "/realtime/kit/" + env.REALTIME_KIT_APP_ID, tok: env.REALTIME_API_TOKEN }
  : null;

async function kit(c, path, opts = {}) {
  try {
    const r = await fetch(c.base + path, { ...opts, headers: { authorization: "Bearer " + c.tok, "content-type": "application/json" } });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && !!(j && j.success), data: (j && (j.data || j.result)) || null };
  } catch (_) { return { ok: false, data: null }; }
}

export async function onRequestGet({ env }) {
  return json({ configured: !!cfg(env) });
}

export async function onRequestPost({ request, env }) {
  const c = cfg(env);
  if (!c) return json({ error: "setup", message: "OBS streaming isn't switched on yet." }, 501);
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return json({ error: "sign_in" }, 401);
  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);

  if (body.action === "create") {
    // a handful of fresh stream keys an hour is plenty, and keeps the free tier safe
    if ((await take(env, "obs:" + me.id, 3600, 5)) === false)
      return json({ error: "limit", message: "Too many stream keys this hour. Try again later." }, 429);
    const name = String(body.title || "Live on Meechie's World").slice(0, 80);
    const r = await kit(c, "/livestreams", { method: "POST", body: JSON.stringify({ name }) });
    if (!r.ok || !r.data || !r.data.id) return json({ error: "cf", message: "Cloudflare couldn't make your stream. Try again in a moment." }, 502);
    const d = r.data;
    return json({ id: d.id, ingest_server: d.ingest_server || "", stream_key: d.stream_key || "", playback_url: d.playback_url || "", status: d.status || "INVOKED" });
  }

  const id = String(body.id || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return json({ error: "bad_request" }, 400);

  if (body.action === "status") {
    const r = await kit(c, "/livestreams");
    const all = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.data) ? r.data.data : []);
    const one = all.find((x) => x && x.id === id);
    if (!one) return json({ error: "gone" }, 404);
    return json({ status: one.status || "IDLE", disabled: !!one.disabled });
  }

  if (body.action === "stop") {
    // end it on Cloudflare's side as well: delete the livestream; if delete isn't accepted, disable it.
    let ok = (await kit(c, "/livestreams/" + id, { method: "DELETE" })).ok;
    if (!ok) ok = (await kit(c, "/livestreams/" + id, { method: "PATCH", body: JSON.stringify({ disabled: true }) })).ok;
    return json({ ok });
  }
  return json({ error: "bad_request" }, 400);
}
