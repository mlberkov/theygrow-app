'use strict';

// What a return from the background does, executed in a browser (FIU-P1).
//
// THE DEFECT THIS FILE IS THE EXECUTOR FOR. The owner reported, from the first
// live install, that coming back to the app after a screen lock "starts over on
// the same initial screen". It did, and it needed no reload, no process death
// and no manifest fault to do it: `surfaces/import.js` registered a
// `visibilitychange` listener that called `offerImportIfPending()` on every
// return to visible, and that function's terminal branch opened `#importModal`
// unconditionally when nothing was staged. On a phone that modal is
// `100vw/100dvh`, so it WAS a screen — the transfer screen, which was the first
// screen after an install.
//
// L3-P2 REMOVED THE SCREEN ITSELF (FIU-DL-002), and this file's first leg
// changed shape with it rather than being deleted. FIU-P1 narrowed the resume
// call so the offer stopped RE-opening; the owner then removed the offer
// outright, so `surfaces/import.js`, `#importModal` and that listener are all
// gone. The claim worth executing is therefore the general one the report was
// really about — a return from the background puts NOTHING over the parent's
// work — and it is stronger than the old per-modal assertion, because it holds
// for whatever a later packet might be tempted to open on that event. The old
// leg's arm (a refused handoff must still reach the parent) has no subject any
// more: there is no surface for it to reach.
//
// AND THE SECOND CLAIM, on the same event from the other direction: the store
// now CLOSES when the page goes hidden (`store/boot.js parkNativeStore`), which
// is what finally makes `clean_shutdown` mean something and stops
// `PRAGMA integrity_check` running at every launch (DIA-DL-008 debt 8).
//
// HOW THE VISIBILITY IS DRIVEN, AND WHAT THAT COSTS — stated up front because
// it is the one thing a reader must not assume. Chromium's own visibility
// bookkeeping cannot be driven from a headless browser: MEASURED on this
// machine, a second page in the same context brought to the front leaves the
// first at `visible`, CDP has no `Emulation.setPageVisibilityState` at all, and
// `Page.setWebLifecycleState: frozen` leaves `visibilityState` at `visible`.
// Both Playwright browser flavours behave identically.
//
// So each leg redefines `document.visibilityState` and `document.hidden` — the
// two properties every handler under test reads — and dispatches a real event on
// the real document. What executes after that is the WHOLE shipped chain: the
// listener in `core/state.js`, then `parkNativeStore`, then the gate in
// `store/bridge.js`, then `closeStore`, then the bridge, then the seam.
//
// WHAT IS THEREFORE NOT EXECUTED HERE, and where it is: Chromium's decision to
// fire that event when an Android activity stops. That is the whole question
// DIA-DL-008 debt 8 left open, and it is answered on a device by
// `StoreLifecycleTest`, which drives a real MainActivity to STOPPED and reads
// the device log. A green in this file is not evidence for it, and this file
// says so rather than letting a reader infer otherwise.
//
// The override is not silent about failing: `Object.defineProperty` THROWS if
// the property ever stops being configurable, so a future Chromium that closed
// this door reds these legs loudly instead of leaving them asserting nothing.
//
// WHAT THIS PROVES NOTHING ABOUT. SQLite, and the Android WebView. The seam
// behind the store here (`support/page-bridge.js`) executes no SQL and has no
// connection to close, so what executes is the shipped CHAIN — the listener, the
// gate in `store/bridge.js`, `parkNativeStore`, `closeStore` — and not the
// engine underneath it. That a real Android WebView delivers the event at
// `Activity.onStop` at all, and that a real SQLCipher connection closes and
// reopens, is `StoreLifecycleTest` on `android-instrumented`. Neither file
// substitutes for the other.

const fs = require('fs');
const path = require('path');
const { test, expect, gotoApp, STATES } = require('./support/seed');
const { installPageBridge, shippedStatements } = require('./support/page-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const STATEMENTS = shippedStatements(APP_ROOT, MOUNT.dir);

const SELF = 'p-lifecycle-self';
const CHILD = {
    id: 'child-lifecycle',
    name: 'Проба',
    birthdate: '2024-09-15',
    createdAtUtc: 1_700_000_000_000,
};

/** Boots the app on the native branch with a store that opens. */
async function bootWithStore(page) {
    await installPageBridge(page, {
        mountBase: MOUNT.prefix,
        statements: STATEMENTS,
        child: CHILD,
        selfParticipantId: SELF,
    });
    await gotoApp(page, { state: STATES.empty });
}

/** Drives the page's visibility, and proves the drive took. */
async function setVisibility(page, value) {
    await page.evaluate((state) => {
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => state,
        });
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => state === 'hidden',
        });
        document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    await page.waitForFunction((state) => document.visibilityState === state, value);
}

/** The app goes to the background. */
async function goToBackground(page) {
    await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('visible');
    await setVisibility(page, 'hidden');
}

/** The parent unlocks the phone. */
async function comeBack(page) {
    await setVisibility(page, 'visible');
}

/** Every CapacitorSQLite call the page made, in order. */
const sqliteCalls = (page) =>
    page.evaluate(() =>
        (window.__pageBridgeCalls || [])
            .filter((call) => call.plugin === 'CapacitorSQLite')
            .map((call) => call.method)
    );

/** Every statement the page ran through `run`, in order. */
const runStatements = (page) =>
    page.evaluate(() =>
        (window.__pageBridgeCalls || [])
            .filter((call) => call.plugin === 'CapacitorSQLite' && call.method === 'run')
            .map((call) => call.options.statement)
    );

test.describe('coming back from the background leaves the parent where they were', () => {
    test('the page really took the journal backend', async ({ page }) => {
        // ANTI-VACUITY, and it is the same premise `diary-save.spec.js` states:
        // with no store the app takes a different branch entirely, and every leg
        // below would be asserting about a screen a parent with a store never
        // sees.
        await bootWithStore(page);
        expect(await sqliteCalls(page)).toContain('createConnection');
        await expect(page.locator('#diaryBtn')).toBeVisible();
    });

    test('a return to visibility puts nothing over the parent\u2019s work', async ({ page }) => {
        await bootWithStore(page);

        // The parent is IN something when the phone locks — the state the
        // owner's report was actually about. A leg that backgrounded an idle
        // table could not tell "nothing opened" from "nothing was there".
        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryModal')).toBeVisible();

        await goToBackground(page);
        await comeBack(page);

        // Every listener on this event has run by now: each runs synchronously
        // off the event and only then awaits. The park leg below is what proves
        // they are alive at all, so a green here cannot come from a page that
        // stopped listening.
        const opened = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.modal.show, .onboarding-modal.show'))
                .map((element) => element.id)
                .filter((id) => id !== 'diaryModal')
        );
        expect(
            opened,
            'unlocking the phone opened something over whatever the parent was doing'
                + ' (FIU-P1-INV-001, as amended by FIU-DL-002)'
        ).toEqual([]);
        await expect(
            page.locator('#diaryModal'),
            'the parent came back to a different screen from the one they left'
        ).toBeVisible();
    });
});

test.describe('the store closes when the page goes away, and comes back when it is needed', () => {
    test('going hidden writes the clean-shutdown marker and closes the connection', async ({
        page,
    }) => {
        await bootWithStore(page);

        // The marker is not yet written: the app is running.
        expect(await runStatements(page)).not.toContain(STATEMENTS.markClean);

        await goToBackground(page);
        await page.waitForFunction(
            () =>
                (window.__pageBridgeCalls || []).some(
                    (call) => call.plugin === 'CapacitorSQLite' && call.method === 'closeConnection'
                ),
            null,
            { timeout: 5000 }
        );

        const statements = await runStatements(page);
        expect(
            statements,
            'the park did not write clean_shutdown = 1, so the next open would still owe a full'
                + ' integrity_check over the family history (FIU-P1-INV-001)'
        ).toContain(STATEMENTS.markClean);

        // ORDER, not just presence. The marker has to be written while the
        // connection is still open, so a park that closed first and then tried
        // to write would red here rather than pass on presence alone.
        // All three positions read off the SAME list, which is the mistake this
        // shape exists to avoid: an index into the filtered SQLite calls
        // compared against an index into the whole transcript compares nothing.
        const order = await page.evaluate((statement) => {
            const calls = (window.__pageBridgeCalls || []).filter(
                (call) => call.plugin === 'CapacitorSQLite'
            );
            return {
                marker: calls.findIndex(
                    (call) => call.method === 'run' && call.options.statement === statement
                ),
                close: calls.findIndex((call) => call.method === 'close'),
                closeConnection: calls.findIndex((call) => call.method === 'closeConnection'),
            };
        }, STATEMENTS.markClean);

        expect(order.marker, 'the clean-shutdown marker was never written').toBeGreaterThan(-1);
        expect(order.close, 'the database was never closed').toBeGreaterThan(-1);
        expect(
            order.close,
            'close ran before the marker was written, so the marker went to a closed database'
        ).toBeGreaterThan(order.marker);
        expect(
            order.closeConnection,
            'the connection was dropped before the database was closed'
        ).toBeGreaterThan(order.close);
    });

    test('the next call that needs the store reopens it, and the parent sees their diary', async ({
        page,
    }) => {
        await bootWithStore(page);

        await goToBackground(page);
        await page.waitForFunction(() =>
            (window.__pageBridgeCalls || []).some(
                (call) => call.plugin === 'CapacitorSQLite' && call.method === 'closeConnection'
            )
        );
        await comeBack(page);

        const before = (await sqliteCalls(page)).filter((m) => m === 'createConnection').length;
        expect(before, 'the store was opened more than once before the resume').toBe(1);

        // A parent taps the diary. Nothing about that path knows the store was
        // parked, which is the point: the gate reopens it underneath.
        await page.locator('#diaryBtn').click();
        await expect(page.locator('#diaryModal')).toBeVisible();
        await expect(
            page.locator('#diaryNewBtn'),
            'the diary refused after a resume — the parked store never reopened'
        ).toBeVisible();

        const after = (await sqliteCalls(page)).filter((m) => m === 'createConnection').length;
        expect(
            after,
            'the store was not reopened on the first call that needed it'
        ).toBe(before + 1);
    });
});
