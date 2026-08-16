'use strict';

// The transfer seam's two-language boundary (DIA-P1).
//
// STATIC, AND IT SAYS SO. Nothing here boots a page, an emulator or a process.
// It reads the shipped JavaScript and the shipped Java and asserts they agree
// about numbers, names and sets. That is a property of the tree, and reading the
// tree is the right instrument for it (AGENTS.md §11) — but it is emphatically
// NOT evidence that the plugin works. Whether the intent-filter delivers,
// whether the Intent stages, whether a refusal refuses: all of that is
// android-instrumented's, which runs on pull_request and workflow_dispatch only.
// A green run of this file says the two sides were written down the same, and
// nothing more.
//
// WHY THE NUMBERS ARE WRITTEN TWICE AT ALL. The app is buildless in both
// delivery channels and the plugin is Java; they share no config surface and
// there is no generator between them. The repository's existing answer is to
// write the value in both places and assert equality off-device — the
// arrangement STORE_CONFIG.sqliteVersionFloor has with app/tests/schema/
// harness.py, and EXPORT_CONFIG.sinkLaunchOptionsMaxBytes has with
// ExportSinkPlugin.LAUNCH_OPTIONS_MAX_BYTES. This is the third instance of it.
//
// THE ONE PAIR THAT IS EMPTY ON PURPOSE. TRANSFER_CONFIG.handoffOrigin and
// HANDOFF_ORIGIN are both the empty string: the PWA's serving URL is not
// recorded anywhere in this repository (docs/RUNBOOK.md carries the Cloud Run
// service name and the region, deliberately not the host). They are asserted
// equal WHILE EMPTY, so the pair cannot drift apart before either is filled in,
// and the fail-closed refusal that empty produces is asserted too — a knob whose
// unset state is a silent no-op is worse than one that is missing.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

const CONFIG_JS = fs.readFileSync(
  path.join(APP_ROOT, 'm', MOUNT.dir, 'transfer', 'config.js'),
  'utf8'
);
const SEAM_JS = fs.readFileSync(path.join(APP_ROOT, 'm', MOUNT.dir, 'store', 'transfer.js'), 'utf8');
const JAVA_ROOT = path.join(
  REPO_ROOT,
  'native/android/app/src/main/java/app/theygrow'
);
const PLUGIN_JAVA = fs.readFileSync(path.join(JAVA_ROOT, 'HistoryTransferPlugin.java'), 'utf8');
const ACTIVITY_JAVA = fs.readFileSync(path.join(JAVA_ROOT, 'MainActivity.java'), 'utf8');
const MANIFEST = fs.readFileSync(
  path.join(REPO_ROOT, 'native/android/app/src/main/AndroidManifest.xml'),
  'utf8'
);
const SIGNALS_JS = fs.readFileSync(
  path.join(APP_ROOT, 'm', MOUNT.dir, 'core', 'signals.js'),
  'utf8'
);

/** A `name: 12345,` knob out of the JS config surface. */
function jsNumber(name) {
  const match = new RegExp(`\\b${name}:\\s*(\\d+)`).exec(CONFIG_JS);
  if (!match) throw new Error(`transfer/config.js declares no numeric knob "${name}"`);
  return Number(match[1]);
}

/** A `name: 'value',` knob out of the JS config surface. */
function jsString(name) {
  const match = new RegExp(`\\b${name}:\\s*'([^']*)'`).exec(CONFIG_JS);
  if (!match) throw new Error(`transfer/config.js declares no string knob "${name}"`);
  return match[1];
}

/** A `static final int NAME = 12345;` constant out of the plugin. */
function javaNumber(name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*([0-9*\\s]+);`).exec(PLUGIN_JAVA);
  if (!match) throw new Error(`HistoryTransferPlugin.java declares no constant "${name}"`);
  // Written as `16 * 1024` in places, deliberately, because that is how a
  // reader checks it against a limit. Evaluated rather than string-matched.
  return match[1]
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1);
}

function javaString(name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(PLUGIN_JAVA);
  if (!match) throw new Error(`HistoryTransferPlugin.java declares no string constant "${name}"`);
  return match[1];
}

test.describe('transfer seam — the two languages agree (DIA-P1, static)', () => {
  test('the sources under test were actually read', () => {
    // Anti-vacuity. Every assertion below is an equality between two parsed
    // values; a parse that silently returned nothing would make them compare
    // absences. The parsers throw rather than return null, and this pins that
    // the files they parse are non-trivial.
    for (const [name, source] of [
      ['transfer/config.js', CONFIG_JS],
      ['store/transfer.js', SEAM_JS],
      ['HistoryTransferPlugin.java', PLUGIN_JAVA],
      ['MainActivity.java', ACTIVITY_JAVA],
      ['AndroidManifest.xml', MANIFEST],
    ]) {
      expect(source.length, `${name} is empty or unreadable`).toBeGreaterThan(200);
    }
  });

  test('every mirrored number is the same number on both sides', () => {
    expect(jsNumber('launchOptionsMaxBytes')).toBe(javaNumber('LAUNCH_OPTIONS_MAX_BYTES'));
    expect(jsNumber('transferChunkBytes')).toBe(javaNumber('TRANSFER_CHUNK_BYTES'));
    expect(jsNumber('linkMaxBytes')).toBe(javaNumber('LINK_MAX_BYTES'));
  });

  test('the handoff URL is declared identically, and its empty default refuses', () => {
    expect(jsString('handoffPath')).toBe(javaString('HANDOFF_PATH'));
    expect(
      jsString('handoffOrigin'),
      'the PWA origin disagrees across the bridge; the app would open a page the'
        + ' plugin refuses to open'
    ).toBe(javaString('HANDOFF_ORIGIN'));

    // The pair is empty today, and that is a recorded state rather than an
    // oversight — see the header. What must not be true is that empty means
    // "open whatever the app asks for".
    expect(
      PLUGIN_JAVA,
      'HANDOFF_ORIGIN has no fail-closed branch: an unconfigured build would'
        + ' start something rather than say it cannot'
    ).toContain('HANDOFF_ORIGIN.isEmpty()');
    expect(PLUGIN_JAVA).toContain('handoff_unconfigured');
  });

  test('the declared link parameters are the same set on both sides', () => {
    const block = /linkParams:\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(CONFIG_JS);
    expect(block, 'transfer/config.js declares no linkParams').not.toBeNull();
    const js = new Set(Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]));

    const java = /LINK_PARAM_KEYS\s*=\s*\n?\s*Arrays\.asList\(([\s\S]*?)\);/.exec(PLUGIN_JAVA);
    expect(java, 'the plugin declares no LINK_PARAM_KEYS').not.toBeNull();
    // The Java side names the four through PARAM_ constants, so the values are
    // read from those rather than from the list literal.
    const javaValues = new Set(
      Array.from(java[1].matchAll(/PARAM_([A-Z]+)/g)).map(
        (m) => /PARAM_%s\s*=\s*"([^"]+)"/.exec('') || m[1]
      )
    );
    const resolved = new Set(
      [...javaValues].map((constant) => javaString(`PARAM_${constant}`))
    );
    expect(
      resolved,
      'the link parameter sets differ; the plugin refuses an undeclared key, so a'
        + ' disagreement here is a transfer that never starts'
    ).toEqual(js);
  });

  test('the method allowlist is exactly what the app may call', () => {
    const block = /ALLOWED_TRANSFER_METHODS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(CONFIG_JS);
    expect(block, 'transfer/config.js declares no ALLOWED_TRANSFER_METHODS').not.toBeNull();
    const allowed = new Set(Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]));

    // THE SET IS ASSERTED, NOT ITS SIZE — the same boundary ALLOWED_SINK_METHODS
    // draws. None of these can write, delete, list, or read a path of its own
    // choosing; the one that reads at all reads the single document the parent
    // picked in the system picker.
    expect(allowed).toEqual(
      new Set(['openHandoff', 'pendingTransfer', 'readChunk', 'discardTransfer', 'pickTransfer'])
    );

    // Every method the app CALLS is on the list…
    const called = new Set(
      Array.from(SEAM_JS.matchAll(/callTransfer\(\s*'([^']+)'/g)).map((m) => m[1])
    );
    expect(called.size, 'no transfer call sites found — the scan would be vacuous').toBeGreaterThan(
      0
    );
    for (const method of called) {
      expect(allowed.has(method), `"${method}" is called but not on the allowlist`).toBeTruthy();
    }

    // …and every method the PLUGIN exposes is on it too. This direction is the
    // one that matters: a @PluginMethod the app never calls is still callable
    // from any JavaScript in the WebView, so an undeclared one is a surface the
    // allowlist does not describe.
    const exposed = new Set(
      Array.from(PLUGIN_JAVA.matchAll(/@PluginMethod\s+public\s+(?:synchronized\s+)?void\s+(\w+)/g))
        .map((m) => m[1])
    );
    expect(
      exposed,
      'the plugin exposes a method the app-side allowlist does not name'
    ).toEqual(allowed);
  });

  test('every refusal code the plugin can emit is declared in the taxonomy', () => {
    // The vocabulary has three holders — the plugin, transfer/errors.js and the
    // signal taxonomy — and a code that exists in one and not the others is a
    // refusal that either cannot be reported or is reported as something else.
    const block = /refusal: Object\.freeze\(\[([\s\S]*?)\]\)/.exec(SIGNALS_JS);
    expect(block, 'core/signals.js declares no closed refusal list').not.toBeNull();
    const declared = new Set(Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]));

    // Codes the plugin passes to call.reject(...) or to refuse(...).
    const emitted = new Set([
      ...Array.from(PLUGIN_JAVA.matchAll(/call\.reject\([\s\S]*?,\s*"([a-z_]+)"\);/g)).map(
        (m) => m[1]
      ),
      ...Array.from(PLUGIN_JAVA.matchAll(/refuse\(\s*\n?\s*"([a-z_]+)"/g)).map((m) => m[1]),
      ...Array.from(PLUGIN_JAVA.matchAll(/put\("refusal",\s*"([a-z_]+)"\)/g)).map((m) => m[1]),
    ]);
    expect(emitted.size, 'no refusal codes found in the plugin — the scan is vacuous').toBeGreaterThan(
      4
    );
    for (const code of emitted) {
      expect(
        declared.has(code),
        `the plugin can refuse with "${code}", which core/signals.js does not declare —`
          + ' the signal surface would drop the payload silently and the event would vanish'
      ).toBeTruthy();
    }
  });

  test('the manifest filter and the link the page builds are the same address', () => {
    const scheme = jsString('linkScheme');
    const host = jsString('linkHost');
    const pkg = jsString('linkPackage');

    expect(
      MANIFEST,
      'AndroidManifest.xml declares no intent-filter for the scheme the page builds'
    ).toContain(`android:scheme="${scheme}"`);
    expect(MANIFEST).toContain(`android:host="${host}"`);
    expect(MANIFEST).toContain('android.intent.category.BROWSABLE');

    // The package the link names must be the package that is built. A
    // disagreement here is a link Chrome resolves to nothing.
    const gradle = fs.readFileSync(
      path.join(REPO_ROOT, 'native/capacitor.config.json'),
      'utf8'
    );
    expect(JSON.parse(gradle).appId, 'the link names a package this project does not build').toBe(
      pkg
    );

    // autoVerify would claim an App Links verification nothing performs, and
    // that verification needs a release signature this project has never
    // produced (ADR-047).
    //
    // MATCHED AS AN ATTRIBUTE, NOT AS A SUBSTRING. The first form of this was
    // `MANIFEST.includes('autoVerify')` and it red on the manifest's own COMMENT
    // saying the attribute is deliberately absent — the over-matching-substring
    // class AGENTS.md §11 records, which this packet has now reproduced twice in
    // its own guards. An attribute is a name followed by `=`; prose is not.
    expect(
      /android:autoVerify\s*=/.test(MANIFEST),
      'the manifest claims App Links verification; no release signature exists to verify against'
    ).toBeFalsy();
  });

  test('the Intent is consumed natively, never handed to the WebView', () => {
    // The transport property, asserted where it is decidable off-device: the
    // activity stages the Intent itself, on both the cold-start and the
    // singleTask paths. That the staging then WORKS is android-instrumented's.
    expect(ACTIVITY_JAVA).toContain('stageHandoff(getIntent())');

    // MATCHED AS A DECLARATION, NOT AS A SUBSTRING — an override is a name
    // followed by its parameter list. The first form was
    // `.toContain('public void onNewIntent')`, and a mutation renaming the
    // method to `onNewIntentDISABLED` left it GREEN, because the disabled name
    // contains the enabled one. Measured, not reasoned about: that is the third
    // time this packet has reproduced the over-matching-substring class
    // AGENTS.md §11 records, and the second time inside a guard written to
    // prevent it.
    expect(
      /@Override\s+public\s+void\s+onNewIntent\s*\(\s*Intent\b/.test(ACTIVITY_JAVA),
      'onNewIntent is not overridden: the activity is singleTask, so a parent who'
        + ' returns to an already-open app hands over a link nothing consumes — the'
        + ' transfer would work exactly once, on a cold start, and look intermittent'
    ).toBeTruthy();
    expect(
      /stageHandoff\(intent\)/.test(ACTIVITY_JAVA),
      'onNewIntent does not stage what it received'
    ).toBeTruthy();
    expect(ACTIVITY_JAVA).toContain('registerPlugin(HistoryTransferPlugin.class)');

    // No @PluginMethod may take the payload: the staging entry point is
    // package-private and not annotated, so the WebView cannot call it.
    expect(
      /@PluginMethod\s+[^}]*?stageFromIntent/.test(PLUGIN_JAVA),
      'stageFromIntent is exposed to the WebView; the payload would then cross the bridge'
    ).toBeFalsy();
  });

  test('no bridge call in the seam carries a payload key', () => {
    // The XPT-P1 property, restated for this direction. The app sends only
    // references and small metadata; the plugin sends bytes back only through
    // readChunk, bounded by the chunk ceiling.
    for (const match of SEAM_JS.matchAll(/callTransfer\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
      const [, method, options] = match;
      const keys = Array.from(options.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/g)).map(
        (m) => m[1]
      );
      for (const key of keys) {
        expect(
          ['base64', 'payload', 'bytes', 'archive', 'profiles'].includes(key),
          `${method} carries the option "${key}", which is a payload-shaped name`
        ).toBeFalsy();
      }
    }
  });
});
