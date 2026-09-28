// Service worker: keeps the app itself available offline (e.g. in-store with poor
// reception). Prices come from /api and are cached by the app in IndexedDB.
const VERSION = 'v1';
const CACHE = `grocery-shell-${VERSION}`;
// Not '/index.html': Cloudflare redirects it to '/', and a redirected response can't be
// used to answer a page load.
const SHELL = [
  '/',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/core/units.js',
  '/js/core/query.js',
  '/js/core/match.js',
  '/js/core/basket.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App files: serve from cache straight away, refresh the cache in the background.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = event.request.mode === 'navigate' ? '/' : event.request;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached || Response.error());
      return cached || fresh;
    }),
  );
});
