// OBS streaming for members, powered by Cloudflare RealtimeKit "independent livestreams".
// This gateway asks Cloudflare for a private RTMPS address + stream key, the streamer pastes
// them into OBS (Stream -> Custom), and viewers watch the HLS playback URL on the Live page.
// The stream key is a secret: it is only ever returned to the member who created it.
//
// GO LIVE STUDIO (2026-10-29): the same gateway also mints RealtimeKit MEETING
// participant tokens for the booth's browser WebRTC studio (action "live_mint").
// The owner (admin) gets a host token for a fresh meeting per publish session;
// anyone who can see the station (signed-in member or guest) gets a view-only
// token for the meeting the booth is publishing to. The API token itself never
// leaves this function — clients only ever receive their own participant token.
//
// The OWNER switches this on by setting three Pages environment variables in the Cloudflare
// dashboard (never in code): REALTIME_ACCOUNT_ID, REALTIME_KIT_APP_ID, REALTIME_API_TOKEN
// (the token needs the Realtime Admin permission). Until then GET answers {configured:false}.
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
import { userFrom, take, isAdmin, randToken } from "../../lib/cf.js";

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

/* The studio app was created in the Cloudflare dashboard, which seeds default
 * presets. Resolve the role preset by name at mint time — preferred names
 * first, then any preset whose name matches the role — so a renamed or missing
 * preset surfaces as a clear "preset" error instead of a silent failure. */
async function pickPreset(c, prefs, rx) {
  const r = await kit(c, "/presets");
  const d = r.data;
  const list = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : null);
  if (!list) return prefs[0]; // preset list unreadable: try the dashboard default name
  const names = list.map((p) => (p && p.name) || "").filter(Boolean);
  for (const want of prefs) if (names.indexOf(want) >= 0) return want;
  return names.find((n) => rx.test(n)) || null;
}

async function addParticipant(c, mid, name, preset, customId) {
  const r = await kit(c, "/meetings/" + mid + "/participants", { method: "POST", body: JSON.stringify({ name, preset_name: preset, custom_participant_id: customId }) });
  if (!r.ok || !r.data) return "";
  return r.data.token || r.data.authToken || "";
}

async function liveMint(request, env, c, me, body) {
  if (body.role === "watch") {
    const mid = String(body.meeting || "");
    if (!/^[A-Za-z0-9-]{8,80}$/.test(mid)) return json({ error: "bad_request" }, 400);
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    if ((await take(env, "kitwatch:" + (me ? me.id : ip), 60, 20)) === false)
      return json({ error: "limit", message: "Too many live joins in a row — give it a minute." }, 429);
    const preset = await pickPreset(c, ["group_call_participant", "webinar_viewer", "livestream_viewer"], /viewer|participant/i);
    if (!preset) return json({ error: "preset", message: "The streaming app is missing a viewer preset — Amani needs to add one in the RealtimeKit dashboard." }, 502);
    const token = await addParticipant(c, mid, me ? "Member" : "Guest", preset, (me ? me.id : "guest") + "-" + randToken(6));
    if (!token) return json({ error: "kit", message: "The streaming service did not hand back a join token. Try again in a moment." }, 502);
    return json({ meeting: mid, token });
  }
  // host: the owner only — this is the one door onto the master screen
  if (!me) return json({ error: "sign_in" }, 401);
  if (!(await isAdmin(env, me.id))) return json({ error: "owner", message: "Only Meechie can start the live video." }, 403);
  if ((await take(env, "kitpub:" + me.id, 3600, 36)) === false)
    return json({ error: "limit", message: "Too many live video starts this hour. Try again later." }, 429);
  const mt = await kit(c, "/meetings", { method: "POST", body: JSON.stringify({ title: "Meechie's World — Live Studio" }) });
  const mid = (mt.ok && mt.data && (mt.data.id || mt.data.meeting_id)) || "";
  if (!mid) return json({ error: "kit", message: "The streaming service could not open the studio. Try again in a moment." }, 502);
  const preset = await pickPreset(c, ["group_call_host", "webinar_presenter", "webinar_host", "livestream_host"], /host|presenter/i);
  if (!preset) return json({ error: "preset", message: "The streaming app is missing a host preset — Amani needs to add one in the RealtimeKit dashboard." }, 502);
  const token = await addParticipant(c, mid, "Meechie", preset, me.id);
  if (!token) return json({ error: "kit", message: "The streaming service did not hand back a join token. Try again in a moment." }, 502);
  return json({ meeting: mid, token, hostId: me.id });
}

export async function onRequestGet({ env }) {
  return json({ configured: !!cfg(env) });
}

export async function onRequestPost({ request, env }) {
  const c = cfg(env);
  if (!c) return json({ error: "setup", message: "OBS streaming isn't switched on yet." }, 501);
  const me = await userFrom(request, env).catch(() => null);
  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);

  if (body.action === "live_mint") return liveMint(request, env, c, me, body);

  if (!me) return json({ error: "sign_in" }, 401);

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
