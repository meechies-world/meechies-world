/* Runs in front of every page and file on the site.
 * 1) Turns away AI bots and scrapers (even the ones that ignore robots.txt).
 * 2) Adds security headers to every response.
 * Link-preview bots (Facebook, iMessage, WhatsApp, Discord, Telegram, X) and search engines still get through,
 * so shared links show the picture and people can find the site on Google. */
const AI_BOTS = /GPTBot|ChatGPT|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic|Google-Extended|GoogleOther|Applebot-Extended|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|meta-externalagent|meta-externalfetcher|FacebookBot|cohere|Diffbot|YouBot|DuckAssistBot|MistralAI|AI2Bot|Ai2Bot|ImagesiftBot|Omgili|Timpibot|img2dataset|PanguBot|Kangaroo Bot|Webzio|iaskspider|Scrapy|python-requests|python-urllib|aiohttp|httpx|Go-http-client|node-fetch|axios\/|okhttp|libwww-perl|Java\/|curl\/|Wget|HTTrack|Firecrawl|Apify|scrapingbee|ScraperAPI|Crawl4AI|SemrushBot|AhrefsBot|MJ12bot|DotBot|DataForSeoBot|PetalBot|Barkrowler/i;
const PREVIEW = /facebookexternalhit|Facebot|Twitterbot|WhatsApp|Discordbot|TelegramBot|Slackbot|LinkedInBot|Pinterest|SkypeUriPreview|iMessage|Googlebot|bingbot|DuckDuckBot|Applebot\//i;
// AI assistants that open a page because a person asked about it (not training or scraping crawlers).
const ASSISTANTS = /ChatGPT-User|Claude-User|Perplexity-User/i;
// Paths that must never be served from the public site.
const INTERNAL = /^\/(supabase|lib|functions)\/|^\/(wrangler\.toml|tools-bump\.py|AGENTS\.md|CLAUDE\.md|GEMINI\.md|README\.md|\.gitignore)$/i;

import { install } from "../lib/sbshim.js";
let ENV = null; install(() => ENV); // server helpers read the new free database once the move is done (lib/sbshim.js)

export async function onRequest(ctx) {
  ENV = ctx.env;
  const url = new URL(ctx.request.url);
  // www.meechiesworldinc.com → meechiesworldinc.com. meechies-world.pages.dev keeps working on its own (owner's choice).
  if (url.hostname === "www.meechiesworldinc.com") {
    return Response.redirect("https://meechiesworldinc.com" + url.pathname + url.search, 301);
  }
  // Internal project files are never public: database scripts, library code, deploy settings, team notes.
  if (INTERNAL.test(url.pathname)) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const ua = ctx.request.headers.get("user-agent") || "";
  const allowed = url.pathname === "/robots.txt" || url.pathname.startsWith("/api/voice") || ASSISTANTS.test(ua) || (PREVIEW.test(ua) && !/Applebot-Extended|GoogleOther|Google-Extended/i.test(ua));
  if (!allowed && (AI_BOTS.test(ua) || !ua.trim())) {
    return new Response("Access denied. AI bots and scrapers are not allowed on Meechie's World.\n", {
      status: 403, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, noai, noimageai", "cache-control": "no-store" },
    });
  }
  const res = await ctx.next();
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("X-Robots-Tag", "noai, noimageai");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Permitted-Cross-Domain-Policies", "none");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "SAMEORIGIN");
  return out;
}
