/* Vivo Rewards — minimal, safe service worker.
   It caches ONLY the app shell (for offline navigation) and never caches
   hashed JS/CSS assets — so it can never serve a stale chunk that 404s and
   freezes the app on the splash screen. Assets always come from the network
   (they're content-hashed + immutable, so that's both fresh and cacheable by
   the browser). Bumping VERSION purges any older, cache-heavy SW.
*/
const VERSION = "vivo-v5";
const SHELL = "/loyalty-app/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.add(SHELL).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Navigations: fresh from network, cached shell only as an offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(SHELL)));
    return;
  }
  // Everything else (assets, API): do NOT intercept — go straight to network.
});
