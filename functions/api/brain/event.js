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
 * exactly one fold in the world. */
import { userFrom, json, take } from "../../../lib/cf.js";
import { cleanBrainEvent, recordBrainEvents } from "../../../lib/brain-taste.js";

const MAX_BATCH = 25; // the blueprint cap: one flush is a handful of songs, never a flood

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "not_ready" }, 503);
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return json({ ok: false, error: "sign_in" }, 401);
  if (!(await take(env, "bevent:" + me.id, 60, 20))) return json({ ok: false, error: "too_fast" }, 429); // each call is ~28 D1 writes: keep the free tier safe
  let b = null; try { b = await request.json(); } catch (_) {}
  const list = Array.isArray(b) ? b : (b && Array.isArray(b.events) ? b.events : null);
  if (!list) return json({ ok: false, error: "bad_body" }, 400);
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
