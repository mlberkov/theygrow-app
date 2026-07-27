'use strict';

// Determinism harness for the parity suite (A1-P1).
//
// app/index.html computes age from new Date() (calculateAge :2079,
// calculateAgeInMonths :2106), and that age drives the current-month column,
// the ZPD readiness marker and the whole Tier-1/Tier-2 activities ranking.
// Without a pinned clock every baseline in this suite would rot within a day,
// and "update the baselines" would quietly become "re-bless whatever we see".

const base = require('@playwright/test');

// Fixed instant for every test. setFixedTime (not clock.install) is deliberate:
// it freezes Date/Date.now while leaving real timers running, so the debounced
// resize handler and CSS transitions still behave normally.
const FIXED_NOW = new Date('2026-03-15T12:00:00.000Z');

// Chosen so the child is exactly 18 months old at FIXED_NOW.
const BIRTHDATE = '2024-09-15';

// A real prerequisite chain from app/kb-v1.json:
//   GM_002 -> GM_004 -> GM_005 -> GM_006  (GM_006 needs GM_004 AND GM_005)
// With GM_001..GM_004 completed, GM_005 is ZPD-ready and GM_006 is not; ticking
// GM_005 must flip GM_006 to ready. That is the recompute the main flow asserts.
const SEEDED_COMPLETED = ['GM_001', 'GM_002', 'GM_003', 'GM_004'];

const CHAIN = {
  completed: 'GM_004',
  ready: 'GM_005',
  blocked: 'GM_006',
};

const PROFILE = {
  // Literal id, not `profile_${Date.now()}` — baselines must not carry a timestamp.
  id: 'profile_parity_0001',
  name: 'Тестовый профиль',
  birthdate: BIRTHDATE,
  completedSkills: SEEDED_COMPLETED,
};

const STORAGE_KEYS = {
  profiles: 'childDevTracker_profiles',
  current: 'childDevTracker_currentProfile',
  legacy: 'childDevTracker_completed',
  accordion: 'milestones_accordion_states',
  filterZpd: 'milestones_filter_zpd',
  onboardingDismissed: 'onboarding_dismissed',
};

// Storage states the suite boots from.
const STATES = {
  // No profile at all: the honest-degradation path (A1-P0) lives here.
  empty: {
    [STORAGE_KEYS.onboardingDismissed]: 'true',
  },
  // The standard seeded family: one profile with a birthdate and four skills done.
  seeded: {
    [STORAGE_KEYS.profiles]: JSON.stringify([PROFILE]),
    [STORAGE_KEYS.current]: PROFILE.id,
    [STORAGE_KEYS.onboardingDismissed]: 'true',
  },
  // Same, with the ZPD filter already on — exercises restore-from-storage.
  seededFiltered: {
    [STORAGE_KEYS.profiles]: JSON.stringify([PROFILE]),
    [STORAGE_KEYS.current]: PROFILE.id,
    [STORAGE_KEYS.onboardingDismissed]: 'true',
    [STORAGE_KEYS.filterZpd]: 'true',
  },
  // Onboarding not yet dismissed: the modal must appear on boot.
  firstRun: {},
};

const test = base.test.extend({
  // Opt-out for the kb-load error path, which logs a console error by design.
  allowConsoleErrors: [false, { option: true }],

  page: async ({ page, allowConsoleErrors, baseURL }, use) => {
    // 1. Freeze time before any page script evaluates.
    await page.clock.setFixedTime(FIXED_NOW);

    // 2. Block the analytics beacon. Keeps the suite hermetic and means CI
    //    generates no third-party egress and no telemetry (contract §4).
    //    trackEvent still pushes to window.dataLayer, which is what we assert on.
    //    Fulfilled with an empty stub rather than aborted: an abort surfaces as
    //    a "Failed to load resource" console error, which would collide with the
    //    console-error guard below. The request never leaves the browser either way.
    await page.route(
      /(googletagmanager\.com|google-analytics\.com|analytics\.google\.com)/,
      (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' })
    );

    // 3. Fail loudly on unexpected console noise.
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await use(page);

    if (!allowConsoleErrors && errors.length) {
      throw new Error(`Unexpected console errors:\n  ${errors.join('\n  ')}`);
    }
    void baseURL;
  },
});

// Seeds localStorage BEFORE page scripts run. This ordering is load-bearing:
// the kb fetch starts at script eval (app/index.html:1808) and init() reads
// storage, so seeding after navigation would be too late.
async function seedStorage(page, state) {
  await page.addInitScript((entries) => {
    try {
      // addInitScript runs on EVERY navigation, including reloads. Seeding
      // unconditionally would wipe whatever the test just did and make every
      // reload assertion meaningless, so seed exactly once per tab and let the
      // app own localStorage from then on. sessionStorage survives reloads but
      // not a fresh context, which is the scope we want.
      if (window.sessionStorage.getItem('__parity_seeded__')) return;
      window.sessionStorage.setItem('__parity_seeded__', '1');
      window.localStorage.clear();
      for (const [k, v] of Object.entries(entries)) {
        window.localStorage.setItem(k, v);
      }
    } catch {
      /* storage unavailable — tests will fail on their own assertions */
    }
  }, state || {});
}

// Navigate with a storage state seeded and the app fully booted.
async function gotoApp(page, { state = STATES.seeded, path = '/', waitForTable = true } = {}) {
  await seedStorage(page, state);
  await page.goto(path);
  if (waitForTable) {
    // init() has run and buildTableBody() has populated rows.
    await page.waitForFunction(
      () => document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0
    );
    // Fonts settle before any measurement: setFixedSkillColumnWidth sizes the
    // skill column from measured text, so capturing early would be flaky.
    await page.evaluate(() => document.fonts.ready.then(() => true));
  }
}

function readStorage(page, key) {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

// Reads the GA surface without touching it. gtag is an inline shim
// (app/index.html:37) that pushes into window.dataLayer, so events are
// observable even though the external googletagmanager script is blocked.
// This only OBSERVES — production emission is unchanged by this suite.
async function gaEvents(page) {
  return page.evaluate(() =>
    Array.from(window.dataLayer || [])
      .map((entry) => Array.from(entry))
      .filter((args) => args[0] === 'event')
      .map((args) => ({ name: args[1], params: args[2] || {} }))
  );
}

module.exports = {
  test,
  expect: base.expect,
  FIXED_NOW,
  BIRTHDATE,
  PROFILE,
  SEEDED_COMPLETED,
  CHAIN,
  STORAGE_KEYS,
  STATES,
  seedStorage,
  gotoApp,
  readStorage,
  gaEvents,
};
