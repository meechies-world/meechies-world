// Meechie's AI: answers questions about Meechie's World using Cloudflare Workers AI (free tier).
// Needs the "AI" binding (set in wrangler.toml). Visitors must be signed in, which keeps strangers
// from burning the free daily allowance.
const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const BRIEF = `You are the assistant on the Meechie's World Inc website (owner: Meechie). Be friendly, direct, and brief (under 120 words). Only describe what's listed here; for quotes or anything else, tell people to DM @meechiesworldinc on TikTok or elpesidentay on Snapchat, or email meechiesworldinc@aol.com.
Services (all start at $50 minimum, quoted per job): music production, recording rap/singing artists, sound engineering, music videos, commercials, AI video and TikTok content, artist development, concert/event promotion, sales and distribution, website building, coding, AI prompting, documents/decks/spreadsheets/research, legal document preparation and paralegal services (document prep only, not legal advice, not a law firm), help for incarcerated people's families (staying in touch, approved money transfers, grievance writing), clothing line and on-demand printing setup, house remodeling, cleaning, landscaping, security.
Books: Paper Trail; From Harlem to Fort Dix; Donald J. Trump: An Investigative Biography.
Shop tab: official Meechie's World merch (blankets, hoodies, clocks, pillowcases and more), printed on demand by Printify at meechiesworld-inc.printify.me; checkout happens there. Messages tab: private one-to-one messages between members. Creators tab clothing studio: design tees, long sleeves, hoodies, sweatshirts, and tanks front and back, or upload finished art, then submit for a community vote. Platform: Games tab (Gold Rush Arena, a live battle game members play against each other, plus a Fortnite Squad Finder to post Epic names and team up; Fortnite itself is played in Epic's app), joining, posting, chat, voice clips, gifts, the virtual world (with AI look-alike avatars and avatar outfit design), the Creators tab (design clothing for the line, vote on designs, apply to join the team and earn a share of what you build, set in a written agreement), going live, linking Printify/Shopify stores, and community ads are free. Paid promotion: Spotlight $50/7 days, Featured $150/14 days, Takeover $400/30 days; request it on the Promote tab.
Never give legal advice, never promise outcomes, never collect payment details. If you do not know something, say so and point to the DM options. Stay on the topic of Meechie's World; politely decline unrelated requests.`;

const EXTRA = `More facts:
- Paying: Promote packages have Pay now buttons (Spotlight $50, Featured $150, Takeover $400). Services can be booked with a $50 deposit on the Services page, and invoices or quotes can be paid any amount on the Services or Contact page. Checkout is by Stripe (cards, Apple Pay, Google Pay, Cash App Pay); we never see card numbers.
- Promotion: we promote paid campaigns across all Meechie's World social media (TikTok @meechiesworldinc, Snapchat elpesidentay) plus the site feed and Ad Board.
- Donations: the Support Meechie's World section (Home and Contact pages) takes any amount. Meechie's World is a business, not a charity, so donations are not tax-deductible.
- Members can message each other privately on the Messages tab, and the site owner can edit the site.
How to answer: reply in the same language the visitor writes in. Be warm, confident, and specific. Use short paragraphs or a few bullet points, and end with one clear next step (which tab or button to use, or who to DM). Keep answers under 150 words unless asked for detail. Never invent prices, products, or promises that are not listed here.`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env.AI) return json({ error: "ai_off" }, 501);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign_in" }, 401);
  const who = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON, authorization: "Bearer " + token } });
  if (!who.ok) return json({ error: "sign_in" }, 401);

  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10).map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "bad_request" }, 400);

  // Live context: today's date and the current shop products.
  let live = "Today is " + new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" }) + ".";
  try {
    const st = await fetch(new URL("/api/store", request.url).toString()).then((r) => r.json());
    if (st && st.products && st.products.length) live += "\nCurrent Shop products (Shop tab, checkout on Printify): " + st.products.slice(0, 20).map((p) => p.title + (p.price ? " " + p.price : "")).join("; ") + ".";
  } catch (_) {}
  const SYSTEM = BRIEF + "\n\n" + EXTRA + "\n\n" + live;
  const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.1-8b-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/qwen/qwen2.5-coder-32b-instruct"];
  const errs = [];
  for (const model of MODELS) {
    try {
      const out = await env.AI.run(model, { messages: [{ role: "system", content: SYSTEM }, ...turns], max_tokens: 500, temperature: 0.4 });
      const reply = String((out && (out.response || out.result || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || "")) || "").trim();
      if (reply) return json({ reply });
      errs.push(model + ": empty");
    } catch (e) { errs.push(model + ": " + String(e && e.message || e).slice(0, 160)); }
  }
  return json({ error: "busy", detail: errs }, 503);
}
