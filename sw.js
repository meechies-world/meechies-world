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
const MUSIC = "mw-music"; // stable name on purpose: updates must never wipe saved songs
const SHELL = "mw-shell-v2";
// --- device-saved skeleton (2026-10-30): see the skeleton section below ---
const SKEL_PREFIX = "mw-skeleton-"; // + build stamp = one generation of the frame
const SKEL_META = "mw-frame-meta"; // one JSON record naming the live generations (named outside the mw-skeleton- prefix on purpose: generation pruning must never match it)
const SKEL_HTML_KEY = "/"; // canonical key the shell HTML is stored under
const SKEL_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // backstop: re-baseline the shell weekly
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keep = new Set([MUSIC, SHELL, SKEL_META]);
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

async function navStrategy(e) {
  const cache = await caches.open(SHELL);
  try {
    const net = await fetch(e.request);
    if (net.ok) e.waitUntil(cache.put(e.request.url, net.clone()));
    return net;
  } catch (_) {
    return (await cache.match(e.request.url)) || (await cache.match(self.location.origin + "/")) || new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
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
  return (await cache.match(e.request.url)) || (await cache.match(self.location.origin + "/")) || new Response("You are offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
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
  if (url.pathname.indexOf("/js/") !== 0 && url.pathname.indexOf("/css/") !== 0 && url.pathname.indexOf("/img/") !== 0) return false;
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
