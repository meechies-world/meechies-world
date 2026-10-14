// Visitor alerts for the owner. The site calls this when someone opens it:
//   kind "enter"  - a signed-in member came on the site (sends their name)
//   kind "joined" - a brand-new member just made an account
//   kind "gate"   - someone who isn't signed in is looking at the sign-up screen
// It sends a push notification to the owner's phone through the free ntfy app (ntfy.sh).
// The alert channel (topic) is set from the owner's Visitors panel on the site (saved in site/alerts),
// or in Cloudflare as the NTFY_TOPIC variable. The owner's own visits are never announced.
const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
import { take } from "../../lib/brain.js";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const TOPIC_RE = /^[A-Za-z0-9_-]{12,64}$/;
const cacheKey = (k) => new Request("https://mw-internal.cache/" + k);

async function cacheGet(k) { const r = await caches.default.match(cacheKey(k)); return r ? r.text() : null; }
async function cachePut(k, v, ttl) { await caches.default.put(cacheKey(k), new Response(v, { headers: { "cache-control": "max-age=" + ttl } })); }

export async function onRequestPost({ request, env }) {
  let body = {}; try { body = (await request.json()) || {}; } catch (_) {}
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  // people who aren't signed in can only ever trigger the "someone is on the sign-up screen" alert
  let kind = !auth ? "gate" : ["enter", "joined", "contact"].includes(body.kind) ? body.kind : "enter";
  const ip = request.headers.get("cf-connecting-ip") || "x";
  const ua = request.headers.get("user-agent") || "";
  const device = /iPhone|iPad/i.test(ua) ? "iPhone" : /Android/i.test(ua) ? "Android phone" : /Mobile/i.test(ua) ? "phone" : "computer";
  const svc = env.SUPABASE_SERVICE_ROLE_KEY, SVC = svc ? { apikey: svc, authorization: "Bearer " + svc } : null;
  const getJson = (url, headers) => fetch(url, { headers }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  let uid = null, name = "", H = null;
  if (auth) {
    H = { apikey: SUPABASE_ANON, authorization: "Bearer " + auth };
    const u = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    uid = u && u.id;
    if (!uid) return json({ ok: false, error: "not_signed_in" }, 401);
    const [adm, mem] = await Promise.all([
      getJson(SUPABASE_URL + "/rest/v1/admins?select=user_id&user_id=eq." + uid, H),
      getJson(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq.members/" + uid, H),
    ]);
    if (Array.isArray(adm) && adm.length) { // the owner: remember the alert channel (the owner can always read it), never announce
      const al = await getJson(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq.site/alerts", H);
      const t = al[0] && al[0].data && al[0].data.topic, off = !!(al[0] && al[0].data && al[0].data.off);
      if (TOPIC_RE.test(t || "")) await cachePut("alerts-topic", off ? "off" : t, 86400 * 30).catch(() => {});
      return json({ ok: true, skipped: "owner" });
    }
    name = String((mem[0] && mem[0].data && mem[0].data.handle) || (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || "").slice(0, 40);
    // "new member" only for an account that really was just made (the sign-in system's own date, which members can't change)
    if (kind === "joined" && !(Date.now() - new Date(u.created_at || 0).getTime() < 30 * 60e3)) kind = "enter";
    // "contact info" only if they really just sent Meechie their contact card in Messages
    if (kind === "contact") {
      const own = await getJson(SUPABASE_URL + "/rest/v1/admins?select=user_id&limit=1", H);
      const owner = own[0] && own[0].user_id;
      const since = new Date(Date.now() - 10 * 60e3).toISOString();
      const sent = owner ? await getJson(SUPABASE_URL + "/rest/v1/dms?select=id&sender=eq." + uid + "&recipient=eq." + owner + "&created_at=gte." + encodeURIComponent(since) + "&body=like." + encodeURIComponent("📇*") + "&limit=1", H) : [];
      if (!Array.isArray(sent) || !sent.length) return json({ ok: true, skipped: "no_contact" });
    }
  }

  // the alert channel: Cloudflare setting, else the owner's saved channel (read with the server key), else remembered from the owner's visit
  let topic = TOPIC_RE.test(env.NTFY_TOPIC || "") ? env.NTFY_TOPIC : "", off = false;
  if (SVC || H) {
    const al = await getJson(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq.site/alerts", SVC || H); // members can only read it before lockdown.sql
    const t = al[0] && al[0].data && al[0].data.topic; off = !!(al[0] && al[0].data && al[0].data.off);
    if (!topic && TOPIC_RE.test(t || "")) topic = t;
  }
  if (!topic) { const c = (await cacheGet("alerts-topic").catch(() => null)) || ""; if (c === "off") off = true; else topic = c; }
  if (off) return json({ ok: true, skipped: "alerts_off" });
  if (!TOPIC_RE.test(topic)) return json({ ok: true, skipped: "no_topic" });

  // one alert per person (or per address for visitors who aren't signed in) every 20 minutes, and at most one
  // "visitor" alert a minute in total, so the phone can't be flooded (kept in the database when the server key is set)
  const once = async (k, secs) => { const t = await take(env, null, k, secs, 1); if (t !== null) return t; if (await cacheGet("rl-" + k).catch(() => null)) return false; await cachePut("rl-" + k, "1", secs).catch(() => {}); return true; };
  if (!(await once("visit-" + kind + "-" + (uid || ip), 1200))) return json({ ok: true, skipped: "recent" });
  if (kind === "gate" && !(await once("visit-gate-all", 60))) return json({ ok: true, skipped: "recent" });

  const who = name || "A member";
  const msg = kind === "contact" ? `📇 ${who} just sent you their contact info. Open Messages on the site to see it.`
    : kind === "joined" ? `🎉 New member: ${who} just made an account on Meechie's World (${device}).`
    : kind === "gate" ? `👀 Someone is on the Meechie's World sign-up screen (${device}).`
    : `🔔 ${who} just came on Meechie's World (${device}).`;
  const r = await fetch("https://ntfy.sh/" + topic, {
    method: "POST", body: msg,
    headers: { ...(env.NTFY_TOKEN ? { Authorization: "Bearer " + env.NTFY_TOKEN } : {}), Title: kind === "joined" ? "New member" : kind === "contact" ? "New contact info" : "Someone's on your site", Tags: kind === "joined" ? "tada" : kind === "contact" ? "card_index" : "eyes", Click: "https://meechiesworldinc.com/", Priority: kind === "joined" ? "high" : "default" },
  }).catch(() => null);
  return json({ ok: !!(r && r.ok), status: r ? r.status : 0, info: r && !r.ok ? (await r.text().catch(() => "")).slice(0, 200) : undefined });
}
