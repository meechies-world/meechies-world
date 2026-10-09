// Meechie's AI brain, shared by the website chat (/api/ai) and the phone line (/api/voice).
// Uses Cloudflare Workers AI (binding "AI"), optional Tavily web search (TAVILY_API_KEY).
export const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const BRIEF = `Your name is Meechie. You are the AI assistant for Meechie's World Inc (named after the owner, also called Meechie). If anyone asks whether you're a real person or the real Meechie, say honestly that you're Meechie's AI assistant, and offer to connect them with the real Meechie (DM on TikTok). Be friendly, direct, and brief (under 120 words). Only describe what's listed here; for quotes or anything else, tell people to DM @meechiesworldinc on TikTok or elpesidentay on Snapchat, or email meechiesworldinc@aol.com.
Services (all start at $50 minimum, quoted per job): music production, recording rap/singing artists, sound engineering, music videos, commercials, AI video and TikTok content, artist development, concert/event promotion, sales and distribution, website building, coding, AI prompting, documents/decks/spreadsheets/research, legal document preparation and paralegal services (document prep only, not legal advice, not a law firm), help for incarcerated people's families (staying in touch, approved money transfers, grievance writing), clothing line and on-demand printing setup, house remodeling, cleaning, landscaping, security.
Books: Paper Trail; From Harlem to Fort Dix; Donald J. Trump: An Investigative Biography.
Shop tab: official Meechie's World merch (blankets, hoodies, clocks, pillowcases and more), printed on demand by Printify at meechiesworld-inc.printify.me; checkout happens there. Messages tab: private one-to-one messages between members. Creators tab clothing studio: design tees, long sleeves, hoodies, sweatshirts, and tanks front and back, or upload finished art, then submit for a community vote. Platform: Games tab (Gold Rush Arena, a live battle game members play against each other, plus a Fortnite Squad Finder to post Epic names and team up; Fortnite itself is played in Epic's app), joining, posting, chat, voice clips, gifts, the virtual world (with AI look-alike avatars and avatar outfit design), the Creators tab (design clothing for the line, vote on designs, apply to join the team and earn a share of what you build, set in a written agreement), going live, linking Printify/Shopify stores, and community ads are free. Paid promotion: Spotlight $50/7 days, Featured $150/14 days, Takeover $400/30 days; request it on the Promote tab.
Never give legal advice, never promise outcomes, never collect payment details. If you do not know something, say so and point to the DM options. For general questions not about Meechie's World, answer helpfully using the web results provided (and say so if you are not sure); still never give legal, medical, or financial advice.`;

const EXTRA = `More facts:
- Paying: Promote packages have Pay now buttons (Spotlight $50, Featured $150, Takeover $400). Services can be booked with a $50 deposit on the Services page, and invoices or quotes can be paid any amount on the Services or Contact page. Checkout is by Stripe (cards, Apple Pay, Google Pay, Cash App Pay); we never see card numbers.
- Promotion: we promote paid campaigns across all Meechie's World social media (TikTok @meechiesworldinc, Snapchat elpesidentay) plus the site feed and Ad Board.
- Donations: the Support Meechie's World section (Home and Contact pages) takes any amount. Meechie's World is a business, not a charity, so donations are not tax-deductible.
- Members can message each other privately on the Messages tab, and the site owner can edit the site.
How to answer: reply in the same language the visitor writes in. Be warm, confident, and specific. Use short paragraphs or a few bullet points, and end with one clear next step (which tab or button to use, or who to DM). Keep answers under 150 words unless asked for detail. Never invent prices, products, or promises that are not listed here. Only mention Meechie's World services, books, or products when they genuinely relate to the question; for general-knowledge answers, just answer and cite the sources.`;

// ---------- free web lookup (Wikipedia + DuckDuckGo instant answers) ----------
const UA = { "user-agent": "MeechiesWorldAI/1.0 (https://meechies-world.pages.dev; meechiesworldinc@aol.com)" };
async function decideSearch(env, turns) {
  const last = turns[turns.length - 1].content;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: "You route questions for the Meechie's World website assistant. If answering the user's latest message needs outside facts (news, current events, sports, people, places, businesses, products, history, science, how-to, definitions, general knowledge) that are NOT about Meechie's World, its services, prices, shop, or website features, reply with ONLY a short web search query (max 8 words). Questions asking for recommendations, tools, current information, or anything happening in the world also need a search. Otherwise reply with exactly NONE." },
        ...turns.slice(-4)
      ], max_tokens: 24, temperature: 0
    });
    const q = String(out && out.response || "").trim().replace(/^["']|["']$/g, "");
    if (!q || /^none\b/i.test(q) || q.length > 90) return null;
    return q;
  } catch (_) { return /\b(who|what|when|where|why|how)\b/i.test(last) && !/meechie|price|service|shop|promot|pay|site|join|radio|design/i.test(last) ? last.slice(0, 80) : null; }
}
async function tavily(env, q) {
  if (!env.TAVILY_API_KEY) return [];
  try {
    const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.TAVILY_API_KEY },
      body: JSON.stringify({ query: q, search_depth: "basic", max_results: 4, include_answer: false }) }).then((x) => x.json());
    return ((r && r.results) || []).slice(0, 4).map((x) => ({ title: x.title || x.url, text: String(x.content || "").slice(0, 900), url: x.url }));
  } catch (_) { return []; }
}
function htmlToText(h) {
  return h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
async function readUrls(text) {
  const urls = (text.match(/https?:\/\/[^\s<>"')]+/g) || []).slice(0, 2);
  const out = [];
  for (const u of urls) {
    try {
      const host = new URL(u).hostname;
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(host)) continue;
      const r = await fetch(u, { headers: { ...UA, accept: "text/html,text/plain" }, redirect: "follow", cf: { cacheTtl: 300 } });
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") || "";
      if (!/text|html|json/.test(ct)) continue;
      const raw = (await r.text()).slice(0, 400000);
      const title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i) || [, u])[1].trim().slice(0, 120);
      out.push({ title: title || u, text: htmlToText(raw).slice(0, 3500), url: u });
    } catch (_) {}
  }
  return out;
}
async function webLookup(q, env) {
  const t = await tavily(env || {}, q);
  if (t.length) return t;
  const results = [];
  try {
    const ddg = await fetch("https://api.duckduckgo.com/?no_html=1&skip_disambig=1&format=json&q=" + encodeURIComponent(q), { headers: UA }).then((r) => r.json());
    if (ddg && ddg.AbstractText) results.push({ title: ddg.Heading || q, text: ddg.AbstractText.slice(0, 900), url: ddg.AbstractURL || "https://duckduckgo.com/?q=" + encodeURIComponent(q) });
    else if (ddg && ddg.Answer) results.push({ title: q, text: String(ddg.Answer).slice(0, 500), url: "https://duckduckgo.com/?q=" + encodeURIComponent(q) });
  } catch (_) {}
  try {
    const sr = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=" + encodeURIComponent(q), { headers: UA }).then((r) => r.json());
    const titles = ((sr && sr.query && sr.query.search) || []).map((x) => x.title).slice(0, 2);
    for (const t of titles) {
      try {
        const sm = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(t.replace(/ /g, "_")), { headers: UA }).then((r) => r.json());
        if (sm && sm.extract && !results.some((r) => r.title === sm.title)) results.push({ title: sm.title, text: sm.extract.slice(0, 900), url: (sm.content_urls && sm.content_urls.desktop && sm.content_urls.desktop.page) || "https://en.wikipedia.org/wiki/" + encodeURIComponent(t) });
      } catch (_) {}
    }
  } catch (_) {}
  return results.slice(0, 3);
}


// ---------- live facts the AI can use ----------
async function liveFacts(origin) {
  const now = new Date();
  let live = "Right now it is " + now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + " (Eastern time).";
  const H = { apikey: SUPABASE_ANON, authorization: "Bearer " + SUPABASE_ANON };
  const tasks = [
    fetch(origin + "/api/store").then((r) => r.json()).then((st) => { if (st && st.products && st.products.length) live += "\nShop products (Shop tab, checkout on Printify): " + st.products.slice(0, 20).map((p) => p.title + (p.price ? " " + p.price : "")).join("; ") + "."; }).catch(() => {}),
    fetch(SUPABASE_URL + "/rest/v1/docs?select=data->>title&coll=eq.tracks&limit=80", { headers: H }).then((r) => r.json()).then((rows) => { if (Array.isArray(rows) && rows.length) live += "\nSongs on Meechie's World Radio (Radio tab, plays 24/7): " + rows.map((x) => x.title).filter(Boolean).slice(0, 60).join("; ") + "."; }).catch(() => {}),
    fetch(SUPABASE_URL + "/rest/v1/docs?select=data->>title&coll=eq.videos&data->>ttUser=eq.meechiesworldinc&limit=12&order=created_at.desc", { headers: H }).then((r) => r.json()).then((rows) => { if (Array.isArray(rows) && rows.length) live += "\nRecent Meechie TikToks (Home page and Videos tab): " + rows.map((x) => String(x.title || "").slice(0, 70)).filter(Boolean).join(" | ") + "."; }).catch(() => {}),
  ];
  await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, 2500))]);
  return live;
}

const SITE_MAP = `Website tabs: Home (TikToks, donations), Services, Shop, Community (posts with photos and videos), Radio (24/7 station, Library, live DJ sets, live radio stations from around the world), Clips (TikTok-style swipe videos), Videos (YouTube and TikTok sharing, Live TV channels), Virtual World (3D rooms and avatars like IMVU, full screen), Chat & Walkie, Messages (private), Games, Creators (clothing studio), Ad Board (free ads with photos and videos), Promote (paid promotion), Contact. Site: https://meechies-world.pages.dev`;

// ---------- understand a picture (members can attach a photo) ----------
async function seeImage(env, dataUrl, question) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m || m[2].length > 1600000) return "";
  const ask = "Describe this image in detail for someone who can't see it, including any text in it. Then answer: " + (question || "What is this?");
  try {
    const out = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: [{ role: "user", content: [{ type: "text", text: ask }, { type: "image_url", image_url: { url: dataUrl } }] }], max_tokens: 400 });
    const t = String(out && (out.response || out.result) || "").trim(); if (t) return t;
  } catch (_) {}
  try {
    const bytes = [...Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))];
    const out = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", { image: bytes, prompt: ask, max_tokens: 300 });
    return String(out && (out.description || out.response) || "").trim();
  } catch (_) { return ""; }
}

// ---------- the main answer ----------
// turns: [{role:"user"|"assistant", content}], opts: {origin, image, voice}
export async function answer(env, turns, opts = {}) {
  const origin = opts.origin || "https://meechies-world.pages.dev";
  const lastQ = turns[turns.length - 1].content;
  const [facts, linked] = await Promise.all([liveFacts(origin), opts.voice ? [] : readUrls(lastQ)]);
  let live = facts, sources = linked;
  if (opts.image) {
    const seen = await seeImage(env, opts.image, lastQ);
    live += seen ? "\n\nThe visitor attached a picture. What it shows: " + seen : "\n\nThe visitor attached a picture but it couldn't be read. Ask them to describe it.";
  }
  if (sources.length) live += "\n\nPages the visitor linked (read them to answer; cite like [1]):\n" + sources.map((r, i) => "[" + (i + 1) + "] " + r.title + " (" + r.url + "): " + r.text).join("\n");
  const q = sources.length ? null : await decideSearch(env, turns);
  if (q) {
    sources = await webLookup(q, env);
    if (sources.length) live += "\n\nWeb results for \"" + q + "\" (use these for outside facts" + (opts.voice ? "" : " and cite them like [1], [2]") + "):\n" + sources.map((r, i) => "[" + (i + 1) + "] " + r.title + ": " + r.text).join("\n");
    else live += "\n\nA web lookup for \"" + q + "\" found nothing. If you are not sure of the answer, say so.";
  }
  if (!sources.length && !opts.voice) live += "\n\nNo web results were provided for this message, so do not claim to cite sources.";
  const style = opts.voice
    ? "\n\nYou are speaking on a PHONE CALL. Talk naturally like a friendly receptionist. Keep every answer under 60 words, plain spoken sentences only: no lists, no symbols, no links, no emojis, no citations. Say web addresses simply (meechies dash world dot pages dot dev). If the caller wants to book, give prices, then offer to connect them to Meechie or tell them to DM @meechiesworldinc on TikTok."
    : "\n\nThink step by step before answering hard questions, but only show the final answer. Use markdown-free plain text with short paragraphs or simple dashes for lists.";
  const SYSTEM = BRIEF + "\n\n" + EXTRA + "\n\n" + SITE_MAP + "\n\n" + live + style;
  const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fast"];
  const errs = [];
  for (const model of MODELS) {
    try {
      const out = await env.AI.run(model, { messages: [{ role: "system", content: SYSTEM }, ...turns], max_tokens: opts.voice ? 220 : 700, temperature: 0.4 });
      const reply = String((out && (out.response || out.result || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || "")) || "").trim();
      if (reply) return { reply, sources: sources.map((r) => ({ title: r.title, url: r.url })), searched: q || null, engine: sources.length ? (env.TAVILY_API_KEY && !/wikipedia|duckduckgo/.test(sources[0].url) ? "tavily" : "free") : null };
      errs.push(model + ": empty");
    } catch (e) { errs.push(model + ": " + String(e && e.message || e).slice(0, 160)); }
  }
  return { error: "busy", detail: errs };
}
