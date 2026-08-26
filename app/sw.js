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
//
// changed_in: DIA-DL-004 — v14 -> v15 with the /m/v5/ mount bump, which carries
// the web channel composition and the export confirmation. Both are bytes the
// WEB channel executes — the stylesheet, the export surface and two new modules
// — so this bump is the delivery mechanism rather than a formality: the archive
// control stops being offered where no archive can be produced, and the parent
// who is already on a previous generation gets that through the network-first
// shell plus a mount URL their immutable window cannot answer with a stale copy.
//
// changed_in: DIA-DL-005 — v15 -> v16 with the /m/v6/ mount bump, which carries
// the diary write path. FORCED, not chosen: this packet changes app.js, app.css,
// three surfaces and four store modules, and bytes at a published mount URL are
// never rewritten. The cost is a SIXTH generation shipped and served immutable,
// stated here rather than absorbed — see DIA-DL-005 for what retiring the early
// generations would take, which is still deferred.
//
// changed_in: FIU-DL-001 — v16 -> v17 with the /m/v7/ mount bump, the first of
// L3, which carries the store's close-on-background lifecycle and the resume
// defect that put a parent back on the first-install screen every time they
// unlocked their phone. FORCED for the same reason the last one was: bytes at a
// published mount URL are never rewritten, and /m/v6/ has been published since
// the L2 merge. Both changes are bytes the WEB channel loads, so the bump is
// the delivery mechanism and not a formality — though only the native channel
// has a store to close. The cost is a SEVENTH generation shipped and served
// immutable; retiring the early ones stays an owner cleanup (DIA-DL-008 debt 7).
//
// changed_in: PPR-DL-002 — v17 -> v18 with the /m/v8/ mount bump, which carries
// three changes at once and exists BECAUSE it carries three: the web channel's
// analytics-consent gate, the retirement of the browser-to-native transfer, and
// the platform-aware download offer. Each of them changes bytes under the mount
// and each would otherwise have cost a generation of its own — bytes at a
// published mount URL are never rewritten (A1-DL-004), so the only question a
// mount change ever asks is how many changes ride one bump. The cost is an
// EIGHTH generation shipped and served immutable; retiring the early ones stays
// an owner cleanup (DIA-DL-008 debt 7). /m/v8/ is also the first generation that
// is SMALLER than the one before it: it ships no transfer/ directory and no
// store/transfer.js, because a copy-forward that omits a file deletes it without
// touching a frozen byte.
//
// changed_in: UIP-DL-001 — v18 -> v19 with the /m/v9/ mount bump, which carries
// one change: analytics leaves the web showcase entirely (vault ADR-043
// annotation 2026-08-25, class: reversal), and the consent surface PPR-P2 built
// to gate it retires with its object rather than staying switched off. Under the
// mount that is consent/config.js and surfaces/consent.js deleted, the stored
// answer and its two accessors gone from core/storage.js, thirteen trackEvent()
// call sites gone from seven surfaces, and the banner and footer-control rules
// gone from app.css. FORCED for the standing reason: bytes at a published mount
// URL are never rewritten (A1-DL-004), and /m/v8/ has been published since the
// PPR merge. The cost is a NINTH generation shipped and served immutable;
// retiring the early ones stays an owner cleanup (DIA-DL-008 debt 7). /m/v9/ is
// the second generation SMALLER than the one before it, and for the same reason
// /m/v8/ was: a copy-forward that omits a file deletes it without touching a
// frozen byte.
const CACHE_VERSION = 'v19';
const CACHE_NAME = 'theygrow-' + CACHE_VERSION;

const OFFLINE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/kb-v1.json',
  // PPR-P2 — /transfer.html and its four modules are GONE from this list,
  // because they are gone from the image. cache.addAll is atomic, so a stale
  // entry here does not degrade quietly: it fails the install outright and the
  // client keeps the previous worker. That is the reason the deletion has to be
  // done in both directions in one packet rather than swept up later.
  // Versioned module mount (A1-DL-004): the shell references these by URL, so
  // they are precached by name. Content changes ship as a NEW mount version
  // (/m/v9/...), never as new bytes at these URLs — inside the 30-day immutable
  // window addAll would otherwise refill the new cache from the stale HTTP copy.
  '/m/v9/app.css',
  '/m/v9/sw-register.js',
  // A1-P4/A1-P5: the app entry and the whole graph it imports — core/ (shared
  // state, I/O and pure helpers) and surfaces/ (one module per UI surface). The
  // shell EXECUTES only the entry; since A1-P6 it also NAMES every other module
  // in a <link rel=modulepreload> delivery hint, which fetches and compiles but
  // never evaluates. Everything past the entry is reachable solely through
  // `import` statements, so the ship-list guard walks the import graph to keep
  // this list and the graph in agreement (A1-P4-INV-001), and asserts the hint
  // set equals that graph in both directions (A1-P6-INV-001). cache.addAll is
  // atomic: a path that is wrong here fails SW install outright.
  '/m/v9/app.js',
  '/m/v9/core/kb-boot.js',
  '/m/v9/core/state.js',
  '/m/v9/core/storage.js',
  '/m/v9/core/repo-local.js',
  '/m/v9/core/signals.js',
  '/m/v9/core/dom-utils.js',
  '/m/v9/core/format.js',
  '/m/v9/core/zpd.js',
  '/m/v9/core/urgency.js',
  '/m/v9/surfaces/table.js',
  '/m/v9/surfaces/skill-completion.js',
  '/m/v9/surfaces/zpd-filter.js',
  '/m/v9/surfaces/skill-modal.js',
  '/m/v9/surfaces/profile.js',
  '/m/v9/surfaces/activities.js',
  '/m/v9/surfaces/onboarding.js',
  '/m/v9/surfaces/accordion.js',
  // L1-P2: the native store. These ship to BOTH channels byte-identically
  // (LSC-P1-INV-002) and are inert on the web — boot.js returns before touching
  // anything when there is no Capacitor bridge. They are precached because the
  // import graph reaches them, and an installed client must not boot offline
  // with a broken graph. The DDL artifact they read
  // (/m/v9/store/schema/001-core.sql) is deliberately NOT here: only the native
  // channel ever fetches it, and that channel does not use this worker.
  //
  // NOTE, and it is a real trap: no apostrophe may appear in a comment inside
  // this array. The ship-list guard reads OFFLINE_URLS TEXTUALLY, pairing single
  // quotes — an apostrophe swallows every entry after it and the guard then
  // reports the icons as unprecached.
  '/m/v9/store/boot.js',
  '/m/v9/store/store.js',
  '/m/v9/store/journal.js',
  '/m/v9/store/repo-journal.js',
  '/m/v9/store/import-legacy.js',
  // DIA-P3 — the diary record path. Precached with the rest of the store
  // because the diary is the app shell now, not an extra: a parent who opens
  // the app offline must still be able to write down what happened today.
  '/m/v9/store/records.js',
  '/m/v9/store/bridge.js',
  '/m/v9/store/config.js',
  '/m/v9/store/errors.js',
  // DIA-P2 — the channel composition: which of the two header actions this
  // channel offers, and the knobs that decide it.
  '/m/v9/surfaces/channel.js',
  '/m/v9/channel/config.js',
  // L1-P3: the export contour. Precached for the same reason the store modules
  // are — the import graph reaches them, and an installed client must not boot
  // offline with a broken graph. Like the DDL above, the artifacts these modules
  // FETCH at runtime are deliberately NOT here: the declaration
  // (/m/v9/export/declaration.json) plus the two print-layer binaries, the
  // embedded font and the ICC profile under /m/v9/export/assets/. Only the
  // native channel ever reads them, that channel does not use this worker, and
  // the web channel cannot export at all — so precaching them would spend
  // roughly 443 KB of an installed web client cache budget on bytes it can
  // never use. See LSC-DL-003.
  //
  // (Note the wording above avoids an apostrophe on purpose — see the trap
  // named further down this comment block.)
  '/m/v9/surfaces/diary.js',
  '/m/v9/surfaces/export.js',
  '/m/v9/export/run.js',
  '/m/v9/export/build.js',
  '/m/v9/export/readout.js',
  '/m/v9/export/sink.js',
  '/m/v9/export/text.js',
  '/m/v9/export/readme.js',
  '/m/v9/export/zip.js',
  '/m/v9/export/pdf.js',
  '/m/v9/export/ttf.js',
  '/m/v9/export/config.js',
  '/m/v9/export/errors.js',
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
// closed and small: it is the navigable pages app/Dockerfile ships, other than
// index.html.
//
// PPR-P1 ADDS THE POLICY DOCUMENT, AND CORRECTS WHAT THIS COMMENT CLAIMED. It
// used to say app/tests/delivery-contract.spec.js asserted the correspondence
// with the COPY list. No such assertion existed — and the omission it was meant
// to catch is precisely the one this packet found by hand: /privacy is a second
// real page, so without an entry here one visit would replace the app shell's
// offline copy with the policy document, permanently, for every client that
// ever opened the link. The guard now exists ("NON_SHELL_PAGES covers every
// navigable page this image ships", delivery-contract.spec.js), and it
// understands both kinds of entry: a shipped .html, and an extension-less route
// that an exact-match location in app/nginx.conf resolves to one with try_files.
//
// BOTH SPELLINGS ARE NAMED on purpose. The fetch handler compares url.pathname,
// the canonical address is /privacy, and /privacy.html is the same bytes served
// under the name the file has in the image — a visitor who reaches either one
// must not poison the shell.
//
// PPR-P2 DROPS /transfer.html, which was the entry this list was created for.
// The page is retired with the mechanism behind it, and the guard above catches
// the other half of that drift by name: an entry naming a page the image no
// longer serves protects nothing and reads as protection.
const NON_SHELL_PAGES = ['/offline.html', '/privacy', '/privacy.html'];

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
  // THE MIRROR IS CONDITIONAL, AND THE CONDITION IS LOAD-BEARING (DIA-P1).
  // Before that packet every navigation was mirrored to '/', on the premise that
  // every navigable path IS the app shell: nginx's `try_files $uri $uri/
  // /index.html` makes any unknown path serve index.html, and /offline.html was
  // reached from the cache rather than navigated to. /transfer.html broke that
  // premise first and /privacy — a real, separately-shipped page a parent
  // navigates to on purpose — carries it now: mirroring one would overwrite the
  // app shell's offline copy with the policy document, and the next offline boot
  // of '/' would show that document instead of the app, permanently, for every
  // client that had ever opened the link. (/transfer.html is retired at PPR-P2;
  // the defect it introduced is not, which is why this branch stays.) Named
  // rather than pattern-matched: the set of HTML pages this image ships is
  // small, closed, and asserted against app/Dockerfile's COPY list in both
  // directions by app/tests/delivery-contract.spec.js.
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
