// Minimal service worker so the site can be installed as an app. It does not cache anything,
// so people always get the newest version.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
