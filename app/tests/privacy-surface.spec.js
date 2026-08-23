'use strict';

// The policy page as a browser actually meets it (PPR-P1).
//
// WHY THIS EXISTS SEPARATELY FROM privacy-page.spec.js. That file reads the
// tree: the page ships, it contains no <script>, it says what the source
// document says. None of that is a claim about what happens when someone opens
// the address (AGENTS.md §11), and three of this packet's four risks are
// exactly that kind of claim:
//
//   1. /privacy could answer 200 with the APP SHELL. That is what it did before
//      this packet — `try_files $uri $uri/ /index.html` serves index.html for
//      every unknown path, silently, with no error anywhere. A source scan
//      cannot see it; only a navigation can.
//   2. The page could pull in a third party. The document states in §3.2 and
//      §5 that it runs no analytics before consent; a policy page that loaded
//      gtag while saying so would be the worst possible defect in this file.
//   3. A visit could POISON THE APP SHELL. app/sw.js mirrors every navigation
//      into the cache keyed '/', which is the shell's offline copy, unless the
//      path is named in NON_SHELL_PAGES. /privacy is the second real page this
//      image has ever shipped, so it re-arms the defect DIA-P1 repaired for
//      /transfer.html (DIA-DL-005 (m)). The last test here is the executing
//      half of that repair, built to the same shape as its precedent — which
//      lived in app/tests/handoff-transfer.spec.js until PPR-P2 retired the
//      transfer. Since that packet this file is the ONLY executor of the
//      property for any page, which is why it is written out here rather than
//      referred to.
//
// WHAT THIS FILE STILL CANNOT CLAIM. It drives app/tests/server.js, not nginx:
// the routing rule proved here is the MIRROR of app/nginx.conf, paired to the
// real file by the drift guard in delivery-contract.spec.js. What the shipped
// container does with `location = /privacy` is owner-run smoke, and it is
// named as such in the execution report rather than implied by a green run.

const { test, expect, gotoApp, STATES } = require('./support/seed');

const ROUTE = '/privacy';
const DOCUMENT_TITLE = 'Политика конфиденциальности TheyGrow';
const SHELL_MARKER = 'id="mainTable"';

test.describe('the policy address serves the policy document', () => {
  test('a navigation to /privacy renders the document, not the app shell', async ({ page }) => {
    const response = await page.goto(ROUTE);

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');

    // The document, by the two things a reader sees first.
    await expect(page).toHaveTitle(DOCUMENT_TITLE);
    await expect(page.locator('h1')).toHaveText(DOCUMENT_TITLE);
    // And by something from deep inside it, so a stub page carrying the right
    // title could not pass: the retention table is the last section but one.
    await expect(page.locator('h2', { hasText: 'Сроки хранения по категориям' })).toHaveCount(1);
    await expect(page.locator('table')).toHaveCount(2);

    // The defect this address had until this packet. Asserted on the rendered
    // page rather than on the response body, because "what the parent is
    // looking at" is the claim.
    expect(
      await page.content(),
      'the app shell was served at /privacy — the exact-match location is gone, or lost its precedence to try_files'
    ).not.toContain(SHELL_MARKER);
  });

  test('the trailing-slash spelling lands on the same document', async ({ page }) => {
    // /privacy/ matches no exact location, so without its own rule it falls
    // into `location /`, finds no such directory and is answered with the
    // shell — the same silent 200 as above, one character away.
    const response = await page.goto('/privacy/');
    expect(response.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(ROUTE);
    await expect(page.locator('h1')).toHaveText(DOCUMENT_TITLE);
  });
});

test.describe('the policy page runs nothing and reaches nobody', () => {
  test('opening it produces no script, no stylesheet and no third-party request', async ({
    page,
  }) => {
    const seen = [];
    page.on('request', (request) =>
      seen.push({ url: request.url(), type: request.resourceType() })
    );

    await page.goto(ROUTE);

    // Anti-vacuity FIRST: a listener attached too late, or a page that never
    // loaded, would make every assertion below hold against an empty array.
    expect(
      seen.some((r) => new URL(r.url).pathname === ROUTE && r.type === 'document'),
      'the request listener never saw the document itself'
    ).toBe(true);

    // The analytics hosts are stubbed for the whole suite by the page fixture
    // (support/seed.js) so CI generates no third-party egress. That stub
    // fulfils requests; it does not hide them — page.on('request') fires for a
    // routed request exactly as for any other — so an absence asserted here is
    // a real absence, not an artefact of the harness.
    const origin = new URL(page.url()).host;
    expect(
      seen.filter((r) => new URL(r.url).host !== origin),
      'the policy page reached a third party'
    ).toEqual([]);

    const EXECUTABLE = ['script', 'stylesheet', 'xhr', 'fetch', 'websocket', 'eventsource'];
    expect(
      seen.filter((r) => EXECUTABLE.includes(r.type)),
      'the policy page fetched something executable — it is a document, and its style is inline'
    ).toEqual([]);

    // Belt and braces on the same claim from inside the loaded page: a script
    // element that failed to fetch would leave no request but would still be
    // in the DOM, and an inline one would never have made a request at all.
    expect(await page.evaluate(() => document.scripts.length)).toBe(0);

    // What is deliberately NOT forbidden: a browser-initiated /favicon.ico.
    // The page names no icon, Chromium asks anyway, and it is same-origin, not
    // executable, and not something the page can suppress. Naming it here
    // keeps the two lists above narrow enough to mean something.
  });

  test('opening it registers no service worker', async ({ page }) => {
    await page.goto(ROUTE);

    // A fresh context, so nothing is installed unless this page installs it.
    // The page loads no sw-register.js by construction; this is the executing
    // proof that it does not, and that the address is not quietly an app shell
    // that happens to render a document.
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
      'the policy page is controlled by a service worker in a fresh context'
    ).toBe(false);
    expect(
      await page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).length
      ),
      'the policy page registered a service worker'
    ).toBe(0);
  });
});

test.describe('visiting the policy page does not overwrite the app shell offline copy', () => {
  test('the cached shell survives a visit to /privacy', async ({ page }) => {
    // THE DEFECT THIS PAGE RE-ARMS, EXECUTED. app/sw.js serves navigations
    // network-first and mirrors the successful response into the cache keyed
    // '/', which is the app shell's offline copy. That is sound only while
    // every navigable path IS the shell. /privacy is a real second page a
    // parent opens on purpose — from the Play listing, from the intro window
    // once the declaration is flipped — so without its entry in
    // NON_SHELL_PAGES one visit would replace the app shell's offline copy
    // with the policy document, permanently, for every client that ever
    // opened it.
    //
    // Asserted on the CACHE rather than on a later offline boot, for the
    // reason the retired precedent recorded (DIA-DL-005 (m)): the poisoning
    // happens at the moment of the visit, and reading it there names the cause
    // instead of a symptom two steps downstream.
    await gotoApp(page, { state: STATES.seeded });
    await page.evaluate(() => navigator.serviceWorker.ready);

    const cachedShellBefore = await page.evaluate(async () => {
      const response = await caches.match('/');
      return response ? response.text() : null;
    });
    // Anti-vacuity: with '/' uncached, everything below holds trivially.
    expect(cachedShellBefore, 'the app shell is not in the cache to be overwritten').not.toBeNull();
    expect(cachedShellBefore).toContain(SHELL_MARKER);

    await page.goto(ROUTE);
    await expect(page.locator('h1')).toHaveText(DOCUMENT_TITLE);

    // The mirror, if it happens, happens on the response — poll rather than
    // assume it has settled, so a pass is not a race that went our way.
    await expect
      .poll(
        async () => {
          const body = await page.evaluate(async () => {
            const response = await caches.match('/');
            return response ? response.text() : null;
          });
          return body === null ? 'absent' : body.includes(SHELL_MARKER) ? 'shell' : 'poisoned';
        },
        { timeout: 5000 }
      )
      .toBe('shell');

    const cachedShellAfter = await page.evaluate(async () => {
      const response = await caches.match('/');
      return response ? response.text() : null;
    });
    expect(
      cachedShellAfter.includes(DOCUMENT_TITLE),
      'the app shell offline copy is now the policy document'
    ).toBe(false);
  });

  test('the same visit under the .html spelling is equally harmless', async ({ page }) => {
    // Both spellings are named in NON_SHELL_PAGES because the fetch handler
    // compares url.pathname, and the file is reachable under its own name too.
    // One entry without the other is a guard that holds for the address people
    // are given and fails for the one a crawler or an old link finds.
    await gotoApp(page, { state: STATES.seeded });
    await page.evaluate(() => navigator.serviceWorker.ready);

    const before = await page.evaluate(async () => {
      const response = await caches.match('/');
      return response ? response.text() : null;
    });
    expect(before, 'the app shell is not in the cache to be overwritten').not.toBeNull();
    expect(before).toContain(SHELL_MARKER);

    await page.goto('/privacy.html');
    await expect(page.locator('h1')).toHaveText(DOCUMENT_TITLE);

    await expect
      .poll(
        async () => {
          const body = await page.evaluate(async () => {
            const response = await caches.match('/');
            return response ? response.text() : null;
          });
          return body === null ? 'absent' : body.includes(SHELL_MARKER) ? 'shell' : 'poisoned';
        },
        { timeout: 5000 }
      )
      .toBe('shell');
  });
});
