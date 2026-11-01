// Meechie's AI brain, shared by the website chat (/api/ai) and the phone line (/api/voice).
// Uses Cloudflare Workers AI (binding "AI"), optional Tavily web search (TAVILY_API_KEY).
import { MODEL_BY_ID } from "./ai-catalog.js";
import { readMember, memberFacts } from "./brain-member.js";
const CHAT_KINDS = new Set(["chat", "reasoning", "code", "vision"]);
export const SUPABASE_URL = "https://yjouaysczttqbytksejq.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlqb3VheXNjenR0cWJ5dGtzZWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDQzMjYsImV4cCI6MjEwNzA4MDMyNn0.4IQNTjyuF4P-WhnhBxs_kA90MhLj9I6c-xUFzOqWhcw";
const BRIEF = `Your name is Meechie. You are the AI assistant for Meechie's World Inc (named after the owner, also called Meechie). If anyone asks whether you're a real person or the real Meechie, say honestly that you're Meechie's AI assistant, and offer to connect them with the real Meechie (DM on TikTok). You are his people's assistant: look after his visitors and members like a good host — greet them warmly, help them find what they came for, walk them to it, and never leave a person stuck; if you cannot do something, tell them how to reach the real Meechie. Be friendly, direct, and brief (under 120 words). Only describe what's listed here; for quotes or anything else, tell people to DM @meechiesworldinc on TikTok or elpesidentay on Snapchat, or email meechiesworldinc@aol.com.
Services (all start at $50 minimum, quoted per job): music production, recording rap/singing artists, sound engineering, music videos, commercials, AI video and TikTok content, artist development, concert/event promotion, sales and distribution, website building, coding, AI prompting, documents/decks/spreadsheets/research, legal document preparation and paralegal services (document prep only, not legal advice, not a law firm), help for incarcerated people's families (staying in touch, approved money transfers, grievance writing), clothing line and on-demand printing setup, house remodeling, cleaning, landscaping, security.
Books: Paper Trail; From Harlem to Fort Dix; Donald J. Trump: An Investigative Biography.
Shop tab: official Meechie's World merch (blankets, hoodies, clocks, pillowcases and more), printed on demand by Printify at meechiesworld-inc.printify.me; checkout happens there. Messages tab: private one-to-one messages between members. Creators tab clothing studio: design tees, long sleeves, hoodies, sweatshirts, and tanks front and back, or upload finished art, then submit for a community vote. Platform: Games tab (Gold Rush Arena, a live battle game members play against each other, plus a Fortnite Squad Finder to post Epic names and team up; Fortnite itself is played in Epic's app), joining, posting, chat, voice clips, gifts, the virtual world (with AI look-alike avatars and avatar outfit design), the Creators tab (design clothing for the line, vote on designs, apply to join the team and earn a share of what you build, set in a written agreement), going live, linking Printify/Shopify stores, and community ads are free. Paid promotion: Spotlight $50/7 days, Featured $150/14 days, Takeover $400/30 days; request it on the Promote tab.
Never promise outcomes and never collect payment details. You may explain the law and court procedure in plain words (legal information, like a law library would), but say you're not a lawyer and that this isn't legal advice. For court papers (motions, petitions, complaints, affidavits, letters to the court), send people to the Legal Help tab, where Meechie's AI drafts the document for free, finds real case law and checks the citations. If they'd rather have Meechie prepare it for them, that's $50 per motion or document (Legal Help tab, "Have Meechie prepare it for you"). If you do not know something, say so and point to the DM options. For general questions not about Meechie's World, answer helpfully using the web results provided (and say so if you are not sure); still never give legal, medical, or financial advice.`;

const EXTRA = `More facts:
- Paying: Promote packages have Pay now buttons (Spotlight $50, Featured $150, Takeover $400). Services can be booked with a $50 deposit on the Services page, and invoices or quotes can be paid any amount on the Services or Contact page. Checkout is by Stripe (cards, Apple Pay, Google Pay, Cash App Pay); we never see card numbers.
- Promotion: we promote paid campaigns across all Meechie's World social media (TikTok @meechiesworldinc, Snapchat elpesidentay) plus the site feed and Ad Board.
- Donations: the Support Meechie's World section (Home and Contact pages) takes any amount. Meechie's World is a business, not a charity, so donations are not tax-deductible.
- Members can message each other privately on the Messages tab, and the site owner can edit the site.
How to answer: reply in the same language the visitor writes in. Be warm, confident, and specific. Use short paragraphs or a few bullet points, and end with one clear next step (which tab or button to use, or who to DM). Keep answers under 250 words unless asked for detail. Never invent prices, products, or promises that are not listed here. Only mention Meechie's World services, books, or products when they genuinely relate to the question; for general-knowledge answers, just answer and cite the sources.
Navigation help: you can also take visitors around the site yourself. When someone asks to be taken somewhere, asks where something is, or clearly wants a section (the shop, the radio, the DJ booth, clips, legal help, dating, friends, the coin casino, the virtual world, games, messages and so on), give your short answer and finish with a line containing only [[nav:VIEW]], where VIEW is exactly one of: home, community, services, shop, radio, dj, clips, videos, live, livetv, liveradio, friends, dating, coin, world, games, creators, legal, chat, messages, connect, books, studio, markets, predict, promote, contact. The website turns that line into a Go button that takes them straight there. Never mention or explain the marker itself. The Games tab is the Coin Jackpot (never call it a casino).`;

// ---------- free web lookup (Wikipedia + DuckDuckGo instant answers) ----------
const UA = { "user-agent": "MeechiesWorldAI/1.0 (https://meechiesworldinc.com; meechiesworldinc@aol.com)" };
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
const okHost = (host) => !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) && !/^\[|^[\d.]+$|^0x|\.local$|\.internal$|\.localhost$/i.test(host);
async function readUrls(text) {
  const urls = (text.match(/https?:\/\/[^\s<>"')]+/g) || []).slice(0, 2);
  const out = [];
  for (const u of urls) {
    try {
      // follow up to 3 redirects ourselves, checking every hop is a real public web address (no internal hosts or bare IPs)
      let at = u, r = null;
      for (let hop = 0; hop < 4; hop++) {
        const h = new URL(at); if (!/^https?:$/.test(h.protocol) || !okHost(h.hostname)) { r = null; break; }
        r = await fetch(at, { headers: { ...UA, accept: "text/html,text/plain" }, redirect: "manual", cf: { cacheTtl: 300 } });
        const loc = r.status >= 300 && r.status < 400 && r.headers.get("location");
        if (!loc) break; at = new URL(loc, at).href; r = null;
      }
      if (!r || !r.ok) continue;
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
const JACKPOT_LINE = "\nCoin Jackpot (Games tab): Coin Flip, High Card, Lucky Dice, Gold Slots, Meechie Race, Wheel of Gold, Gold Drop and Triple Flip, plus member-vs-member coin-flip pots. Coins are worth 1 cent each and are bought in packs from the Wallet card on the Games page. A daily check-in pays 10 free coins (50 every 7th straight day), and every member can claim a one-time 100-coin welcome drop on the Jackpot page. Game winnings are coins to play with; the cash value comes from gifts — a member who receives gifts earns 40 percent of their value as real money and can cash out from $10 up.";
const APPS_LINE = "\nApps: Meechie's World has free home-screen apps — the full site app plus one per section (Radio, Meechie AI, Book, Dating, Legal, Shop, Live, Studio, TV, Games, Jobs, Books, Fans, World) — all on the App Store page at /apps/. They install straight from the browser; nobody needs an app store account.";
/* The site brain (owner, 2026-10-27: "give my website a brain"): live facts read
   from the site's real database at answer time — what is on the radio right now,
   the Jackpot pool, the song library, the member count, and what members have
   been asking lately (the AI's memory of questions lives in ai_questions). */
async function siteBrain(env) {
  if (!env || !env.DB) return "";
  let out = JACKPOT_LINE + APPS_LINE;
  const get = async (sql) => { try { return await env.DB.prepare(sql).first(); } catch (_) { return null; } };
  const all = async (sql) => { try { const r = await env.DB.prepare(sql).all(); return (r && r.results) || []; } catch (_) { return []; } };
  const [djRow, pool, trackRows, memberRow, qs, contentRow] = await Promise.all([
    get("select data from docs where path = 'radio/dj'"),
    get("select coins from game_pool where id = 1"),
    all("select json_extract(data, '$.title') as t from docs where coll = 'tracks' order by created_at desc limit 40"),
    get("select count(*) as c from docs where coll = 'members'"),
    all("select q from ai_questions order by at desc limit 40"),
    get("select data from docs where path = 'site/content'"),
  ]);
  /* The owner's own site edits (PR-B3, BLUEPRINT §3): what Malik changes in
     the site editor lands in site/content, so his edits reach Meechie's
     answers without a code deploy. Only the factual edges are folded in —
     pages he has hidden (never send a visitor to a hidden page) and the
     fact that wording on the site is owner-edited (believe the page over
     the brief when they disagree). The raw text-replacement map is NOT
     dumped into the prompt: it is presentation, not facts. */
  if (contentRow && contentRow.data) {
    try {
      const C = typeof contentRow.data === "string" ? JSON.parse(contentRow.data) : contentRow.data;
      const hidden = Array.isArray(C.hidden) ? C.hidden.filter((h) => typeof h === "string" && h).slice(0, 20) : [];
      if (hidden.length) out += "\nThe owner currently hides these pages from visitors: " + hidden.join(", ") + " — do not send people there or describe them as available.";
      if (C.t && typeof C.t === "object" && Object.keys(C.t).length) out += "\nSome wording on the site has been edited by the owner himself; if a visitor quotes what a page says and it differs from these facts, believe the visitor.";
    } catch (_) {}
  }
  if (djRow && djRow.data) {
    try {
      const S = typeof djRow.data === "string" ? JSON.parse(djRow.data) : djRow.data;
      const playing = ["A", "B", "C", "D"].filter((k) => S[k] && S[k].playing && S[k].title).map((k) => S[k].title);
      if (S.live && playing.length) out += "\nOn the radio right now: Meechie is LIVE on the DJ decks, playing " + playing.join(" and ") + ". Visitors can hear it on the Radio tab.";
      else if (playing.length) out += "\nOn the radio right now: " + playing.join(" and ") + " (the station is playing; Meechie is not live on the decks at this moment).";
      else out += "\nOn the radio right now: the Auto-DJ rotation is playing from the song library.";
    } catch (_) {}
  }
  if (pool && pool.coins != null) out += "\nThe Coin Jackpot prize pool right now holds " + pool.coins + " coins — every game payout comes out of that pool.";
  const titles = trackRows.map((r) => r.t).filter(Boolean);
  if (titles.length) out += "\nSongs in the radio library include: " + titles.slice(0, 30).join("; ") + ".";
  if (memberRow && memberRow.c) out += "\nThe community has " + memberRow.c + " members.";
  const seen = new Set(), top = [];
  for (const r of qs) { const q = String(r.q || "").replace(/\s+/g, " ").trim(); const key = q.toLowerCase().slice(0, 60); if (q && !seen.has(key)) { seen.add(key); top.push(q); if (top.length >= 6) break; } }
  // members' questions stay private (owner-only log): never fed into other members' chats
  return out;
}
export async function logQuestion(env, uid, q) {
  if (!env || !env.DB || !q) return;
  try {
    await env.DB.prepare("create table if not exists ai_questions (id integer primary key autoincrement, uid text, q text, at integer)").run();
    await env.DB.prepare("insert into ai_questions (uid, q, at) values (?, ?, ?)").bind(uid || "", String(q).slice(0, 300), Date.now()).run();
    await env.DB.prepare("delete from ai_questions where id not in (select id from ai_questions order by id desc limit 500)").run();
  } catch (_) {}
}
export async function recentQuestions(env, n) {
  if (!env || !env.DB) return [];
  try { const r = await env.DB.prepare("select q, at from ai_questions order by at desc limit ?").bind(n || 50).all(); return (r && r.results) || []; } catch (_) { return []; }
}
async function liveFacts(env, origin, token) {
  const now = new Date();
  let live = "Right now it is " + now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + " (Eastern time).";
  const tasks = [
    fetch(origin + "/api/store", { headers: UA }).then((r) => r.json()).then((st) => { if (st && st.products && st.products.length) live += "\nShop products (Shop tab, checkout on Printify): " + st.products.slice(0, 20).map((p) => p.title + (p.price ? " " + p.price : "")).join("; ") + "."; }).catch(() => {}),
    siteBrain(env).then((t) => { if (t) live += t; }).catch(() => {}),
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

// ---------- run the AI (strongest free model first, then fall back) ----------
// gpt-oss-120b uses the "responses" style (instructions + input); the others use chat messages.
// Fair-use limits (supabase/lockdown.sql: public.take). Returns true (go ahead), false (limit reached) or null (couldn't check,
// e.g. before the database update is run): callers only stop on false, so nothing breaks if the check isn't set up.
// With a member's token the limit is per member (Meechie is never limited); without one it needs SUPABASE_SERVICE_ROLE_KEY.
export async function take(env, token, key, windowSecs, max) {
  const svc = env && env.SUPABASE_SERVICE_ROLE_KEY;
  const bearer = token || svc; if (!bearer) return null;
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/take", { method: "POST", headers: { apikey: token ? SUPABASE_ANON : svc, authorization: "Bearer " + bearer, "content-type": "application/json" },
      body: JSON.stringify({ p_key: key, p_window: windowSecs, p_max: max }) });
    if (!r.ok) return null;
    return (await r.json()) === true;
  } catch (_) { return null; }
}

export const MODELS = ["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fast"];

/* ---------- all-in-one router (PR-B4, BLUEPRINT §4) ----------
 * One assistant, many engines: the job picks the tier, the tier orders the
 * chain, and the fall-through chain stays the safety net under every tier.
 * All models come from lib/ai-catalog.js — nothing new is wired, and the
 * member own model pick still wins over every rule below. */
const TIER_FAST = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct"];
const TIER_DEEP = ["@cf/openai/gpt-oss-120b", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/qwen/qwq-32b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fast"];
const TIER_VISION = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.2-11b-vision-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fast"];
const TIER_DEFAULT = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/openai/gpt-oss-120b", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/meta/llama-3.1-8b-instruct-fast"];
const BIG_TIER = new Set(["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/qwen/qwq-32b"]);

/* Cheap shape-of-the-question test — string work only, never a model call
 * (the router call budget belongs to decideSearch, which stays as is). */
function isHardQuestion(q) {
  const s = String(q || "");
  if (s.length > 600) return true;
  if (/```/.test(s)) return true;
  if ((s.match(/\?/g) || []).length >= 3) return true;
  return /\b(explain in detail|in detail|step[- ]by[- ]step|draft|write (me |up )?(a |an |the )?(letter|essay|contract|motion|affidavit|petition|complaint|business plan|resume)|pros and cons|compare .+ (with|to|versus|vs)|analyze|analyse)\b/i.test(s);
}

/* Budget mode: the free daily allowance is one shared pool, and a spent
 * pool looks like the big models erroring again and again. Three answers
 * inside half an hour where two or more big-tier models failed is that
 * shape — when it trips, the chain pins to the fast tier for an hour
 * (stamped in the brain/budget doc) and Meechie keeps answering in the
 * smaller voice instead of going silent. A member own model pick is never
 * pinned: their pick, their call. */
let budgetMemo = { at: 0, pinUntil: 0 };
async function budgetPinUntil(env) {
  const now = Date.now();
  if (now - budgetMemo.at < 60e3) return budgetMemo.pinUntil;
  budgetMemo = { at: now, pinUntil: 0 };
  if (!env || !env.DB) return 0;
  try {
    const row = await env.DB.prepare("select data from docs where path = 'brain/budget'").first();
    if (row && row.data) { const b = JSON.parse(row.data); if (b && +b.pinUntil > now) budgetMemo.pinUntil = +b.pinUntil; }
  } catch (_) {}
  return budgetMemo.pinUntil;
}
async function noteBigTierFailure(env) {
  if (!env || !env.DB) return;
  try {
    const now = Date.now();
    const row = await env.DB.prepare("select data from docs where path = 'brain/budget'").first();
    let b = { fails: [], pinUntil: 0 };
    if (row && row.data) { try { const p = JSON.parse(row.data); if (p && Array.isArray(p.fails)) b = p; } catch (_) {} }
    b.fails = b.fails.filter((t) => now - +t < 30 * 60e3);
    b.fails.push(now);
    if (b.fails.length >= 3) { b.pinUntil = now + 60 * 60e3; budgetMemo = { at: now, pinUntil: b.pinUntil }; }
    const nowIso = new Date().toISOString(), data = JSON.stringify(b);
    const r = await env.DB.prepare("update docs set data = ?, updated_at = ? where path = ?").bind(data, nowIso, "brain/budget").run();
    if (!r.meta || !r.meta.changes) await env.DB.prepare("insert or ignore into docs (path, coll, owner, data, created_at, updated_at) values (?,?,?,?,?,?)").bind("brain/budget", "brain", null, data, nowIso, nowIso).run();
    await env.DB.prepare("insert into changes (tbl, path, coll, a, b, at) values (?,?,?,?,?,?)").bind("docs", "brain/budget", "brain", null, null, now).run();
  } catch (_) {}
}
function textOf(out) {
  if (!out) return "";
  if (typeof out === "string") return out;
  if (out.response) return typeof out.response === "string" ? out.response : JSON.stringify(out.response);
  if (out.result && typeof out.result === "string") return out.result;
  if (out.output_text) return out.output_text;
  if (Array.isArray(out.output)) {
    const parts = [];
    for (const o of out.output) if (o && o.type === "message" && Array.isArray(o.content)) for (const c of o.content) if (c && (c.type === "output_text" || c.text)) parts.push(c.text || "");
    if (parts.length) return parts.join("");
  }
  const ch = out.choices && out.choices[0];
  if (ch) return (ch.message && ch.message.content) || ch.text || "";
  return "";
}
export async function runModel(env, system, turns, opts = {}) {
  const errs = [], models = opts.models || MODELS;
  for (const model of models) {
    try {
      let out;
      if (/gpt-oss/.test(model)) out = await env.AI.run(model, { instructions: system, input: turns.map((t) => ({ role: t.role, content: t.content })), max_output_tokens: opts.max_tokens || 900, reasoning: { effort: opts.effort || "low" } });
      else out = await env.AI.run(model, { messages: [{ role: "system", content: system }, ...turns], max_tokens: Math.min(opts.max_tokens || 900, /8b/.test(model) ? 2000 : 4000), temperature: opts.temperature ?? 0.4 });
      const reply = String(textOf(out) || "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "").trim();
      if (reply) return { reply, model, errs };
      errs.push(model + ": empty");
    } catch (e) { errs.push(model + ": " + String(e && e.message || e).slice(0, 160)); }
  }
  return { error: "busy", detail: errs };
}

// ---------- the main answer ----------
// turns: [{role:"user"|"assistant", content}], opts: {origin, image, voice, uid}
// opts.uid is set ONLY by /api/ai from the caller's own session (PR-B3): it
// unlocks that member's own memory block below. The phone line and any
// caller without a member session pass no uid and get no member block —
// a member's memory is read only with that member's own session, and only
// ever injected into that member's own answers (BLUEPRINT §3 hard rule).
export async function answer(env, turns, opts = {}) {
  const origin = opts.origin || "https://meechies-world.pages.dev";
  const lastQ = turns[turns.length - 1].content;
  const [facts, linked] = await Promise.all([liveFacts(env, origin, opts.token), opts.voice ? [] : readUrls(lastQ)]);
  let live = facts, sources = linked;
  if (opts.uid) {
    try { const mem = await readMember(env, opts.uid); const mf = memberFacts(mem); if (mf) live += mf; } catch (_) {}
  }
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
  // a member can pick their brain from the installed catalog; it goes first, the house chain backs it up
  const picked = opts.model && MODEL_BY_ID[opts.model] && CHAT_KINDS.has(MODEL_BY_ID[opts.model].kind) ? opts.model : null;
  /* Router (PR-B4): a real model pick wins outright. Otherwise the widget
   * routing choice (opts.tier: quick / deep) beats the shape rules; then
   * voice goes fast (latency), a picture goes vision, a long or hard
   * question goes deep, and everything else takes the default 70B tier.
   * Budget mode overrides every routed tier except a member pick. */
  let tier = "default", chain = TIER_DEFAULT;
  if (picked) { tier = "picked"; chain = [picked, ...MODELS.filter((m) => m !== picked)]; }
  else if (opts.tier === "quick") { tier = "quick"; chain = TIER_FAST; }
  else if (opts.tier === "deep") { tier = "deep"; chain = TIER_DEEP; }
  else if (opts.voice) { tier = "fast"; chain = TIER_FAST; }
  else if (opts.image) { tier = "vision"; chain = TIER_VISION; }
  else if (isHardQuestion(lastQ)) { tier = "deep"; chain = TIER_DEEP; }
  if (!picked && (await budgetPinUntil(env)) > Date.now()) { tier = "budget"; chain = TIER_FAST; }
  const out = await runModel(env, SYSTEM, turns, { max_tokens: opts.voice ? 260 : tier === "deep" ? 2200 : 1400, temperature: 0.4, models: chain });
  // budget bookkeeping: two or more big-tier failures inside one answer is
  // a strike; three strikes in half an hour pins the fast tier for an hour
  const bigFails = (out.errs || []).filter((e) => BIG_TIER.has(String(e).split(": ")[0])).length;
  if (!picked && (bigFails >= 2 || (out.error && bigFails >= 1))) { try { await noteBigTierFailure(env); } catch (_) {} }
  if (out.error) return { ...out, tier };
  return { reply: out.reply, model: out.model, tier, sources: sources.map((r) => ({ title: r.title, url: r.url })), searched: q || null, engine: sources.length ? (env.TAVILY_API_KEY && !/wikipedia|duckduckgo/.test(sources[0].url) ? "tavily" : "free") : null };
}


// ---------- double-check an answer ----------
const CHECK = `You are a strict fact-checker for the Meechie's World website assistant. Check the ASSISTANT ANSWER to the QUESTION.
Use the web results when provided. For facts about Meechie's World itself, trust the site facts given.
Reply in plain text (no markdown symbols), short:
First line exactly one of: "✅ Looks right" or "⚠️ Partly right" or "❌ Needs correcting" or "❔ Couldn't confirm".
Then: what is confirmed, what is wrong or out of date (with the correct information), and what couldn't be confirmed. Name the source for each correction. Never invent facts or sources.`;
async function claudeCheck(env, system, user) {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 1200, system,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }], messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text || null;
  } catch (_) { return null; }
}
export async function verifyAnswer(env, question, answer, opts = {}) {
  const q = String(question || "").slice(0, 1500), a = String(answer || "").split("\n\nSources:")[0].slice(0, 5000);
  const facts = await liveFacts(env, opts.origin || "https://meechies-world.pages.dev", opts.token).catch(() => "");
  const base = "QUESTION:\n" + q + "\n\nASSISTANT ANSWER:\n" + a + "\n\nSITE FACTS:\n" + BRIEF.slice(0, 2500) + "\n" + facts.slice(0, 2500);
  const c = await claudeCheck(env, CHECK, base);
  if (c) return { text: c, by: "claude" };
  let web = [];
  try { const sq = await decideSearch(env, [{ role: "user", content: q }]); if (sq) web = await webLookup(sq, env); } catch (_) {}
  const user = base + (web.length ? "\n\nWEB RESULTS:\n" + web.map((r, i) => "[" + (i + 1) + "] " + r.title + " (" + r.url + "): " + r.text).join("\n") : "\n\nWEB RESULTS: none found.");
  // a different AI than the one that answered, so it isn't grading its own work
  const out = await runModel(env, CHECK, [{ role: "user", content: user }], { models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/openai/gpt-oss-120b"], max_tokens: 700, temperature: 0.1 });
  if (out.error) return { error: "busy" };
  return { text: out.reply, by: "second-ai", sources: web.map((r) => ({ title: r.title, url: r.url })) };
}
