/* v2 SERVICE WORKER (Rebuild Phase 5 — owner decision 2026-10-30:
   the skeleton is saved to the visitor's device; MAP v2 §4.7).
   Cache-first: the shell, the lazy view modules and the key brand
   images, versioned by the BUILD stamp below — a new release is a
   new cache name, so the whole skeleton swaps atomically.
   Network-only, NEVER cached: every /api/* call, station state,
   the docs/changes feeds, and all media streams (audio/video/HLS).
   Update discipline: a new worker waits and takes over on the
   visitor's NEXT natural load — nothing here forces a reload,
   swaps mid-session, or interrupts playback. The one recurring
   cost is the browser's own tiny update check per visit.
   js/ai.js (Meechie AI, the shell-wide assistant) is precached
   with the rest of the skeleton — the brain rides in the frame,
   per the heart + brain audit (owner, 2026-10-30).
   Offline music keeps the live rule: songs a listener plays are
   stored under the stable "mw-music" name, which skeleton updates
   never wipe. */
const BUILD = "p5-diet-2026-10-30";
const SHELL = "mw2-shell-" + BUILD;
const MUSIC = "mw-music";
const PRECACHE = [
 "/v2/index.html",
 "/v2/css/shell.css",
 "/v2/js/core.js",
 "/v2/js/views/watch.js",
 "/v2/js/engine.js",
 "/v2/js/station.js",
 "/v2/css/ads.css",
 "/v2/css/book.css",
 "/v2/css/books.css",
 "/v2/css/chat.css",
 "/v2/css/clips.css",
 "/v2/css/coin.css",
 "/v2/css/connect.css",
 "/v2/css/contact.css",
 "/v2/css/creators.css",
 "/v2/css/dating.css",
 "/v2/css/directory.css",
 "/v2/css/dj.css",
 "/v2/css/engine.css",
 "/v2/css/exclusives.css",
 "/v2/css/fans.css",
 "/v2/css/friends.css",
 "/v2/css/games.css",
 "/v2/css/home.css",
 "/v2/css/jobs.css",
 "/v2/css/legal.css",
 "/v2/css/live.css",
 "/v2/css/markets.css",
 "/v2/css/messages.css",
 "/v2/css/mwtv.css",
 "/v2/css/preach.css",
 "/v2/css/predict.css",
 "/v2/css/profile.css",
 "/v2/css/promote.css",
 "/v2/css/radio.css",
 "/v2/css/services.css",
 "/v2/css/shop.css",
 "/v2/css/studio.css",
 "/v2/css/tv.css",
 "/v2/css/videos.css",
 "/v2/css/watch.css",
 "/v2/css/world.css",
 "/v2/js/ai.js",
 "/v2/js/beatlab.js",
 "/v2/js/beatmaker.js",
 "/v2/js/commerce.js",
 "/v2/js/designstudio.js",
 "/v2/js/djdecks.js",
 "/v2/js/djfree.js",
 "/v2/js/djshare.js",
 "/v2/js/djstate.js",
 "/v2/js/golive.js",
 "/v2/js/jackpot.js",
 "/v2/js/mini.js",
 "/v2/js/movies.js",
 "/v2/js/obs.js",
 "/v2/js/platform.js",
 "/v2/js/rails.js",
 "/v2/js/shopgift.js",
 "/v2/js/social.js",
 "/v2/js/views/ads-markup.js",
 "/v2/js/views/ads.js",
 "/v2/js/views/books-markup.js",
 "/v2/js/views/books.js",
 "/v2/js/views/chat.js",
 "/v2/js/views/clips.js",
 "/v2/js/views/coin-markup.js",
 "/v2/js/views/coin.js",
 "/v2/js/views/community.js",
 "/v2/js/views/connect-markup.js",
 "/v2/js/views/connect.js",
 "/v2/js/views/contact-markup.js",
 "/v2/js/views/contact.js",
 "/v2/js/views/creators-markup.js",
 "/v2/js/views/creators.js",
 "/v2/js/views/dating-markup.js",
 "/v2/js/views/dating.js",
 "/v2/js/views/directory-cards.js",
 "/v2/js/views/directory.js",
 "/v2/js/views/dj.js",
 "/v2/js/views/exclusives-markup.js",
 "/v2/js/views/exclusives.js",
 "/v2/js/views/fans-markup.js",
 "/v2/js/views/fans.js",
 "/v2/js/views/friends.js",
 "/v2/js/views/games.js",
 "/v2/js/views/home.js",
 "/v2/js/views/jobs-markup.js",
 "/v2/js/views/jobs.js",
 "/v2/js/views/legal-markup.js",
 "/v2/js/views/legal.js",
 "/v2/js/views/live-markup.js",
 "/v2/js/views/live.js",
 "/v2/js/views/markets-markup.js",
 "/v2/js/views/markets.js",
 "/v2/js/views/messages.js",
 "/v2/js/views/mwtv.js",
 "/v2/js/views/placeholder.js",
 "/v2/js/views/preach-markup.js",
 "/v2/js/views/preach.js",
 "/v2/js/views/predict-markup.js",
 "/v2/js/views/predict.js",
 "/v2/js/views/profile.js",
 "/v2/js/views/promote-markup.js",
 "/v2/js/views/promote.js",
 "/v2/js/views/radio.js",
 "/v2/js/views/services-markup.js",
 "/v2/js/views/services.js",
 "/v2/js/views/shop.js",
 "/v2/js/views/studio-markup.js",
 "/v2/js/views/studio.js",
 "/v2/js/views/tv-markup.js",
 "/v2/js/views/tv.js",
 "/v2/js/views/videos-markup.js",
 "/v2/js/views/videos.js",
 "/v2/js/views/world-markup.js",
 "/v2/js/views/world.js",
 "/v2/js/world3d.js",
 /* hero art precaches the diet WebPs (Gate T gap 5): the *-640.webp
    files must be in the repo at these paths before this ships, and
    the views that show this art (radio/watch -> radio-promo,
    mwtv -> tv-poster, books -> book-cover) must point at the same
    .webp paths, or the precache and the pages disagree. Removed:
    /img/crest.png (no such file in the repo — the shell draws the
    crest as inline SVG; the dead entry also failed cache.addAll)
    and /img/og.jpg (nothing in v2 loads it; v2's og:image is
    /img/og-5.jpg, which crawlers fetch, not the shell). */
 "/img/radio-promo-640.webp",
 "/img/tv-poster-640.webp",
 "/img/book-cover-640.webp"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("mw2-shell-") && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function rangeResponse(blob, range) {
  const type = blob.type || "audio/mpeg";
  const m = /bytes=(\d*)-(\d*)/.exec(range || "");
  if (!m) return new Response(blob, { headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(blob.size) } });
  const start = m[1] ? +m[1] : 0;
  const end = m[2] ? Math.min(+m[2], blob.size - 1) : blob.size - 1;
  if (start >= blob.size) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + blob.size } });
  const chunk = blob.slice(start, end + 1);
  return new Response(chunk, { status: 206, headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": "bytes " + start + "-" + end + "/" + blob.size, "Content-Length": String(chunk.size) } });
}
async function trimMusic(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) await cache.delete(k);
  } catch (_) {}
}
/* offline music, the live sw.js strategy verbatim: cache-first for
   song files, range-aware, whole-song fill on a seek-first play,
   capped at 60 entries */
async function mediaStrategy(e) {
  const url = e.request.url;
  const range = e.request.headers.get("range");
  const cache = await caches.open(MUSIC);
  const hit = await cache.match(url);
  if (hit) {
    if (range) return rangeResponse(await hit.blob(), range);
    return hit;
  }
  try {
    const net = await fetch(e.request);
    if (net.ok && !range) {
      const len = +net.headers.get("content-length") || 0;
      if (!len || len < 12 * 1024 * 1024) e.waitUntil(cache.put(url, net.clone()).then(() => trimMusic(cache)));
    } else if (net.ok && range) {
      e.waitUntil(fetch(url).then((full) => { if (full.ok) return cache.put(url, full).then(() => trimMusic(cache)); }).catch(() => {}));
    }
    return net;
  } catch (_) {
    return new Response("", { status: 504, statusText: "Offline and not saved" });
  }
}

const MEDIA_RE = /\.(mp3|m4a|ogg|opus|wav)(\?|$)/i;
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  /* data is always live: the API, station state, feeds, streams */
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.includes(".m3u8") || url.pathname.includes(".mpd") || url.pathname.includes("/m/streams/")) return;
  if (url.origin !== self.location.origin && !MEDIA_RE.test(url.pathname)) return;
  if (MEDIA_RE.test(url.pathname) || url.pathname.startsWith("/m/media/") || url.pathname.startsWith("/m/assets/")) { e.respondWith(mediaStrategy(e)); return; }
  if (url.origin !== self.location.origin) return;
  /* the skeleton: cache-first, network fill */
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req.url, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net.ok && (url.pathname.startsWith("/v2/") || req.mode === "navigate")) e.waitUntil(cache.put(req.url, net.clone()));
      return net;
    } catch (_) {
      if (req.mode === "navigate") { const home = await cache.match("/v2/index.html"); if (home) return home; }
      throw new Error("offline");
    }
  })());
});
