const CACHE_NAME = `rac-app-shell-${__RAC_CACHE_VERSION__}`;
const CACHE_PREFIX = "rac-app-shell-";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/fieldwork.svg",
  "/icons/fieldwork-192.png",
  "/icons/fieldwork-512.png",
  ...__RAC_BUILD_ASSETS__,
];
const PRECACHE_PATHS = new Set(PRECACHE_URLS);
const DEV_ASSET_PATHS = ["/src/", "/node_modules/.vite/", "/@vite/", "/@react-refresh"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_PATHS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isDevelopmentAsset(pathname) {
  return (
    (self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1") &&
    DEV_ASSET_PATHS.some((prefix) => pathname.startsWith(prefix))
  );
}

function isCacheableAsset(pathname) {
  return PRECACHE_PATHS.has(pathname) || isDevelopmentAsset(pathname);
}

function isStaticResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  return /^(text\/javascript|application\/javascript|text\/css|image\/|font\/)/i.test(contentType);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    if (url.pathname !== "/") {
      event.respondWith(
        fetch(request).catch(() => caches.match(new URL("/", self.location.origin).href)),
      );
      return;
    }
    event.respondWith(
      fetch(request).catch(() => caches.match(new URL("/", self.location.origin).href)),
    );
    return;
  }

  if (!isCacheableAsset(url.pathname)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached && !isDevelopmentAsset(url.pathname)) return cached;

      try {
        const response = await fetch(request);
        if (response.ok && isStaticResponse(response)) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    }),
  );
});
