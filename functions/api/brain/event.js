/* The DJ brain's front door (PR-B1): the booth client batches the music
 * events it sees — plays, natural ends, skips, watchdog stalls, Auto-DJ
 * draws — and posts them here. Signed-in members only, like /api/ai: a
 * stranger with no session gets a 401 and nothing is written.
 *
 * The actor on every row is the session's own uid, stamped server-side —
 * the body can never name someone else. Events are the station's music
 * history, never chat content: nothing a member asked Meechie AI is read
 * or stored here (that log stays private under its own rule).
 *
 * Rows land in the brain_events table and fold into the brain/taste doc
 * through the one shared writer (lib/brain-taste.js) — the station keeper
 * writes its own unattended starts through the same path, so there is
 * exactly one fold in the world.
 *
 * PR-B3 adds one exception, kept narrow on purpose: a batch of ONLY
 * {type:"visit"} events from any signed-in member folds that member's own
 * host-brain memory (lib/brain-member.js) and writes nothing here. Music
 * events stay owner-only, unchanged. */
import { userFrom, json, take, isAdmin } from "../../../lib/cf.js";
import { cleanBrainEvent, recordBrainEvents } from "../../../lib/brain-taste.js";
import { foldVisit } from "../../../lib/brain-member.js";

const MAX_BATCH = 25; // the blueprint cap: one flush is a handful of songs, never a flood

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return json({ ok: false, error: "sign_in" }, 401);
  let b = null; try { b = await request.json(); } catch (_) {}
  const list = Array.isArray(b) ? b : (b && Array.isArray(b.events) ? b.events : null);
  if (!list) return json({ ok: false, error: "bad_body" }, 400);
  /* Host-brain visits (PR-B3, BLUEPRINT §3): the one event type ANY signed-in
   * member may send — the AI widget reports in once per session. A batch of
   * nothing but visits folds into that member's OWN memory doc through the
   * single writer path (lib/brain-member.js); it never touches brain_events
   * or the taste profile, so it cannot plant anything on air. The uid comes
   * from the session, never the body. A batch mixing a visit with anything
   * else falls through to the owner-only music path below and is refused
   * for non-owners exactly as before. */
  if (list.length && list.every((e) => e && e.type === "visit")) {
    if (!(await take(env, "bvisit:" + me.id, 60, 6))) return json({ ok: false, error: "too_fast" }, 429);
    try {
      const mem = await foldVisit(env, me);
      return json({ ok: true, visit: true, visits: mem ? +mem.visits || 0 : 0 });
    } catch (_) {
      return json({ ok: false, error: "write_failed" }, 500);
    }
  }
  // Only Meechie's booth feeds the brain (the client sends from the owner lead booth only);
  // without this any member could plant artists the unattended AI DJ then plays on air.
  if (!(await isAdmin(env, me.id))) return json({ ok: false, error: "owner_only" }, 403);
  if (!(await take(env, "bevent:" + me.id, 60, 20))) return json({ ok: false, error: "too_fast" }, 429); // each call is ~28 D1 writes: keep the free tier safe
  const evts = [];
  for (const raw of list.slice(0, MAX_BATCH)) { const e = cleanBrainEvent(raw, me.id); if (e) evts.push(e); }
  if (!evts.length) return json({ ok: true, accepted: 0 });
  try {
    const r = await recordBrainEvents(env, evts);
    return json({ ok: true, accepted: r.inserted });
  } catch (_) {
    return json({ ok: false, error: "write_failed" }, 500);
  }
}
