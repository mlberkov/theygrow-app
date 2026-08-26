'use strict';

// LSC-P1-INV-002 — the native channel ships the web channel's bytes unchanged,
// and exports nothing off the device (L1-P1).
//
// FIVE CLAIMS, ONE FILE. The first two are the two halves of "the Android
// shell is a shell"; the third (EMV-P5-INV-001) is what keeps the native side
// pointed at the generation the shell actually runs; the fourth (DIA-P5-INV-001)
// pins the knob that stops the framework beneath the shell writing the family's
// data to the device log; the fifth (FIU-P1-INV-002) pins the knob that closes
// the OTHER door into the same build:
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
//  (e) NO REMOTE WEBVIEW INSPECTION. The same `isDebug` default reaches a
//      second, independent knob: CapConfig.java:286 resolves
//      webContentsDebuggingEnabled from FLAG_DEBUGGABLE and Bridge.java:618
//      hands it to WebView.setWebContentsDebuggingEnabled. `loggingBehavior`
//      does nothing to it — different sink, same build, same phone: an
//      authorised adb connection reaches the DOM, the JS heap and WebView
//      storage over chrome://inspect. Pinned here for the reason (d) is pinned
//      here: one JSON key that a toolchain upgrade or a careless `cap sync`
//      could reshape, on a gate that runs every push while the device leg runs
//      on dispatch only. The device half is WebInspectionTest; this half is
//      static, and neither of them executes "chrome://inspect finds nothing" —
//      the WebView exposes no getter for the flag it was handed, so what is
//      checkable is the value that reaches it (DIA-DL-010 debt 12, FIU-DL-001).
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

  test('the build does not expose the WebView to chrome://inspect (FIU-P1-INV-002)', () => {
    // A SECOND KNOB WITH THE SAME DEFAULT AND A DIFFERENT SINK. The test above
    // pins loggingBehavior, which closes logcat. It does nothing at all to this
    // one: CapConfig.java:286 resolves `android.webContentsDebuggingEnabled`
    // from FLAG_DEBUGGABLE independently, and Bridge.java:618 hands the result
    // to WebView.setWebContentsDebuggingEnabled. Left at the default, the build
    // docs/RUNBOOK.md tells the owner to install on the phone that holds the
    // family's real history answers chrome://inspect over an authorised adb
    // connection with the DOM, the JS heap and WebView storage — the store's
    // contents included, decrypted, because the WebView is on the inside of the
    // encryption boundary.
    //
    // `false` EXPLICITLY, not "absent and therefore false". Absent is exactly
    // the state that produced the exposure: the resolver's default argument is
    // `isDebug`, so an unset key means ON in the build that matters.
    //
    // This is a STATIC check of a knob and it carries no runtime claim (§11).
    // Its device twin is WebInspectionTest, on the emulator, which reads what
    // the bridge actually parsed out of the APK's own generated asset. NEITHER
    // executes "chrome://inspect finds nothing": android.webkit.WebView has a
    // static setter and no getter, so the flag's effect is not readable by any
    // test this repository can write. What is checkable is the value that
    // reaches the setter, and that is what both legs check.
    const config = JSON.parse(fs.readFileSync(path.join(NATIVE_ROOT, 'capacitor.config.json'), 'utf8'));
    expect(
      config.android && config.android.webContentsDebuggingEnabled,
      'native/capacitor.config.json must set android.webContentsDebuggingEnabled to false —'
        + ' Capacitor defaults it to the debuggable flag, which exposes the DOM, the JS heap'
        + ' and WebView storage over chrome://inspect on the build the owner installs'
    ).toBe(false);
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

// ---------------------------------------------------------------------------
// (f) THE LAUNCHER ICON IS THE PRODUCT'S, IN EVERY FORM ANDROID USES (UIP-P5).
//
// The sixth claim in this file, and the first one about a BITMAP rather than a
// literal. Until UIP-P5 all fifteen launcher bitmaps were the stock Capacitor
// mark — a blue "X" on a faint grid — and had been since `npx cap add android`
// wrote them at L1-P1. Nothing noticed, because nothing looked: the manifest
// pointed at resource names that existed, the build was green, and the only
// place the difference showed was a parent's home screen.
//
// So this guard exists to make "the icon is ours" a property of the tree. Three
// separate failures, each of which has actually happened to somebody:
//
//   * a REGENERATION THAT SILENTLY DID NOTHING — the assets are still the
//     template's. Caught by CAPACITOR_PLACEHOLDER, a pinned list of the fifteen
//     digests that shipped before this packet. That list never expires and is
//     never rewritten: those bytes are wrong forever, whatever replaces them.
//   * a REGENERATION THAT WROTE THE WRONG THING — one density everywhere, a
//     half-finished run, a hand-edited PNG. Caught by EXPECTED (per-file digest,
//     the "is the intended image" claim) and by the IHDR dimensions read out of
//     the file's own bytes, which is the one thing here that does not need the
//     digest to be right to be worth checking.
//   * a MASTER THAT MOVED OUT FROM UNDER THE DERIVED SET — the owner supplies a
//     corrected logo and the icons are not regenerated. Caught by pinning
//     app/icons/icon-master-1024.png's digest, so the source and its fifteen
//     derivatives can only drift apart loudly.
//
// WHY BYTES AND NOT PIXELS. This file is `fs` + `crypto` and no image library,
// deliberately — the `contract` project runs on every push and installs nothing
// beyond Playwright. Pixel-level re-derivation from the master is
// `python3 native/tools/gen-launcher-icons.py --check`, which needs Pillow and
// is therefore a developer/owner command, written down in docs/RUNBOOK.md and
// named in UIP-P5-INV-001's Scope rather than quietly assumed to run.
//
// THIS GUARD IS STATIC AND CARRIES NO RUNTIME CLAIM (AGENTS.md §11). It reads
// files and boots nothing. That the resources COMPILE is the `android` job's
// `assembleDebug` on every push; that a launcher renders them correctly under
// its own mask is a phone, and nothing here substitutes for either.
test.describe('native shell — the launcher icon is the product\'s, in every form (UIP-P5-INV-001)', () => {
  const RES = path.join(NATIVE_ROOT, 'android', 'app', 'src', 'main', 'res');
  const MASTER = path.join(APP_ROOT, 'icons', 'icon-master-1024.png');

  // The brand master every one of the fifteen is derived from (owner decision
  // 2026-08-25, item 9). Pinned in TWO places on purpose — here and in
  // native/tools/gen-launcher-icons.py — so a swap that updates one of them and
  // not the other cannot pass quietly.
  const MASTER_SHA256 = '46d27cf42368cf5934ae1e998b902ce7bda327b80f9555b2bcbac332a6bd3bcd';

  // densityBucket -> [legacy px, adaptive foreground px]. 48dp and 108dp at
  // 1x/1.5x/2x/3x/4x; these are also exactly the sizes the template shipped, so
  // a wrong number here is a wrong number, not a convention change.
  const DENSITIES = {
    mdpi: [48, 108],
    hdpi: [72, 162],
    xhdpi: [96, 216],
    xxhdpi: [144, 324],
    xxxhdpi: [192, 432],
  };

  // What shipped BEFORE UIP-P5. Never update this list — extend it, if some
  // other template's placeholder ever gets in.
  const CAPACITOR_PLACEHOLDER = new Set([
    '27ed3603010ebc278f64f8645741ab132ff517abb5308eb9df6c8e42a48956b2', // mdpi   ic_launcher
    '58e78a618778926b1f6d9472a6468de878de8530970934e94aab5ba4ba08cc00', // mdpi   foreground
    '0166fc333074c373fbd0ce6b5defd71552166165ac778121ca9c9dff6b83f0fc', // mdpi   round
    '72b71c3581ca3b5a23b1c168d69b9d855b3f184fa079902a01f088eb4f0607d5', // hdpi   ic_launcher
    '32baa10d2632a4417454a579f992bd640e0a3cec79321423559b2c9940de58a9', // hdpi   foreground
    'bfcc1b0fa931b14bb241372c76ab4f04374b67d02363c98d9cb12edfdacdf5f3', // hdpi   round
    'd35dbfff175b83c13ef59cf924abfc810f7b6a158595d7417c5498ea8c7c7ed1', // xhdpi  ic_launcher
    '6f88083b8166cc559102f7044688de7525287632ebe09ac45d001ac8bf4b3eae', // xhdpi  foreground
    '40911a00922868686854a4804b93fd6e56b503664696de03f450bff690affb6d', // xhdpi  round
    'ed346eb1e3f0280f15709393705899b3ff55c20b88f4e0308006b3c33cf5fe14', // xxhdpi ic_launcher
    '4a82bc1e9923576275869998925ce0ae021a79aa18b24a0dd87ad6b61ca85053', // xxhdpi foreground
    '1ee4cd9ff371dcb2e3938097e434f6fb8731688ed7165e61fc63693ad5b2f455', // xxhdpi round
    '87cb2f2ffe992652bb4fa768c73719a37b5852ab17fbf8e170e888f7a42b0761', // xxxhdpi ic_launcher
    'bd24fd383253bf8d43f0a81f11c071d76d1d555114376dd647cd9fb38fa0a9da', // xxxhdpi foreground
    'ab93096331e7cd8ec379f73f1e9adcaaa9ee1115c9f4ff10411a811fb9700174', // xxxhdpi round
  ]);

  // What the master derives today, on the toolchain UIP-DL-005 records. A
  // deliberate regeneration moves these AND the table in that decision entry.
  const EXPECTED = {
    'mipmap-mdpi/ic_launcher.png': '6776c0ab05c2794a839abc8131a4294a812958685c1da75fc91b071503c62259',
    'mipmap-mdpi/ic_launcher_foreground.png': '160b9063f9c4f2e6916bb863d2342bd2f3382b8948a03568185e3b64be732263',
    'mipmap-mdpi/ic_launcher_round.png': '87df0a4496b0a09048b282c61c0adcad1db10df38906289abd6d7630f9346f43',
    'mipmap-hdpi/ic_launcher.png': '3c59e913f8a66b956d55cb31c7f9ea74ad4967af434520985c8fb8e79fb9ee3b',
    'mipmap-hdpi/ic_launcher_foreground.png': 'bbde1f59e7e8a28cc9297343b5d2e78790befe9a7e69dc1516627ed6375ce8f7',
    'mipmap-hdpi/ic_launcher_round.png': '16c3c49613da509574aa6718d8ae3408065ce173b923e32e8e2b98f444b7f194',
    'mipmap-xhdpi/ic_launcher.png': 'ac37d7d8a7964a5264c1ee2b1721a407cfc1bb6d890014183b97d63466080264',
    'mipmap-xhdpi/ic_launcher_foreground.png': '673d5fa68c29349e6d0c07eb8fa5f968366e87ad4bfedd8eb8edfccc308905c1',
    'mipmap-xhdpi/ic_launcher_round.png': 'ad65389764fe35118dd2880c824cb310ce420f69c9faf3f1cf7e35e650671235',
    'mipmap-xxhdpi/ic_launcher.png': 'c42e905baf046a6613afc899e6fef346e7b53fd50eafbaa55a53678ba419c4f7',
    'mipmap-xxhdpi/ic_launcher_foreground.png': 'a1d0f143012a36bc6200c17790f0b9a13ffa1a5964857c35f98d1a0caf023722',
    'mipmap-xxhdpi/ic_launcher_round.png': 'dd9238f859ad4e17b9ac955a6e85fb85ed4f8757b52b37cd38219897cc90b31d',
    'mipmap-xxxhdpi/ic_launcher.png': 'a53021a24accaa81523e91453521d3ddec00a55a26518125e439f332a9db30e8',
    'mipmap-xxxhdpi/ic_launcher_foreground.png': '0bf41f4bc2d4f121a006981bd0bf588d313447c27b0dd4c819a89c766c93088e',
    'mipmap-xxxhdpi/ic_launcher_round.png': '3ebcfc4ea5e880a07f010c419bf6bfea761d3f32efd7771a1ce5b428e70f1a39',
  };

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Read the dimensions out of the file's OWN bytes rather than trusting a
  // filename or a digest: IHDR is the first chunk a PNG must carry, so width
  // and height sit at fixed offsets 16..24, big-endian.
  function pngSize(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
    if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  const BITMAPS = [];
  for (const [bucket, [legacy, foreground]] of Object.entries(DENSITIES)) {
    BITMAPS.push([`mipmap-${bucket}/ic_launcher.png`, legacy]);
    BITMAPS.push([`mipmap-${bucket}/ic_launcher_round.png`, legacy]);
    BITMAPS.push([`mipmap-${bucket}/ic_launcher_foreground.png`, foreground]);
  }

  const manifest = fs.readFileSync(ANDROID_MANIFEST, 'utf8');

  test('the icon set is fully enumerated, and the guard is comparing something', () => {
    // Anti-vacuity, in this file's house style. A typo that emptied the tables
    // would make every assertion below pass while checking nothing, and the
    // placeholder list going empty would make the whole point of the block
    // vanish silently.
    expect(BITMAPS.length, 'the density x form matrix is incomplete').toBe(15);
    expect(CAPACITOR_PLACEHOLDER.size, 'the placeholder list must hold all fifteen').toBe(15);
    expect(Object.keys(EXPECTED).length, 'the expected-digest table must cover all fifteen').toBe(15);
    for (const [rel] of BITMAPS) {
      // toContain over the key list, NOT toHaveProperty: these keys carry `/`
      // and `.`, and toHaveProperty reads a dotted string as a nested path, so
      // `mipmap-mdpi/ic_launcher.png` would be looked up as a `png` field of an
      // `ic_launcher` field. It reds on a table that is completely correct.
      expect(Object.keys(EXPECTED), `${rel} has no expected digest`).toContain(rel);
    }
    for (const digest of [...CAPACITOR_PLACEHOLDER, ...Object.values(EXPECTED)]) {
      expect(digest, `not a sha256: ${digest}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the brand master is present and is the one the icons were derived from', () => {
    // Provenance. If the owner supplies a corrected logo, this reds and forces a
    // regeneration rather than letting the source and its derivatives drift.
    expect(fs.existsSync(MASTER), `the brand master is missing: ${MASTER}`).toBe(true);
    expect(
      sha256(MASTER),
      'app/icons/icon-master-1024.png changed — regenerate the launcher icons'
        + ' (python3 native/tools/gen-launcher-icons.py) and move BOTH pins:'
        + ' this file and native/tools/gen-launcher-icons.py'
    ).toBe(MASTER_SHA256);

    const generator = path.join(NATIVE_ROOT, 'tools', 'gen-launcher-icons.py');
    expect(fs.existsSync(generator), 'the committed generator is missing').toBe(true);
    const source = fs.readFileSync(generator, 'utf8');
    expect(source, 'the generator no longer names the master').toContain('icon-master-1024.png');
    expect(source, 'the generator no longer pins the master digest').toContain(MASTER_SHA256);
  });

  test('every density and variant exists, at the right size, and is the intended image', () => {
    const problems = [];
    for (const [rel, expectedPx] of BITMAPS) {
      const abs = path.join(RES, rel);
      if (!fs.existsSync(abs)) {
        problems.push(`${rel}: missing`);
        continue;
      }
      const size = pngSize(abs);
      if (size === null) {
        problems.push(`${rel}: not a PNG (no signature or no IHDR)`);
        continue;
      }
      if (size.width !== expectedPx || size.height !== expectedPx) {
        problems.push(`${rel}: ${size.width}x${size.height}, expected ${expectedPx}x${expectedPx}`);
        continue;
      }
      const digest = sha256(abs);
      if (CAPACITOR_PLACEHOLDER.has(digest)) {
        problems.push(`${rel}: still the Capacitor placeholder`);
      } else if (digest !== EXPECTED[rel]) {
        problems.push(`${rel}: ${digest.slice(0, 16)}…, expected ${EXPECTED[rel].slice(0, 16)}…`);
      }
    }
    expect(
      problems,
      'the launcher icon set does not match the brand master. Regenerate with'
        + ' `python3 native/tools/gen-launcher-icons.py`, verify with `--check`, and'
        + ' move the digests here and in docs/decision-log.md (UIP-DL-005) together'
    ).toEqual([]);
  });

  test('no two of the fifteen are the same file', () => {
    // A generator that wrote one size into every bucket, or one form into all
    // three names, produces a set that passes "exists" and "is not the
    // placeholder" and is still wrong. Digest collision across the set is the
    // cheapest way to say so, and it does not depend on EXPECTED being right.
    const seen = new Map();
    const collisions = [];
    for (const [rel] of BITMAPS) {
      const abs = path.join(RES, rel);
      if (!fs.existsSync(abs)) continue;
      const digest = sha256(abs);
      if (seen.has(digest)) collisions.push(`${seen.get(digest)} == ${rel}`);
      else seen.set(digest, rel);
    }
    expect(collisions, 'these launcher assets are byte-identical to each other').toEqual([]);
  });

  test('the manifest, the adaptive wiring and the background colour agree', () => {
    // Asserted against the MANIFEST rather than a hard-coded list, so the claim
    // is "every variant the manifest references exists" and not "these files
    // exist". A manifest repointed at a name nobody generated reds here.
    const icon = manifest.match(/android:icon="@mipmap\/([\w]+)"/);
    const round = manifest.match(/android:roundIcon="@mipmap\/([\w]+)"/);
    expect(icon, 'AndroidManifest.xml declares no @mipmap android:icon').not.toBeNull();
    expect(round, 'AndroidManifest.xml declares no @mipmap android:roundIcon').not.toBeNull();
    expect(icon[1]).toBe('ic_launcher');
    expect(round[1]).toBe('ic_launcher_round');

    for (const name of [icon[1], round[1]]) {
      // API 26+ resolves the anydpi-v26 XML; API 24-25 falls back to the
      // bitmaps, which minSdkVersion = 24 makes a real path and not a relic.
      const adaptive = path.join(RES, 'mipmap-anydpi-v26', `${name}.xml`);
      expect(fs.existsSync(adaptive), `${name} has no adaptive icon for API 26+`).toBe(true);
      const xml = fs.readFileSync(adaptive, 'utf8');
      expect(xml, `${name}.xml declares no foreground`).toMatch(/<foreground android:drawable="@mipmap\/ic_launcher_foreground"\s*\/>/);
      expect(xml, `${name}.xml declares no background`).toMatch(/<background android:drawable="@color\/ic_launcher_background"\s*\/>/);
      for (const bucket of Object.keys(DENSITIES)) {
        expect(
          fs.existsSync(path.join(RES, `mipmap-${bucket}`, `${name}.png`)),
          `${name} is missing its ${bucket} bitmap, which API 24-25 falls back to`
        ).toBe(true);
      }
    }

    const colours = fs.readFileSync(path.join(RES, 'values', 'ic_launcher_background.xml'), 'utf8');
    expect(
      colours,
      '@color/ic_launcher_background is what both adaptive icons composite the'
        + ' foreground over — an undefined colour is a build failure, a changed one'
        + ' is a brand decision'
    ).toMatch(/<color name="ic_launcher_background">#FFFFFF<\/color>/);
  });

  test('no launcher resource sits in the tree that nothing references', () => {
    // The Capacitor/Android-Studio template also left drawable/ic_launcher_background.xml
    // (a teal grid) and drawable-v24/ic_launcher_foreground.xml (a gradient),
    // referenced by NOTHING: the adaptive icons name @color/ and @mipmap/, not
    // @drawable/. They compiled into every APK for four milestones. Deleted at
    // UIP-P5; this is what keeps them deleted and catches the next one.
    const referenced = new Set(['mipmap:ic_launcher', 'mipmap:ic_launcher_round']);
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const xml = fs.readFileSync(path.join(RES, 'mipmap-anydpi-v26', `${name}.xml`), 'utf8');
      for (const m of xml.matchAll(/@(\w+)\/(\w+)/g)) referenced.add(`${m[1]}:${m[2]}`);
    }

    const orphans = [];
    for (const dir of fs.readdirSync(RES, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      // `values` files DECLARE resources, they are not resources named by their
      // filename — @color/ic_launcher_background lives in one and is checked above.
      const type = dir.name.split('-')[0];
      if (type === 'values') continue;
      for (const entry of fs.readdirSync(path.join(RES, dir.name))) {
        if (!entry.startsWith('ic_launcher')) continue;
        const name = entry.replace(/\.(png|xml|webp)$/, '');
        if (!referenced.has(`${type}:${name}`)) {
          orphans.push(`${dir.name}/${entry} — nothing references @${type}/${name}`);
        }
      }
    }
    expect(
      orphans,
      'launcher resources reachable from no reference. They still compile into'
        + ' the APK and they still look like the icon to a reader — delete them,'
        + ' or reference them on purpose'
    ).toEqual([]);
  });
});
