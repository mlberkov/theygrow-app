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
      // DIA-P1 checkpoint B added two — handoff-source and transfer-format — and
      // transfer-seam and transfer-drain-unit joined them. PPR-P2 removes all
      // four with the mechanism they were about: the browser-to-native transfer
      // is retired, not dormant, and a spec adapted to assert the hole where a
      // mechanism used to be is a spec that passes for a reason other than the
      // one it names. The one property they carried that was NOT about the
      // transfer — a separately-shipped page must not overwrite the app shell's
      // offline copy — has a second executor since PPR-P1 and survives there,
      // in privacy-surface.spec.js.
      // DIA-P3 adds one: diary-write, the record path's control flow against the
      // recorder — one transaction for the area and its first entry, an edit
      // that is an UPDATE, a full disk classified rather than swallowed. What
      // PPR-P2 added consent-gate, and UIP-P1 replaced it with two files. The
      // consent half has no object: analytics left the web showcase entirely
      // (vault ADR-043 annotation 2026-08-25), so the gate, the banner and the
      // stored answer are gone rather than switched off. What is left of that
      // file is download-offer, the platform probe behind the APK control —
      // never a consent subject, still enforcing PPR-P2-INV-002, renamed because
      // docs/INVARIANTS.md names its path and a file named for a retired subject
      // misleads the next reader. And analytics-absence takes the place the
      // consent legs held: an ABSENCE guard, over the shipped mount tree and the
      // shell, that no analytics origin, loader, measurement id or event
      // vocabulary is anywhere in what ships. It is here rather than in
      // `behavior` because an absence is a property of the tree, which is the
      // admissible static kind (AGENTS.md §11). Its executing twin — that a real
      // browser reaches no analytics origin in any visitor state — is
      // analytics-egress.spec.js in `behavior`, and this file says so in both
      // places on purpose.
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
      // L3-P3 adds one: install-channel, an ABSENCE guard over the shell and the
      // running mount — no install banner, no `beforeinstallprompt` path, no
      // rules left dressing a deleted surface, and no `<link rel="manifest">`.
      // It is here rather than in `behavior` because an absence is a property of
      // the tree, which is the admissible static kind (AGENTS.md §11), and
      // because there is nothing for a browser to execute: its subject is a
      // surface that no longer exists. What DOES exist and ships hidden is swept
      // at runtime, by behavior.spec.js.
      // PPR-P1 adds one: privacy-page, the policy document as a property of the
      // tree — that the image ships it, that it precaches nothing, that it
      // carries no script, that every link it does carry is on a declared
      // allowlist and none of them is its own address (UIP-P2, which replaced
      // the blanket no-<a> rule), and that it still says what the CURRENT
      // edition — docs/privacy-policy-v1.3.md — says. It is here because all of that is
      // read from files and boots nothing. What a browser does at the address —
      // that the shell is not served there, that no third party is reached, and
      // that the visit leaves the cached shell alone — is privacy-surface.spec.js
      // in `behavior`, deliberately not this one.
      // NAV-P2 adds one: update-contour, the static half of the packet that gives
      // this app its first outbound request. Two of its claims are ABSENCES over
      // the tree, which is the admissible static kind (AGENTS.md §11) and is why
      // it is here — that the update surface has ONE address and no second
      // request primitive, and that it writes no text at all, so a message
      // carrying anything about the family has nowhere to come from. A running
      // page could only show that the messages it happened to display were clean.
      // Its executing twin — when the request happens and what it is made of,
      // read off the network log of a real page — is update-check.spec.js in
      // `behavior`, and both files say so about each other on purpose.
      testMatch: /(delivery-contract|storage-seam|native-shell|merge-semantics|store-supply-chain|store-unit|store-seam|export-contour|export-sink-unit|write-path|import-legacy|diary-write|signal-payload|show-rule-coverage|mount-reference|undeclared-reference|embedded-js-parse|install-channel|privacy-page|download-offer|analytics-absence|update-contour)\.spec\.js/,
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
      // FIU-P1 adds store-lifecycle: what a return from the background does, on
      // both of the things that happen on that one event — the transfer screen
      // that used to reappear over the parent's work, and the store that now
      // closes and reopens under it. Here rather than in `contract` because
      // every leg is a fact about a rendered page, a real visibility change and
      // a handler that ran; and NOT in `native` below for the reason
      // diary-save.spec.js records — that project serves a different web root,
      // and a leg that also simulates the shell would vary two things at once.
      // PPR-P1 adds privacy-surface: what a browser meets at /privacy. Three of
      // its four legs are claims no source scan can carry — that the address
      // does not answer with the app shell (which is what it did before this
      // packet, silently, with a 200), that opening it fetches nothing
      // executable and reaches no third party, and that the visit does not
      // overwrite the app shell offline copy through the service worker's
      // navigation mirror. It is NOT in `native` below: that project serves a
      // different web root, and the APK offers no /privacy route at all.
      // PPR-P2 added consent-surface and UIP-P1 replaced it with analytics-egress:
      // whether anything is fetched from an analytics origin AT ALL, in any
      // visitor state. The subject changed from "and when" to "ever", because
      // the answer no longer depends on anything the visitor did — there is no
      // loader to gate. Every leg of it is still a claim about a request a
      // browser did or did not make, which is the definition of a claim no
      // source scan can carry, and it carries its own anti-vacuity leg: the same
      // observer must record a request that IS expected, or a zero means only
      // that the instrument saw nothing. Its static half — that the vocabulary
      // is absent from the tree — is in `contract` as analytics-absence.
      // NAV-P2 adds update-check, and it is the packet's real deliverable: this
      // app now makes ONE outbound request, and both halves of that — that it
      // happens on a press and nowhere else, and that it carries no credential
      // and no identifier — are claims about a request a browser did or did not
      // make. That is the definition of a claim no source scan can carry, and it
      // is the instrument vault ADR-052 §4 names, borrowed from analytics-egress
      // above. Every leg carries its own anti-vacuity assertion on the same
      // observer: the document and the knowledge base must both have been
      // recorded, or a zero means only that the instrument saw nothing. Nothing
      // in it dials out — one catch-all route over every off-origin address
      // either fulfils the answer the leg is about or aborts, and the RECORDING
      // is the evidence rather than the abort. It is NOT in `native` below, on
      // the argument diary-save.spec.js records: that project serves a different
      // web root, and a leg that also simulates the shell would vary two things
      // at once.
      testMatch: /(behavior|upgrade-path|mount-derivation|channel-composition|diary-surface|diary-save|diary-search|store-lifecycle|privacy-surface|analytics-egress|update-check)\.spec\.js/,
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
