'use strict';

// Parity suite config (A1-P1). Dev/CI only — no part of this reaches production.
//
// Two pins carry the whole suite:
//   1. TIME. app/index.html calculateAge/calculateAgeInMonths read new Date(),
//      so the current-month column, ZPD readiness and the activities ranking
//      all drift daily. Every test installs a fixed clock (tests/support/seed.js).
//   2. PLATFORM. setFixedSkillColumnWidth measures text and writes
//      --skill-col-width, so layout is font-metric dependent. Screenshots are
//      only valid inside the pinned Playwright container — see scripts/parity-suite.sh.
//      The @playwright/test version in package.json and the container tag must
//      match exactly (1.61.1); Playwright refuses to run on a mismatch.
//
// Baselines are NEVER written implicitly: updateSnapshots is 'none', so a missing
// or changed baseline FAILS. The only way to write one is
// `scripts/parity-suite.sh --update-snapshots`.

const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.PARITY_PORT || 8080);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const DESKTOP = { width: 1280, height: 800 };
// Matches the viewport A0 verified on; the mobile accordion is a separate code
// path gated at window.innerWidth <= 767 (app/index.html initMobileAccordion).
const MOBILE = { width: 412, height: 760 };

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A parity gate must be deterministic. Retries would let a flaky assertion
  // pass on the second attempt and hide exactly the instability we care about.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/__baselines__/{projectName}/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Strict by default. If the pinned container ever proves it needs a
      // floor, raise it HERE (one documented place), never per-test.
      maxDiffPixels: 0,
    },
  },

  use: {
    baseURL: BASE_URL,
    deviceScaleFactor: 1,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    locale: 'ru-RU',
    timezoneId: 'UTC',
  },

  webServer: {
    command: 'node tests/server.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
    stdout: 'ignore',
    stderr: 'pipe',
  },

  projects: [
    {
      name: 'contract',
      testMatch: /delivery-contract\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    {
      name: 'dom-desktop',
      testMatch: /dom-parity\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    {
      name: 'dom-mobile',
      testMatch: /dom-parity\.spec\.js/,
      use: { viewport: MOBILE },
    },
    {
      name: 'behavior',
      testMatch: /behavior\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    {
      name: 'visual-desktop',
      testMatch: /visual\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    {
      name: 'visual-mobile',
      testMatch: /visual\.spec\.js/,
      use: { viewport: MOBILE },
    },
  ],
});
