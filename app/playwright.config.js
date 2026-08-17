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
      // EMV-P1 adds one more: the show-rule coverage guard, which reads the
      // shipped mount's CSS and modules and drives no browser. Its runtime
      // twin — the click that proves the export modal is actually visible —
      // lives in behavior.spec.js, deliberately not here.
      // XPT-P1 adds one more off-device unit run: the export sink's transfer,
      // driven against a fake Capacitor. It is here rather than beside the
      // instrumented tests because "the chunks reassemble to the bytes that left"
      // is cheap enough to check on every push, and because the claims that need
      // a device — saved instance state, the binder limit — are deliberately NOT
      // made there.
      // DIA-P1 adds one more: the mount-reference guard, the app-side twin of
      // EMV-P5-INV-001. It reads the tree and boots nothing, which is what it
      // says about itself — a reference left at the frozen generation resolves
      // rather than 404s, so nothing else in this suite would ever notice it.
      // DIA-P1 checkpoint B adds two: handoff-source (leg (a) of the band
      // invariant — the handoff page imports no writer and calls none) and
      // transfer-format (the transitional envelope, imported under Node the same
      // way store-unit imports the store). Leg (b) of that invariant is NOT
      // here: it presses the button in a real browser and belongs in `behavior`.
      // DIA-P3 adds one: diary-write, the record path's control flow against the
      // recorder — one transaction for the area and its first entry, an edit
      // that is an UPDATE, a full disk classified rather than swallowed. What
      // those statements MEAN is `pytest app/tests/schema`
      // (test_diary_write_path.py) and whether a parent's entry actually lands
      // is `android-instrumented`; neither claim is made here, and the file's
      // header says so about itself.
      // DIA-P3R adds one: undeclared-reference, a source scan over the shipped
      // mount for the one shape that cost this milestone a packet — a SPREAD of
      // an identifier the module never declares. It is deliberately narrow and
      // says so about itself: general no-undef needs a scope-accurate parser,
      // this repository carries no eslint on purpose, and the class it belongs
      // to is bought by diary-save.spec.js in `behavior`, which EXECUTES the
      // path rather than reading it.
      testMatch: /(delivery-contract|storage-seam|native-shell|merge-semantics|store-supply-chain|store-unit|store-seam|export-contour|export-sink-unit|write-path|import-legacy|diary-write|signal-payload|show-rule-coverage|mount-reference|handoff-source|transfer-format|transfer-seam|transfer-drain-unit|undeclared-reference|embedded-js-parse)\.spec\.js/,
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
      // EMV-P3 adds upgrade-path.spec.js here and NOT to `native` below: it
      // stages the previously published generation, installs its service worker
      // and drives the update path, all of which are inert in the Capacitor
      // shell — /sw.js is never re-fetched there, so no waiting worker and no
      // banner can ever appear (LSC-DL-001). Running it under that profile would
      // assert web-channel delivery against a channel that has none.
      name: 'behavior',
      // DIA-P1 adds mount-derivation: the executing half of DIA-P1-INV-003. It
      // is here rather than in `contract` because its whole subject is what the
      // shipped config modules COMPUTE when a browser evaluates them at a real
      // origin — a claim no source scan can carry (AGENTS.md §11).
      // DIA-P1 checkpoint B adds handoff-transfer: leg (b) of the band
      // invariant, which seeds a real source, presses the button and compares
      // the whole of localStorage before and after. It is deliberately NOT in
      // the `native` project below — the handoff page runs in the parent's
      // BROWSER at the production origin, never inside the Capacitor WebView,
      // and running it there would assert a web-channel surface against a
      // channel that never serves it.
      //
      // DIA-P2 adds channel-composition: what each delivery channel OFFERS,
      // read off a rendered page rather than out of the markup. It is in this
      // project and not in `native` below for the reason its own header gives —
      // it simulates the native branch with an init script, and running it
      // under a profile that also serves a different web root would confuse two
      // independent variables.
      // DIA-P3 adds diary-surface: which channel offers the diary, that the
      // window actually opens, and — the claim it exists for — that a refused
      // entry leaves the parent's text in the field. It is here and not in
      // `contract` because every one of those is a fact about a rendered page
      // and a handler that ran. The disk-full refusal is deliberately NOT among
      // them: reaching it needs a store that opens, and that is
      // DiaryEntryTest on android-instrumented.
      // DIA-P3R adds diary-save: the diary's SUCCESS path, which until run
      // 31971968427 had no executor anywhere off-device. diary-surface reaches
      // the surface with no store behind it, so every leg there ends in a
      // refusal before the store is ever called — and a bare ReferenceError on
      // the line that calls it went unseen through 1104 green tests. This one
      // installs a seam at the BRIDGE boundary that resolves, so the whole
      // shipped chain executes. It is here rather than in `contract` for the
      // same reason diary-surface is: it is a fact about a rendered page and a
      // handler that ran. It is NOT in `native` below, on the argument that
      // file's placement already records for channel-composition — that project
      // serves a different web root, and a leg that also simulates the shell
      // would vary two things at once. What it does NOT claim is anything about
      // SQLite, and its own header says so.
      testMatch: /(behavior|upgrade-path|mount-derivation|handoff-transfer|channel-composition|diary-surface|diary-save|diary-search)\.spec\.js/,
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
      // mount-derivation runs on BOTH channels on purpose (DIA-P1): the values
      // it checks are derived from the origin the modules are loaded from, so
      // the staged Capacitor web root and the nginx mirror are two executions of
      // the property rather than one repeated.
      testMatch: /(dom-parity|behavior|mount-derivation)\.spec\.js/,
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
