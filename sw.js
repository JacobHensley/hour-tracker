const CACHE = 'hour-tracker-v11';
const ASSETS = [
  './',
  './index.html',
  './backup.html',
  './styles.css',
  './app.js',
  './backup.js',
  './billing.js',
  './state.js',
  './render.js',
  './firebase.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GET requests for our static shell.
  // Firebase auth/Firestore/SDK traffic passes through untouched —
  // Firestore's own persistent cache handles offline data.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first: the shell is small, and serving it from cache first meant
  // an edited file kept being served stale until CACHE was bumped by hand.
  // The cache is refreshed on every success and is what answers when offline.
  //
  // `cache: 'reload'` skips the browser's own HTTP cache. Without it, a file
  // the browser cached heuristically (a plain static host sends no
  // Cache-Control) comes back stale and gets stored here as if it were fresh.
  e.respondWith(
    fetch(e.request, { cache: 'reload' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
