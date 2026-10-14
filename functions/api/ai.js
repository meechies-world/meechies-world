// Website chat for Meechie's AI. Signed-in members only (keeps strangers from burning the free AI allowance).
import { answer, verifyAnswer, take, SUPABASE_URL, SUPABASE_ANON } from "../../lib/brain.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: "ai_off" }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign_in" }, 401);
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } });
  if (!who.ok) return json({ error: "sign_in" }, 401);

  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
  if (body.verify && typeof body.verify === "object") { // "Double-check" button: a second opinion on one answer
    // fair-use limit (the double-check can use the paid Claude AI): 10 an hour, 40 a day per member
    if ((await take(env, token, "verify", 3600, 10)) === false || (await take(env, token, "verify-day", 86400, 40)) === false)
      return json({ error: "limit", message: "You've used Double-check a lot today. Try again later." }, 429);
    const v = await verifyAnswer(env, body.verify.question, body.verify.answer, { origin: new URL(request.url).origin, token });
    return json(v, v.error ? 503 : 200);
  }
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "bad_request" }, 400);
  const image = typeof body.image === "string" && body.image.length < 2200000 ? body.image : "";
  // fair-use limit: 60 questions an hour, 300 a day per member (the reply explains it, so every chat box shows it)
  if ((await take(env, token, "ai", 3600, 60)) === false || (await take(env, token, "ai-day", 86400, 300)) === false)
    return json({ reply: "You've used Meechie's AI a lot this hour. Take a short break and try again later.", limited: true });
  const out = await answer(env, turns, { origin: new URL(request.url).origin, image, token });
  return json(out, out.error ? 503 : 200);
}
