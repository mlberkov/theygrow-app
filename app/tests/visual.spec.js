'use strict';

// Level (b) — visual regression (ADR-037 §3b).
//
// PLATFORM PIN. setFixedSkillColumnWidth (app/index.html:2873) measures text and
// writes --skill-col-width, so layout is font-metric dependent. These baselines
// are only valid inside the pinned Playwright container
// (mcr.microsoft.com/playwright:v1.61.1-noble). Run them via
// scripts/parity-suite.sh, which uses that container locally and in CI alike;
// a bare `npx playwright test` on a host with different fonts will legitimately
// differ.
//
// Baselines are never written implicitly — playwright.config.js sets
// updateSnapshots: 'none', so a missing baseline fails. Use
// `scripts/parity-suite.sh --update-snapshots`.

const { test, expect, gotoApp, STATES, CHAIN } = require('./support/seed');

test.describe('visual — app shell', () => {
  test('booted with a seeded profile', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
    await expect(page).toHaveScreenshot('shell-seeded.png');
  });

  test('booted with no profile', async ({ page }) => {
    await gotoApp(page, { state: STATES.empty });
    await expect(page).toHaveScreenshot('shell-no-profile.png');
  });

  test('ZPD filter active', async ({ page }) => {
    await gotoApp(page, { state: STATES.seededFiltered });
    await expect(page.locator('#zpdFilterToggleBtn')).toHaveClass(/active/);
    await expect(page).toHaveScreenshot('shell-zpd-filtered.png');
  });
});

test.describe('visual — key containers', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
  });

  test('header', async ({ page }) => {
    await expect(page.locator('header')).toHaveScreenshot('header.png');
  });

  test('control footer', async ({ page }) => {
    await expect(page.locator('footer.control-footer')).toHaveScreenshot('control-footer.png');
  });
});

test.describe('visual — modals', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
  });

  test('create-profile modal', async ({ page }) => {
    await page.evaluate(() => openCreateProfileModal());
    await expect(page.locator('#createProfileModal')).toHaveScreenshot('modal-create-profile.png');
  });

  test('skill modal', async ({ page }) => {
    await page.evaluate((id) => openSkillModal(DATA._skillsMap[id], false, 'parity'), CHAIN.ready);
    await expect(page.locator('#skillModal')).toHaveScreenshot('modal-skill.png');
  });

  test('activities modal', async ({ page }) => {
    await page.evaluate(() => openActivitiesModal());
    await expect(page.locator('#activitiesModal')).toHaveScreenshot('modal-activities.png');
  });

  test('onboarding modal', async ({ page }) => {
    await page.evaluate(() => openOnboardingModal());
    await expect(page.locator('#onboardingModal')).toHaveScreenshot('modal-onboarding.png');
  });
});

test.describe('visual — honest empty state', () => {
  test('ZPD empty state when the filter matches nothing', async ({ page }) => {
    // Complete every skill so nothing is left ready, then filter.
    await gotoApp(page, { state: STATES.seeded });
    await page.evaluate(() => {
      const all = Object.keys(DATA._skillsMap);
      const profile = profiles.find((p) => p.id === currentProfileId);
      profile.completedSkills = all;
      saveProfiles();
    });
    await page.reload();
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    await page.locator('#zpdFilterToggleBtn').click();

    await expect(page.locator('#zpdEmptyState')).toBeVisible();
    await expect(page).toHaveScreenshot('shell-zpd-empty-state.png');
  });
});
