'use strict';

// DIA-P1-INV-001, LEG (b) — the handoff page, EXECUTED against a real source.
//
// This boots a browser, seeds the family's history into localStorage at the
// origin the page runs on, PRESSES THE BUTTON, and reads the whole of storage
// back. That is the difference between this file and its static twin
// (app/tests/handoff-source.spec.js, leg (a)): leg (a) proves that no writer is
// imported and no write is called, which is a property of a set of files; this
// proves what the page DOES to the only copy of a family's history when it runs.
// AGENTS.md §11 — a static guard cannot carry a runtime claim however precisely
// it reads the source that would produce it.
//
// THE COMPARISON IS THE WHOLE OF STORAGE, NOT THE PROFILE KEY. A guard that
// checked only `childDevTracker_profiles` would stay green while the page
// dropped the current-profile pointer, the accordion state or the onboarding
// flag — none of which is the history, all of which is the parent's, and none of
// which this page has any business touching. So the snapshot is every key, in
// order, with every value, and it is compared for equality.
//
// WHAT ELSE IS EXECUTED HERE, because it can only be observed by running:
//   * the ceiling decision — over TRANSFER_CONFIG.linkMaxBytes the page emits a
//     FILE and never builds a link, and the switch happens with no fork shown
//     to the parent;
//   * the no-handler path — Chrome's browser_fallback_url brings the page back
//     with a flag, and the page comes up in file mode with one line of
//     instruction;
//   * that visiting this page does not overwrite the app shell's offline copy,
//     which is a defect the second navigable page introduces and app/sw.js
//     guards against (see NON_SHELL_PAGES there).
//
// WHAT IS NOT EXECUTED, and is not claimed: nothing here drives a real Android
// intent. Whether Chrome delivers the link to the app is the instrumented
// leg's and the owner smoke's; what this file proves is what the page emits.

const fs = require('fs');
const path = require('path');
const { test, expect, gotoApp, seedStorage, STORAGE_KEYS, PROFILE } = require('./support/seed');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

// Read out of the shipped config rather than retyped, so the fixtures below
// cannot drift away from the ceiling they are about.
const CONFIG_SOURCE = fs.readFileSync(
  path.join(APP_ROOT, 'm', MOUNT.dir, 'transfer', 'config.js'),
  'utf8'
);
const LINK_MAX_BYTES = Number(/linkMaxBytes:\s*(\d+)/.exec(CONFIG_SOURCE)[1]);
const FALLBACK_FILENAME = /fallbackFilename:\s*'([^']+)'/.exec(CONFIG_SOURCE)[1];

// A source that fits under the ceiling: the parity suite's standard family, plus
// the other keys a real browser would be holding beside it. Those extra keys are
// not decoration — they are what makes "the page wrote nothing" a claim about
// the parent's whole storage rather than about one key.
const SOURCE_STATE = {
  [STORAGE_KEYS.profiles]: JSON.stringify([PROFILE]),
  [STORAGE_KEYS.current]: PROFILE.id,
  [STORAGE_KEYS.onboardingDismissed]: 'true',
  [STORAGE_KEYS.accordion]: JSON.stringify({ 'Крупная моторика': true }),
  [STORAGE_KEYS.filterZpd]: 'true',
};

/** A source deliberately past the link ceiling, to force the file path. */
function oversizedState() {
  // Padding rides in completedSkills as skill-id-shaped strings: the field the
  // envelope actually carries, so the size lands where a real history's size
  // lands rather than in a field the format would drop.
  const skills = [];
  for (let at = 0; skills.length * 12 < LINK_MAX_BYTES * 2; at += 1) {
    skills.push(`XX_${String(at).padStart(6, '0')}`);
  }
  return {
    ...SOURCE_STATE,
    [STORAGE_KEYS.profiles]: JSON.stringify([{ ...PROFILE, completedSkills: skills }]),
  };
}

/** Every key and value in localStorage, in index order. */
function snapshot(page) {
  return page.evaluate(() => {
    const out = [];
    for (let at = 0; at < window.localStorage.length; at += 1) {
      const key = window.localStorage.key(at);
      out.push([key, window.localStorage.getItem(key)]);
    }
    return out;
  });
}

/**
 * Records every mutating Web Storage call the page makes, in the page.
 *
 * WHY A SNAPSHOT COMPARISON IS NOT ENOUGH, measured rather than reasoned. The
 * first form of this file compared localStorage before and after the click and
 * nothing else. Mutating the page to call `writeOnboardingDismissed()` — one
 * plausible line, the shape a refactor actually takes — left that comparison
 * GREEN, because the fixture already held `onboarding_dismissed = 'true'` and
 * the write set it to the value it already had. A write whose value happens to
 * match is invisible to a state check and is still a write to the only copy of a
 * family history.
 *
 * So the run is observed twice, independently: what was CALLED, and what the
 * state IS afterwards. The patch keeps the original behaviour rather than
 * blocking it, so the state check still sees a real write if one happens.
 *
 * Registered AFTER seedStorage, deliberately: init scripts run in registration
 * order, so the seeding has already happened by the time this patch is
 * installed and the fixture's own writes are not recorded as the page's.
 */
async function installWriteRecorder(page) {
  await page.addInitScript(() => {
    window.__storageWrites = [];
    const proto = window.Storage.prototype;
    for (const method of ['setItem', 'removeItem', 'clear']) {
      const original = proto[method];
      proto[method] = function patched(...args) {
        const store = this === window.sessionStorage ? 'sessionStorage' : 'localStorage';
        window.__storageWrites.push({ store, method, key: args[0] ?? null });
        return original.apply(this, args);
      };
    }
  });
}

async function openHandoff(page, state, { query = '' } = {}) {
  await seedStorage(page, state);
  await installWriteRecorder(page);
  await page.goto(`/transfer.html${query}`);
  await page.waitForSelector('#handoffBtn');
}

test.describe('handoff page — reads the browser source and leaves it untouched (DIA-P1-INV-001 leg b)', () => {
  test('pressing the button changes nothing in localStorage', async ({ page }) => {
    await openHandoff(page, SOURCE_STATE);

    const before = await snapshot(page);
    // ANTI-VACUITY, first: an empty source would make the comparison hold for
    // the wrong reason, which is the failure mode this repository has already
    // paid for twice (AGENTS.md §11, the vacuous fixture).
    expect(before.length, 'the source fixture did not seed').toBeGreaterThan(4);
    expect(before.map(([key]) => key)).toContain(STORAGE_KEYS.profiles);

    // The REAL button, pressed. The link assignment that follows cannot resolve
    // in a desktop browser — intent:// has no handler here — so the page stays
    // put and storage can be read back, which is the whole point of asserting
    // it at this moment rather than after a navigation.
    await page.click('#handoffBtn');
    await expect(page.locator('#handoffStatus')).not.toBeHidden();

    // OBSERVATION 1 — what was CALLED. Catches a write whose value happens to
    // equal what was already there, which observation 2 cannot see.
    const writes = await page.evaluate(() => window.__storageWrites);
    expect(
      writes,
      'the handoff page called a mutating Web Storage method. Under the production'
        + ' origin that storage is the ONLY copy of this family history.'
    ).toEqual([]);

    // OBSERVATION 2 — what the state IS. Catches a write this recorder could not
    // see, including one made through a reference captured before it patched.
    const after = await snapshot(page);
    expect(
      after,
      'the handoff page changed the browser source. Under the production origin that'
        + ' localStorage is the ONLY copy of this family history.'
    ).toEqual(before);

    // SELF-PROVING: the recorder is fired at an input this test makes, so an
    // empty `writes` above cannot mean "the patch never installed".
    const proof = await page.evaluate(() => {
      window.localStorage.setItem('__recorder_probe__', '1');
      window.localStorage.removeItem('__recorder_probe__');
      return window.__storageWrites.map((entry) => entry.method);
    });
    expect(proof, 'the write recorder did not record a write it was handed').toEqual([
      'setItem',
      'removeItem',
    ]);
  });

  test('the emitted link carries the history and names this app only', async ({ page }) => {
    await openHandoff(page, SOURCE_STATE);

    // THE PAGE'S OWN DECISION, CALLED — not rebuilt here. `prepareHandoff()` is
    // the function the click handler calls; import() of an already-loaded URL
    // returns the SAME module instance the page booted (the seam
    // app/tests/support/app-module.js documents), so this is a handle on the
    // live page rather than a second copy of it. Reimplementing buildEnvelope /
    // encodePayload / digestHex in the test would have proved the test.
    //
    // WHAT STAYS UNEXECUTED, stated rather than implied: the one assignment to
    // location.href. An intent:// URL has no handler in a desktop browser, so
    // whether Android delivers it is the instrumented leg's and the owner
    // smoke's — never this file's.
    const prepared = await page.evaluate(async (prefix) => {
      const mod = await import(`${prefix}transfer/handoff-page.js`);
      const cfg = await import(`${prefix}transfer/config.js`);
      const out = await mod.prepareHandoff();
      return { ...out, config: cfg.TRANSFER_CONFIG };
    }, MOUNT.prefix);

    expect(prepared.mode, 'a source under the ceiling did not take the link path').toBe('link');
    expect(prepared.payload.length).toBeLessThanOrEqual(prepared.config.linkMaxBytes);

    // The package is named, which is what makes the link undeliverable to any
    // other app that registered the same scheme — a privacy property, not a
    // routing detail (TRANSFER_CONFIG.linkPackage).
    expect(prepared.link).toContain(`package=${prepared.config.linkPackage}`);
    expect(prepared.link).toContain(`scheme=${prepared.config.linkScheme}`);
    expect(prepared.link.startsWith(`intent://${prepared.config.linkHost}/`)).toBeTruthy();
    expect(prepared.link, 'the no-handler detector is not wired into the link').toContain(
      'S.browser_fallback_url='
    );

    // The query carries the four declared keys and NOTHING else. The receiving
    // plugin refuses an undeclared key before it stages anything, so an extra
    // one here would not be a leak — it would be a transfer that never starts.
    const query = new URL(prepared.link.slice('intent:'.length).split('#')[0], 'https://x')
      .searchParams;
    expect([...query.keys()].sort()).toEqual(
      Object.values(prepared.config.linkParams).sort()
    );

    // The payload round-trips back to the profiles the importer will be handed.
    const profiles = await page.evaluate(
      async ({ prefix, payload }) => {
        const mod = await import(`${prefix}transfer/format.js`);
        return mod.parseEnvelope(new TextDecoder().decode(mod.decodePayload(payload)));
      },
      { prefix: MOUNT.prefix, payload: query.get(prepared.config.linkParams.payload) }
    );

    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(PROFILE.id);
    expect(profiles[0].completedSkills).toEqual(PROFILE.completedSkills);
    expect(profiles[0].birthdate).toBe(PROFILE.birthdate);

    // The transport metadata describes the bytes it travels with — the property
    // a truncating browser breaks, and the one the receiver refuses on.
    expect(Number(query.get(prepared.config.linkParams.bytes))).toBe(prepared.bytes);
    expect(query.get(prepared.config.linkParams.digest)).toBe(prepared.digest);
  });

  test('over the ceiling the page emits a file and builds no link', async ({ page }) => {
    await openHandoff(page, oversizedState());
    const before = await snapshot(page);

    const download = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#handoffBtn');
    const file = await download;

    expect(
      file.suggestedFilename(),
      'the fallback file must carry no child name — a filename is visible in'
        + ' file managers and download lists'
    ).toBe(FALLBACK_FILENAME);

    // The switch is automatic: the parent was told what happened in one line and
    // was never asked to choose a path.
    await expect(page.locator('#handoffStatus')).not.toBeHidden();
    expect(await snapshot(page), 'the fallback path wrote to the source').toEqual(before);
  });

  test('the no-handler return puts the page in file mode with one line', async ({ page }) => {
    // This is the state Chrome's browser_fallback_url produces when nothing on
    // the device registered the scheme. Reached by the flag rather than by
    // simulating Android, because the flag is the whole contract between the two.
    await openHandoff(page, SOURCE_STATE, { query: '?fallback=1' });

    await expect(page.locator('#handoffInstruction')).not.toBeHidden();
    await expect(page.locator('#handoffBtn')).toHaveText(/файл/i);

    const before = await snapshot(page);
    const download = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#handoffBtn');
    await download;
    expect(await snapshot(page), 'the no-handler path wrote to the source').toEqual(before);
  });

  test('visiting the handoff page does not overwrite the app shell offline copy', async ({
    page,
  }) => {
    // THE DEFECT THIS PAGE WOULD OTHERWISE INTRODUCE, EXECUTED. app/sw.js serves
    // navigations network-first and mirrors the successful response into the
    // cache keyed '/', which is the app shell's offline copy. That was sound
    // while every navigable path WAS the app shell — nginx serves index.html for
    // anything unknown, and /offline.html is reached from the cache rather than
    // navigated to. /transfer.html is the first real second page, so without the
    // NON_SHELL_PAGES guard in app/sw.js one visit here would replace the app
    // shell's offline copy with the handoff page, permanently, for every client
    // that ever pressed the transfer link.
    //
    // Asserted on the CACHE rather than on a later offline boot on purpose: the
    // poisoning is what happens at the moment of the visit, and reading it there
    // names the cause instead of a symptom two steps downstream.
    await gotoApp(page, { state: SOURCE_STATE });
    await page.evaluate(() => navigator.serviceWorker.ready);

    const shellMarker = 'id="mainTable"';
    const cachedShellBefore = await page.evaluate(async () => {
      const response = await caches.match('/');
      return response ? response.text() : null;
    });
    // Anti-vacuity: if '/' is not cached at all, everything below holds
    // trivially and proves nothing.
    expect(cachedShellBefore, 'the app shell is not in the cache to be overwritten').not.toBeNull();
    expect(cachedShellBefore).toContain(shellMarker);

    await page.goto('/transfer.html');
    await page.waitForSelector('#handoffBtn');
    // The mirror, if it happened, happens on the response — poll rather than
    // assume it has settled, so a pass is not a race that went our way.
    await expect
      .poll(
        async () => {
          const body = await page.evaluate(async () => {
            const response = await caches.match('/');
            return response ? response.text() : null;
          });
          return body === null ? 'absent' : body.includes(shellMarker) ? 'shell' : 'poisoned';
        },
        { timeout: 5000 }
      )
      .toBe('shell');

    const cachedShellAfter = await page.evaluate(async () => {
      const response = await caches.match('/');
      return response ? response.text() : null;
    });
    expect(
      cachedShellAfter.includes('id="handoffBtn"'),
      'the app shell offline copy is now the handoff page'
    ).toBeFalsy();
  });

  test('an empty source is worded as a fact about this browser', async ({ page }) => {
    // The zero case says what is true of the SOURCE, not of the child: "nothing
    // is saved in this browser", never "there is nothing to transfer".
    await openHandoff(page, { [STORAGE_KEYS.onboardingDismissed]: 'true' });
    await page.click('#handoffBtn');
    await expect(page.locator('#handoffStatus')).toHaveText(/в этом браузере/i);
  });
});
