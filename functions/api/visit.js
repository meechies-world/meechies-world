// Visitor alerts + traffic counting for the owner (Cloudflare-native rewrite,
// 2026-10-27 — the old version validated sessions against the retired Supabase
// backend, so member alerts silently died in the migration; it also never
// counted anything).
//
// POST /api/visit — the site calls this as people use it:
//   kind "view"    - a page view, guest or member (counted, never announced)
//   kind "click"   - a link click {label} (counted, never announced)
//   kind "enter"   - a signed-in member came on the site (alert to owner's phone)
//   kind "joined"  - a brand-new member just made an account (alert)
//   kind "gate"    - someone who isn't signed in is on the sign-up screen (alert)
//   kind "contact" - a member sent the owner their contact info (alert)
// Alerts go to the owner's phone through the free ntfy app. The channel is set
// in the owner's Visitors panel (saved in the site/alerts doc) or as the
// NTFY_TOPIC Pages variable. The owner's own activity is never counted or
// announced.
//
// Counts live in one doc per day: stats/day-<YYYY-MM-DD in New York time>
//   { views, guests, members, sections: {radio: n}, clicks: {label: n}, uq: {ipHash: 1} }
// Only a hash of each address is kept — never the address itself.
//
// GET /api/visit?days=7 — owner only: the daily counts for the Visitors panel.
import { userFrom, isAdmin, take, sha256hex, json } from "../../lib/cf.js";

const TOPIC_RE = /^[A-Za-z0-9_-]{12,64}$/;

async function readDoc(env, path) {
  const row = await env.DB.prepare("select data from docs where path = ?").bind(path).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (_) { return null; }
}
async function writeDoc(env, path, coll, data) {
  const nowIso = new Date().toISOString();
  const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(JSON.stringify(data), nowIso, path).run();
  if (!r.meta || !r.meta.changes) {
    await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind(path, coll, null, JSON.stringify(data), nowIso, nowIso).run();
  }
  await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", path, coll, null, null, Date.now()).run();
}

const dayET = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const statsPath = (day) => "stats/day-" + day;

async function bumpStats(env, fn) {
  const path = statsPath(dayET());
  const st = (await readDoc(env, path)) || { views: 0, guests: 0, members: 0, sections: {}, clicks: {}, uq: {} };
  fn(st);
  await writeDoc(env, path, "stats", st);
  return st;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  let body = {}; try { body = (await request.json()) || {}; } catch (_) {}
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const ip = request.headers.get("cf-connecting-ip") || "x";
  const ua = request.headers.get("user-agent") || "";
  const device = /iPhone|iPad/i.test(ua) ? "iPhone" : /Android/i.test(ua) ? "Android phone" : /Mobile/i.test(ua) ? "phone" : "computer";
  const ipHash = (await sha256hex(ip + "|mw-stats")).slice(0, 16);

  let user = null, uid = null, admin = false;
  if (auth) {
    user = await userFrom(request, env).catch(() => null);
    if (!user) return json({ ok: false, error: "not_signed_in" }, 401);
    uid = user.id || user.uid || null;
    if (uid) admin = await isAdmin(env, uid).catch(() => false);
  }
  const kind = String(body.kind || "");

  /* ----- counting: views and clicks, guests included ----- */
  if (kind === "view" || kind === "click") {
    if (admin) return json({ ok: true, skipped: "owner" });
    const allowed = await take(env, "stats-" + kind + "-" + ipHash, 60, 40).catch(() => true);
    if (allowed === false) return json({ ok: true, skipped: "rate" });
    if (kind === "view") {
      const v = String(body.v || "home").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24) || "home";
      await bumpStats(env, (st) => {
        st.views = (st.views || 0) + 1;
        if (uid) st.members = (st.members || 0) + 1; else st.guests = (st.guests || 0) + 1;
        st.sections = st.sections || {}; st.sections[v] = (st.sections[v] || 0) + 1;
        st.uq = st.uq || {}; if (Object.keys(st.uq).length < 800) st.uq[ipHash] = 1;
      });
    } else {
      const label = String(body.label || "").replace(/[^A-Za-z0-9 _.\-:/]/g, "").trim().slice(0, 48);
      if (!label) return json({ ok: true, skipped: "no_label" });
      await bumpStats(env, (st) => {
        st.clicks = st.clicks || {};
        if (st.clicks[label] != null || Object.keys(st.clicks).length < 80) st.clicks[label] = (st.clicks[label] || 0) + 1;
      });
    }
    return json({ ok: true, counted: kind });
  }

  /* ----- alerts: member arrivals, sign-ups, the gate, contact cards ----- */
  let akind = kind;
  if (!uid) akind = "gate"; // people who aren't signed in can only ever trigger the sign-up screen alert
  if (!["enter", "joined", "gate", "contact"].includes(akind)) akind = uid ? "enter" : "gate";
  if (admin) return json({ ok: true, skipped: "owner" });

  let name = "";
  if (uid) {
    const mem = await readDoc(env, "members/" + uid);
    name = String((mem && (mem.handle || mem.name)) || user.name || (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || "").slice(0, 40);
    // "new member" only for an account that really was just made
    if (akind === "joined") {
      const made = new Date(user.created_at || 0).getTime();
      if (!(made && Date.now() - made < 30 * 60e3)) akind = "enter";
    }
  }

  const alerts = (await readDoc(env, "site/alerts")) || {};
  let topic = TOPIC_RE.test(env.NTFY_TOPIC || "") ? env.NTFY_TOPIC : "";
  if (!topic && TOPIC_RE.test(alerts.topic || "")) topic = alerts.topic;
  if (alerts.off) return json({ ok: true, skipped: "alerts_off" });
  if (!TOPIC_RE.test(topic)) return json({ ok: true, skipped: "no_topic" });

  // one alert per person (or per address for guests) every 20 minutes, and at
  // most one "visitor at the gate" alert a minute in total, so the phone can't be flooded
  if ((await take(env, "visit-" + akind + "-" + (uid || ipHash), 1200, 1).catch(() => true)) === false) return json({ ok: true, skipped: "recent" });
  if (akind === "gate" && (await take(env, "visit-gate-all", 60, 1).catch(() => true)) === false) return json({ ok: true, skipped: "recent" });

  const who = name || "A member";
  const msg = akind === "contact" ? `📇 ${who} just sent you their contact info. Open Messages on the site to see it.`
    : akind === "joined" ? `🎉 New member: ${who} just made an account on Meechie's World (${device}).`
    : akind === "gate" ? `👀 Someone is on the Meechie's World sign-up screen (${device}).`
    : `🔔 ${who} just came on Meechie's World (${device}).`;
  const r = await fetch("https://ntfy.sh/" + topic, {
    method: "POST", body: msg,
    headers: { ...(env.NTFY_TOKEN ? { Authorization: "Bearer " + env.NTFY_TOKEN } : {}), Title: akind === "joined" ? "New member" : akind === "contact" ? "New contact info" : "Someone's on your site", Tags: akind === "joined" ? "tada" : akind === "contact" ? "card_index" : "eyes", Click: "https://meechiesworldinc.com/", Priority: akind === "joined" ? "high" : "default" },
  }).catch(() => null);
  return json({ ok: !!(r && r.ok), status: r ? r.status : 0 });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const user = await userFrom(request, env).catch(() => null);
  const uid = user && (user.id || user.uid);
  if (!uid || !(await isAdmin(env, uid).catch(() => false))) return json({ ok: false, error: "owner_only" }, 403);
  const daysN = Math.max(1, Math.min(14, +(new URL(request.url).searchParams.get("days") || 7)));
  const days = [];
  for (let i = daysN - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const day = dayET(d);
    const st = (await readDoc(env, statsPath(day))) || { views: 0, guests: 0, members: 0, sections: {}, clicks: {}, uq: {} };
    days.push({ date: day, views: st.views || 0, guests: st.guests || 0, members: st.members || 0, uniques: Object.keys(st.uq || {}).length, sections: st.sections || {}, clicks: st.clicks || {} });
  }
  return json({ ok: true, days });
}
