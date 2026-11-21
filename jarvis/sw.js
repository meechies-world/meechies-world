// Meechie JARVIS phone PWA — service worker.
// Caches the app shell (page, css, js, catalog, icons, Meechie art) so the
// app opens fast and light mode works with NO connection at all.
// It NEVER caches hub calls, chat, settings, or the token — those are live
// and private and always go to the hub (or stay in localStorage on the phone).
const CACHE = "meechie-jarvis-v1";
const SHELL = [
  "./",
  "./index.html",
  "./jarvis.css",
  "./jarvis.js",
  "./catalog.json",
  "./manifest.json",
  "./img/icon-192.png",
  "./img/icon-512.png",
  "./img/meechie-base.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Hub calls are live + authenticated + private: never cache, never serve stale.
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/jarvis/")) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || caches.match("./index.html"));
      return hit || net;
    })
  );
});
