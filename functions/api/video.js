// /api/video — Meechie Video Studio (owner, 2026-11-10: "create videos like Muse").
// Owner only. Two steps:
//   plan  — Meechie (free Workers AI brain) turns an idea into a commercial: storyboard,
//           voiceover, caption and one render-ready video prompt.
//   make  — renders a realistic video WITH SOUND on Cloudflare's video models (billed by
//           Cloudflare per second — NOT free), under a monthly spending cap the owner sets.
// Finished videos are copied into the site's own storage and served from /m/media/studio/.
import { userFrom, isAdmin, take } from "../../lib/cf.js";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/* Prices are Cloudflare's published per-second rates (developers.cloudflare.com/ai/models,
 * checked 2026-11-10). They are estimates for the spending cap; Cloudflare's bill is final. */
export const VIDEO_MODELS = {
  "pixverse/v6": {
    name: "PixVerse v6", blurb: "Best value. Up to 15 seconds, sound included.",
    durations: [5, 8, 10, 15], qualities: { "540p": 0.045, "720p": 0.06, "1080p": 0.115 }, image: "data",
    input: (o) => ({ prompt: o.prompt, ...(o.negative ? { negative_prompt: o.negative } : {}), duration: o.duration, aspect_ratio: o.aspect, quality: o.quality, generate_audio: o.audio, ...(o.image ? { image_input: o.image } : {}) }),
  },
  "bytedance/seedance-2.0": {
    name: "Seedance 2.0", blurb: "Most cinematic and realistic. Up to 12 seconds.",
    durations: [5, 8, 10, 12], qualities: { "480p": 0.07, "720p": 0.15, "1080p": 0.37 }, image: "data",
    input: (o) => ({ prompt: o.prompt + (o.negative ? " Avoid: " + o.negative : ""), duration: o.duration, resolution: o.quality, aspect_ratio: o.aspect, fps: 24, camera_fixed: false, generate_audio: o.audio, watermark: false, use_virtual_avatar: false, ...(o.image ? { image: o.image } : {}) }),
  },
  "lightricks/ltx-2-5-fast": {
    name: "LTX-2.5 Fast", blurb: "Fastest. 8-second clips, sound included.",
    durations: [8], qualities: { "720p": 0.09, "1080p": 0.15 }, image: "",
    input: (o) => ({ prompt: o.prompt, duration: o.duration, resolution: ltxRes(o.quality, o.aspect), fps: 24, generate_audio: o.audio }),
  },
};
const ASPECTS = ["9:16", "16:9", "1:1"];
function ltxRes(q, a) { const hd = q === "1080p"; if (a === "16:9") return hd ? "1920x1080" : "1280x720"; return hd ? "1080x1920" : "720x1280"; }
export const estimate = (model, quality, duration) => Math.round((VIDEO_MODELS[model]?.qualities[quality] || 0) * duration * 100) / 100;

const SCHEMA = [
  `create table if not exists video_jobs (id text primary key, at integer not null, model text not null, quality text, duration integer, est_cost real not null, title text, prompt text, status text not null, url text, detail text)`,
  `create table if not exists video_settings (k text primary key, v text not null)`,
];
let ready = false;
async function setup(env) { if (!ready) { for (const s of SCHEMA) await env.DB.prepare(s).run(); ready = true; } }
const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
async function capOf(env) { const r = await env.DB.prepare("select v from video_settings where k = 'monthly_cap'").first(); const n = r ? parseFloat(r.v) : 10; return isFinite(n) ? n : 10; }
async function spentThisMonth(env) { const r = await env.DB.prepare("select coalesce(sum(est_cost),0) s from video_jobs where at >= ? and status != 'failed'").bind(monthStart()).first(); return Math.round((r ? r.s : 0) * 100) / 100; }

async function owner(request, env) {
  const me = await userFrom(request, env).catch(() => null);
  if (!me) return { err: json({ error: "sign_in", message: "Sign in as Meechie first." }, 401) };
  if (!(await isAdmin(env, me.id).catch(() => false))) return { err: json({ error: "owner_only", message: "The Video Studio is owner-only." }, 403) };
  return { me };
}

/* ---------- Meechie the director ---------- */
const DIRECTOR = `You are Meechie, the AI creative director for Meechie's World Inc (owner: Daryl "Meechie" Goodall). You turn an idea into a short, realistic, cinematic vertical commercial.
Brand: black and gold, crown logo, "Where The World Tunes In!", MeechiesWorldInc.com. Products: $10 PDF books (SpaceX: The Mission; TikTok: The Opportunity; Faith: The Foundation; From Harlem to Fort Dix; Only the Family; Elon Musk: The Visionary; Islam: Faith, History and Civilization; The Pyramids of Egypt; Paper Trail), shop items, the MY EMPIRE TV show, Meechie's World radio, paralegal document preparation, hair and nails.
Rules: The Meechie character wears a tailored black suit with gold accents and already has his own gold chains, so never add jewelry and never anything silver. Never depict real celebrities or public figures; show the book, props or Meechie instead. Never invent statistics, reviews, testimonials or income promises. Keep it believable and physically coherent: one clear action per shot, realistic light, natural motion.
Return ONLY JSON with keys: title (short), shots (array of {time, visual, sound}), voiceover (exact spoken words, at most 2.5 words per second of the video), caption (under 220 characters, ends with a call to action), hashtags (4-7, include #MeechiesWorldInc), video_prompt (ONE paragraph for a text-to-video model: subject and wardrobe, setting, lighting, camera moves, the shots in order with timing, the exact spoken line in quotes, music and sound), negative (things to avoid, comma separated).`;

function pullJson(t) {
  if (t && typeof t === "object") return t;
  const s = String(t || ""); const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
async function plan(env, idea, seconds, aspect) {
  const msgs = [{ role: "system", content: DIRECTOR }, { role: "user", content: `Idea from Meechie: ${idea}\nLength: ${seconds} seconds. Aspect ratio: ${aspect}.` }];
  const tryModel = async (model) => {
    const out = await env.AI.run(model, { messages: msgs, max_tokens: 1400, temperature: 0.7 });
    return pullJson(out && (out.response ?? out.result ?? out));
  };
  let p = null;
  for (const m of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/zai-org/glm-4.7-flash"]) { try { p = await tryModel(m); } catch (_) {} if (p && p.video_prompt) break; }
  if (!p || !p.video_prompt) return null;
  const s = (v, n) => String(v ?? "").slice(0, n);
  return {
    title: s(p.title, 90) || "Meechie's World commercial",
    shots: (Array.isArray(p.shots) ? p.shots : []).slice(0, 8).map((x) => ({ time: s(x && x.time, 16), visual: s(x && x.visual, 400), sound: s(x && x.sound, 200) })),
    voiceover: s(p.voiceover, 600), caption: s(p.caption, 300),
    hashtags: (Array.isArray(p.hashtags) ? p.hashtags : []).slice(0, 8).map((h) => s(h, 40)),
    video_prompt: s(p.video_prompt, 2000), negative: s(p.negative, 400),
  };
}

/* ---------- rendering ---------- */
function findVideoUrl(out) {
  if (!out) return "";
  if (out.result && typeof out.result.video === "string") return out.result.video;
  if (typeof out.video === "string") return out.video;
  const m = JSON.stringify(out).match(/https:\/\/[^"\s]+\.(mp4|webm|mov)[^"\s]*/i);
  return m ? m[0] : "";
}
async function keepCopy(env, id, src) {
  // copy into the site's own storage so the video doesn't vanish when the model's link expires
  if (!env.MEDIA) return "";
  try {
    const r = await fetch(src);
    if (!r.ok) return "";
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 24 * 1024 * 1024) return ""; // KV limit; keep the model's link instead
    const key = `media/studio/${id}.mp4`;
    await env.MEDIA.put(key, buf, { metadata: { type: r.headers.get("content-type") || "video/mp4", size: buf.byteLength } });
    return "/m/" + key;
  } catch (_) { return ""; }
}

export async function onRequestGet({ request, env }) {
  const o = await owner(request, env); if (o.err) return o.err;
  await setup(env);
  const { results } = await env.DB.prepare("select id, at, model, quality, duration, est_cost, title, status, url, detail from video_jobs order by at desc limit 30").all();
  return json({
    models: Object.fromEntries(Object.entries(VIDEO_MODELS).map(([id, m]) => [id, { name: m.name, blurb: m.blurb, durations: m.durations, qualities: m.qualities, image: !!m.image }])),
    aspects: ASPECTS, cap: await capOf(env), spent: await spentThisMonth(env), videos: results || [], ai: !!env.AI,
  });
}

export async function onRequestPost({ request, env }) {
  const o = await owner(request, env); if (o.err) return o.err;
  if (!env.AI) return json({ error: "ai_off", message: "Cloudflare AI isn't connected to the site." }, 501);
  await setup(env);
  let b; try { b = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const act = b && b.action;

  if (act === "cap") {
    const n = Math.max(0, Math.min(500, Math.round(parseFloat(b.cap) * 100) / 100));
    if (!isFinite(n)) return json({ error: "bad_cap" }, 400);
    await env.DB.prepare("insert into video_settings (k, v) values ('monthly_cap', ?) on conflict(k) do update set v = excluded.v").bind(String(n)).run();
    return json({ ok: true, cap: n });
  }

  if (act === "plan") {
    if (!(await take(env, "vplan:" + o.me.id, 3600, 40))) return json({ error: "limit", message: "That's a lot of plans this hour. Take a breather." }, 429);
    const idea = String(b.idea || "").trim().slice(0, 1500);
    if (idea.length < 4) return json({ error: "bad_request", message: "Tell Meechie what the video is about." }, 400);
    const secs = Math.max(5, Math.min(15, parseInt(b.duration, 10) || 10));
    const aspect = ASPECTS.includes(b.aspect) ? b.aspect : "9:16";
    const p = await plan(env, idea, secs, aspect);
    if (!p) return json({ error: "plan_failed", message: "Meechie couldn't write that one. Try saying the idea a different way." }, 502);
    return json({ plan: p });
  }

  if (act === "make") {
    const model = VIDEO_MODELS[b.model] ? b.model : null;
    if (!model) return json({ error: "bad_model" }, 400);
    const M = VIDEO_MODELS[model];
    const duration = M.durations.includes(parseInt(b.duration, 10)) ? parseInt(b.duration, 10) : M.durations[0];
    const quality = M.qualities[b.quality] ? b.quality : Object.keys(M.qualities).includes("720p") ? "720p" : Object.keys(M.qualities)[0];
    const aspect = ASPECTS.includes(b.aspect) ? b.aspect : "9:16";
    const prompt = String(b.prompt || "").trim().slice(0, model === "pixverse/v6" ? 2048 : 6000);
    if (prompt.length < 10) return json({ error: "bad_request", message: "The video prompt is empty." }, 400);
    const image = M.image && typeof b.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(b.image) && b.image.length < 3_000_000 ? b.image : "";
    const cost = estimate(model, quality, duration);
    // spending guard: the owner must have seen this exact price, and the month's cap must allow it
    if (Math.abs((parseFloat(b.confirm_cost) || -1) - cost) > 0.001) return json({ error: "confirm", message: `This video costs about $${cost.toFixed(2)}. Confirm to make it.`, cost }, 409);
    const cap = await capOf(env), spent = await spentThisMonth(env);
    if (spent + cost > cap + 1e-9) return json({ error: "cap", message: `That would pass your $${cap.toFixed(2)} monthly video limit ($${spent.toFixed(2)} used). Raise the limit to keep going.`, cap, spent, cost }, 402);
    if (!(await take(env, "vmake:" + o.me.id, 3600, 12))) return json({ error: "limit", message: "12 videos an hour is the limit. Try again soon." }, 429);

    const id = crypto.randomUUID();
    const title = String(b.title || "").slice(0, 90);
    await env.DB.prepare("insert into video_jobs (id, at, model, quality, duration, est_cost, title, prompt, status) values (?, ?, ?, ?, ?, ?, ?, ?, 'rendering')").bind(id, Date.now(), model, quality, duration, cost, title, prompt).run();
    let out;
    try {
      out = await env.AI.run(model, M.input({ prompt, negative: String(b.negative || "").slice(0, 1000), duration, aspect, quality, audio: b.audio !== false, image }));
    } catch (e) {
      const detail = String(e && e.message || e).slice(0, 300);
      await env.DB.prepare("update video_jobs set status = 'failed', detail = ? where id = ?").bind(detail, id).run();
      return json({ error: "render_failed", message: "The video model said no: " + detail, id }, 502);
    }
    const src = findVideoUrl(out);
    if (!src) {
      const detail = JSON.stringify(out || {}).slice(0, 300);
      const state = out && out.state ? String(out.state) : "";
      await env.DB.prepare("update video_jobs set status = ?, detail = ? where id = ?").bind(state && state !== "Completed" ? "pending" : "failed", detail, id).run();
      return json({ error: "no_video", message: state ? `The model answered "${state}" without a video yet.` : "The model finished without a video.", id, detail }, 502);
    }
    const kept = await keepCopy(env, id, src);
    const url = kept || src;
    await env.DB.prepare("update video_jobs set status = 'done', url = ? where id = ?").bind(url, id).run();
    return json({ ok: true, id, url, kept: !!kept, cost, spent: Math.round((spent + cost) * 100) / 100, cap });
  }

  return json({ error: "bad_request" }, 400);
}
