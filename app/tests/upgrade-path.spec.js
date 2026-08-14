'use strict';

// The installed-client upgrade path (EMV-P3, EMV-DL-003).
//
// WHY THIS SPEC EXISTS. EMV-P1 made the export contour reachable and delivered
// the fix on a NEW mount, because the bytes of a published immutable mount are
// never rewritten (A1-DL-004). Its own decision entry then recorded the gap it
// could not close: no automated test proved that a client ALREADY INSTALLED on
// the previous generation ends up running the new one. The delivery argument
// rested on the worker's strategies — network-first navigation, CACHE_VERSION
// bump, activate() purging every non-current cache — which is derivation
// standing in for execution, on the branch whose purpose is to end exactly that
// (AGENTS.md §11).
//
// So this spec installs the previous generation in a real browser, lets it
// precache, then takes the fixture away and serves the current build — and
// asserts what the upgraded client actually evaluates and actually sees.
//
// TWO LEGS, AND THE SECOND IS THE MAJORITY CASE.
//   1. The client ACCEPTS the update banner. The waiting worker skips waiting,
//      activate() purges the previous cache generation, the page reloads under
//      the new worker.
//   2. The client NEVER TOUCHES the banner and simply opens the app again. Most
//      installed clients do this, so proving only leg 1 would prove the fix
//      reaches a minority and leave the majority resting on an argument about
//      the old worker's cache-first handler — the same substitution this packet
//      exists to end. Leg 2 asserts the measured outcome, not the hoped one.
//
// WHAT IS STAGED, AND HOW FAITHFUL IT IS. tests/support/prev-generation.js
// derives the previous shell and worker from the bytes on disk; read its header
// for the derivation and its verified byte-identity to the shell published at
// 711b5bc. The mount assets themselves are NOT derived — /m/v1/** on disk IS the
// frozen prior generation, missing the .modal.show rule, which is why the staged
// client reproduces the original defect rather than imitating it.
//
// THE BOUND, STATED WHERE IT CANNOT BE MISSED. This is the generation the repo
// published, not the bytes any PARTICULAR live client holds: a live client holds
// whatever was current when it last updated, and its HTTP-cache state — how much
// of the 30-day immutable window on the previous mount has elapsed — is
// invisible from here. What executes here is the MECHANISM. The only evidence
// about real bytes on a real installed client is the owner step in
// docs/RUNBOOK.md (Promotion + rollback, step 5), and this spec does not make
// that step redundant.
//
// CHANNEL BOUNDARY. Runs in `behavior` (nginx channel) only, never in `native`.
// In the APK the shell is read from local assets, /sw.js is never re-fetched,
// the waiting worker cannot appear and the whole update channel is inert — the
// finding recorded in LSC-DL-001 and in behavior.spec.js's own skip. There is no
// delivery path to prove there; APK replacement is the only one (ADR-043).

const fs = require('fs');
const path = require('path');
const { test, expect, gotoApp, STATES } = require('./support/seed');
const { PREV_GEN_COOKIE } = require('./server');
const { previousGeneration } = require('./support/prev-generation');
const { shippedPaths } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');

// null when the current mount is the only one shipped — the state an owner
// retiring /m/v{N}/ produces. That is a vacuous case rather than a failure (with
// one generation there is nothing to upgrade FROM), so the tests skip with the
// reason printed instead of passing quietly.
const STAGED = previousGeneration(APP_ROOT);

// Read from disk, and used ONLY to select which pre-upgrade assertion applies —
// never as evidence for a runtime claim. Today the previous mount is v1, which
// declares no .modal.show rule, so the staged client reproduces the defect and
// the spec asserts it. After a later bump the previous generation will carry the
// rule, that branch drops out, and the generation-generic pins below still carry
// the anti-vacuity weight. Which branch ran is annotated into the test report,
// because a conditional assertion nobody can see the disposition of is the way
// a guard rots into vacuity.
const PREV_APP_CSS = STAGED
  ? fs.readFileSync(path.join(APP_ROOT, 'm', STAGED.mount.dir, 'app.css'), 'utf8')
  : '';
const PREV_DECLARES_SHOW_RULE = /(^|[\s,};])\.modal\.show\b/.test(PREV_APP_CSS);

const stylesheetHrefs = (page) =>
  page.evaluate(() =>
    Array.from(document.styleSheets)
      .map((sheet) => sheet.href)
      .filter(Boolean)
  );

const cacheKeys = (page) => page.evaluate(() => caches.keys());

// Installs and activates the previously published generation, waits for its
// precache to settle, and pins that it really happened.
//
// THE PINS ARE THE ANTI-VACUITY HALF. Without them this spec would also pass
// with no worker installed at all — it would be asserting that a fresh browser
// loads the current build, which every other spec in this suite already covers
// and which says nothing about an upgrade. Measured, not assumed: running the
// legs below with the fixture switch never set reds here, at the cache pin.
async function installPreviousGeneration(page, context, baseURL) {
  await context.addCookies([{ name: PREV_GEN_COOKIE, value: '1', url: baseURL }]);
  await gotoApp(page, { state: STATES.seeded });
  await page.evaluate(() => navigator.serviceWorker.ready);

  // expect.poll rather than page.waitForFunction, and the difference is not
  // stylistic: waitForFunction given an ASYNC predicate resolves on the first
  // call whatever the predicate computes — measured while writing this spec, by
  // handing it a predicate that sleeps and then returns false, which resolved
  // after one iteration instead of timing out. A wait that does not wait would
  // leave the pins below racing the precache. expect.poll awaits the value it
  // polls, and page.evaluate awaits an async body properly.
  await expect
    .poll(
      () =>
        page.evaluate(
          // Read as the cache's KEY SET rather than through cache.match(), and
          // that is also a measured point rather than a preference: the static
          // rule serves the mount with `Vary: Accept-Encoding`, and a match()
          // built from a bare URL varies from the stored request, so it returns
          // undefined for an entry that is demonstrably there. (The product is
          // unaffected — the fetch handler matches with the real request, which
          // is why the offline boot works.) The key set answers the question this
          // pin actually asks: is the entry in the cache.
          async ({ cacheName, css }) => {
            const keys = await caches.keys();
            if (!keys.includes(cacheName)) return false;
            const cache = await caches.open(cacheName);
            const cached = (await cache.keys()).map((request) => new URL(request.url).pathname);
            return cached.includes(css);
          },
          { cacheName: STAGED.cacheName, css: `${STAGED.mount.prefix}app.css` }
        ),
      {
        message: `the staged generation never precached ${STAGED.mount.prefix}app.css into ${STAGED.cacheName}`,
        timeout: 30_000,
      }
    )
    .toBe(true);

  // A worker is installed AND controlling this page.
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  // The previous generation's cache exists and holds the previous mount.
  expect(await cacheKeys(page)).toContain(STAGED.cacheName);

  // And the document is actually evaluating the previous mount's stylesheet —
  // the staged shell is the old one, not the current one behind a cookie.
  const sheets = await stylesheetHrefs(page);
  expect(sheets.some((href) => href.includes(`${STAGED.mount.prefix}app.css`))).toBe(true);
  expect(sheets.some((href) => href.includes(STAGED.currentMount.prefix))).toBe(false);

  if (!PREV_DECLARES_SHOW_RULE) {
    test.info().annotations.push({
      type: 'staged generation',
      description: `${STAGED.mount.version}/app.css declares no .modal.show rule — the defect EMV-P1 fixed is reproduced by the staged client and asserted here`,
    });
    // The defect, executed rather than described: the handler runs to
    // completion and the parent sees nothing.
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportModal')).toHaveCSS('display', 'none');
  } else {
    test.info().annotations.push({
      type: 'staged generation',
      description: `${STAGED.mount.version}/app.css already declares .modal.show — the defect-reproduction branch does not apply to this generation`,
    });
  }
}

test.describe('an installed client on the previous generation reaches the current mount', () => {
  test.skip(
    STAGED === null,
    'only one mount generation is shipped — there is no previous generation to upgrade from, so the property is vacuous by construction'
  );

  // Two full worker installs, a precache settle and a banner wait each.
  test.slow();

  test('leg 1 — accepting the update banner lands the client on the current mount', async ({
    page,
    context,
    baseURL,
  }) => {
    await installPreviousGeneration(page, context, baseURL);

    // The deployment: this origin now serves the current build to this context.
    await context.clearCookies({ name: PREV_GEN_COOKIE });

    // Everything the DOCUMENT requests from here on. The service worker's own
    // precache fetches are not visible to this listener, so the claim it carries
    // is about what the page resolves — which is the claim that matters, since
    // it is the document's stylesheet that decides what a parent sees.
    const requested = [];
    page.on('request', (request) => requested.push(new URL(request.url()).pathname));

    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });

    // sw.js ships without skipWaiting(), so the new worker parks and the page
    // offers the choice (PWA-DL-001).
    await expect(page.locator('#updateBanner')).toHaveClass(/visible/, { timeout: 30_000 });
    await Promise.all([page.waitForEvent('load'), page.locator('#updateReloadBtn').click()]);
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );

    // activate() ran: the current generation is the cache, and the previous one
    // is gone rather than merely outnumbered.
    const keys = await cacheKeys(page);
    expect(keys).toContain(STAGED.currentCacheName);
    expect(keys).not.toContain(STAGED.cacheName);

    // The upgraded client evaluates the CURRENT mount's stylesheet.
    const sheets = await stylesheetHrefs(page);
    expect(sheets.some((href) => href.includes(`${STAGED.currentMount.prefix}app.css`))).toBe(true);
    expect(sheets.some((href) => href.includes(STAGED.mount.prefix))).toBe(false);

    // And the surface the fix was for is visible to a person pressing the
    // control — the computed style, after a click, on the upgraded client.
    await expect(page.locator('#exportModal')).toBeHidden();
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportModal')).toBeVisible();
    await expect(page.locator('#exportModal')).toHaveCSS('display', 'block');
    await page.locator('#exportModalClose').click();
    await expect(page.locator('#exportModal')).toHaveCSS('display', 'none');

    // No request under the previous mount decided any of that. The mount bump is
    // what makes this true: the new stylesheet lives at a URL the client has no
    // cached copy of, so the 30-day immutable window on the old one cannot hand
    // back a stale file (A1-DL-004).
    expect(
      requested.filter((pathname) => pathname.startsWith(STAGED.mount.prefix)),
      'the upgraded document requested the previous mount'
    ).toEqual([]);
  });

  test('leg 2 — a client that never touches the banner gets the current mount on the next open', async ({
    page,
    context,
    baseURL,
  }) => {
    await installPreviousGeneration(page, context, baseURL);
    await context.clearCookies({ name: PREV_GEN_COOKIE });

    const requested = [];
    page.on('request', (request) => requested.push(new URL(request.url()).pathname));

    // Opening the app again — a navigation, deliberately NOT page.reload(): a
    // reload revalidates the main resource, while opening the app is what an
    // installed client actually does and is subject to the shell's own
    // max-age=3600, must-revalidate freshness. The navigation is handled by the
    // OLD worker (network-first for navigate), and every sub-resource by its
    // cache-first handler.
    await gotoApp(page, { state: STATES.seeded });

    // The banner is offered, and this client ignores it. This is what makes the
    // leg distinct rather than an accidental repeat of leg 1.
    await expect(page.locator('#updateBanner')).toHaveClass(/visible/, { timeout: 30_000 });

    // Not accepted: the previous generation is still the controller, and its
    // cache has not been purged. Asserted BEFORE the outcome below, so the
    // outcome cannot be read as leg 1 happening quietly.
    expect(await cacheKeys(page)).toContain(STAGED.cacheName);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // THE MEASURED OUTCOME (EMV-DL-003 (e)). The document evaluates the CURRENT
    // mount's stylesheet even though the client never accepted the update, and
    // the export modal is visible on click. The mechanism, and the reason this
    // is a property of the arrangement rather than a coincidence: the worker
    // serves navigations network-first, so the fresh shell arrives on the next
    // open; that shell names /m/v{N+1}/app.css, which is not in the old cache
    // and has no HTTP-cached copy, so the cache-first handler falls through to
    // the network and gets the new bytes. Both halves are load-bearing — with
    // the fix shipped at the SAME mount URL, the immutable window would have
    // handed this client the stale file instead.
    const sheets = await stylesheetHrefs(page);
    expect(sheets.some((href) => href.includes(`${STAGED.currentMount.prefix}app.css`))).toBe(true);
    expect(sheets.some((href) => href.includes(STAGED.mount.prefix))).toBe(false);

    await expect(page.locator('#exportModal')).toBeHidden();
    await page.locator('#exportBtn').click();
    await expect(page.locator('#exportModal')).toBeVisible();
    await expect(page.locator('#exportModal')).toHaveCSS('display', 'block');

    expect(
      requested.filter((pathname) => pathname.startsWith(STAGED.mount.prefix)),
      'the unaccepting client requested the previous mount'
    ).toEqual([]);
  });
});

// STATIC (AGENTS.md §11): a property of the tree, carrying no runtime claim.
// The fixture is test-side and must never become a delivery surface — neither in
// the image nor in the staged APK web root, which native/tools/stage-webdir.js
// assembles from the same COPY list.
test.describe('the upgrade-path fixture is not a delivery surface', () => {
  test('app/Dockerfile ships nothing under /tests/', () => {
    const ship = shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8'));
    const shipped = [...ship.files, ...ship.dirs];
    expect(shipped.length, 'no COPY list parsed — the scan would be vacuous').toBeGreaterThan(5);
    expect(
      shipped.filter((urlPath) => urlPath.startsWith('/tests')),
      'app/Dockerfile ships a path under /tests/ — the parity fixtures would reach production'
    ).toEqual([]);
  });
});
