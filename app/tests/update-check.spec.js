'use strict';

// NAV-P2-INV-001 / NAV-P2-INV-002, the executing halves — WHEN this app reaches
// the network, and WHAT the one request it makes is composed of.
//
// WHY THIS FILE IS THE PACKET'S REAL DELIVERABLE. NAV-P2 adds the first outbound
// request this product has ever made. Everything else in the packet is a row, a
// stylesheet rule and a paragraph of policy; the thing that has to be true, and
// has to keep being true after the next packet, is that the request happens on a
// press and nowhere else, and that it carries nothing about the family, the
// device or the person. Neither of those is a property of the source, so neither
// is asserted by reading it (AGENTS.md §11). What is read here is the network log
// of a real page — the instrument vault ADR-052 §4 names by the precedent it
// borrows, app/tests/analytics-egress.spec.js.
//
// NOTHING IN CI EVER DIALS OUT, AND THE ABSENCE IS STILL REAL. Every leg installs
// one catch-all route over EVERY off-origin address, and that route either
// fulfils the answer the leg is about or aborts. So a stray request — the boot
// fetch this packet must not add, a retry, a second address — is recorded by the
// `request` listener before the route decides anything, and then goes nowhere.
// The recording is the evidence; the abort is only hygiene.
//
// THE ANTI-VACUITY PROBLEM, NAMED BEFORE THE LEGS, because "no request matched"
// is exactly what a listener that was never attached reports, what a navigation
// that never happened reports, and what a page that failed to boot reports. Every
// leg below asserts on the SAME observer and the SAME navigation that two
// requests which MUST happen were seen — the document and the knowledge base —
// before it asserts that a third was not.
//
// WHAT THIS FILE DOES NOT CLAIM. It says nothing about a real Capacitor WebView:
// `installNativeShell` below satisfies the channel probe and plants a build-info
// plugin, and the project it runs in serves app/tests/server.js over plain HTTP.
// Whether the shipped plugin reports the truth on a device is
// BuildInfoTest on the emulator, and whether «Установить» actually reaches the
// system browser is the owner-run smoke in docs/RUNBOOK.md — both said in those
// files too, so neither claim can drift here unnoticed.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { gotoApp, STATES } = require('./support/seed');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);

// The shipped knobs, read rather than restated — the rule this suite already
// follows for apkReleaseUrl and policyUrl: a test that wrote the address down
// again would agree with itself after the knob changed.
const CONFIG_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'channel', 'config.js'), 'utf8');
const API_URL = /updateApiUrl:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const RELEASE_URL = /apkReleaseUrl:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];
const TIMEOUT_MS = Number(/updateCheckTimeoutMs:\s*(\d+)/.exec(CONFIG_SOURCE)[1]);

// The one header the product sets, read out of the shipped surface for the same
// reason. The composition leg allows exactly this one beyond what a browser
// sends by itself.
const UPDATE_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'surfaces', 'update.js'), 'utf8');
const ACCEPT = /const ACCEPT = '([^']+)';/.exec(UPDATE_SOURCE)[1];

// The version the fake plugin reports as installed. A literal, because the whole
// point of the comparison legs is to vary the OTHER side of it.
const INSTALLED_CODE = 221;

/**
 * Every request the page attempted, recorded before anything routes it, split by
 * whether it left this origin.
 */
function watchRequests(page) {
    const local = [];
    const away = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
            local.push(url.pathname);
        } else {
            away.push(request);
        }
    });
    return {
        local: () => local,
        away: () => away,
        sawPath: (p) => local.includes(p),
    };
}

/**
 * The single catch-all over every off-origin address.
 *
 * `answer` is called for the update API and may fulfil, abort or delay. Anything
 * else off-origin is aborted outright: this product addresses exactly one
 * off-origin URL, and a leg that let a second one through would be measuring the
 * network rather than the app.
 */
async function routeAway(page, answer) {
    await page.route(
        (url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
        async (route) => {
            if (answer && route.request().url() === API_URL) {
                await answer(route);
                return;
            }
            await route.abort();
        }
    );
}

/**
 * The smallest thing that makes this page the native channel WITH a build-info
 * plugin — the two facts the row's reveal depends on.
 */
async function installNativeShell(page, { installer = null, versionCode = INSTALLED_CODE } = {}) {
    await page.addInitScript(
        ([who, code]) => {
            window.Capacitor = {
                isNativePlatform: () => true,
                nativePromise: (plugin, method) => {
                    if (plugin === 'TheyGrowBuild' && method === 'info') {
                        return Promise.resolve({
                            versionCode: code,
                            versionName: `0.1.${code}`,
                            installer: who,
                        });
                    }
                    return Promise.reject(new Error(`unexpected plugin call ${plugin}.${method}`));
                },
            };
        },
        [installer, versionCode]
    );
}

/** A releases/latest body carrying one asset for the given versionCode. */
function releaseBody(versionCode) {
    return JSON.stringify({
        tag_name: `v0.1.${versionCode}`,
        assets: [
            { name: `theygrow-v0.1.${versionCode}-${versionCode}.apk` },
            { name: `theygrow-v0.1.${versionCode}-${versionCode}.apk.sha256` },
        ],
    });
}

/** Asserts the observer was live for this navigation before any absence is read. */
function expectObserverLive(requests, what) {
    expect(
        requests.sawPath('/'),
        `${what}: the request listener never saw the document itself, so an absence here would be`
            + ' about a page that did not load'
    ).toBe(true);
    expect(
        requests.sawPath('/kb-v1.json'),
        `${what}: the app never fetched the knowledge base, so it did not boot and an absence here`
            + ' is a fact about a dead page rather than about this product'
    ).toBe(true);
}

function awayUrls(requests) {
    return requests.away().map((request) => request.url());
}

async function openMenu(page) {
    await page.locator('#menuBtn').click();
    await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);
}

test.describe('nothing leaves this app until the row is pressed (NAV-P2-INV-001)', () => {
    test('booting the app reaches nothing', async ({ page }) => {
        const requests = watchRequests(page);
        await routeAway(page, null);
        await installNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });

        // The reveal has happened — so this is an absence measured on a page
        // that DID take the branch the request lives on, not on one where the
        // surface was never wired.
        await expect(page.locator('#menuUpdateBtn')).toHaveCount(1);
        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(true);

        expectObserverLive(requests, 'boot');
        expect(awayUrls(requests), 'a request left the app on boot').toEqual([]);
    });

    test('opening the menu reaches nothing', async ({ page }) => {
        const requests = watchRequests(page);
        await routeAway(page, null);
        await installNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });

        await openMenu(page);
        // ANTI-VACUITY for the action: the row is really on screen, so the
        // absence below is about a menu that opened onto it.
        await expect(page.locator('#menuUpdateBtn')).toBeVisible();

        expectObserverLive(requests, 'menu open');
        expect(awayUrls(requests), 'a request left the app on opening the menu').toEqual([]);
    });

    test('driving every other surface on the app channel reaches nothing', async ({ page }) => {
        // The sweep analytics-egress.spec.js performs, for a different absence:
        // a request fired from any handler other than this row's would be caught
        // here and nowhere else, whatever host it addressed.
        //
        // WHAT THIS BRANCH CAN AND CANNOT BE DRIVEN THROUGH, measured rather than
        // assumed. Installing a `nativePromise` is what makes the build-info
        // plugin reachable, and it is also what store/bridge.js reads as "the
        // native store is available" — so this page takes the device-store path
        // with no device behind it, and the activities window correctly reports
        // that it has nothing to suggest. The skill window opens from an activity
        // card, so there is no card to open it from here. That surface is swept
        // on the web branch by the leg below instead of being faked into
        // existence here.
        const requests = watchRequests(page);
        await routeAway(page, null);
        await installNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });

        await openMenu(page);
        await page.locator('#menuAboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
        await page.locator('#onboardingCloseBtn').click();

        await page.locator('#profileButton').click();
        await expect(page.locator('#profileDropdown')).toBeVisible();
        await page.locator('#profileButton').click();

        await page.locator('#zpdFilterToggleBtn').click();
        await page.locator('#zpdFilterToggleBtn').click();

        await page.locator('#activitiesBtn').click();
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);
        await page.locator('#activitiesModalClose').click();

        await openMenu(page);
        await page.locator('#exportBtn').click();
        await expect(page.locator('#exportModal')).toBeVisible();
        await page.locator('#exportModalClose').click();

        await openMenu(page);
        await page.locator('#surfaceDiaryBtn').click();
        await expect(page.locator('#diaryModal')).toBeVisible();
        await page.locator('#diaryModalClose').click();

        // ANTI-VACUITY for the actions themselves: if none of the clicks landed,
        // the absence would be about a page nobody touched.
        await expect(page.locator('#diaryModal')).toBeHidden();
        await expect(page.locator('#exportModal')).toBeHidden();
        expectObserverLive(requests, 'a full pass over every other surface on the app channel');
        expect(awayUrls(requests), 'a request left the app from some other surface').toEqual([]);
    });

    test('driving every surface on the web channel reaches nothing either', async ({ page }) => {
        // The full seeded pass, on the branch where every surface is reachable —
        // including the skill window, which opens from an activity card and so
        // needs a board with something left to suggest. Same absence, wider
        // surface: this is the sweep analytics-egress.spec.js runs for analytics
        // origins, asked here about EVERY off-origin address.
        const requests = watchRequests(page);
        await routeAway(page, null);
        await gotoApp(page, { state: STATES.seeded });

        await page.locator('#aboutBtn').click();
        await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
        await page.locator('#onboardingCloseBtn').click();

        await page.locator('#profileButton').click();
        await expect(page.locator('#profileDropdown')).toBeVisible();
        await page.locator('#profileButton').click();

        const skillId = await page.evaluate(() => {
            const row = Array.from(document.querySelectorAll('#tableBody tr[data-skill-id]')).find(
                (tr) => {
                    const input = tr.querySelector('input[type="checkbox"]');
                    return input && !input.checked;
                }
            );
            return row ? row.getAttribute('data-skill-id') : null;
        });
        expect(skillId, 'no unticked skill on the seeded board — nothing to tick').not.toBeNull();
        const box = page.locator(`#tableBody tr[data-skill-id="${skillId}"] input[type="checkbox"]`);
        await box.check();
        await expect(box).toBeChecked();
        await box.uncheck();

        await page.locator('#zpdFilterToggleBtn').click();
        await page.locator('#zpdFilterToggleBtn').click();

        await page.locator('#activitiesBtn').click();
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);
        const card = page.locator('#activitiesGrid .activity-card-title[data-skill-id]').first();
        await expect(card).toBeVisible();
        await card.click();
        await expect(page.locator('#skillModal')).toHaveCSS('display', 'block');
        await page.locator('#skillModalClose').click();

        // ANTI-VACUITY for the actions: the activities window is still open
        // underneath, which is only true if the stack was actually driven.
        await expect(page.locator('#activitiesModal')).toHaveClass(/show/);
        expectObserverLive(requests, 'a full pass over every surface on the web channel');
        expect(awayUrls(requests), 'a request left the app from some other surface').toEqual([]);
    });

    test('the web channel has no handler to fire at all', async ({ page }) => {
        // STRONGER THAN "THE ROW IS HIDDEN", and that is the point of the leg.
        // A hidden control with a live handler is one line of someone else's
        // code away from a request — a `hidden` attribute cleared in devtools, a
        // stylesheet from an extension. On the web channel wireUpdate() returns
        // before it registers anything, so the row is revealed BY FORCE here and
        // pressed, and the network log stays empty.
        const requests = watchRequests(page);
        await routeAway(page, null);
        await gotoApp(page, { state: STATES.seeded });

        expect(await page.evaluate(() => window.IS_NATIVE_SHELL)).toBe(false);
        await page.evaluate(() => {
            document.getElementById('headerMenu').hidden = false;
            document.getElementById('headerMenuPanel').classList.add('show');
            document.getElementById('menuUpdateBtn').hidden = false;
        });
        await page.locator('#menuUpdateBtn').click();
        await expect(page.locator('#updateStatusChecking')).toBeHidden();

        expectObserverLive(requests, 'the web channel with the row forced open');
        expect(awayUrls(requests), 'the web channel reached the network').toEqual([]);
    });

    test('a Play copy has no handler either', async ({ page }) => {
        const requests = watchRequests(page);
        await routeAway(page, null);
        await installNativeShell(page, { installer: 'com.android.vending' });
        await gotoApp(page, { state: STATES.seeded });

        await openMenu(page);
        await expect(page.locator('#menuUpdateBtn')).toBeHidden();
        await page.evaluate(() => {
            document.getElementById('menuUpdateBtn').hidden = false;
        });
        await page.locator('#menuUpdateBtn').click();
        await expect(page.locator('#updateStatusChecking')).toBeHidden();

        expectObserverLive(requests, 'a Play copy with the row forced open');
        expect(awayUrls(requests), 'the Play copy reached the network').toEqual([]);
    });
});

test.describe('what the one request is made of (NAV-P2-INV-001)', () => {
    test('exactly one request, to the declared address, carrying no credential and no identifier',
        async ({ page }) => {
            const requests = watchRequests(page);
            await routeAway(page, (route) =>
                route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: releaseBody(INSTALLED_CODE),
                })
            );
            await installNativeShell(page);
            await gotoApp(page, { state: STATES.seeded });

            await openMenu(page);
            await page.locator('#menuUpdateBtn').click();
            await expect(page.locator('#updateStatusCurrent')).toBeVisible();

            const away = requests.away();
            // ANTI-VACUITY, first and loudest: everything below describes a
            // request, and describing one that was never made is the failure mode
            // this whole file is arranged against.
            expect(away.length, 'the press produced no request at all').toBe(1);

            const request = away[0];
            expect(request.method()).toBe('GET');
            expect(request.url(), 'the request did not address the declared knob').toBe(API_URL);
            expect(new URL(request.url()).search, 'the address carries a query string').toBe('');
            expect(request.postData(), 'the request carries a body').toBeNull();

            const headers = await request.allHeaders();
            expect(headers.authorization, 'the request carries an Authorization header').toBeUndefined();
            expect(headers.cookie, 'the request carries a Cookie header').toBeUndefined();
            expect(headers.referer, 'the request names the page it came from').toBeUndefined();
            expect(headers.accept, 'the one header the product sets is not the declared one')
                .toBe(ACCEPT);

            // AND NOTHING ELSE. The allowlist below is the whole of what GitHub
            // may observe about this request, and it is what the published policy
            // calls "standard HTTP client headers" — every name on it is set by
            // the browser for every request it makes, and none of them is chosen,
            // filled in or derived by this product. A header added later, for any
            // reason, reds here and has to be argued for against the policy
            // sentence rather than slipped in.
            const ALLOWED = new Set([
                'accept',
                'accept-encoding',
                'accept-language',
                'host',
                'origin',
                'user-agent',
                'referer',
                'sec-fetch-dest',
                'sec-fetch-mode',
                'sec-fetch-site',
                'sec-ch-ua',
                'sec-ch-ua-mobile',
                'sec-ch-ua-platform',
                'cache-control',
                'pragma',
                'priority',
                'connection',
                ':authority',
                ':method',
                ':path',
                ':scheme',
            ]);
            const unexpected = Object.keys(headers).filter((name) => !ALLOWED.has(name.toLowerCase()));
            expect(
                unexpected,
                'the request carries a header this product was not supposed to add'
            ).toEqual([]);
        });

    test('a second press while the first is in flight adds no second request', async ({ page }) => {
        let release = null;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const requests = watchRequests(page);
        await routeAway(page, async (route) => {
            await held;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: releaseBody(INSTALLED_CODE),
            });
        });
        await installNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });

        await openMenu(page);
        await page.locator('#menuUpdateBtn').click();
        await expect(page.locator('#updateStatusChecking')).toBeVisible();

        await page.locator('#menuUpdateBtn').click({ force: true });
        await page.locator('#menuUpdateBtn').click({ force: true });
        expect(requests.away().length, 'a press during a check started a second request').toBe(1);

        release();
        await expect(page.locator('#updateStatusCurrent')).toBeVisible();
        expect(requests.away().length, 'the settled check left more than one request').toBe(1);
    });
});

test.describe('the row answers, and answers honestly (NAV-P2-INV-002)', () => {
    /** Presses the row with a prepared answer and returns the request recorder. */
    async function press(page, answer, options = {}) {
        const requests = watchRequests(page);
        await routeAway(page, answer);
        await installNativeShell(page, options);
        await gotoApp(page, { state: STATES.seeded });
        await openMenu(page);
        await page.locator('#menuUpdateBtn').click();
        return requests;
    }

    // WHY THE RATE-LIMIT FIXTURES CARRY AN EXPOSE HEADER. The answer is
    // cross-origin, so a response header the product wants to READ has to be on
    // the CORS expose list or `headers.get()` returns null in any browser —
    // measured here while writing these legs, not assumed: without the header
    // the rate-limit fixtures landed on the server-error sentence. Whether the
    // real API exposes its `x-ratelimit-*` family is a fact about GitHub that
    // this packet did NOT verify at the source, so it is not asserted anywhere;
    // what is asserted is both branches. This fixture is the readable one. The
    // unreadable one is a leg of its own below, and it degrades to the plain
    // server-error sentence rather than claiming a limit it cannot see — which
    // is the honest direction and the one that holds whichever way GitHub
    // behaves.
    const json = (body, init = {}) => (route) => {
        const headers = Object.assign({}, init.headers);
        const exposed = Object.keys(headers).filter((name) => name.startsWith('x-'));
        if (exposed.length) headers['access-control-expose-headers'] = exposed.join(', ');
        return route.fulfill({
            status: init.status || 200,
            contentType: 'application/json',
            headers,
            body,
        });
    };

    test('a newer release offers «Установить», addressed at the declared page', async ({ page }) => {
        const requests = await press(page, json(releaseBody(INSTALLED_CODE + 1)));

        await expect(page.locator('#updateStatusAvailable')).toBeVisible();
        const link = page.locator('#updateInstallLink');
        await expect(link).toBeVisible();
        // The address comes from the knob, NOT from the answer: taking a
        // navigable address out of a network response is a strictly larger trust
        // surface than reading a constant.
        await expect(link).toHaveAttribute('href', RELEASE_URL);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

        // The menu did NOT close under the answer.
        await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);
        expect(requests.away().length).toBe(1);
    });

    test('the same version answers «Обновлений нет» and offers nothing', async ({ page }) => {
        await press(page, json(releaseBody(INSTALLED_CODE)));
        await expect(page.locator('#updateStatusCurrent')).toBeVisible();
        await expect(page.locator('#updateInstallLink')).toBeHidden();
    });

    test('an older release answers «Обновлений нет» too', async ({ page }) => {
        await press(page, json(releaseBody(INSTALLED_CODE - 1)));
        await expect(page.locator('#updateStatusCurrent')).toBeVisible();
        await expect(page.locator('#updateInstallLink')).toBeHidden();
    });

    // THE FAILURE PATHS ARE THE PACKET, NOT ITS AFTERTHOUGHT. Each one asserts
    // three things: the honest sentence appears, the menu still works, and
    // NOTHING WAS RETRIED — the request count stays at one after the failure has
    // been on screen.
    const FAILURES = [
        [
            'no network',
            (route) => route.abort(),
            'updateStatusOffline',
        ],
        [
            'a rate-limited answer',
            json('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
            'updateStatusRateLimited',
        ],
        [
            'a rate-limited answer that says 429',
            json('{}', { status: 429 }),
            'updateStatusRateLimited',
        ],
        [
            'a forbidden answer that is not about the limit',
            json('{}', { status: 403, headers: { 'x-ratelimit-remaining': '57' } }),
            'updateStatusServerError',
        ],
        [
            'a server error',
            json('{}', { status: 500 }),
            'updateStatusServerError',
        ],
        [
            'a not-found answer',
            json('{}', { status: 404 }),
            'updateStatusServerError',
        ],
        [
            'a malformed body',
            (route) =>
                route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }),
            'updateStatusUnreadable',
        ],
        [
            'a body with no assets at all',
            json(JSON.stringify({ tag_name: 'v0.1.500' })),
            'updateStatusUnreadable',
        ],
        [
            'a release whose assets do not match the published shape',
            json(JSON.stringify({ assets: [{ name: 'app-release.apk' }] })),
            'updateStatusUnreadable',
        ],
    ];

    for (const [what, answer, expected] of FAILURES) {
        test(`${what} lands on its own sentence, retries nothing, and leaves the menu working`,
            async ({ page }) => {
                const requests = await press(page, answer);

                await expect(page.locator(`#${expected}`)).toBeVisible();
                await expect(page.locator('#updateInstallLink')).toBeHidden();

                // Nothing is retried, automatically or otherwise. Waited on
                // rather than sampled instantly: a retry scheduled a tick later
                // would pass an immediate count.
                await page.waitForTimeout(500);
                expect(requests.away().length, `${what} was retried`).toBe(1);

                // The menu still works, and the row is pressable again — the
                // parent is not left holding a dead control.
                await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);
                await expect(page.locator('#menuUpdateBtn')).toBeEnabled();
                await page.keyboard.press('Escape');
                await expect(page.locator('#headerMenuPanel')).toBeHidden();
                await page.locator('#menuBtn').click();
                await expect(page.locator('#headerMenuPanel')).toHaveClass(/show/);

                // And re-opening the menu clears the stale answer rather than
                // presenting it as fresh.
                await expect(page.locator(`#${expected}`)).toBeHidden();
            });
    }

    test('a rate-limited answer whose header is not readable degrades to the server sentence',
        async ({ page }) => {
            // The direction of the degradation, stated by executing it. If the
            // limit header is ever withheld from cross-origin readers, this
            // product says "the server answered with an error" — which is true —
            // rather than claiming a limit it cannot see.
            await press(page, (route) =>
                route.fulfill({
                    status: 403,
                    contentType: 'application/json',
                    headers: { 'x-ratelimit-remaining': '0' },
                    body: '{}',
                })
            );
            await expect(page.locator('#updateStatusServerError')).toBeVisible();
            await expect(page.locator('#updateStatusRateLimited')).toBeHidden();
        });

    test('a timeout is told apart from a dead network', async ({ page }) => {
        // The response is held past the declared deadline and never delivered,
        // which is the shape a hung server has. The distinction matters to a
        // parent: "no connection" and "the server did not answer" are different
        // facts and this product says which one it met.
        const requests = await press(page, () => new Promise(() => {}));

        await expect(page.locator('#updateStatusChecking')).toBeVisible();
        await expect(page.locator('#updateStatusTimeout')).toBeVisible({
            timeout: TIMEOUT_MS + 5000,
        });
        await expect(page.locator('#updateStatusOffline')).toBeHidden();
        expect(requests.away().length, 'the timeout was retried').toBe(1);
        await expect(page.locator('#menuUpdateBtn')).toBeEnabled();
    });
});

test.describe('the fill is the countdown it claims to be (NAV-P2-INV-002)', () => {
    test('the row fills for exactly as long as the check may take', async ({ page }) => {
        // WHY THIS LEG EXISTS. The fill is the one part of this surface that
        // makes a claim about TIME, and a fill whose duration drifted from the
        // abort deadline would be a progress bar that finishes while the app is
        // still waiting, or one that is still moving after it gave up. Reading
        // the computed duration off the running element is the only way to know
        // the knob reached the stylesheet — the rule uses a custom property with
        // no fallback precisely so that an unset value is no animation rather
        // than a different duration.
        await routeAway(page, () => new Promise(() => {}));
        await installNativeShell(page);
        await gotoApp(page, { state: STATES.seeded });

        await openMenu(page);
        const row = page.locator('#menuUpdateBtn');
        await expect(row).not.toHaveClass(/is-checking/);
        await row.click();

        await expect(row).toHaveClass(/is-checking/);
        await expect(row).toHaveAttribute('aria-busy', 'true');
        await expect(row).toBeDisabled();

        const fill = page.locator('#updateFill');
        await expect(fill).toHaveCSS('animation-duration', `${TIMEOUT_MS / 1000}s`);
        await expect(fill).toHaveCSS('animation-name', 'header-menu-update-fill');

        // And it stops being a countdown the moment there is an answer.
        await expect(page.locator('#updateStatusTimeout')).toBeVisible({
            timeout: TIMEOUT_MS + 5000,
        });
        await expect(row).not.toHaveClass(/is-checking/);
        await expect(row).not.toHaveAttribute('aria-busy', 'true');
    });
});
