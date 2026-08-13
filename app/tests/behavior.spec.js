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
  gaEvents,
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

    // The action actually happened, so it is reported.
    const events = await gaEvents(page);
    expect(
      events.filter((e) => e.name === 'skill_complete' && e.params.skill_id === CHAIN.ready)
    ).toHaveLength(1);

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
  test('with no profile a tick is refused honestly and emits nothing', async ({ page }) => {
    await gotoApp(page, { state: STATES.empty });

    // .click(), not .check(): check() asserts the box ends up checked, and the
    // whole point of this path is that the app reverts it.
    await checkboxFor(page, CHAIN.ready).click();

    await expect(checkboxFor(page, CHAIN.ready)).not.toBeChecked();
    await expect(page.locator('#createProfileModal')).toHaveCSS('display', 'block');
    expect(await readStorage(page, STORAGE_KEYS.profiles)).toBeNull();

    const events = await gaEvents(page);
    expect(events.filter((e) => e.name === 'skill_complete')).toHaveLength(0);
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

  test('onboarding shows on first run and stays dismissed afterwards', async ({ page }) => {
    await gotoApp(page, { state: STATES.firstRun });
    await expect(page.locator('#onboardingModal')).toHaveClass(/show/);

    await page.locator('#onboardingDismissCheckbox').check();
    await page.locator('#onboardingCloseBtn').click();
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
    expect(await readStorage(page, STORAGE_KEYS.onboardingDismissed)).toBe('true');

    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/show/);
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

    const events = await gaEvents(page);
    expect(
      events.filter((e) => e.name === 'activity_skill_open' && e.params.skill_id === skillId)
    ).toHaveLength(1);

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
      // Give the precache (OFFLINE_URLS) time to settle before cutting the network.
      await page.waitForFunction(async () => {
        const keys = await caches.keys();
        if (!keys.length) return false;
        const cache = await caches.open(keys[0]);
        return (await cache.match('/kb-v1.json')) !== undefined;
      });

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
