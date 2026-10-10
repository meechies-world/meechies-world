// Visitor alerts for the owner. The site calls this when someone opens it:
//   kind "enter"  - a signed-in member came on the site (sends their name)
//   kind "joined" - a brand-new member just made an account
//   kind "gate"   - someone who isn't signed in is looking at the sign-up screen
// It sends a push notification to the owner's phone through the free ntfy app (ntfy.sh).
// The alert channel (topic) is set from the owner's Visitors panel on the site (saved in site/alerts),
// or in Cloudflare as the NTFY_TOPIC variable. The owner's own visits are never announced.
const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const TOPIC_RE = /^[A-Za-z0-9_-]{12,64}$/;
const cacheKey = (k) => new Request("https://mw-internal.cache/" + k);

async function cacheGet(k) { const r = await caches.default.match(cacheKey(k)); return r ? r.text() : null; }
async function cachePut(k, v, ttl) { await caches.default.put(cacheKey(k), new Response(v, { headers: { "cache-control": "max-age=" + ttl } })); }

export async function onRequestPost({ request, env }) {
  let body = {}; try { body = await request.json(); } catch (_) {}
  const kind = ["enter", "joined", "gate", "contact"].includes(body.kind) ? body.kind : "enter";
  const ip = request.headers.get("cf-connecting-ip") || "x";
  const ua = request.headers.get("user-agent") || "";
  const device = /iPhone|iPad/i.test(ua) ? "iPhone" : /Android/i.test(ua) ? "Android phone" : /Mobile/i.test(ua) ? "phone" : "computer";
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  let uid = null, name = "", topic = TOPIC_RE.test(env.NTFY_TOPIC || "") ? env.NTFY_TOPIC : "";
  if (auth) {
    const H = { apikey: SUPABASE_ANON, authorization: "Bearer " + auth };
    const u = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    uid = u && u.id;
    if (!uid) return json({ ok: false, error: "not_signed_in" }, 401);
    const [adm, mem, al] = await Promise.all([
      fetch(SUPABASE_URL + "/rest/v1/admins?select=user_id&user_id=eq." + uid, { headers: H }).then((r) => r.json()).catch(() => []),
      fetch(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq.members/" + uid, { headers: H }).then((r) => r.json()).catch(() => []),
      topic ? Promise.resolve([]) : fetch(SUPABASE_URL + "/rest/v1/docs?select=data&path=eq.site/alerts", { headers: H }).then((r) => r.json()).catch(() => []),
    ]);
    if (Array.isArray(adm) && adm.length) return json({ ok: true, skipped: "owner" });
    name = String((mem[0] && mem[0].data && mem[0].data.handle) || (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || "").slice(0, 40);
    const t = al[0] && al[0].data && al[0].data.topic;
    if (!topic && TOPIC_RE.test(t || "")) { topic = t; await cachePut("alerts-topic", t, 86400 * 30); }
    if (al[0] && al[0].data && al[0].data.off) return json({ ok: true, skipped: "alerts_off" });
  }
  if (!topic) topic = (await cacheGet("alerts-topic")) || "";
  if (!TOPIC_RE.test(topic)) return json({ ok: true, skipped: "no_topic" });

  // one alert per person (or per address for visitors who aren't signed in) every 20 minutes, so the phone isn't flooded
  const rk = "rl-" + kind + "-" + (uid || ip);
  if (await cacheGet(rk)) return json({ ok: true, skipped: "recent" });
  await cachePut(rk, "1", 1200);
  if (kind === "gate") { // and never more than one "visitor" alert a minute in total
    if (await cacheGet("rl-gate-all")) return json({ ok: true, skipped: "recent" });
    await cachePut("rl-gate-all", "1", 60);
  }

  const who = name || "A member";
  const msg = kind === "contact" ? `📇 ${who} just sent you their contact info. Open Messages on the site to see it.`
    : kind === "joined" ? `🎉 New member: ${who} just made an account on Meechie's World (${device}).`
    : kind === "gate" ? `👀 Someone is on the Meechie's World sign-up screen (${device}).`
    : `🔔 ${who} just came on Meechie's World (${device}).`;
  const r = await fetch("https://ntfy.sh/" + topic, {
    method: "POST", body: msg,
    headers: { Title: kind === "joined" ? "New member" : kind === "contact" ? "New contact info" : "Someone's on your site", Tags: kind === "joined" ? "tada" : "eyes", Click: "https://meechies-world.pages.dev/", Priority: kind === "joined" ? "high" : "default" },
  }).catch(() => null);
  return json({ ok: !!(r && r.ok) });
}
