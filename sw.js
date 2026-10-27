/* Offline support: app shell is cached; library.json is fetched fresh when online. */
const CACHE = 'travel-podcasts-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'library.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fresh = /library\.json$|\.html$|\/$/.test(new URL(req.url).pathname);
  e.respondWith(
    fresh
      ? fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })
          .catch(() => caches.match(req).then((m) => m || caches.match('index.html')))
      : caches.match(req).then((m) => m || fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }))
  );
});
