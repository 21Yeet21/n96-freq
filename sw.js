/* N96_freq — Service Worker v89
   v89: Fixed drag-and-drop to collections (button→div). */

const CACHE_NAME = 'n96-v89';
const ASSETS = [
  '/',
  '/index.html',
  '/assets/css/style.css',
  '/assets/js/app.js',
  '/manifest.json'
];

/* Install — cache core assets */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* Activate — clean old caches */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* Fetch — network-first with cache fallback for static assets ONLY.
   Audio streams, range requests, and non-GET requests are passed through
   to the network without interception. */
self.addEventListener('fetch', event => {
  /* Skip non-GET requests */
  if (event.request.method !== 'GET') return;

  /* Skip API calls */
  if (event.request.url.includes('/api/')) return;

  /* v79: CRITICAL — Skip /audio/ requests entirely.
     The audio element needs unintercepted streaming for reliable playback.
     The SW was previously cloning audio responses (to cache them), which:
     1. Buffers the entire file into memory instead of streaming
     2. Breaks range requests (used for seeking and continued buffering)
     3. Causes tracks to cut off after the initial buffer is consumed
     This is the fix for "local music cuts off after 1-2 minutes". */
  if (event.request.url.includes('/audio/')) return;

  /* Skip range requests (used for seeking in audio/video) */
  if (event.request.headers.get('range')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        /* Cache successful responses for static assets only */
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
