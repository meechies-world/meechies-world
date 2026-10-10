// Website chat for Meechie's AI. Signed-in members only (keeps strangers from burning the free AI allowance).
import { answer, SUPABASE_URL, SUPABASE_ANON } from "../../lib/brain.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: "ai_off" }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign_in" }, 401);
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } });
  if (!who.ok) return json({ error: "sign_in" }, 401);

  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "bad_request" }, 400);
  const image = typeof body.image === "string" && body.image.length < 2200000 ? body.image : "";
  const out = await answer(env, turns, { origin: new URL(request.url).origin, image, token });
  return json(out, out.error ? 503 : 200);
}
