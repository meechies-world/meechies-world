// Meechie's AI phone line. Point a Twilio phone number's "A call comes in" webhook (HTTP POST) at
//   https://meechies-world.pages.dev/api/voice
// Optional Cloudflare secrets/vars:
//   TWILIO_AUTH_TOKEN  - checks that calls really come from Twilio (recommended)
//   FORWARD_TO         - phone number to connect callers who ask for Meechie, e.g. +17245551234
import { answer } from "../../lib/brain.js";

const xml = (body) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });
const X = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const VOICE = 'voice="Polly.Matthew-Neural" language="en-US"';
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => { try { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); } catch (_) { return ""; } };

async function validTwilio(request, params, token) {
  if (!token) return true;
  const sig = request.headers.get("x-twilio-signature") || "";
  const data = request.url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

function gather(url, prompt) {
  return `<Gather input="speech" action="${X(url)}" method="POST" speechTimeout="auto" speechModel="phone_call" enhanced="true" language="en-US" actionOnEmptyResult="true">${prompt ? `<Say ${VOICE}>${X(prompt)}</Say>` : ""}</Gather>`;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  let params = {};
  if (request.method === "POST") { try { const f = await request.formData(); for (const [k, v] of f) params[k] = String(v); } catch (_) { return new Response("Bad request", { status: 400 }); } }
  if (!(await validTwilio(request, params, env.TWILIO_AUTH_TOKEN))) return new Response("Forbidden", { status: 403 });

  const self = url.origin + url.pathname;
  // short call memory travels in the URL (last few turns)
  let hist = []; try { hist = JSON.parse(unb64u(url.searchParams.get("h") || "") || "[]"); } catch (_) { hist = []; }
  // only plain caller/AI turns from the URL (never a "system" turn, never non-text)
  hist = (Array.isArray(hist) ? hist : []).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string");
  const misses = +(url.searchParams.get("m") || 0);
  const speech = (params.SpeechResult || "").trim();
  const next = (h, m = 0) => self + "?h=" + b64u(JSON.stringify(h.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 280) })))) + (m ? "&m=" + m : "");

  // first ring
  if (!url.searchParams.has("h") && !speech) {
    return xml(gather(next([]), "Hey, thanks for calling Meechie's World! This is Meechie, the A I assistant. Ask me about our services, prices, music, the website, or anything else. How can I help you?") + `<Redirect method="POST">${X(next([], 1))}</Redirect>`);
  }
  // silence
  if (!speech) {
    if (misses >= 2) return xml(`<Say ${VOICE}>I didn't catch anything, so I'll let you go. You can also reach us at meechies dash world dot pages dot dev, or DM Meechie's World Inc on TikTok. Have a blessed day!</Say><Hangup/>`);
    return xml(gather(next(hist, misses + 1), "Sorry, I didn't hear you. What can I help you with?") + `<Redirect method="POST">${X(next(hist, misses + 1))}</Redirect>`);
  }
  // goodbye
  if (/\b(bye|goodbye|that'?s all|that is all|no thanks?|nothing else|hang up)\b/i.test(speech) && speech.split(/\s+/).length < 8) {
    return xml(`<Say ${VOICE}>Thanks for calling Meechie's World. Have a blessed day!</Say><Hangup/>`);
  }
  // wants a real person
  if (/\b(talk|speak|connect|transfer)\b.*\b(meechie|person|human|someone|owner|real)\b|\b(real person|human|operator|representative)\b/i.test(speech)) {
    if (env.FORWARD_TO && /^\+\d{10,15}$/.test(env.FORWARD_TO)) return xml(`<Say ${VOICE}>Sure, connecting you to Meechie now. One moment.</Say><Dial timeout="25" callerId="${X(params.To || "")}">${X(env.FORWARD_TO)}</Dial><Say ${VOICE}>Meechie couldn't pick up right now. Please send a DM to Meechie's World Inc on TikTok and he'll get back to you. Goodbye!</Say><Hangup/>`);
    return xml(gather(next(hist), "Meechie isn't taking calls on this line right now, but the fastest way to reach him is a DM to Meechie's World Inc on TikTok, or email meechies world inc at A O L dot com. Anything else I can help with?") + `<Redirect method="POST">${X(next(hist, 1))}</Redirect>`);
  }

  const turns = [...hist, { role: "user", content: speech.slice(0, 500) }];
  let reply = "Sorry, I'm having trouble thinking right now. Please try again in a minute, or DM Meechie's World Inc on TikTok.";
  if (env.AI) {
    const out = await answer(env, turns, { origin: url.origin, voice: true });
    if (out.reply) reply = out.reply.replace(/\[\d+\]/g, "").replace(/[*#_`>]/g, "").replace(/https?:\/\/\S+/g, "our website").slice(0, 900);
  }
  const h2 = [...turns, { role: "assistant", content: reply }];
  return xml(gather(next(h2), reply + " ... Anything else?") + `<Redirect method="POST">${X(next(h2, 1))}</Redirect>`);
}
