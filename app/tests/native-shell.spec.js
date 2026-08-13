'use strict';

// LSC-P1-INV-002 — the native channel ships the web channel's bytes unchanged,
// and exports nothing off the device (L1-P1).
//
// TWO CLAIMS, ONE FILE, because they are the two halves of "the Android shell
// is a shell":
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
// This spec reads native/www/ AS IT STANDS and deliberately does NOT stage it
// first: staging inside the test would wipe a hand-added file moments before
// checking for hand-added files, and the assertion would be tautological.
// scripts/parity-suite.sh stages before running, and the failure message below
// says so.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const { shippedPaths, expandShippedFiles } = require('./support/ship-list');

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
});
