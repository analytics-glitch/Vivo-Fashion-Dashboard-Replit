/* Vivo Johari (community) — minimal service worker.
 *
 * IT CACHES THE SHELL AND NOTHING ELSE.
 *
 * Hashed JS and CSS are never cached here, deliberately. A service worker that
 * holds onto them will one day serve an index.html that asks for a chunk it no
 * longer has, and the app freezes on a blank screen with a 404 in the console —
 * a failure this estate has already had once. Those files are content-hashed
 * and served `immutable`, so the browser's own HTTP cache handles them
 * correctly without any help from here.
 *
 * API calls are never intercepted either. Stale community data is worse than
 * absent community data: a cached feed or points balance that disagrees with
 * the server is a support ticket nobody can reproduce.
 *
 * Bump VERSION to purge whatever an older worker was holding.
 */
const VERSION = "johari-community-v1";
const SHELL = "/";

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
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Navigations come from the network; the cached shell is only an offline
  // fallback, so a deploy is picked up on the next load rather than the load
  // after that.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(SHELL)));
    return;
  }

  // Everything else — assets, images, /api/community/* — goes straight to the
  // network. Not intercepting is the point.
});
