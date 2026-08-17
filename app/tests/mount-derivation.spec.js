'use strict';

// DIA-P1-INV-003 (half b) — the mount's own self-references resolve to the
// generation that is running (DIA-P1).
//
// WHY THIS IS A SEPARATE FILE FROM mount-reference.spec.js, AND WHY IT BOOTS A
// BROWSER. The two halves of this invariant fail for different reasons and
// neither substitutes for the other:
//
//   (a) mount-reference.spec.js reads the tree and asserts that nothing under
//       app/tests/ NAMES a generation the shell does not run. Static, on every
//       push, boots nothing — and it says so about itself (AGENTS.md §11).
//   (b) this file asserts that the four addresses the mount computes for its own
//       assets actually ADDRESS them. That is a claim about what the code does
//       when it runs, so it is made by running it: a real browser evaluates the
//       shipped config modules and fetches what they name.
//
// WHAT CHANGED, AND WHY IT NEEDED A DETECTOR. Until DIA-P1 those four values
// were absolute literals — `STORE_CONFIG.schemaUrl` and `EXPORT_CONFIG`'s
// declarationUrl / fontUrl / iccUrl — repointed by hand at every mount bump,
// three times over three bumps, with the RUNBOOK carrying a step to remember it.
// They are now derived from `import.meta.url`. That removes the hand edit and
// removes the class of defect with it, but it also moves the values from
// something a reader can check by eye to something only execution can confirm:
// a wrong `new URL(...)` base, a `.href` where `.pathname` was meant, or a
// renamed asset all produce a plausible-looking string that resolves to nothing.
//
// NOTHING ELSE IN THE SUITE WOULD CATCH THAT, which is the whole argument for
// this file. On the web branch the store never opens (no injected bridge), so
// `schemaUrl` is never fetched; the export contour's fetches sit behind a sink
// that is unavailable off-device; and export-contour.spec.js reads the config as
// SOURCE TEXT. Every one of those would stay green against four values that
// addressed nothing at all.
//
// RUNS ON BOTH DELIVERY CHANNELS. The `behavior` project serves through a mirror
// of app/nginx.conf; the `native` project serves the staged Capacitor web root
// (native/www/, assembled from app/Dockerfile's COPY list). The derivation
// depends on the origin the modules are loaded from, so the two channels are
// two different executions of the property, not one repeated.

const fs = require('fs');
const path = require('path');
const { test, expect, gotoApp, STATES } = require('./support/seed');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');

// Derived from the shell, never written down — the same rule the values under
// test now follow.
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

// module -> knob -> the asset that knob must address, relative to the mount.
// The suffixes are the only thing stated here; the mount half is derived on both
// sides, so this table cannot go stale at a bump.
const DERIVED = [
  { module: 'store/config.js', surface: 'STORE_CONFIG', knob: 'schemaUrl', asset: 'store/schema/001-core.sql' },
  { module: 'export/config.js', surface: 'EXPORT_CONFIG', knob: 'declarationUrl', asset: 'export/declaration.json' },
  { module: 'export/config.js', surface: 'EXPORT_CONFIG', knob: 'fontUrl', asset: 'export/assets/PTSans-Regular.ttf' },
  { module: 'export/config.js', surface: 'EXPORT_CONFIG', knob: 'iccUrl', asset: 'export/assets/sRGB-v2-micro.icc' },
];

/** Reads the four derived values out of the modules the page actually loads. */
async function derivedValues(page) {
  return page.evaluate(async (prefix) => {
    const [store, exportConfig] = await Promise.all([
      import(`${prefix}store/config.js`),
      import(`${prefix}export/config.js`),
    ]);
    return {
      schemaUrl: store.STORE_CONFIG.schemaUrl,
      declarationUrl: exportConfig.EXPORT_CONFIG.declarationUrl,
      fontUrl: exportConfig.EXPORT_CONFIG.fontUrl,
      iccUrl: exportConfig.EXPORT_CONFIG.iccUrl,
    };
  }, MOUNT.prefix);
}

test.describe('mount derivation — the mount addresses its own assets (DIA-P1-INV-003 half b)', () => {
  test('every derived URL names the running generation', async ({ page }) => {
    await gotoApp(page, { state: STATES.seeded });
    const values = await derivedValues(page);

    for (const { knob, asset, surface, module } of DERIVED) {
      expect(
        values[knob],
        `${surface}.${knob} in ${module} derived "${values[knob]}" — the shell runs ${MOUNT.prefix}`
      ).toBe(`${MOUNT.prefix}${asset}`);
    }
  });

  test('every derived URL actually fetches the asset it names', async ({ page }) => {
    // The equality above proves the STRING. This proves the string addresses a
    // file — the half that a renamed or unshipped asset breaks while the string
    // still looks perfect. Fetched from inside the page, so the request goes
    // through the same origin and the same delivery rules the app uses.
    await gotoApp(page, { state: STATES.seeded });
    const values = await derivedValues(page);

    const results = await page.evaluate(async (urls) => {
      const out = {};
      for (const [knob, url] of Object.entries(urls)) {
        try {
          const response = await fetch(url);
          const body = await response.arrayBuffer();
          out[knob] = { ok: response.ok, status: response.status, bytes: body.byteLength };
        } catch (error) {
          out[knob] = { ok: false, status: 0, bytes: 0, error: String(error && error.name) };
        }
      }
      return out;
    }, values);

    for (const { knob } of DERIVED) {
      expect(
        results[knob],
        `${knob} -> ${values[knob]} did not fetch: ${JSON.stringify(results[knob])}`
      ).toMatchObject({ ok: true, status: 200 });
      // Non-empty as well as present: an empty file served with a 200 is the
      // shape a mis-staged asset takes, and every one of these four has content.
      expect(results[knob].bytes, `${knob} -> ${values[knob]} fetched 0 bytes`).toBeGreaterThan(0);
    }
  });

});

// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT, and where it is asserted instead.
//
// Neither test above can tell a derivation from a LITERAL that happens to be
// correct today — which is the state this packet changed, and the state that
// goes stale at the next bump. The obvious way to force the distinction at
// runtime is to load the same module from a second address and watch the value
// move; the frozen generation is not that address, because the frozen
// generation's own config still carries the literal it shipped with, so the
// comparison would pass whichever thing the current one is.
//
// So the "it is derived, not written down" half is what it actually is — a
// property of the source text — and it lives with the other source-text guards,
// in mount-reference.spec.js's second describe block. The split is deliberate:
// that half reds when a literal comes back, this file reds when the derivation
// addresses the wrong thing, and neither can stand in for the other.
