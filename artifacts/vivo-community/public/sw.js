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
const VERSION = "johari-community-v2";
const APP_BASE = new URL(self.registration.scope).pathname;
const SHELL = APP_BASE;
const appUrl = (path = "") => new URL(path, self.registration.scope).pathname;

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

// ── Web push ──────────────────────────────────────────────────────────────
// A member should learn what they earned while they are still in the shop.
// The payload is written by the loyalty backend (lib/push.ts) — the same
// sender that notifies the loyalty app, because a subscription belongs to the
// account rather than to one face of it.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A malformed payload must still show something rather than nothing.
    data = { title: "Vivo Johari", body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Vivo Johari", {
      body: data.body || "",
      icon: appUrl("icons/icon-192.png"),
      badge: appUrl("icons/icon-192.png"),
      // Same tag replaces an earlier notification instead of stacking three
      // "you earned points" alerts from one shopping trip.
      tag: data.tag || "vivo",
      data: { url: data.url || APP_BASE },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The same backend notifies the loyalty app, and its URLs (/dashboard,
  // /messages) mean nothing here — this app lives entirely at "/" with a ?tab=
  // query. Anything else opens home rather than a path the router cannot show
  // and the member cannot get out of.
  const raw = (event.notification.data && event.notification.data.url) || APP_BASE;
  const url =
    raw === "/" || raw === APP_BASE
      ? APP_BASE
      : raw.startsWith("/?")
        ? appUrl(raw.slice(1))
        : raw.startsWith(APP_BASE + "?")
          ? raw
          : APP_BASE;

  event.waitUntil(
    // Focus an open tab rather than opening a second copy of the app.
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
