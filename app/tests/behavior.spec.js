'use strict';

// Level (c) — behavioral smoke (ADR-037 §3c).
//
// Covers the flows the split must not break: the main tick -> ZPD recompute ->
// save loop, reload from seeded storage, the activity -> skill deep link and its
// modal stack, service-worker registration / offline boot / PWA update, and the
// kb-load error path.

const {
  test,
  expect,
  gotoApp,
  readStorage,
  STATES,
  STORAGE_KEYS,
  PROFILE,
  CHAIN,
} = require('./support/seed');
const { SW_TEST_VERSION, SW_BUMP_COOKIE } = require('./server');
const { appModule } = require('./support/app-module');

const rowFor = (page, id) => page.locator(`#tableBody tr[data-skill-id="${id}"]`);
const checkboxFor = (page, id) => rowFor(page, id).locator('input[type="checkbox"]');

test.describe('main flow — checkbox -> ZPD recompute -> save', () => {
  test('ticking a skill recomputes dependents, persists, and survives reload', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });

    // GM_005 is ready (GM_004 done); GM_006 is blocked (needs GM_004 AND GM_005).
    await expect(rowFor(page, CHAIN.ready)).toHaveAttribute('data-zpd-ready', 'true');
    await expect(rowFor(page, CHAIN.blocked)).toHaveAttribute('data-zpd-ready', 'false');

    await checkboxFor(page, CHAIN.ready).check();

    // Recompute reaches beyond the clicked row — the point of refreshAllZpdReadiness.
    await expect(rowFor(page, CHAIN.ready)).toHaveAttribute('data-zpd-ready', 'false');
    await expect(rowFor(page, CHAIN.ready)).toHaveClass(/skill-completed/);
    await expect(rowFor(page, CHAIN.blocked)).toHaveAttribute('data-zpd-ready', 'true');

    // Persisted to the profile record.
    const stored = JSON.parse(await readStorage(page, STORAGE_KEYS.profiles));
    expect(stored[0].completedSkills).toContain(CHAIN.ready);

    // Survives a reload.
    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    await expect(checkboxFor(page, CHAIN.ready)).toBeChecked();
    await expect(rowFor(page, CHAIN.blocked)).toHaveAttribute('data-zpd-ready', 'true');
  });

  test('unticking releases the dependent again', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
    await checkboxFor(page, CHAIN.completed).uncheck();

    await expect(rowFor(page, CHAIN.completed)).toHaveAttribute('data-zpd-ready', 'true');
    await expect(rowFor(page, CHAIN.ready)).toHaveAttribute('data-zpd-ready', 'false');

    const stored = JSON.parse(await readStorage(page, STORAGE_KEYS.profiles));
    expect(stored[0].completedSkills).not.toContain(CHAIN.completed);
  });

  // The A1-P0 fix (3e11a1a) this suite exists to baseline: without a profile the
  // write has nowhere to go, so the tick is refused rather than silently lost.
  // (The name said "and emits nothing" until UIP-P1, which was about a GA4
  // event that no longer exists. What the refusal must not do is WRITE, and that
  // is what the last assertion has always checked.)
  test('with no profile a tick is refused honestly and writes nothing', async ({ page }) => {
    await gotoApp(page, { state: STATES.empty });

    // .click(), not .check(): check() asserts the box ends up checked, and the
    // whole point of this path is that the app reverts it.
    await checkboxFor(page, CHAIN.ready).click();

    await expect(checkboxFor(page, CHAIN.ready)).not.toBeChecked();
    await expect(page.locator('#createProfileModal')).toHaveCSS('display', 'block');
    expect(await readStorage(page, STORAGE_KEYS.profiles)).toBeNull();
  });

  // THE ONE PATH TO A PROFILE, EXECUTED (L3-P2, FIU-DL-002).
  //
  // Until this packet nothing anywhere drove this form — not off-device, not on
  // a device. `#createProfileModal` is offered from three places (the dropdown,
  // a tick with no child, and since L3-P2 a first launch with an empty store),
  // and what happens after Создать was covered by no executor at all. That was
  // survivable while the transfer offer stood beside it; with the offer removed
  // this IS the path a fresh install takes, so it gets an executor.
  //
  // On this channel because the surface is what is under test: `createProfile`
  // goes through core/repo-local.js here and needs no store, and it is the same
  // shipped handler the native channel runs. The JOURNAL half — `appendChild`
  // against a real SQLCipher store — is `DiaryEntryTest` on
  // `android-instrumented`, and this leg claims nothing about it.
  test('creating a profile from the form leaves the app with a usable one', async ({ page }) => {
    await gotoApp(page, { state: STATES.empty });

    // Reached the way a parent reaches it: the header control, then the item.
    await expect(page.locator('#profileName')).toHaveText('Малыш (выберите дату)');
    await page.locator('#profileButton').click();
    await page.locator('#profileDropdown .create-new').click();
    await expect(page.locator('#createProfileModal')).toHaveCSS('display', 'block');

    await page.locator('#childName').fill('Мила');
    await page.locator('#childBirthdate').fill('2024-09-15');
    await page.locator('#createProfileForm button[type="submit"]').click();

    await expect(page.locator('#createProfileModal')).toHaveCSS('display', 'none');
    await expect(
      page.locator('#profileName'),
      'the profile was created but the app did not switch to it, so the parent is still'
        + ' looking at an app that cannot record anything'
    ).toContainText('Мила');

    // AND NOTHING ELSE OPENED (UIP-P4). Since that packet a created profile
    // continues into the diary's first-entry form — but only where the diary can
    // be written, which this channel cannot: there is no store here at all
    // (`store/bridge.js` is inert in a browser by construction, LSC-P1-INV-001),
    // so a form offered here would take a parent's text about their child and
    // refuse it on save. This assertion is the negative arm of `UIP-P4-INV-001`;
    // the flow's own legs are in `diary-save.spec.js`, behind a store that opens.
    await expect(
      page.locator('#diaryModal'),
      'the first-entry form was offered on a channel whose save is certain to refuse'
    ).toHaveCSS('display', 'none');
    await expect(page.locator('.modal.show')).toHaveCount(0);

    // It is a real profile, not a label: the same tick that was refused above
    // is now recorded, and it survives a reload.
    await checkboxFor(page, CHAIN.ready).click();
    await expect(checkboxFor(page, CHAIN.ready)).toBeChecked();
    await page.reload();
    await expect(page.locator('#profileName')).toContainText('Мила');
    await expect(checkboxFor(page, CHAIN.ready)).toBeChecked();
  });
});

test.describe('reload with seeded localStorage state', () => {
  test('ZPD filter state is restored from storage', async ({ page }) => {
    await gotoApp(page, { state: STATES.seededFiltered });
    await expect(page.locator('#zpdFilterToggleBtn')).toHaveClass(/active/);
    await expect(page.locator('#zpdFilterToggleBtn')).toHaveText('Показать все навыки');
    // Filtered view hides everything that is not ready.
    const visible = page.locator('#tableBody tr[data-skill-id]:not(.hidden)');
    expect(await visible.count()).toBeGreaterThan(0);
    for (const row of await visible.all()) {
      await expect(row).toHaveAttribute('data-zpd-ready', 'true');
    }
  });

  test('toggling the filter round-trips through storage', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
    expect(await readStorage(page, STORAGE_KEYS.filterZpd)).toBeNull();

    await page.locator('#zpdFilterToggleBtn').click();
    expect(await readStorage(page, STORAGE_KEYS.filterZpd)).toBe('true');

    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    await expect(page.locator('#zpdFilterToggleBtn')).toHaveClass(/active/);
  });

  test('profile identity is restored into the header', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
    await expect(page.locator('#profileName')).toContainText(PROFILE.name);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THE INTRO WINDOW OPENS ON ONE CONTROL AND ON NOTHING ELSE (UIP-P3-INV-001).
  //
  // The owner retired the automatic opening on 2026-08-25. Before this packet
  // the window came up by itself on a first run and a close marked it read;
  // now there is no automatic opening in any state, first run included, and the
  // header control is the only way in.
  //
  // WHY THAT CONTROL'S VISIBILITY IS ASSERTED RATHER THAN ASSUMED. Two things
  // live inside that window and nowhere else: the privacy-policy link — one of
  // its exactly two carriers (PDR-035, owner annotation 2026-08-21), the other
  // being the control itself — and the sentence saying the browser copy has no
  // backup. A window that cannot be opened makes both unreachable, so "the
  // control is on screen" is half of this invariant rather than scenery.
  //
  // THE TWO HALVES ARE ARMED SEPARATELY, MEASURED RATHER THAN ARGUED (UIP-P3,
  // both mutations run and reverted on the host, 2026-08-26). The dispositions
  // differ, which is the property that matters — neither mutation produces the
  // other's report:
  //
  //   (A) the intro opens at boot again (`openOnboardingModal()` in app.js's
  //       init) — 6 failed / 1 passed. Everything reds EXCEPT *the control that
  //       opens the intro is offered on a first run*, which is about visibility
  //       and is untouched by it. *…does not open by itself* reds on its own
  //       assertion; the door legs red on a click timeout, because the
  //       auto-opened window is over the control they press — a truthful red
  //       that names the auto-open as the cause.
  //
  //   (B) `#aboutBtn` unwired in surfaces/onboarding.js — 5 failed / 2 passed.
  //       *…does not open by itself* now passes as well, and that difference is
  //       exactly what separates the two mutations: A is the only one that can
  //       falsify it, B is the only one that can falsify *the info control opens
  //       the intro*. The reachability leg stays green under B on purpose — it
  //       asks whether the control is OFFERED, and an unwired control still is;
  //       the leg that asks whether pressing it works is the next one down.
  // ─────────────────────────────────────────────────────────────────────────

  test('the intro does not open by itself on a first run', async ({ page }) => {
    // The state that used to open it: nothing stored at all.
    await gotoApp(page, { state: STATES.firstRun });

    // Anti-vacuity first. "Not shown" is true of a window that is missing, of a
    // selector typo and of a shell that failed to boot, so: the window IS in the
    // document, and the page behind it is really built.
    await expect(page.locator('#onboardingModal')).toHaveCount(1);
    await expect(page.locator('#tableBody tr[data-skill-id]').first()).toBeVisible();

    await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
    await expect(page.locator('#onboardingModal')).toHaveCSS('display', 'none');
  });

  test('the control that opens the intro is offered on a first run', async ({ page }) => {
    // The reachability half, on the state where it matters most: a visitor who
    // has just arrived has never seen the window, so if this control were
    // withheld here the policy document would be unreachable for them.
    await gotoApp(page, { state: STATES.firstRun });
    await expect(page.locator('#aboutBtn')).toBeVisible();
  });

  test('the info control opens the intro, and it is really on screen', async ({ page }) => {
    await gotoApp(page, { state: STATES.firstRun });
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);

    await page.locator('#aboutBtn').click();

    await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
    // Not merely class-toggled: the window is on screen and its text readable.
    await expect(page.locator('#onboardingModal')).toHaveCSS('display', 'flex');
    await expect(page.locator('#onboardingModal h2')).toBeVisible();
  });

  // EACH OF THE THREE DOORS, STILL EXECUTED — and the claim behind them has
  // changed with the mechanism. It used to be "this door records that the
  // window was read", asserted on `onboarding_dismissed`; the key has no reader
  // any more and left `core/storage.js` with the auto-open, so a fixture
  // assertion about it would be about nothing. What each door must do now is
  // simply close the window and leave it closed — including across a reload,
  // which is where the old defect (a ✕ that persisted nothing) actually showed
  // itself.
  //
  // The arm is the same for all three: empty `closeOnboardingModal()`'s body in
  // surfaces/onboarding.js and all three red on the first assertion after the
  // close.
  for (const [door, close] of [
    ['the close button', (page) => page.locator('#onboardingCloseBtn').click()],
    ['the ✕', (page) => page.locator('#onboardingModalClose').click()],
    // The backdrop is the element itself; clicking its centre would land on the
    // content, so the click is aimed at a corner outside the card.
    ['the backdrop', (page) => page.locator('#onboardingModal').click({ position: { x: 5, y: 5 } })],
  ]) {
    test(`the intro closes, and stays closed, when it is closed with ${door}`, async ({ page }) => {
      await gotoApp(page, { state: STATES.firstRun });
      await page.locator('#aboutBtn').click();
      await expect(page.locator('#onboardingModal')).toHaveClass(/show/);

      await close(page);
      await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);

      await page.reload();
      await page.waitForFunction(
        () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
      );
      await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
    });
  }

  // AND IT OPENS AGAIN AFTERWARDS, ANY NUMBER OF TIMES. The window closing for
  // good was the L3-P3 property; what has to hold now is stronger and simpler —
  // the control works on a later launch just as it did on the first, because it
  // is the only path to the policy document there has ever been since the
  // auto-open went.
  test('the control opens the intro again on a later launch', async ({ page }) => {
    await gotoApp(page, { state: STATES.firstRun });
    await page.locator('#aboutBtn').click();
    await page.locator('#onboardingModalClose').click();
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);

    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);

    await expect(page.locator('#aboutBtn')).toBeVisible();
    await page.locator('#aboutBtn').click();
    await expect(page.locator('#onboardingModal')).toHaveClass(/show/);
    await expect(page.locator('#onboardingModal')).toHaveCSS('display', 'flex');
    await expect(page.locator('#onboardingModal h2')).toBeVisible();
  });
});

test.describe('deep link: activity card -> skill modal (modal stack)', () => {
  test('the skill modal stacks over the activities modal and unwinds', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });

    await page.locator('#activitiesBtn').click();
    await expect(page.locator('#activitiesModal')).toHaveClass(/show/);

    const card = page.locator('#activitiesGrid .activity-card-title[data-skill-id]').first();
    await expect(card).toBeVisible();
    const skillId = await card.getAttribute('data-skill-id');

    await card.click();

    // Stacked, not replaced: activities stays open underneath (z-index 120 vs 100).
    await expect(page.locator('#skillModal')).toHaveCSS('display', 'block');
    await expect(page.locator('#activitiesModal')).toHaveClass(/show/);
    await expect(page.locator('#skillModalBody h2')).toHaveAttribute('data-skill-id', skillId);

    // Closing the skill modal reveals the activities modal still open.
    await page.locator('#skillModalClose').click();
    await expect(page.locator('#skillModal')).toHaveCSS('display', 'none');
    await expect(page.locator('#activitiesModal')).toHaveClass(/show/);
  });

  test('graph chips push history and the close glyph walks back', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });

    await page.evaluate(
      ({ app, id }) => app.openSkillModal(app.DATA._skillsMap[id], true, 'parity'),
      { app: await appModule(page), id: CHAIN.blocked }
    );
    await expect(page.locator('#skillModalBody h2')).toHaveAttribute(
      'data-skill-id',
      CHAIN.blocked
    );

    const chip = page.locator('#skillModalBody .prerequisite-skill[data-skill-id]').first();
    const chipId = await chip.getAttribute('data-skill-id');
    await chip.click();
    await expect(page.locator('#skillModalBody h2')).toHaveAttribute('data-skill-id', chipId);

    // History is non-empty, so the glyph is a BACK control, not a close control.
    await page.locator('#skillModalClose').click();
    await expect(page.locator('#skillModalBody h2')).toHaveAttribute(
      'data-skill-id',
      CHAIN.blocked
    );
    await expect(page.locator('#skillModal')).toHaveCSS('display', 'block');

    // History now empty — the same glyph closes.
    await page.locator('#skillModalClose').click();
    await expect(page.locator('#skillModal')).toHaveCSS('display', 'none');
  });
});

test.describe('the .modal.show rule resolves the surfaces the app opens by class', () => {
  // WHY THIS BLOCK EXISTS (EMV-DL-001).
  //
  // `.modal { display: none }` shipped without a `.modal.show` rule, so
  // `openExportModal()` ran to completion — status cleared, availability
  // computed, button hidden, class added — and the parent saw nothing. Every
  // guard over this surface was green throughout, because every one of them
  // read source text. The property none of them could see is the one a parent
  // experiences.
  //
  // WHERE THE CLICKING HALF WENT (DIA-P2). Until this packet the first test
  // here clicked #exportBtn on the web channel. That control is now offered on
  // the NATIVE channel only — in a browser the archive cannot be produced at
  // all — so the click-and-read-computed-style claim moved to
  // app/tests/channel-composition.spec.js, which simulates the native branch
  // before boot and presses the control where it exists. It did not weaken: it
  // is the same click on the same element with the same two assertions.
  //
  // CHANNEL BOUNDARY. This runs in `behavior` (nginx channel) and in `native`
  // (the staged APK web root). Neither injects a Capacitor bridge, so BOTH take
  // the WEB branch of every runtime probe in the shell.

  // THE CLAIM HERE IS NARROW, AND IS WORDED TO MATCH.
  //
  // These are the bare-.modal elements opened by classList.add('show'), and one
  // rule covers all of them. No trigger is reachable on the web branch:
  // #exportBtn is not revealed off the native channel (DIA-P2), and
  // showStoreUnavailable() sits behind canRecord() === false, which the web
  // channel never reaches (core/state.js puts it on the localStorage backend).
  // #importModal left this list at L3-P2 by leaving the product: the transfer
  // offer and its surface were removed outright (FIU-DL-002).
  //
  // So what is asserted is that THE RULE RESOLVES TO display: block FOR THESE
  // ELEMENTS — a real property of the shipped stylesheet, executed by a real
  // browser against the real element. It is NOT a claim that any of the three
  // becomes visible in use: the handler paths are not exercised here and would
  // not red if they broke. Those belong to android-instrumented and remain
  // residual debt (LSC-DL-005 debt 13).
  // DIA-P3 adds #diaryModal to the same list, on the same terms: its trigger
  // (#diaryBtn) is revealed on the native channel only, so what is asserted here
  // is the RULE resolving for it and nothing about the diary being reachable.
  // That the control appears where it should, and that the surface refuses
  // honestly when the store does, is app/tests/diary-surface.spec.js.
  for (const id of ['storeUnavailableModal', 'exportModal', 'diaryModal']) {
    test(`the .modal.show rule resolves #${id} to display: block`, async ({ page }) => {
      await gotoApp(page, { state: STATES.seeded });

      await expect(page.locator(`#${id}`)).toHaveCSS('display', 'none');
      await page.evaluate((el) => document.getElementById(el).classList.add('show'), id);
      await expect(page.locator(`#${id}`)).toHaveCSS('display', 'block');
      await page.evaluate((el) => document.getElementById(el).classList.remove('show'), id);
      await expect(page.locator(`#${id}`)).toHaveCSS('display', 'none');
    });
  }
});

test.describe('service worker: registration, offline boot, update flow', () => {
  // NOT RUN under the Capacitor profile, and the reason is a finding rather
  // than a convenience (L1-P1, LSC-DL-001).
  //
  // In the APK the shell is read from local assets, so /sw.js is never
  // re-fetched from a network origin: a bumped CACHE_VERSION can never be
  // discovered, the waiting worker can never appear, and #updateBanner can
  // never fire. The whole update channel these three tests describe is INERT
  // there — the only update path is APK replacement. Running them under
  // 'capacitor' would assert web-channel behaviour against a channel that does
  // not have it, and a green result would be meaningless in both directions.
  //
  // The consequence that is NOT inert — a registered worker turning Cache
  // Storage into a second, stale copy of the shell inside WebView storage — is
  // knowingly uncovered here and is L1-P2's to dispose of (see the Scope of
  // LSC-P1-INV-001). What this packet does assert is the weaker, checkable
  // thing: the app BOOTS without depending on the service worker at all, which
  // the native project proves by running every other flow in this file.
  test.skip(
    ({ parityProfile }) => parityProfile === 'capacitor',
    'the service-worker update channel is inert in the Capacitor shell — see LSC-DL-001'
  );

  test('registers and reaches activated', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active && reg.active.state;
    });
    expect(state).toBe('activated');
  });

  // Cutting the network necessarily produces "Failed to load resource" console
  // errors for the requests the SW then serves from cache. That noise is the
  // expected shape of this test, so the guard is relaxed here and only here —
  // the assertions below still prove the shell rebuilt completely.
  test.describe('offline', () => {
    test.use({ allowConsoleErrors: true });

    test('boots offline from the precache', async ({ page, context }) => {
      await gotoApp(page, { state: STATES.seeded });
      await page.evaluate(() => navigator.serviceWorker.ready);
      // Let the precache (OFFLINE_URLS) settle before cutting the network.
      //
      // expect.poll, NOT page.waitForFunction, and the difference is a
      // measurement rather than a style preference (EMV-DL-003 side-find,
      // retired in EMV-DL-004). waitForFunction given an ASYNC predicate
      // resolves on the FIRST call whatever the predicate computes — the
      // predicate returns a Promise, and a Promise is truthy. Measured with a
      // predicate that sleeps 1.5 s and then returns false: it resolved after
      // one iteration instead of timing out. This wait therefore did not wait,
      // and passed only because the precache settles quickly on this host —
      // a property of the timing, not of the arrangement, which is exactly the
      // class of green AGENTS.md §11 exists against. expect.poll awaits the
      // value it polls, so the pin below cannot race the precache; re-measured
      // with the same sleeping-false predicate, it now times out as it should.
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const keys = await caches.keys();
              if (!keys.length) return false;
              const cache = await caches.open(keys[0]);
              return (await cache.match('/kb-v1.json')) !== undefined;
            }),
          {
            message: 'the precache never settled: /kb-v1.json is in no cache generation',
            timeout: 30_000,
          }
        )
        .toBe(true);

      await context.setOffline(true);
      await page.reload();

      // The shell rebuilds entirely from cache: navigation falls back to '/',
      // and the kb resolves from the precache.
      await page.waitForFunction(
        () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
      );
      await expect(page.locator('#tableBody tr[data-skill-id]')).toHaveCount(174);
      await expect(page.locator('#profileName')).toContainText(PROFILE.name);

      await context.setOffline(false);
    });
  });

  test('a new worker surfaces the update banner and applies on accept', async ({
    page,
    context,
    baseURL,
  }) => {
    await gotoApp(page, { state: STATES.seeded });
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Ask the parity server for a CACHE_VERSION-mutated /sw.js on this context
    // only. app/sw.js on disk is untouched; its CACHE_VERSION is unaffected.
    await context.addCookies([
      { name: SW_BUMP_COOKIE, value: '1', url: baseURL },
    ]);

    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });

    // sw.js ships without skipWaiting(), so the new worker parks in `waiting`
    // and the page must offer the choice.
    await expect(page.locator('#updateBanner')).toHaveClass(/visible/, { timeout: 30_000 });

    const waitingVersion = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg.waiting ? 'waiting' : null;
    });
    expect(waitingVersion).toBe('waiting');

    // Accepting posts SKIP_WAITING; controllerchange then reloads the page.
    await Promise.all([page.waitForEvent('load'), page.locator('#updateReloadBtn').click()]);

    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    const activeCache = await page.evaluate(async () => (await caches.keys()).sort());
    expect(activeCache).toContain(`theygrow-${SW_TEST_VERSION}`);
  });

  test('dismissing the update banner does not reload', async ({ page, context, baseURL }) => {
    await gotoApp(page, { state: STATES.seeded });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.addCookies([{ name: SW_BUMP_COOKIE, value: '1', url: baseURL }]);
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });
    await expect(page.locator('#updateBanner')).toHaveClass(/visible/, { timeout: 30_000 });

    await page.evaluate(() => {
      window.__parityMarker = 'still-here';
    });
    await page.locator('#updateDismiss').click();
    await expect(page.locator('#updateBanner')).not.toHaveClass(/visible/);
    // No reload happened, so the marker survives.
    expect(await page.evaluate(() => window.__parityMarker)).toBe('still-here');
  });
});

test.describe('kb-load error path', () => {
  test.use({ allowConsoleErrors: true });

  test('a failed kb fetch degrades honestly instead of rendering an empty app', async ({
    page,
  }) => {
    await page.route('**/kb-v1.json', (route) => route.abort());
    await gotoApp(page, { state: STATES.seeded, waitForTable: false });

    // showKbLoadError appends a fixed overlay with no id or class hook, so the
    // assertion is on the copy the user actually sees.
    await expect(page.getByText('Не удалось загрузить данные')).toBeVisible();
    await expect(
      page.getByText('Проверьте подключение к интернету и попробуйте ещё раз.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Перезагрузить' })).toBeVisible();

    // init() never ran, so the table stayed empty rather than half-built.
    await expect(page.locator('#tableBody tr[data-skill-id]')).toHaveCount(0);
  });
});

test.describe('nothing that ships hidden renders (FIU-P3-INV-001)', () => {
  // THE GUARD DIA-DL-008 DESIGNED AND DID NOT BUILD, built here to that design.
  //
  // WHY IT EXISTS. `display` in a class rule outranks the `display: none` the
  // browser's user-agent stylesheet gives the `hidden` attribute, so an element
  // can ship `hidden=""` and render anyway. That has bitten twice in this
  // repository: `.header-action` at DIA-P2 (both channel actions rendered in the
  // browser, including a download link for a release that did not exist) and
  // `.diary-search` at DIA-P4 (a search form offered in an empty diary). Both
  // times the defect was caught by a NEW test on its first run — that is, by
  // luck of scheduling rather than by a guard, and only for the one element that
  // test happened to look at.
  //
  // WHY IT IS THIS SHAPE AND NOT A STYLESHEET SCAN. It executes the real cascade
  // in a real page instead of reading CSS and reasoning about specificity, which
  // is the difference AGENTS.md §11 item 4 was written about. It also needs no
  // list: it asks the document which elements are hidden RIGHT NOW, so a surface
  // added in a later packet is covered the day it lands rather than the day
  // someone remembers to add it here.
  //
  // WHY BOOT IS ENOUGH, and no modal is opened. Computed `display` is not
  // affected by an ancestor being `display: none` — it is the element's own
  // computed value — so a control inside a closed window is answered here just
  // as truthfully as one in the header. What boot does NOT reach is an element
  // that only becomes `hidden` later; that is why the sweep is anchored on the
  // live document rather than on the shell's markup.
  //
  // TWO COMPOSITIONS FOR FREE. This file runs in `behavior` (web branch,
  // desktop) and in `native` (Capacitor asset root, mobile). The hidden SET
  // differs between them — the web branch hides the archive, the diary and,
  // since NAV-P1, the header menu; the native branch hides the download offer
  // and the header's own about control, whose entry moved into that menu — so
  // both channel compositions are swept, at both viewports, by the same eight
  // lines. The web composition is nineteen elements, measured at NAV-P1: the
  // menu joined it and nothing left it.
  //
  // SOUNDNESS, MEASURED. Deleting `.header-action[hidden] { display: none }`
  // from the mount's app.css reds this with exactly two violations,
  // `exportBtn -> flex` and `diaryBtn -> flex`, at 1280x800 and at 412x760.
  test('every element carrying [hidden] computes to display: none', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });

    const hidden = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[hidden]')).map((el) => ({
        id: el.id || '(no id)',
        classes: (el.className && el.className.toString()) || '(no class)',
        display: getComputedStyle(el).display,
      }))
    );

    // Anti-vacuity. A selector that matched nothing would make the assertion
    // below vacuously green, which is the failure mode this milestone keeps
    // paying for. The shell carries nineteen `hidden` elements today; the floor
    // is set well under that so an honest deletion does not red it, and the
    // second assertion pins the class the defect actually landed on twice.
    expect(hidden.length, 'the [hidden] sweep found almost nothing — it is not looking at the app').toBeGreaterThanOrEqual(12);
    expect(
      hidden.some((el) => /(^|\s)header-action(\s|$)/.test(el.classes)),
      'no hidden .header-action in this composition — the class both known instances of this defect landed on is not being swept'
    ).toBe(true);

    const rendered = hidden.filter((el) => el.display !== 'none');
    expect(
      rendered,
      'these elements ship hidden and render anyway — a class rule is beating the hidden attribute, and the parent is being offered something the channel does not do. Give each of them its own `<selector>[hidden] { display: none }` line'
    ).toEqual([]);
  });
});

// THE FOOTER, AFTER THE «Cookie» CONTROL LEFT IT (UIP-P1).
//
// EXECUTED, NOT READ, AND THE REASON IS THAT THE DEFECT WAS INVISIBLE IN THE
// CSS. `#activitiesBtn { margin-left: auto }` has held the footer's right edge
// since L1-P3 and was never touched; PPR-P2 added `.footer-legal-btn` with a
// SECOND `margin-left: auto`, and flexbox distributes free space equally among
// auto margins. Both rules read correctly on their own — nothing in either file
// says "these two now share the gap" — and «Подходящие активности» quietly
// stopped reaching the edge. A source scan cannot see that; a laid-out box can.
//
// This is also why no positional rule was reintroduced when the control was
// removed: `footer button:nth-child(3)` would re-arm the same trap for the next
// button added (LSC-DL-003 (s)), and it is not needed — deleting the second auto
// margin returns the free space to the first.
test.describe('the footer carries two controls and the second reaches the right edge', () => {
  test('the control footer holds exactly the two filter buttons', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });

    const ids = await page.evaluate(() =>
      Array.from(document.querySelector('footer.control-footer').children).map((el) => el.id)
    );
    expect(
      ids,
      'the footer composition changed — a third control is back, or one of the two is gone'
    ).toEqual(['zpdFilterToggleBtn', 'activitiesBtn']);
  });

  test('«Подходящие активности» sits at the footer content edge, measured', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });

    const geometry = await page.evaluate(() => {
      const footer = document.querySelector('footer.control-footer');
      const btn = document.getElementById('activitiesBtn');
      const f = footer.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const padRight = parseFloat(getComputedStyle(footer).paddingRight);
      return { contentRight: f.right - padRight, buttonRight: b.right, buttonWidth: b.width };
    });

    // Anti-vacuity: a button of zero width sitting anywhere would satisfy a
    // naive edge comparison, and a footer that failed to lay out would give both
    // rectangles the same collapsed origin.
    expect(geometry.buttonWidth, 'the activities button has no width — nothing was laid out').toBeGreaterThan(40);

    expect(
      Math.abs(geometry.buttonRight - geometry.contentRight),
      `«Подходящие активности» is ${(geometry.contentRight - geometry.buttonRight).toFixed(1)} px`
        + ' short of the footer content edge — a second auto margin is splitting the free space'
        + ' again, which is exactly what the «Cookie» control did'
    ).toBeLessThanOrEqual(1);
  });
});
