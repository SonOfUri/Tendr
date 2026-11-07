/* Tendr service worker — static shell and the offline page only.
 * Never cache checkout responses, auth, wallet data, API secrets, or private merchant info.
 * Hashed build files (/_next/static) are public and may be kept for a flaky connection.
 */
const SHELL_CACHE = 'tendr-shell-v6';
const RUNTIME_CACHE = 'tendr-static-v1';
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/offline.html',
  '/tendr-logo.png',
  '/favicon.png',
  '/apple-icon.png',
  '/onboarding-bg-image.png',
  '/logo-with-watermark-white.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];
/** Optional — skipped if missing so install still succeeds. */
const SHELL_OPTIONAL = ['/fonts/rethink-sans.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await cache.addAll(SHELL_ASSETS);
      await Promise.all(
        SHELL_OPTIONAL.map((url) => cache.add(url).catch(() => undefined)),
      );
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

function isPrivatePath(pathname) {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/checkout/') ||
    pathname.startsWith('/pay/') ||
    pathname.startsWith('/ses_') ||
    pathname.includes('session')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivatePath(url.pathname)) return;

  // Only top-level pages. A framed navigation (the checkout modal or widget on a store) re-fetched
  // from here loses `Sec-Fetch-Dest: iframe`, so its CSP would only let tendr itself frame it.
  // The HTML is never stored: a signed-in dashboard page is private.
  if (request.mode === 'navigate' && request.destination === 'document') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }

  if (
    SHELL_ASSETS.includes(url.pathname) ||
    SHELL_OPTIONAL.includes(url.pathname) ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/fonts/')
  ) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
    return;
  }

  // Public hashed assets. Network first, so a dev server still gets fresh chunks.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
  }
});
