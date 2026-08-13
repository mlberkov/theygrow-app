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

const path = require('path');

const PORT = Number(process.env.PARITY_PORT || 8080);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Second origin for the Capacitor channel (L1-P1). It serves the STAGED APK web
// root (native/www/, assembled from app/Dockerfile's COPY list) under a
// Capacitor-shaped delivery profile: no nginx cache/MIME headers, no
// try_files SPA fallback, no /api. Two servers rather than one because the two
// channels differ in exactly those delivery semantics — a single server could
// only prove one of them.
const NATIVE_PORT = PORT + 1;
const NATIVE_BASE_URL = `http://127.0.0.1:${NATIVE_PORT}`;
const NATIVE_WEB_ROOT = path.resolve(__dirname, '..', 'native', 'www');

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

  webServer: [
    {
      command: 'node tests/server.js',
      url: `${BASE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(PORT) },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node tests/server.js',
      url: `${NATIVE_BASE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(NATIVE_PORT),
        PARITY_PROFILE: 'capacitor',
        PARITY_WEB_ROOT: NATIVE_WEB_ROOT,
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],

  projects: [
    {
      name: 'contract',
      // Static-source guards and off-device unit runs share this project: they
      // read files or exercise pure functions rather than drive a browser, so
      // they cost nothing to run together. L1-P2 adds three — the CRDT
      // merge-semantics run, the store supply-chain guard, and the store's own
      // unit tests, which import the SHIPPED modules directly under Node. L1-P3
      // adds the export contour's guards; the artifact's own format is proven in
      // `pytest app/tests/export`, which builds it with the shipped builder and
      // reads it back blind. L1-P4 adds three more: the write path's shape, the
      // legacy import's four properties, and the signal-payload guard. Those
      // first two drive a recorder rather than a database — what the SQL MEANS
      // is `pytest app/tests/schema`, against the real frozen DDL.
      testMatch: /(delivery-contract|storage-seam|native-shell|merge-semantics|store-supply-chain|store-unit|export-contour|write-path|import-legacy|signal-payload)\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    {
      name: 'dom-desktop',
      testMatch: /dom-parity\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    {
      // L1-P3 adds footer-height.spec.js here and nowhere else: the footer's
      // height pin is a MOBILE constraint (the desktop footer never wrapped),
      // so this is the only viewport where the assertion means anything.
      name: 'dom-mobile',
      testMatch: /(dom-parity|footer-height)\.spec\.js/,
      use: { viewport: MOBILE },
    },
    {
      name: 'behavior',
      testMatch: /behavior\.spec\.js/,
      use: { viewport: DESKTOP },
    },
    // The Capacitor channel (L1-P1). Same specs, same committed baselines,
    // different delivery surface.
    //
    // It asserts the dom-mobile baselines rather than a set of its own: the two
    // channels ship byte-identical assets (LSC-P1-INV-002), so a second
    // baseline set would be a second thing to re-bless and would prove nothing
    // the hashes do not already prove. Pointing this project at the SAME bytes
    // is what makes a channel divergence visible — if the APK's asset set ever
    // renders differently, it reds against the web channel's own record.
    //
    // Mobile viewport, not desktop: the shipping target is an Android phone,
    // and the mobile accordion is a separate code path (innerWidth <= 767).
    //
    // behavior.spec.js runs here too, minus the service-worker block it skips
    // under this profile for the reason stated in that file.
    {
      name: 'native',
      testMatch: /(dom-parity|behavior)\.spec\.js/,
      snapshotPathTemplate: '{testDir}/__baselines__/dom-mobile/{arg}{ext}',
      use: {
        viewport: MOBILE,
        baseURL: NATIVE_BASE_URL,
        parityProfile: 'capacitor',
      },
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
