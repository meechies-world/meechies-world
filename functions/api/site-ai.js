// Owner-only AI site editor. Turns a plain-English request into a list of safe changes
// (text, colors, pages, custom sections, radio auto-start). The browser shows the list
// and the owner clicks Apply; nothing changes until then.
const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const SYSTEM = `You edit the Meechie's World website for its owner. You can ONLY return changes in this JSON shape (omit keys you don't use):
{
 "reply": "one or two plain sentences telling the owner what you changed",
 "texts": { "<text id>": "<new text>" },          // replace existing words on the page; ids come from the TEXTS list
 "theme": { "--gold": "#rrggbb", "--ink": "#rrggbb", "--panel": "#rrggbb", "--text": "#rrggbb" },  // gold accent, page background, card background, text color
 "hide": ["<page>"], "show": ["<page>"],           // hide or show whole pages (tabs) for visitors
 "add_blocks": [ { "view": "<page>", "title": "...", "body": "...", "button": "optional button words", "url": "https://... or #page", "top": false } ],  // add a new section (card) to a page
 "remove_blocks": ["<block id>"],
 "autoplay": true|false                               // radio starts when the site opens
}
Rules:
- Only use text ids that exist in TEXTS. Keep the owner's style: confident, plain words. Keep prices exactly as the owner says.
- If the owner asks for something you cannot do with these tools (new features, games, code, payments setup), return {"reply":"..."} explaining it needs a bigger update and to ask Claude.
- Never add anything illegal, hateful, misleading, or anyone's private information. Never invent prices or promises.
- Output JSON only, no markdown.`;

function parseJSON(t) {
  t = String(t || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: "AI is not set up" }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "owner_only" }, 401);
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } });
  if (!who.ok) return json({ error: "owner_only" }, 401);
  const uid = (await who.json()).id;
  const adm = await fetch(SUPABASE_URL + "/rest/v1/admins?select=user_id&user_id=eq." + encodeURIComponent(uid), { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } }).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(adm) || !adm.length) return json({ error: "owner_only" }, 403);

  let b; try { b = await request.json(); } catch (_) { return json({ error: "Bad request" }, 400); }
  const req = String(b.request || "").slice(0, 800);
  if (!req) return json({ error: "Tell me what to change." }, 400);
  const texts = (Array.isArray(b.texts) ? b.texts : []).slice(0, 220).map((t) => `${t.id}: ${String(t.text).slice(0, 160)}`).join("\n");
  const context = `CURRENT PAGE: ${b.view}
PAGES: ${(b.views || []).join(", ")}
HIDDEN PAGES: ${(b.hidden || []).join(", ") || "none"}
THEME: ${JSON.stringify(b.theme || {})} (defaults: gold #d4a843, background #0b0a08, cards #15130f, text #f3ecdc)
RADIO AUTO-START: ${b.autoplay !== false}
CUSTOM SECTIONS: ${JSON.stringify(b.blocks || [])}
TEXTS (id: words on the current page, header and footer):
${texts}`;

  const models = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fast"];
  const errs = [];
  for (const model of models) {
    try {
      const out = await env.AI.run(model, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: context + "\n\nOWNER REQUEST: " + req }], max_tokens: 1200, temperature: 0.2 });
      const ops = parseJSON(out && (out.response || out.result));
      if (ops && typeof ops === "object") return json({ reply: String(ops.reply || "").slice(0, 500), ops });
      errs.push(model + ": unreadable: " + String(out && (out.response || out.result) || JSON.stringify(out)).slice(0, 200));
    } catch (e) { errs.push(model + ": " + String(e && e.message || e).slice(0, 200)); }
  }
  return json({ error: "The AI is busy. Try again in a minute.", detail: errs }, 503);
}
