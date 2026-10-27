/* Offline support: files are fetched fresh when online and served from cache when offline. */
const CACHE = 'travel-podcasts-v4';
const AUDIO_CACHE = 'tp-audio-v1'; // filled by the page ("Save for offline"); never deleted here
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'library.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'fonts/young-serif-latin-400-normal.woff2', 'fonts/young-serif-latin-ext-400-normal.woff2',
  'fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2', 'fonts/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== AUDIO_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Saved audio is served from its cache, with Range support so seeking works offline.
async function audioResponse(req) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(req.url);
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  if (!range) return hit;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const buf = await hit.arrayBuffer();
  const size = buf.byteLength;
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  end = Math.min(end, size - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const path = new URL(req.url).pathname;
  if (/\/audio\/[^/]+\/\d+\.(mp3|json)$/.test(path)) { e.respondWith(audioResponse(req)); return; }
  const fresh = true; // network first so updates arrive; cache is the offline fallback
  e.respondWith(
    fresh
      ? fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })
          .catch(() => caches.match(req).then((m) => m || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
      : caches.match(req).then((m) => m || fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }))
  );
});
