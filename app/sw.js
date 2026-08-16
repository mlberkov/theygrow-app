// TheyGrow Service Worker
// Pattern from TheyGrow MVP Blueprint

// --- Delivery knob (front-side) ---------------------------------------------
// changed_in: PWA-DL-001 — single source of truth for the cache
// generation. Bump CACHE_VERSION to ship a fresh app shell to existing installed
// users: a changed sw.js is re-fetched (nginx serves /sw.js no-cache), the new
// worker activates, and activate() purges every non-current cache (one-time
// migration off theygrow-v1). Typed-config home (api parameters.py) is in /api,
// not touched this milestone, so a typed knob is justifiably deferred.
//
// changed_in: EMV-DL-001 — v11 -> v12 with the /m/v2/ mount bump. The bump is
// what refills the precache from the NEW mount URLs; on its own it would not
// refresh an existing one, which is exactly why the mount moved (A1-DL-004,
// docs/RUNBOOK.md "Module mount").
//
// changed_in: XPT-DL-001 — v12 -> v13 with the /m/v3/ mount bump, which carries
// the export transfer repair. The repair itself only runs on the native
// channel, where the mount is read out of the APK rather than fetched over
// HTTP; the bump is here because bytes at a published mount URL are never
// rewritten, whichever channel happens to execute them.
//
// changed_in: DIA-DL-001 — v13 -> v14 with the /m/v4/ mount bump, which carries
// the browser-to-native history transfer. Two of the new generation's files
// differ from the frozen one in bytes the web channel DOES execute — the mount
// now derives its own asset URLs instead of carrying them as literals — so
// unlike the previous bump this one is functional on both channels, not only
// on the one the rule protects.
const CACHE_VERSION = 'v14';
const CACHE_NAME = 'theygrow-' + CACHE_VERSION;

const OFFLINE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/kb-v1.json',
  // DIA-P1 — the browser-to-native handoff page and its module graph. It is
  // precached because the handoff needs no network at all: it reads the
  // localStorage of this same origin and hands the result to the app on the
  // same device, so a parent on a bad connection can still move their history.
  // Its entry is named here because the shell references it; the three modules
  // it imports are named for the same reason index.html names its graph.
  //
  // (No apostrophe in this block, deliberately — see the trap named below.)
  '/transfer.html',
  '/m/v4/transfer/handoff-page.js',
  '/m/v4/transfer/config.js',
  '/m/v4/transfer/errors.js',
  '/m/v4/transfer/format.js',
  // Versioned module mount (A1-DL-004): the shell references these by URL, so
  // they are precached by name. Content changes ship as a NEW mount version
  // (/m/v4/...), never as new bytes at these URLs — inside the 30-day immutable
  // window addAll would otherwise refill the new cache from the stale HTTP copy.
  '/m/v4/app.css',
  '/m/v4/sw-register.js',
  // A1-P4/A1-P5: the app entry and the whole graph it imports — core/ (shared
  // state, I/O and pure helpers) and surfaces/ (one module per UI surface). The
  // shell EXECUTES only the entry; since A1-P6 it also NAMES every other module
  // in a <link rel=modulepreload> delivery hint, which fetches and compiles but
  // never evaluates. Everything past the entry is reachable solely through
  // `import` statements, so the ship-list guard walks the import graph to keep
  // this list and the graph in agreement (A1-P4-INV-001), and asserts the hint
  // set equals that graph in both directions (A1-P6-INV-001). cache.addAll is
  // atomic: a path that is wrong here fails SW install outright.
  '/m/v4/app.js',
  '/m/v4/core/kb-boot.js',
  '/m/v4/core/state.js',
  '/m/v4/core/storage.js',
  '/m/v4/core/repo-local.js',
  '/m/v4/core/signals.js',
  '/m/v4/core/dom-utils.js',
  '/m/v4/core/format.js',
  '/m/v4/core/zpd.js',
  '/m/v4/core/urgency.js',
  '/m/v4/surfaces/table.js',
  '/m/v4/surfaces/skill-completion.js',
  '/m/v4/surfaces/zpd-filter.js',
  '/m/v4/surfaces/skill-modal.js',
  '/m/v4/surfaces/profile.js',
  '/m/v4/surfaces/activities.js',
  '/m/v4/surfaces/onboarding.js',
  '/m/v4/surfaces/accordion.js',
  // L1-P2: the native store. These ship to BOTH channels byte-identically
  // (LSC-P1-INV-002) and are inert on the web — boot.js returns before touching
  // anything when there is no Capacitor bridge. They are precached because the
  // import graph reaches them, and an installed client must not boot offline
  // with a broken graph. The DDL artifact they read
  // (/m/v4/store/schema/001-core.sql) is deliberately NOT here: only the native
  // channel ever fetches it, and that channel does not use this worker.
  //
  // NOTE, and it is a real trap: no apostrophe may appear in a comment inside
  // this array. The ship-list guard reads OFFLINE_URLS TEXTUALLY, pairing single
  // quotes — an apostrophe swallows every entry after it and the guard then
  // reports the icons as unprecached.
  '/m/v4/store/boot.js',
  '/m/v4/store/store.js',
  '/m/v4/store/journal.js',
  '/m/v4/store/repo-journal.js',
  '/m/v4/store/import-legacy.js',
  '/m/v4/store/bridge.js',
  '/m/v4/store/config.js',
  '/m/v4/store/errors.js',
  // L1-P3: the export contour. Precached for the same reason the store modules
  // are — the import graph reaches them, and an installed client must not boot
  // offline with a broken graph. Like the DDL above, the artifacts these modules
  // FETCH at runtime are deliberately NOT here: the declaration
  // (/m/v4/export/declaration.json) plus the two print-layer binaries, the
  // embedded font and the ICC profile under /m/v4/export/assets/. Only the
  // native channel ever reads them, that channel does not use this worker, and
  // the web channel cannot export at all — so precaching them would spend
  // roughly 443 KB of an installed web client cache budget on bytes it can
  // never use. See LSC-DL-003.
  //
  // (Note the wording above avoids an apostrophe on purpose — see the trap
  // named further down this comment block.)
  '/m/v4/surfaces/export.js',
  '/m/v4/surfaces/import.js',
  '/m/v4/export/run.js',
  '/m/v4/export/build.js',
  '/m/v4/export/readout.js',
  '/m/v4/export/sink.js',
  '/m/v4/export/text.js',
  '/m/v4/export/readme.js',
  '/m/v4/export/zip.js',
  '/m/v4/export/pdf.js',
  '/m/v4/export/ttf.js',
  '/m/v4/export/config.js',
  '/m/v4/export/errors.js',
  '/icons/icon-logo-192-v2.png',
  '/icons/icon-logo-512-v2.png',
  '/icons/maskable-192-v2.png',
  '/icons/maskable-512-v2.png',
  '/icons/apple-touch-icon-v2.png',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png'
];

// Navigable pages this image ships that are NOT the app shell (DIA-P1).
//
// A navigation to one of these must not be mirrored into the cache entry keyed
// '/', which is the app shell's offline copy — see the fetch handler for what
// that costs. Kept as an explicit list rather than a pattern because the set is
// closed and small: it is exactly the HTML files in app/Dockerfile's COPY list
// other than index.html, and app/tests/delivery-contract.spec.js asserts that
// correspondence rather than leaving the two to drift.
const NON_SHELL_PAGES = ['/offline.html', '/transfer.html'];

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
  //
  // DIA-P1 — THE MIRROR IS NOW CONDITIONAL, AND THE CONDITION IS LOAD-BEARING.
  // Until this packet every navigation was mirrored to '/', on the premise that
  // every navigable path IS the app shell: nginx's `try_files $uri $uri/
  // /index.html` makes any unknown path serve index.html, and /offline.html was
  // reached from the cache rather than navigated to. /transfer.html breaks that
  // premise — it is a real, separately-shipped page a parent navigates to on
  // purpose — and mirroring it would overwrite the app shell's offline copy
  // with the handoff page. The next offline boot of '/' would then show the
  // handoff page instead of the app, permanently, for every client that had
  // ever opened the transfer link. Named rather than pattern-matched: the set of
  // HTML pages this image ships is small, closed, and asserted against
  // app/Dockerfile's COPY list by app/tests/delivery-contract.spec.js.
  if (request.mode === 'navigate') {
    const mirrorsTheShell = !NON_SHELL_PAGES.includes(url.pathname);
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (mirrorsTheShell) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
          }
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
