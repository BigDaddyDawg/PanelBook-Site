const CACHE_NAME = "panelbook-static-v1";
const CORE_ASSETS = [
  "./",
  "index.html",
  "scan.html",
  "buy.html",
  "theme.css",
  "atmosphere.js",
  "pwa.js",
  "scan.js",
  "config.js",
  "collection.json",
  "missing.json",
  "manifest.webmanifest",
  "icon.svg",
];

/** Network-first with offline fallback — keeps HTML/JS fresh after publishes. */
function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    })
    .catch(() =>
      caches.match(request).then((cached) =>
        cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined)
      )
    );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: "PANELBOOK_SW_UPDATED", cache: CACHE_NAME });
        }
      })
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return;

  const path = url.pathname;
  const isHtmlNav =
    event.request.mode === "navigate" ||
    path.endsWith("/") ||
    path.endsWith("/index.html") ||
    path.endsWith("/scan.html") ||
    path.endsWith("/buy.html");

  if (isHtmlNav) {
    event.respondWith(networkFirst(event.request, "index.html"));
    return;
  }

  event.respondWith(networkFirst(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
