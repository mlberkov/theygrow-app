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
};

// Storage states the suite boots from.
//
// THE SEEDED STATES NO LONGER CARRY A CONSENT ANSWER, AND THE REASON THEY DID IS
// GONE (UIP-P1). PPR-P2 seeded `analytics_consent: 'granted'` into three of the
// four states because the gate made `trackEvent` a no-op for anyone who had not
// consented, and a fixture with no answer stored would have silently emptied
// every dataLayer assertion in this suite — green about nothing. Analytics left
// the web showcase entirely (vault ADR-043 annotation 2026-08-25), so there is
// no gate, no stored answer, no `trackEvent` and no dataLayer to assert through.
// The seeds went with them, and so did `gaEvents()` and the route stub that kept
// the beacon off the network: a request that cannot be made needs no blocking.
// THE SEEDS NO LONGER DISMISS THE INTRO, BECAUSE THERE IS NOTHING TO DISMISS
// (UIP-P3). Three of the four states seeded `onboarding_dismissed: 'true'` for
// one reason: the intro window opened itself on any state that had not, and it
// would have covered the surface under test in every screenshot and every click
// in this suite. The owner retired the auto-open (2026-08-25) — the window now
// opens only from the header control — so the key has no reader, no writer and
// no home in `core/storage.js` any more, and seeding it would be fixture
// vocabulary for a mechanism the product does not have.
//
// `empty` AND `firstRun` ARE THEREFORE THE SAME STORAGE, and that is stated with
// one value rather than two literals that happen to match. Both names are kept
// because each states the question its callers ask — "no profile, so the
// honest-degradation path" and "a visit with nothing stored at all" — and those
// are different questions about one state.
const NOTHING_STORED = {};

const STATES = {
  // No profile at all: the honest-degradation path (A1-P0) lives here.
  empty: NOTHING_STORED,
  // The standard seeded family: one profile with a birthdate and four skills done.
  seeded: {
    [STORAGE_KEYS.profiles]: JSON.stringify([PROFILE]),
    [STORAGE_KEYS.current]: PROFILE.id,
  },
  // Same, with the ZPD filter already on — exercises restore-from-storage.
  seededFiltered: {
    [STORAGE_KEYS.profiles]: JSON.stringify([PROFILE]),
    [STORAGE_KEYS.current]: PROFILE.id,
    [STORAGE_KEYS.filterZpd]: 'true',
  },
  // Nothing stored at all. What a first visit actually is.
  firstRun: NOTHING_STORED,
};

const test = base.test.extend({
  // Opt-out for the kb-load error path, which logs a console error by design.
  allowConsoleErrors: [false, { option: true }],

  // Which delivery channel this run exercises (L1-P1). 'nginx' for every
  // project that predates the Capacitor shell; the `native` project sets
  // 'capacitor'. It exists so a spec can state WHY it does not apply to a
  // channel, in the spec, instead of that knowledge living as a testMatch
  // pattern in the config where the reason cannot be written down.
  parityProfile: ['nginx', { option: true }],

  page: async ({ page, allowConsoleErrors, baseURL }, use) => {
    // 1. Freeze time before any page script evaluates.
    await page.clock.setFixedTime(FIXED_NOW);

    // 2. Fail loudly on unexpected console noise.
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
};
