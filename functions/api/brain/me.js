/* GET /api/brain/me (PR-B3, BLUEPRINT §3): the member's OWN host-brain
 * memory summary, for the AI widget's personalized greeting. Session-checked
 * like /api/ai — the uid comes from the caller's own session, the doc read
 * is brain/member/<that uid>, and there is no way to ask for anyone else's:
 * the path is built from the session, never from the request. Guests get a
 * 401 and no memory exists for them. Read-only: visits are recorded through
 * POST /api/brain/event (type "visit"), the single writer path. */
import { userFrom, json } from "../../../lib/cf.js";
import { readMember, greetingFor } from "../../../lib/brain-member.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return json({ ok: false, error: "sign_in" }, 401);
  const mem = await readMember(env, me.id);
  if (!mem) return json({ ok: true, has: false });
  const g = greetingFor(mem);
  return json({
    ok: true,
    has: true,
    name: mem.name || "",
    visits: +mem.visits || 0,
    favArtists: (mem.favArtists || []).slice(0, 5),
    favTracks: (mem.favTracks || []).slice(0, 3).map((t) => t.title),
    lastHeard: mem.lastHeard || null,
    topics: (mem.topics || []).slice(0, 8),
    greet: g ? g.greet : null,
    hello: g ? g.hello : null,
  });
}
