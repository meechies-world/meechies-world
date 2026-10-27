// Service worker: makes the site installable, keeps phone notifications working,
// and powers offline music — songs a listener plays (or saves from the Offline
// shelf) are stored on the device and keep playing with no internet. Pages and
// scripts always come from the network first when there is a signal, so nobody
// is ever stuck on an old version; the cache is only the offline fallback.
const MUSIC = "mw-music"; // stable name on purpose: updates must never wipe saved songs
const SHELL = "mw-shell-v2";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== MUSIC && k !== SHELL).map((k) => caches.delete(k)));
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

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  const isMedia = e.request.destination === "audio" || e.request.destination === "video" || e.request.headers.get("x-mw-save") === "1" || url.pathname.indexOf("/m/") === 0;
  if (isMedia) { e.respondWith(mediaStrategy(e)); return; }
  if (e.request.mode === "navigate") { e.respondWith(navStrategy(e)); return; }
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
