// TheyGrow Service Worker
// Pattern from TheyGrow MVP Blueprint

// --- Delivery knob (front-side) ---------------------------------------------
// changed_in: PWA-DL-001 — single source of truth for the cache
// generation. Bump CACHE_VERSION to ship a fresh app shell to existing installed
// users: a changed sw.js is re-fetched (nginx serves /sw.js no-cache), the new
// worker activates, and activate() purges every non-current cache (one-time
// migration off theygrow-v1). Typed-config home (api parameters.py) is in /api,
// not touched this milestone, so a typed knob is justifiably deferred.
const CACHE_VERSION = 'v9';
const CACHE_NAME = 'theygrow-' + CACHE_VERSION;

const OFFLINE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/kb-v1.json',
  // Versioned module mount (A1-DL-004): the shell references these by URL, so
  // they are precached by name. Content changes ship as a NEW mount version
  // (/m/v2/...), never as new bytes at these URLs — inside the 30-day immutable
  // window addAll would otherwise refill the new cache from the stale HTTP copy.
  '/m/v1/app.css',
  '/m/v1/sw-register.js',
  // A1-P4/A1-P5: the app entry and the whole graph it imports — core/ (shared
  // state, I/O and pure helpers) and surfaces/ (one module per UI surface). The
  // shell EXECUTES only the entry; since A1-P6 it also NAMES every other module
  // in a <link rel=modulepreload> delivery hint, which fetches and compiles but
  // never evaluates. Everything past the entry is reachable solely through
  // `import` statements, so the ship-list guard walks the import graph to keep
  // this list and the graph in agreement (A1-P4-INV-001), and asserts the hint
  // set equals that graph in both directions (A1-P6-INV-001). cache.addAll is
  // atomic: a path that is wrong here fails SW install outright.
  '/m/v1/app.js',
  '/m/v1/core/kb-boot.js',
  '/m/v1/core/state.js',
  '/m/v1/core/storage.js',
  '/m/v1/core/dom-utils.js',
  '/m/v1/core/format.js',
  '/m/v1/core/zpd.js',
  '/m/v1/core/urgency.js',
  '/m/v1/surfaces/table.js',
  '/m/v1/surfaces/skill-completion.js',
  '/m/v1/surfaces/zpd-filter.js',
  '/m/v1/surfaces/skill-modal.js',
  '/m/v1/surfaces/profile.js',
  '/m/v1/surfaces/activities.js',
  '/m/v1/surfaces/onboarding.js',
  '/m/v1/surfaces/accordion.js',
  '/icons/icon-logo-192-v2.png',
  '/icons/icon-logo-512-v2.png',
  '/icons/maskable-192-v2.png',
  '/icons/maskable-512-v2.png',
  '/icons/apple-touch-icon-v2.png',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png'
];

// Install: precache offline essentials.
// NOTE: no skipWaiting() here — the new worker parks in `waiting` until driven
// by a SKIP_WAITING message (see below). This keeps the SW neutral to the P2
// update-UX decision (auto-apply vs prompt); no reload/skip policy lives here.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(OFFLINE_URLS))
  );
});

// Activate: delete every cache that isn't the current generation, then claim.
// clients.claim() only takes control once this worker has activated — it does
// not force activation, so it stays neutral to P2.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

// Message: the only path to skipWaiting. P2 (auto-apply or prompt) posts
// { type: 'SKIP_WAITING' } to drive activation of a waiting worker.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch: Network-First for /api/ and for navigation (app shell); Cache-First
// for genuinely static assets.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Strategy: Network-First for API calls.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Strategy: Network-First for navigation / app shell — existing users get the
  // freshly deployed index.html on the next navigation, no hard-refresh needed.
  // The successful response is mirrored into the cache keyed to '/' so the
  // offline fallback copy stays current.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() =>
          caches.match(request)
            .then((cached) => cached || caches.match('/') || caches.match('/offline.html'))
        )
    );
    return;
  }

  // Strategy: Cache-First for all other (static) requests.
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => {
            // For navigation requests, return offline page.
            if (request.mode === 'navigate') {
              return caches.match('/offline.html');
            }
            // For other requests, just fail.
            return Promise.reject('no-match');
          });
      })
  );
});
