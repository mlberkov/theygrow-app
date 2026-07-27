'use strict';

// Level (a) — DOM-snapshot parity (ADR-037 §3a).
//
// Automates the method VDK-P3 ran by hand (docs/decision-log.md:617):
// per-section comparison over table head/body, all 174 skill-modal bodies,
// the activities grid, and the deep-link result. Three artifact kinds, chosen
// by size so failures stay readable:
//
//   *.html   normalized markup   — small containers; human-diffable
//   *.json   structural digest   — #tableBody; a regression names itself
//   *.sha256 full-fidelity hash  — the long tail nothing else would catch
//
// Runs at two viewports (dom-desktop / dom-mobile) because the mobile accordion
// is a separate code path gated at innerWidth <= 767.

const { test, expect, STATES, CHAIN } = require('./support/seed');
const { gotoApp } = require('./support/seed');
const { captureHtml, captureHash } = require('./support/normalize');
const { captureTableDigest, captureAllSkillModalBodies } = require('./support/digest');

test.describe('DOM parity — booted with a seeded profile', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
  });

  test('the KB renders the expected shape', async ({ page }) => {
    // Cheap structural guard: if the artifact or the adapter changes, this
    // fails with a number instead of an opaque hash mismatch.
    await expect(page.locator('#tableBody tr[data-skill-id]')).toHaveCount(174);
    await expect(page.locator('#tableBody tr.category-row')).toHaveCount(6);
    await expect(page.locator('#tableHead th[data-month]')).toHaveCount(73);
  });

  test('header markup', async ({ page }) => {
    expect(await captureHtml(page, 'header')).toMatchSnapshot('header.html');
  });

  test('control footer markup', async ({ page }) => {
    expect(await captureHtml(page, 'footer.control-footer')).toMatchSnapshot('control-footer.html');
  });

  test('table head markup', async ({ page }) => {
    expect(await captureHtml(page, '#tableHead')).toMatchSnapshot('table-head.html');
  });

  test('table body structural digest', async ({ page }) => {
    expect(await captureTableDigest(page)).toMatchSnapshot('table-body.json');
  });

  test('table body full-fidelity hash', async ({ page }) => {
    expect(await captureHash(page, '#tableBody')).toMatchSnapshot('table-body.sha256.txt');
  });

  test('zpd empty state markup', async ({ page }) => {
    expect(await captureHtml(page, '#zpdEmptyState')).toMatchSnapshot('zpd-empty-state.html');
  });
});

test.describe('DOM parity — modals', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
  });

  test('create-profile modal markup', async ({ page }) => {
    await page.evaluate(() => openCreateProfileModal());
    expect(await captureHtml(page, '#createProfileModal')).toMatchSnapshot(
      'modal-create-profile.html'
    );
  });

  test('skill modal markup', async ({ page }) => {
    await page.evaluate((id) => openSkillModal(DATA._skillsMap[id], false, 'parity'), CHAIN.ready);
    expect(await captureHtml(page, '#skillModal')).toMatchSnapshot('modal-skill.html');
  });

  test('activities modal markup', async ({ page }) => {
    await page.evaluate(() => openActivitiesModal());
    expect(await captureHtml(page, '#activitiesModal')).toMatchSnapshot('modal-activities.html');
  });

  test('onboarding modal markup', async ({ page }) => {
    await page.evaluate(() => openOnboardingModal());
    expect(await captureHtml(page, '#onboardingModal')).toMatchSnapshot('modal-onboarding.html');
  });
});

test.describe('DOM parity — ZPD filter active', () => {
  test('table body structural digest with the filter on', async ({ page }) => {
    await gotoApp(page, { state: STATES.seededFiltered });
    // Restored from localStorage during init(); confirm before capturing.
    await expect(page.locator('#zpdFilterToggleBtn')).toHaveClass(/active/);
    expect(await captureTableDigest(page)).toMatchSnapshot('table-body-filtered.json');
  });

  test('table body structural digest with no profile', async ({ page }) => {
    await gotoApp(page, { state: STATES.empty });
    expect(await captureTableDigest(page)).toMatchSnapshot('table-body-no-profile.json');
  });
});

test.describe('DOM parity — every skill modal body', () => {
  test('all 174 skill-modal bodies hash as expected', async ({ page }, testInfo) => {
    // Modal body markup does not depend on viewport, so capture it once.
    // Running 174 modals twice would double the cost and duplicate the baseline.
    test.skip(
      testInfo.project.name !== 'dom-desktop',
      'viewport-independent; captured in dom-desktop only'
    );
    test.setTimeout(120_000);
    await gotoApp(page, { state: STATES.seeded });
    expect(await captureAllSkillModalBodies(page)).toMatchSnapshot('skill-modal-bodies.sha256.txt');
  });
});
