/* MY EMPIRE — the owner-only episode watch door (Malik,
 * 2026-11-04 ~21:36 ET: option 2 — "Just give the link to me for
 * now"). GET /api/empire returns the Episode 1 v3 part list ONLY
 * to a session the server verifies as the owner's (userFrom +
 * isAdmin — the sponsors-admin pattern). The episode page
 * (empire.html) holds no media URL at all until this door
 * answers, so a guest who opens the page — or reads its source —
 * gets the refusal and nothing liftable; the part filenames
 * additionally carry an unguessable tag.
 *
 * This door is NOT the premiere: it seeds nothing, queues
 * nothing, and touches no TV doc — PR #573 (premiere-ep1-seed)
 * stays untouched, the episode is in no lineup, pool, insert or
 * queue, and the page is linked from no navigation. The episode
 * airs when Malik says so, and only then.
 *
 * Media shape: the episode rides /media/ as six stream-copy
 * parts of the 107.7 MB link encode (each part < 24 MB — the
 * repo-static and KV per-file caps are ~25 MB, and GitHub web-UI
 * batches stay under ~24 MB), chained seamlessly by the page's
 * player. Quality is the link encode's own: 1280x720, ~825 kbps
 * total — no second compression generation was taken. */
import { json, userFrom, isAdmin } from "../../lib/cf.js";

const PARTS = [1, 2, 3, 4, 5, 6].map((n) => "/media/my-empire-ep1-v3-p" + n + ".mp4");

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: "Database not connected." }, 503);
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  const u = await userFrom(request, env);
  if (!u) return json({ error: "Sign in first." }, 401);
  if (!(await isAdmin(env, u.id))) return json({ error: "Owner only." }, 403);
  return json({ ok: true, title: "MY EMPIRE — Episode 1", cut: "v3", totalDur: 1043.5, parts: PARTS });
}
