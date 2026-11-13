// Minimal service worker. Its only job is to satisfy PWA installability and
// give the build's content-hashed JS/CSS (/assets/*) a cache-first path, so
// a repeat visit or a flaky connection doesn't need to refetch them.
//
// Everything else — index.html, /api/*, the /ws WebSocket — is left to the
// browser's normal network handling. This app is live data; an offline
// shell serving yesterday's readings would be actively misleading, so there
// is deliberately no app-shell/offline caching beyond the static bundle.
const CACHE = "ohm-sweet-ohm-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isHashedAsset =
    event.request.method === "GET" && url.origin === self.location.origin && url.pathname.startsWith("/assets/");

  if (!isHashedAsset) return; // everything else: normal network handling

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })
  );
});

// Usage alerts (see server/src/alerts.js). Payload is JSON: {title, body, url}.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // ignore malformed payloads
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Ohm Sweet Ohm", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
