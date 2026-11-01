// Service worker: makes the site installable, keeps phone notifications working,
// powers offline music — songs a listener plays (or saves from the Offline
// shelf) are stored on the device and keep playing with no internet — and keeps
// the site frame on the device (the device-saved skeleton): the HTML shell and
// every version-stamped script, stylesheet and shell-art image is served cache-first from a
// skeleton cache named for the current build stamp, so a return visit downloads
// only a tiny version check plus live data. Files without a version stamp still
// come from the network first, and /api and media are never cached by the
// skeleton. A new build is picked up on the visitor's next natural load — the
// skeleton never forces a reload and never swaps code under an open page.
// Offline strengthening (2026-10-31): the key station art and the standalone
// app pages are precached into the shell cache at install, so they open with
// no connection even before an online visit pulls them in; unstamped
// same-origin images outside the skeleton live in a bounded
// stale-while-revalidate cache; and an offline navigation that hits nothing
// cached lands on the device frame or a branded offline page instead of a
// browser error. /api is still never intercepted, and saved songs are
// untouched.
const MUSIC = "mw-music"; // stable name on purpose: updates must never wipe saved songs
const SHELL = "mw-shell-v3";
const IMAGES = "mw-images-v1"; // bounded runtime cache for unstamped same-origin images
const IMG_MAX_ENTRIES = 150; // oldest entries are evicted past this count
const IMG_MAX_ITEM = 6 * 1024 * 1024; // a single image larger than this is never stored
const KIDSTHUMBS = "mw-kidsthumbs-v1"; // bounded runtime cache for the kids app's YouTube thumbnails (cross-origin i.ytimg.com)
const KTHUMB_MAX_ENTRIES = 40; // the trending shelf ships 30 pictures; a little slack, oldest evicted past the cap
const KTHUMB_MAX_ITEM = 512 * 1024; // a video thumbnail is tens of KB; anything bigger is never stored
// --- device-saved skeleton (2026-10-30): see the skeleton section below ---
const SKEL_PREFIX = "mw-skeleton-"; // + build stamp = one generation of the frame
const SKEL_META = "mw-frame-meta"; // one JSON record naming the live generations (named outside the mw-skeleton- prefix on purpose: generation pruning must never match it)
const SKEL_HTML_KEY = "/"; // canonical key the shell HTML is stored under
const SKEL_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // backstop: re-baseline the shell weekly
// Precache the frame essentials a first visit has not pulled in yet: the
// standalone app pages and the key station art (the radio posters are
// referenced unstamped by the booth and the kids art unstamped by the kids
// app, so the skeleton rule alone cannot guarantee them on the device).
// Best-effort per file: one bad URL never fails the install, and anything
// already stored is left exactly as it is.
const PRECACHE = ["/", "/kids-app/", "/radio-app/", "/ai-app/", "/apps/",
  "/book-app/", "/books-app/", "/dating-app/", "/fans-app/", "/games-app/",
  "/jobs-app/", "/legal-app/", "/live-app/", "/shop-app/", "/studio-app/",
  "/tv-app/", "/world-app/",
  "/img/radio-promo.jpg", "/img/radio-promo-640.webp", "/img/radio-promo-1080.webp",
  "/img/kids-art-640.webp",
  "/img/tv-poster.jpg?v=1793549811", "/img/tv-poster-640.webp?v=1793549811", "/img/tv-poster-1080.webp?v=1793549811",
  "/img/icon-192.png", "/img/apple-touch-icon.png"];
async function precacheShell() {
  try {
    const cache = await caches.open(SHELL);
    await Promise.all(PRECACHE.map(async (p) => {
      const u = new URL(p, self.location.origin).href;
      try { if (await cache.match(u)) return; } catch (_) {}
      try {
        const r = await fetch(u, { cache: "no-cache" });
        if (r.ok) await cache.put(u, r);
      } catch (_) {}
    }));
  } catch (_) {}
}
self.addEventListener("install", (e) => e.waitUntil((async () => { await precacheShell(); await self.skipWaiting(); })()));
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keep = new Set([MUSIC, SHELL, SKEL_META, IMAGES, KIDSTHUMBS]);
  const meta = await skelMetaRead();
  const metaKnown = !!(meta && meta.build);
  if (metaKnown) { keep.add(SKEL_PREFIX + meta.build); if (meta.prev) keep.add(SKEL_PREFIX + meta.prev); }
  const keys = await caches.keys();
  // skeleton caches are pruned only when the meta record says which
  // generations are current; unknown skeleton state fails safe and keeps them
  await Promise.all(keys.filter((k) => !keep.has(k) && (metaKnown || k.indexOf(SKEL_PREFIX) !== 0)).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

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
      // a seek landed first: quietly store the whole song for next time
      e.waitUntil(fetch(url).then((full) => { if (full.ok) return cache.put(url, full).then(() => trimMusic(cache)); }).catch(() => {}));
    }
    return net;
  } catch (_) {
    return new Response("", { status: 504, statusText: "Offline and not saved" });
  }
}

function offlinePage() {
  const html = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Meechie's World — Offline</title>" +
    "<style>body{margin:0;background:#0b0b0d;color:#e9e2d0;font-family:Georgia,'Times New Roman',serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}" +
    ".c{max-width:420px}h1{color:#d4af37;letter-spacing:.14em;font-size:22px;margin:0 0 6px}p{line-height:1.55;color:#bdb49c}a{display:inline-block;margin-top:16px;padding:11px 22px;border:1px solid #d4af37;border-radius:999px;color:#d4af37;text-decoration:none;letter-spacing:.08em}</style></head>" +
    "<body><div class=\"c\"><div style=\"font-size:44px\">👑</div><h1>MEECHIE'S WORLD</h1>" +
    "<p>You are offline right now. The site lives on this device — your saved songs still play — and everything live comes back the moment you reconnect.</p>" +
    "<a href=\"/\">TRY AGAIN</a></div></body></html>";
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function navStrategy(e) {
  const cache = await caches.open(SHELL);
  try {
    const net = await fetch(e.request);
    if (net.ok) e.waitUntil(cache.put(e.request.url, net.clone()));
    return net;
  } catch (_) {
    const hit = await cache.match(e.request.url);
    if (hit) return hit;
    // a navigation away to another site is not ours to answer for
    if (new URL(e.request.url).origin !== self.location.origin) throw new Error("offline");
    const skel = await skelHtmlLookup(await skelMetaRead());
    if (skel) return skel;
    const root = await cache.match(self.location.origin + "/");
    if (root) return root;
    return offlinePage();
  }
}

async function shellStrategy(e) {
  const cache = await caches.open(SHELL);
  try {
    const net = await fetch(e.request);
    if (net.ok) e.waitUntil(cache.put(e.request.url, net.clone()));
    return net;
  } catch (_) {
    const hit = await cache.match(e.request.url);
    if (hit) return hit;
    throw new Error("offline");
  }
}

// --- bounded runtime image cache: begin ---
// Unstamped same-origin images outside the skeleton (book and shop art,
// promo stills) are served stale-while-revalidate from a bounded cache:
// instant repeat views and an offline copy, with a hard entry cap, a
// per-item size cap and oldest-first eviction, so this cache can never
// grow without limit. The key station art is NOT served from here: it
// stays network-first (shellStrategy) and precached, so a new poster is
// never held back by a stale copy.
function isKeyArt(pathname) {
  const b = pathname.slice(pathname.lastIndexOf("/") + 1);
  return b.indexOf("radio-promo") === 0 || b.indexOf("tv-poster") === 0 || b === "kids-art.jpg";
}

async function trimImages(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length > IMG_MAX_ENTRIES) for (const k of keys.slice(0, keys.length - IMG_MAX_ENTRIES)) await cache.delete(k);
  } catch (_) {}
}

async function imageStrategy(e) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(e.request.url);
  const refresh = (async () => {
    try {
      const net = await fetch(e.request);
      if (net.ok) {
        const len = +net.headers.get("content-length") || 0;
        if (!len || len <= IMG_MAX_ITEM) e.waitUntil(cache.put(e.request.url, net.clone()).then(() => trimImages(cache)));
      }
      return net;
    } catch (_) { return null; }
  })();
  if (hit) { e.waitUntil(refresh); return hit; }
  const net = await refresh;
  if (net) return net;
  throw new Error("offline image");
}
// --- bounded runtime image cache: end ---

// --- kids thumbnails: begin ---
// The kids app's pictures live on i.ytimg.com (cross-origin), so the
// same-origin image cache above can never hold them. This cache-first
// store keeps the trending shelf's 30 thumbnails (and any other kids
// video picture the app shows) on the device, so the shelf still
// browses with no signal. Strictly bounded: hard entry cap with
// oldest-first eviction and a per-item size cap. ONLY i.ytimg.com
// image requests are ever routed here — no other cross-origin traffic
// is intercepted, and /api stays untouched as everywhere in this file.
async function trimKthumbs(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length > KTHUMB_MAX_ENTRIES) for (const k of keys.slice(0, keys.length - KTHUMB_MAX_ENTRIES)) await cache.delete(k);
  } catch (_) {}
}

async function kthumbStrategy(e) {
  const cache = await caches.open(KIDSTHUMBS);
  const hit = await cache.match(e.request.url);
  const refresh = (async () => {
    try {
      const net = await fetch(e.request);
      if (net.ok || net.type === "opaque") {
        const len = +net.headers.get("content-length") || 0;
        if (!len || len <= KTHUMB_MAX_ITEM) e.waitUntil(cache.put(e.request.url, net.clone()).then(() => trimKthumbs(cache)));
      }
      return net;
    } catch (_) { return null; }
  })();
  if (hit) { e.waitUntil(refresh); return hit; }
  const net = await refresh;
  if (net) return net;
  throw new Error("offline thumbnail");
}
// --- kids thumbnails: end ---

// --- device-saved skeleton: begin ---
// The frame (HTML shell + version-stamped scripts, styles and shell art) lives on the
// device in a cache named mw-skeleton-<build>. The build stamp comes from
// version.json, whose build field always equals the js/dj.js?v= stamp in
// the shell (the invariant the site monitor enforces), so a cached frame
// is served only while it is exactly the frame the site is serving now.
async function skelMetaRead() {
  try {
    const c = await caches.open(SKEL_META);
    const r = await c.match("/__meta__");
    if (!r) return null;
    return await r.json();
  } catch (_) { return null; }
}

async function skelMetaWrite(meta) {
  try {
    const c = await caches.open(SKEL_META);
    await c.put("/__meta__", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  } catch (_) {}
}

async function skelBuildCheck() {
  // the tiny version check: version.json is 41 bytes and served no-store
  const r = await fetch("/version.json", { cache: "no-store" });
  if (!r.ok) throw new Error("version check " + r.status);
  const v = await r.json();
  const b = v && v.build != null ? String(v.build) : "";
  if (!b) throw new Error("version check: no build stamp");
  return b;
}

async function skelGens(meta) {
  // the generations to consult, newest first: the meta record is the hint,
  // the caches actually on the device are the ground truth (if the meta
  // record is ever lost, the surviving generations are still found)
  const names = [];
  if (meta && meta.build) names.push(SKEL_PREFIX + meta.build);
  if (meta && meta.prev && meta.prev !== meta.build) names.push(SKEL_PREFIX + meta.prev);
  try {
    const keys = await caches.keys();
    const found = keys.filter((k) => k.indexOf(SKEL_PREFIX) === 0).sort().reverse();
    for (let i = 0; i < found.length && names.length < 3; i++) if (names.indexOf(found[i]) < 0) names.push(found[i]);
  } catch (_) {}
  return names;
}

async function skelHtmlLookup(meta) {
  const names = await skelGens(meta);
  for (let i = 0; i < names.length; i++) {
    try {
      const c = await caches.open(names[i]);
      const hit = await c.match(SKEL_HTML_KEY);
      if (hit) return hit;
    } catch (_) {}
  }
  return null;
}

async function skelStoreHtml(build, response, prevMeta) {
  const cache = await caches.open(SKEL_PREFIX + build);
  await cache.put(SKEL_HTML_KEY, response);
  let prev = null;
  if (prevMeta && prevMeta.build && prevMeta.build !== build) prev = prevMeta.build;
  else if (prevMeta && prevMeta.prev && prevMeta.prev !== build) prev = prevMeta.prev;
  const keys0 = await caches.keys();
  if (!prev) {
    // the meta record was lost somewhere along the way: the newest
    // surviving generation stays on as the previous one, not the bin
    const others = keys0.filter((k) => k.indexOf(SKEL_PREFIX) === 0 && k !== SKEL_PREFIX + build).sort().reverse();
    if (others.length) prev = others[0].slice(SKEL_PREFIX.length);
  }
  await skelMetaWrite({ build: build, prev: prev, htmlAt: Date.now() });
  // the old skeleton is discarded: keep the new generation and one previous
  // (a page opened before the update may still ask the previous generation
  // for a stamped file, and it must get the copy its own frame referenced)
  const keep = new Set([SKEL_PREFIX + build]);
  if (prev) keep.add(SKEL_PREFIX + prev);
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.indexOf(SKEL_PREFIX) === 0 && !keep.has(k)).map((k) => caches.delete(k)));
}

async function skelOfflineNav(e) {
  const cache = await caches.open(SHELL);
  return (await cache.match(e.request.url)) || (await cache.match(self.location.origin + "/")) || offlinePage();
}

async function skelNavStrategy(e) {
  const meta = await skelMetaRead();
  let build = null;
  try { build = await skelBuildCheck(); } catch (_) { build = null; }
  if (build && meta && meta.build === build) {
    const cached = await skelHtmlLookup(meta);
    if (cached && Date.now() - (meta.htmlAt || 0) < SKEL_MAX_AGE) return cached; // frame served from the device
    if (cached) {
      // weekly backstop: re-baseline once from the network, else keep the copy
      try {
        const net = await fetch(e.request);
        if (net.ok) { e.waitUntil(skelStoreHtml(build, net.clone(), meta)); return net; }
      } catch (_) {}
      return cached;
    }
    try {
      const net = await fetch(e.request);
      if (net.ok) e.waitUntil(skelStoreHtml(build, net.clone(), meta));
      return net;
    } catch (_) { return skelOfflineNav(e); }
  }
  if (build) {
    // a new build is out (or the first skeleton visit): the fresh frame is
    // fetched on this natural load and the generation rolls over; pages
    // already open keep running exactly what they loaded
    try {
      const net = await fetch(e.request);
      if (net.ok) { e.waitUntil(skelStoreHtml(build, net.clone(), meta)); return net; }
      const cached = await skelHtmlLookup(meta);
      if (cached) return cached;
      return net;
    } catch (_) {
      const cached = await skelHtmlLookup(meta);
      if (cached) return cached;
      return skelOfflineNav(e);
    }
  }
  // no signal for the version check: the device frame if there is one,
  // otherwise the pre-skeleton navigation behavior
  const cached = await skelHtmlLookup(meta);
  if (cached) return cached;
  return navStrategy(e);
}

function skelStamped(url) {
  // only files the site versions with a ?v= stamp may be served cache-first;
  // a stamped URL never changes under its stamp (the site serves /js and
  // /css as immutable, and stamped shell art under /img joins them under
  // the same invariant), so the exact URL is the version key. Unstamped
  // /img still goes network-first in the fetch handler below: member
  // photos and other changing images are never frozen by this rule
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf("/js/") !== 0 && url.pathname.indexOf("/css/") !== 0 && url.pathname.indexOf("/img/") !== 0 && url.pathname.indexOf("/fonts/") !== 0) return false;
  const v = url.searchParams.get("v");
  return !!v && /^\d+$/.test(v);
}

async function skelAssetStrategy(e) {
  const meta = await skelMetaRead();
  const gens = await skelGens(meta);
  if (!gens.length) return shellStrategy(e); // no generation yet: pre-skeleton behavior
  for (let i = 0; i < gens.length; i++) {
    try {
      const c = await caches.open(gens[i]);
      const hit = await c.match(e.request.url);
      if (hit) {
        if (i > 0) e.waitUntil((async () => { try { const cur = await caches.open(gens[0]); await cur.put(e.request.url, hit.clone()); } catch (_) {} })());
        return hit;
      }
    } catch (_) {}
  }
  // legacy bridge: copies the pre-skeleton worker saved in SHELL stay usable
  try {
    const legacy = await caches.open(SHELL);
    const hit = await legacy.match(e.request.url);
    if (hit) return hit;
  } catch (_) {}
  const net = await fetch(e.request);
  if (net.ok) e.waitUntil((async () => { try { const c = await caches.open(gens[0]); await c.put(e.request.url, net.clone()); } catch (_) {} })());
  return net;
}
// --- device-saved skeleton: end ---

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  // live data is never intercepted and never cached: it goes straight to
  // the network, exactly as it always has
  if (url.origin === self.location.origin && url.pathname.indexOf("/api/") === 0) return;
  const isMedia = e.request.destination === "audio" || e.request.destination === "video" || e.request.headers.get("x-mw-save") === "1" || url.pathname.indexOf("/m/") === 0;
  if (isMedia) { e.respondWith(mediaStrategy(e)); return; }
  if (e.request.mode === "navigate") {
    if (url.origin === self.location.origin && (url.pathname === "/" || url.pathname === "/index.html")) e.respondWith(skelNavStrategy(e));
    else e.respondWith(navStrategy(e));
    return;
  }
  if (skelStamped(url)) { e.respondWith(skelAssetStrategy(e)); return; }
  if (e.request.destination === "image" && url.hostname === "i.ytimg.com") { e.respondWith(kthumbStrategy(e)); return; }
  if (e.request.destination === "image" && url.origin === self.location.origin && !e.request.headers.get("range") &&
      (url.pathname.indexOf("/img/") === 0 || url.pathname.indexOf("/media/") === 0) && !isKeyArt(url.pathname)) { e.respondWith(imageStrategy(e)); return; }
  if (url.origin === self.location.origin && (url.pathname.indexOf("/js/") === 0 || url.pathname.indexOf("/img/") === 0 || /\.(css|webmanifest)$/.test(url.pathname))) e.respondWith(shellStrategy(e));
});
// phone notifications (see js/push.js and functions/api/push.js)
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Meechie's World", { body: d.body || "You have something new", icon: "/img/icon-192.png", badge: "/img/icon-192.png", tag: d.tag || "mw", renotify: true, data: { url: d.url || "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.location.origin)) { c.focus(); return c.navigate ? c.navigate(url) : null; }
    return self.clients.openWindow(url);
  }));
});
