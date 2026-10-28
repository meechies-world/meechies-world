// Website chat for Meechie's AI. Signed-in members only (keeps strangers from burning the free AI allowance).
// Every Workers AI model in lib/ai-catalog.js is wired through here: chat brains answer in the
// chat box (members can pick their brain), image makers return a picture, and the ears / voice /
// language-plumbing models answer their own JSON shapes for the site's features to use.
import { answer, verifyAnswer, take, logQuestion, recentQuestions, SUPABASE_URL, SUPABASE_ANON } from "../../lib/brain.js";
import { userFrom, isAdmin, take as cfTake } from "../../lib/cf.js";
import { MODELS, MODEL_BY_ID } from "../../lib/ai-catalog.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const CHAT_KINDS = new Set(["chat", "reasoning", "code", "vision"]);

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.has("log")) {
    // the AI's memory, owner-only: what members have been asking Meechie AI
    const me = await userFrom(request, env).catch(() => null);
    if (!me || !(await isAdmin(env, me.id).catch(() => false))) return json({ error: "owner_only" }, 403);
    return json({ questions: await recentQuestions(env, 50) });
  }
  return json({ models: MODELS, count: MODELS.length });
}

const b64ToBytes = (b64) => Uint8Array.from(atob(String(b64 || "").replace(/^data:[^,]*,/, "")), (c) => c.charCodeAt(0));
const sniffType = (u8) => (u8[0] === 0xff && u8[1] === 0xd8 ? "image/jpeg" : u8[0] === 0x89 && u8[1] === 0x50 ? "image/png" : "application/octet-stream");
async function imageResponse(out) {
  // image models answer either {image: base64} (FLUX) or raw bytes (SDXL family)
  if (out && typeof out === "object" && typeof out.image === "string") {
    const u8 = b64ToBytes(out.image);
    return new Response(u8, { headers: { "content-type": sniffType(u8), "cache-control": "no-store" } });
  }
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
    const u8 = out instanceof ArrayBuffer ? new Uint8Array(out) : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    return new Response(u8, { headers: { "content-type": sniffType(u8), "cache-control": "no-store" } });
  }
  if (out && typeof out.getReader === "function") return new Response(out, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  return json({ error: "bad_image_result" }, 502);
}

async function runKind(env, model, body) {
  const kind = MODEL_BY_ID[model].kind;
  try {
    if (kind === "image") {
      const prompt = String(body.prompt || "").slice(0, 2000);
      if (!prompt) return json({ error: "bad_request" }, 400);
      return await imageResponse(await env.AI.run(model, { prompt }));
    }
    if (kind === "stt") {
      if (!body.audio) return json({ error: "bad_request" }, 400);
      const out = await env.AI.run(model, { audio: [...b64ToBytes(body.audio)] });
      return json({ text: (out && (out.text || (out.results && out.results.channels?.[0]?.alternatives?.[0]?.transcript))) || "", model });
    }
    if (kind === "tts") {
      const text = String(body.text || "").slice(0, 1200);
      if (!text) return json({ error: "bad_request" }, 400);
      // Meechie speaks with a man's voice (owner, 2026-10-27): Aura's Arcas.
      // If the voice field is ever refused, fall back to the plain call rather
      // than going silent.
      let out;
      if (model.includes("aura")) { try { out = await env.AI.run(model, { text, speaker: "arcas" }); } catch (_) { out = await env.AI.run(model, { text }); } }
      else out = await env.AI.run(model, model.includes("melotts") ? { prompt: text } : { text });
      if (out instanceof ArrayBuffer || ArrayBuffer.isView(out) || (out && typeof out.getReader === "function")) return new Response(out, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
      if (out && typeof out.audio === "string") { const u8 = b64ToBytes(out.audio); return new Response(u8, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } }); }
      return json({ error: "bad_audio_result" }, 502);
    }
    if (kind === "translate") {
      const out = await env.AI.run(model, { text: String(body.text || "").slice(0, 4000), source_lang: String(body.source_lang || "en"), target_lang: String(body.target_lang || "es") });
      return json({ translated_text: (out && out.translated_text) || "", model });
    }
    if (kind === "embed") {
      const out = await env.AI.run(model, { text: Array.isArray(body.text) ? body.text.slice(0, 50) : [String(body.text || "")] });
      return json({ data: (out && out.data) || [], shape: (out && out.shape) || null, model });
    }
    if (kind === "rerank") {
      const out = await env.AI.run(model, { query: String(body.query || ""), documents: (Array.isArray(body.documents) ? body.documents : []).slice(0, 50) });
      return json({ response: (out && out.response) || [], model });
    }
    if (kind === "classify") {
      if (!body.image) return json({ error: "bad_request" }, 400);
      const out = await env.AI.run(model, { image: [...b64ToBytes(body.image)] });
      return json({ labels: Array.isArray(out) ? out : (out && out.response) || out, model });
    }
    // safety + decide: chat-shaped passthrough, raw JSON back
    const msgs = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && typeof m.content === "string").slice(-10);
    if (!msgs.length) return json({ error: "bad_request" }, 400);
    const out = await env.AI.run(model, { messages: msgs, max_tokens: 800 });
    return json({ reply: (out && (out.response || out.result)) || "", raw: out && out.response ? undefined : out, model });
  } catch (e) {
    return json({ error: "model_error", detail: String(e && e.message || e).slice(0, 200), model }, 502);
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.AI) return json({ error: "ai_off" }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign_in" }, 401);
  // the site's own sign-in (mw_ session tokens), not the old Supabase one
  const me = await userFrom(request, env);
  if (!me) return json({ error: "sign_in" }, 401);
  const lim = async (k, w, m) => cfTake(env, "ai-" + k + ":" + me.id, w, m);

  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);
  if (body.verify && typeof body.verify === "object") { // "Double-check" button: a second opinion on one answer
    // fair-use limit (the double-check can use the paid Claude AI): 10 an hour, 40 a day per member
    if (!(await lim("verify", 3600, 10)) || !(await lim("verify-day", 86400, 40)))
      return json({ error: "limit", message: "You've used Double-check a lot today. Try again later." }, 429);
    const v = await verifyAnswer(env, body.verify.question, body.verify.answer, { origin: new URL(request.url).origin, token });
    return json(v, v.error ? 503 : 200);
  }
  const model = typeof body.model === "string" && MODEL_BY_ID[body.model] ? body.model : null;
  if (model && !CHAT_KINDS.has(MODEL_BY_ID[model].kind)) {
    // non-chat models share the chat allowance, with a tighter bucket for image making
    if (!(await lim("ai", 3600, 60)) || !(await lim("ai-day", 86400, 300)))
      return json({ error: "limit", message: "AI allowance used up for now. Try again later." }, 429);
    if (MODEL_BY_ID[model].kind === "image" && !(await lim("ai-img", 3600, 10)))
      return json({ error: "limit", message: "That's a lot of pictures this hour. Try again in a bit." }, 429);
    return runKind(env, model, body);
  }
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "bad_request" }, 400);
  const image = typeof body.image === "string" && body.image.length < 2200000 ? body.image : "";
  // fair-use limit: 60 questions an hour, 300 a day per member (the reply explains it, so every chat box shows it)
  if (!(await lim("ai", 3600, 60)) || !(await lim("ai-day", 86400, 300)))
    return json({ reply: "You've used Meechie's AI a lot this hour. Take a short break and try again later.", limited: true });
  const out = await answer(env, turns, { origin: new URL(request.url).origin, image, token, model, voice: body.voice === true });
  // the brain remembers what members ask (private table, never in the public
  // docs): it feeds the "lately members have been asking" facts on the next
  // answers, and the owner can read the log at GET /api/ai?log.
  if (!out.error && !out.limited && typeof waitUntil === "function") {
    const lastUser = turns[turns.length - 1].content;
    waitUntil((async () => { try { await logQuestion(env, me.id, lastUser); } catch (_) {} })());
  }
  return json(out, out.error ? 503 : 200);
}
