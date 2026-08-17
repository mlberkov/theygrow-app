'use strict';

// LSC-P1-INV-002 — the native channel ships the web channel's bytes unchanged,
// and exports nothing off the device (L1-P1).
//
// FOUR CLAIMS, ONE FILE. The first two are the two halves of "the Android
// shell is a shell"; the third (EMV-P5-INV-001) is what keeps the native side
// pointed at the generation the shell actually runs; the fourth (DIA-P5-INV-001)
// pins the knob that stops the framework beneath the shell writing the family's
// data to the device log:
//
//  (a) BYTE-IDENTITY. The APK's web root is assembled by
//      native/tools/stage-webdir.js from app/Dockerfile's COPY list — the same
//      list the nginx image ships. Asserted in both directions and by content
//      hash, so "no bundler, no transpiler, zero product change" is a checkable
//      property rather than a promise. A packet that quietly minified, inlined
//      or polyfilled anything on the way into the APK would red here.
//
//  (b) NO EXPORT. Android Auto Backup is on by DEFAULT for the app sandbox —
//      the WebView's localStorage today, the native store from L1-P2. Left
//      alone it would carry family data to a third party with no export
//      contour behind it. The manifest hardening that turns it off is a hand
//      edit of a Capacitor-generated file, which is exactly the kind of edit a
//      toolchain upgrade silently reverts, so it is pinned here.
//
//  (c) NO STALE MOUNT ADDRESS UNDER native/. A mount bump is copy-forward, so a
//      native-side file left naming the frozen generation does not 404 — it
//      quietly reaches bytes nobody runs. See the describe block for what that
//      cost, and AGENTS.md §11 for why a source scan is the right instrument
//      for it and carries no runtime claim.
//
//  (d) NO PLUGIN-ARGUMENT TRACE. Capacitor logs every plugin call's whole
//      argument object to logcat whenever the build is debuggable, which is the
//      build the owner installs. Every family value this app holds crosses that
//      bridge as a bound parameter, so the knob that switches it off is pinned
//      here for the same reason (b) is — one JSON key, in a file a toolchain
//      upgrade or a careless `cap sync` could quietly reshape. The device half
//      of the claim is DeviceLogTest, on the emulator; this half is static.
//
// This spec reads native/www/ AS IT STANDS and deliberately does NOT stage it
// first: staging inside the test would wipe a hand-added file moments before
// checking for hand-added files, and the assertion would be tautological.
// scripts/parity-suite.sh stages before running, and the failure message below
// says so.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const { shippedPaths, expandShippedFiles, currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const NATIVE_ROOT = path.resolve(APP_ROOT, '..', 'native');
const WWW_ROOT = path.join(NATIVE_ROOT, 'www');
const ANDROID_MANIFEST = path.join(
  NATIVE_ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'
);

const SHIPPED = expandShippedFiles(
  shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8')),
  APP_ROOT
);

function walk(root, prefix = '/') {
  if (!fs.existsSync(root)) return null;
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, `${prefix}${entry.name}/`));
    else out.push(`${prefix}${entry.name}`);
  }
  return out.sort();
}

const STAGED = walk(WWW_ROOT);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test.describe('native shell — the APK ships the web channel unchanged (LSC-P1-INV-002)', () => {
  test('the web root has been staged', () => {
    expect(
      STAGED,
      'native/www/ does not exist — run `node native/tools/stage-webdir.js` (scripts/parity-suite.sh does this for you)'
    ).not.toBeNull();
    expect(STAGED.length, 'native/www/ is empty').toBeGreaterThan(0);
  });

  test('the staged set is exactly the set app/Dockerfile ships', () => {
    // Both directions. A MISSING file 404s inside the WebView — where there is
    // no network to fall back to, so it is fatal rather than slow. An EXTRA
    // file is worse in a different way: it is content distributed in an APK
    // that no delivery guard, ship list or precache list knows about.
    const missing = SHIPPED.filter((p) => !STAGED.includes(p));
    const extra = STAGED.filter((p) => !SHIPPED.includes(p));
    expect(missing, 'shipped by app/Dockerfile but absent from the APK web root').toEqual([]);
    expect(extra, 'present in the APK web root but not shipped by app/Dockerfile').toEqual([]);
  });

  test('nginx-only machinery never reaches the APK', () => {
    // These two COPY into /etc/nginx and / respectively, so shippedPaths()
    // already excludes them — this asserts the consequence rather than the
    // mechanism, because docker-entrypoint.sh mints the /api proxy's ID token
    // and has no business inside a distributed artifact.
    for (const leaked of ['/nginx.conf', '/docker-entrypoint.sh', '/Dockerfile']) {
      expect(STAGED, `${leaked} must not be packaged into the APK`).not.toContain(leaked);
    }
  });

  for (const urlPath of SHIPPED) {
    test(`"${urlPath}" is byte-identical in both channels`, () => {
      const staged = path.join(WWW_ROOT, urlPath.replace(/^\//, ''));
      expect(fs.existsSync(staged), `${urlPath} is not staged`).toBe(true);
      expect(
        sha256(staged),
        `${urlPath} differs between app/ and the APK web root — the native path must copy, never transform (buildless, ADR-037)`
      ).toBe(sha256(path.join(APP_ROOT, urlPath.replace(/^\//, ''))));
    });
  }
});

test.describe('native shell — configuration is pinned (LSC-P1-INV-002)', () => {
  const config = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'capacitor.config.json'), 'utf8'));

  test('the application id is the owner-fixed value', () => {
    // Irreversible once distributed: the application id is the identity Android
    // installs, updates and grants storage to. A changed value is a different
    // app that cannot read the previous one's data.
    expect(config.appId).toBe('app.theygrow');
  });

  test('the web root points at the staged directory', () => {
    expect(config.webDir).toBe('www');
  });

  test('the WebView origin is pinned, not left to Capacitor defaults', () => {
    // The scheme and hostname ARE the origin, and the origin is what Web
    // Storage is keyed by. A Capacitor upgrade that changed either would orphan
    // everything in WebView storage — invisible today, destructive in L1-P3,
    // where the migration bridge (ADR-043 §5) reads exactly this origin.
    expect(config.server && config.server.androidScheme).toBe('https');
    expect(config.server && config.server.hostname).toBe('localhost');
  });

  test('the native toolchain introduces no build step into the web path', () => {
    // The web assets are copied, never built (ADR-037). This catches the shape
    // of the mistake — a bundler wired into the sync script — rather than every
    // possible tool by name.
    const pkg = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'package.json'), 'utf8'));
    const scripts = Object.values(pkg.scripts || {}).join(' ');
    for (const bundler of ['webpack', 'rollup', 'esbuild', 'vite', 'babel', 'tsc', 'terser', 'swc']) {
      expect(scripts, `native/package.json runs "${bundler}" — the web path must stay buildless`).not.toContain(bundler);
    }
  });
});

test.describe('native shell — family data does not leave the device (LSC-P1-INV-002)', () => {
  // Comments are stripped before matching. The manifest carries a comment
  // explaining why the Capacitor default `android:allowBackup="true"` was
  // changed — and it quotes that default, which the negative assertion below
  // would otherwise read as the attribute still being set. Same class of
  // false-red the nginx location scan in delivery-contract.spec.js strips for.
  const manifest = fs.readFileSync(ANDROID_MANIFEST, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

  test('Android Auto Backup is off', () => {
    // The Capacitor template ships android:allowBackup="true". This assertion
    // exists because that default uploads the app sandbox — WebView storage
    // today, the native store from L1-P2 — to the user's cloud account, which
    // is family data crossing a network boundary with no export contour, no key
    // scope and no grant model behind it.
    expect(
      manifest,
      'AndroidManifest.xml must set android:allowBackup="false" — the Capacitor default is "true"'
    ).toMatch(/android:allowBackup\s*=\s*"false"/);
    expect(manifest).not.toMatch(/android:allowBackup\s*=\s*"true"/);
  });

  test('both backup rule formats are wired and present', () => {
    // allowBackup="false" does not disable device-to-device transfer on
    // Android 12+; only dataExtractionRules does. fullBackupContent covers
    // API 24..30, which minSdkVersion 24 keeps in range. Neither is redundant.
    expect(manifest).toMatch(/android:dataExtractionRules\s*=\s*"@xml\/data_extraction_rules"/);
    expect(manifest).toMatch(/android:fullBackupContent\s*=\s*"@xml\/backup_rules"/);

    const resXml = path.join(NATIVE_ROOT, 'android', 'app', 'src', 'main', 'res', 'xml');
    for (const [file, root] of [
      ['data_extraction_rules.xml', 'data-extraction-rules'],
      ['backup_rules.xml', 'full-backup-content'],
    ]) {
      const source = fs.readFileSync(path.join(resXml, file), 'utf8');
      expect(source, `${file} must declare <${root}>`).toContain(`<${root}>`);
      // Every storage domain excluded. A rules file that referenced nothing
      // would satisfy the manifest attribute and protect nothing.
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
        expect(source, `${file} does not exclude domain="${domain}"`).toContain(`domain="${domain}"`);
      }
    }
  });

  test('the bridge does not trace plugin arguments to the device log (DIA-P5-INV-001)', () => {
    // Capacitor's default is `debug`, which resolves to "log whenever the build
    // is debuggable" — and the debug build is the one docs/RUNBOOK.md tells the
    // owner to install on the phone that holds the family's real history. Under
    // it, Bridge.callPluginMethod writes every plugin call's whole argument
    // object to logcat: measured on android-instrumented run 32044006357, 707
    // such lines, carrying the expression built from what the parent typed into
    // the search box on 5 of 5 searches, and the store's SQLCipher passphrase in
    // cleartext. A second emitter beside it — the injected JavaScript echoing
    // every plugin RESULT to the console — brought that run's totals to the
    // child's name on 31 lines and a diary body on 13.
    //
    // This is a STATIC check of a knob, and it carries no runtime claim (§11).
    // What it defends is the gap between dispatches: android-instrumented is
    // pull_request + workflow_dispatch only, so DIA-P5-INV-001's device leg can
    // be many commits behind a regression, and this key is the regression's
    // whole surface. The generated copy under native/android/.../assets/ is
    // gitignored and rewritten by `cap sync` from THIS file, so this is the one
    // place the value is owned.
    const config = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'capacitor.config.json'), 'utf8'));
    expect(
      config.android && config.android.loggingBehavior,
      'native/capacitor.config.json must set android.loggingBehavior to "none" — Capacitor\'s'
        + ' default traces every plugin call\'s arguments to logcat in any debuggable build'
    ).toBe('none');
  });
});

// EMV-P5-INV-001 — nothing under native/ names a mount version the shell does
// not run.
//
// WHAT THIS COST, AND WHY THE INVERSE PROPERTY IS THE RIGHT ONE (EMV-DL-005).
// A mount bump is COPY-FORWARD: /m/v1/ stays on disk and stays shipped, which is
// what an already-installed client is still holding. So a native-side reference
// left at the frozen mount does NOT 404 — it succeeds, against the generation
// nobody runs. EMV-P1 moved the shell to /m/v2/ and left two such references
// behind, and each failed in its own direction:
//
//   - BridgeSmokeTest imported /m/v1/store/boot.js and got a SECOND, never
//     initialised copy of the module, whose module-scoped handle is null
//     forever. Neither the handle nor the import-error branch ever resolved, so
//     the probe polled 31.4 s in silence and the job went red (run 31750267059)
//     while the app under test had opened its store in 884 ms.
//   - StoreEngineTest applied /m/v1/'s DDL and stayed GREEN, because the two
//     generations' DDL differed only in a comment naming its own path. It was
//     asserting about the frozen generation and reporting success.
//
// The property asserted is the INVERSE of "the staged root carries the current
// mount and only it", which would contradict the copy-forward invariant that
// keeps both generations shipped: what must hold is that nothing OUTSIDE the
// mount root names anything but the current generation.
//
// STATIC BY CONSTRUCTION AND SAID SO (AGENTS.md §11). This boots nothing, starts
// no emulator and carries NO runtime claim. It is a property of the tree — which
// mount version is written down where — and reading the tree is the right
// instrument for exactly that. The runtime claim about the native store is
// carried by BridgeSmokeTest on the emulator in the `android-instrumented` job,
// and nothing here substitutes for it. This guard's value is that it runs on
// EVERY PUSH in the `parity` job, whereas the emulator runs on pull_request and
// workflow_dispatch only — which is how a mount bump travelled four packets and
// three checkpoints before it met a real WebView (LSC-DL-005 debt 13).
test.describe('native shell — no stale mount address under native/ (EMV-P5-INV-001)', () => {
  const MOUNT = currentMount(
    fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'),
    'app/index.html'
  );

  // Scanned as a whole rather than at the two directories where a stale
  // reference has actually been found: the defect class is "a mount address
  // written down somewhere outside app/m/ and left behind at a bump", and a
  // scan narrowed to today's known sites would need widening the first time one
  // appears in capacitor.config.json, a Gradle file or a shell script.
  //
  // EXCLUSIONS, each because the directory is DERIVED and its content is not a
  // reference anyone maintains:
  //   node_modules/                    — third-party trees; not ours to bump.
  //   www/                             — the staged web root, gitignored. It is
  //                                      a byte copy of app/m/, so it carries
  //                                      BOTH generations by design; claim (a)
  //                                      above is what governs it.
  //   android/app/src/main/assets/     — `cap sync` output, gitignored. Same
  //                                      copy of the same both-generation tree.
  //   build/, .gradle/                 — Gradle output.
  //   capacitor-cordova-android-plugins/ — generated by `cap sync`.
  const EXCLUDED_DIRS = new Set([
    'node_modules',
    'www',
    'build',
    '.gradle',
    'capacitor-cordova-android-plugins',
  ]);
  const EXCLUDED_PATHS = new Set([
    path.join(NATIVE_ROOT, 'android', 'app', 'src', 'main', 'assets'),
  ]);

  // Captures whatever sits between `m/v` and the next `/`, rather than only
  // digits, so a mount-shaped token this guard does not model reaches the
  // assertion instead of slipping past the regex. Fails CLOSED like every other
  // parser in this corpus.
  const MOUNT_TOKEN = /\bm\/v([^/\s"'`)]*)\//g;

  function textFilesUnder(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || EXCLUDED_PATHS.has(abs)) continue;
        textFilesUnder(abs, out);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = fs.readFileSync(abs);
      // A NUL byte means binary (keystores, fonts, icons, jars). Skipped rather
      // than listed by extension: an unlisted binary type would otherwise be
      // decoded as UTF-8 and scanned as mojibake.
      if (buffer.includes(0)) continue;
      out.push([abs, buffer.toString('utf8')]);
    }
    return out;
  }

  const SCANNED = textFilesUnder(NATIVE_ROOT);

  test('the scan actually reached the native sources', () => {
    // Anti-vacuity, in the house style: an exclusion typo that emptied the walk
    // would make every assertion below pass while checking nothing. The two
    // instrumented sources that carried the defect are named explicitly.
    expect(
      SCANNED.length,
      'the native/ walk reached too few text files to be checking anything'
    ).toBeGreaterThan(10);
    const scannedPaths = SCANNED.map(([abs]) => path.relative(NATIVE_ROOT, abs));
    for (const required of [
      path.join('android', 'app', 'src', 'androidTest', 'java', 'app', 'theygrow', 'BridgeSmokeTest.java'),
      path.join('android', 'app', 'src', 'androidTest', 'java', 'app', 'theygrow', 'StoreEngineTest.java'),
      path.join('tools', 'stage-webdir.js'),
      'capacitor.config.json',
    ]) {
      expect(scannedPaths, `${required} was not reached by the scan`).toContain(required);
    }
  });

  test(`every mount address under native/ names ${MOUNT.prefix}`, () => {
    const stale = [];
    const unmodelled = [];
    for (const [abs, source] of SCANNED) {
      const where = path.relative(NATIVE_ROOT, abs);
      for (const match of source.matchAll(MOUNT_TOKEN)) {
        const line = source.slice(0, match.index).split('\n').length;
        if (!/^\d+$/.test(match[1])) {
          unmodelled.push(`native/${where}:${line} — "${match[0]}"`);
        } else if (`v${match[1]}` !== MOUNT.version) {
          stale.push(`native/${where}:${line} — "${match[0]}"`);
        }
      }
    }

    expect(
      unmodelled,
      'mount-shaped tokens this guard does not model — it fails closed rather than'
        + ' guessing which generation they mean'
    ).toEqual([]);
    expect(
      stale,
      `these name a mount version the shell does not run (the shell references ${MOUNT.prefix}).`
        + ' A copy-forward bump leaves the frozen generation shipped, so each of these'
        + ' resolves successfully against bytes nobody executes — repoint them, or derive'
        + ' the mount instead of writing it down (MountAddress.java in androidTest does'
        + ' this from the APK, currentMount() in app/tests/support/ship-list.js from the'
        + ' shell)'
    ).toEqual([]);
  });
});
