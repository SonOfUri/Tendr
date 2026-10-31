/* Tendr service worker — caches static shell only.
 * Never cache checkout responses, auth, wallet data, API secrets, or private merchant info.
 */
const SHELL_CACHE = 'tendr-shell-v1';
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/checkout/')) return;
  // The checkout page itself is never touched (`/ses_…` is its form on the pay host).
  if (url.pathname.startsWith('/pay/')) return;
  if (url.pathname.startsWith('/ses_')) return;
  if (url.pathname.includes('session')) return;

  // Only top-level pages. A framed navigation (the checkout modal or widget on a store) re-fetched
  // from here loses `Sec-Fetch-Dest: iframe`, so its CSP would only let tendr itself frame it.
  if (request.mode === 'navigate' && request.destination === 'document') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html')),
    );
    return;
  }

  if (SHELL_ASSETS.includes(url.pathname) || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
  }
});
