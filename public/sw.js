/**
 * Samatat Sanskriti — service worker.
 * Cache-first for same-origin static assets. Network-only for dynamic,
 * user-specific routes (auth, cart, booking, tickets, admin, API). Offline
 * navigations fall back to a small inline HTML page.
 */

const CACHE_NAME = 'samatat-natyomela-v2';

const STATIC_ASSET_PATTERN = /\.(?:css|js|mjs|png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf)$/i;

const NETWORK_ONLY_PREFIXES = ['/api/', '/book', '/cart', '/admin', '/tickets', '/login'];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Offline · Samatat Sanskriti</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #241b17; color: #f7f2ea; font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 2rem; }
  .card { max-width: 32ch; }
  h1 { font-family: Georgia, 'Times New Roman', serif; color: #e7b86a; margin: 0 0 .5rem; font-size: 1.6rem; }
  p { color: #d8c9bd; line-height: 1.5; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>You're offline</h1>
    <p>Samatat Sanskriti needs a connection to load this page. Please reconnect and try again.</p>
  </div>
</body>
</html>`;

const OFFLINE_RESPONSE = () => new Response(OFFLINE_HTML, {
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(['/manifest.webmanifest']))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

function isNetworkOnlyPath(pathname) {
  return NETWORK_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function isStaticAsset(pathname) {
  return pathname === '/manifest.webmanifest' || STATIC_ASSET_PATTERN.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-only: authenticated / dynamic areas must never be served from cache.
  if (isNetworkOnlyPath(url.pathname)) {
    event.respondWith(
      fetch(request).catch(() => (request.mode === 'navigate' ? OFFLINE_RESPONSE() : Response.error()))
    );
    return;
  }

  // Cache-first: static, same-origin assets (css/js/icons/manifest).
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Everything else (marketing pages, programme listing): network-first,
  // with an offline fallback for full-page navigations.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request)) || OFFLINE_RESPONSE())
    );
  }
});
