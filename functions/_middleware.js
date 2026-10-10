/* Runs in front of every page and file on the site.
 * 1) Turns away AI bots and scrapers (even the ones that ignore robots.txt).
 * 2) Adds security headers to every response.
 * Link-preview bots (Facebook, iMessage, WhatsApp, Discord, Telegram, X) and search engines still get through,
 * so shared links show the picture and people can find the site on Google. */
const AI_BOTS = /GPTBot|ChatGPT|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic|Google-Extended|GoogleOther|Applebot-Extended|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|meta-externalagent|meta-externalfetcher|FacebookBot|cohere|Diffbot|YouBot|DuckAssistBot|MistralAI|AI2Bot|Ai2Bot|ImagesiftBot|Omgili|Timpibot|img2dataset|PanguBot|Kangaroo Bot|Webzio|iaskspider|Scrapy|python-requests|python-urllib|aiohttp|httpx|Go-http-client|node-fetch|axios\/|okhttp|libwww-perl|Java\/|curl\/|Wget|HTTrack|Firecrawl|Apify|scrapingbee|ScraperAPI|Crawl4AI|SemrushBot|AhrefsBot|MJ12bot|DotBot|DataForSeoBot|PetalBot|Barkrowler/i;
const PREVIEW = /facebookexternalhit|Facebot|Twitterbot|WhatsApp|Discordbot|TelegramBot|Slackbot|LinkedInBot|Pinterest|SkypeUriPreview|iMessage|Googlebot|bingbot|DuckDuckBot|Applebot\//i;

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const ua = ctx.request.headers.get("user-agent") || "";
  const allowed = url.pathname === "/robots.txt" || url.pathname.startsWith("/api/voice") || (PREVIEW.test(ua) && !/Applebot-Extended|GoogleOther|Google-Extended/i.test(ua));
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
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "SAMEORIGIN");
  return out;
}
