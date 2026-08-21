'use strict';

// FIU-P3-INV-003 — the web channel offers no installable app of its own.
//
// THIS GUARD IS STATIC, AND SAYS SO ABOUT ITSELF (AGENTS.md §11). It reads the
// shipped shell and the running mount's stylesheet and boots nothing. What it
// carries is an ABSENCE — a property of the tree, which is the admissible kind
// of static claim: no install banner in the markup, no `beforeinstallprompt`
// path in the script, no rules left behind for elements that no longer exist,
// and no `<link rel="manifest">` in the shell. It carries no runtime claim, and
// there is nothing here for a runtime test to claim instead: the thing being
// asserted is that a surface does not exist. The nearest executing neighbour is
// app/tests/behavior.spec.js's hidden-cascade sweep, which answers a different
// question — that what DOES exist and ships hidden stays hidden.
//
// WHY THE MANIFEST LINE IS PART OF THE SAME ASSERTION. `beforeinstallprompt`
// fires only for a page whose manifest declares `display: standalone`. Deleting
// our banner while leaving the link would not remove the offer; it would hand
// it to the browser's own install UI, uncontrolled by us. The two therefore go
// together or neither goes (FIU-DL-003).
//
// WHAT IS DELIBERATELY NOT ASSERTED: that `/manifest.json` is absent. The file
// stays on disk, stays in app/Dockerfile's COPY list, stays served by nginx and
// stays in the worker's OFFLINE_URLS, so a client that already installed the
// PWA keeps a working manifest. app/tests/delivery-contract.spec.js still
// covers it as a served asset; the direction that matters there is
// shell-references ⊆ OFFLINE_URLS ⊆ shipped, never the reverse, so a served
// file the shell no longer names is green by construction.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');

// The mount the shell references, never a literal — a copy-forward bump leaves
// the frozen generation on disk, correctly carrying the old rules (EMV-DL-001).
const MOUNT = currentMount(SHELL);
const CSS = fs.readFileSync(path.join(APP_ROOT, 'm', MOUNT.dir, 'app.css'), 'utf8');

// Comments are stripped before matching, so the removal can be EXPLAINED in the
// files it touches without the explanation reading as the thing it removed.
// Same technique as app/tests/native-shell.spec.js:177.
const SHELL_CODE = SHELL.replace(/<!--[\s\S]*?-->/g, '');
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const FORBIDDEN_IN_SHELL = [
  'beforeinstallprompt',
  'deferredPrompt',
  'appinstalled',
  'installBanner',
  'installBtn',
  'installDismiss',
  'iosBanner',
  'iosDismiss',
  'iosInstallDismissed',
];

test.describe(`the web channel offers no installable app of its own — /m/${MOUNT.dir}/ (FIU-P3-INV-003, static)`, () => {
  test('the scan is looking at the real shell and the running mount', () => {
    // Anti-vacuity. A guard whose whole content is "these strings are absent"
    // is green against an empty string, which is the failure shape this
    // milestone keeps paying for (AGENTS.md §11).
    expect(SHELL_CODE.length, 'the shell collapsed to almost nothing').toBeGreaterThan(10000);
    expect(CSS_CODE.length, 'the mount stylesheet collapsed to almost nothing').toBeGreaterThan(10000);
    // Two surfaces that MUST still be there, so "absent" is a fact about these
    // strings and not about the reader: the update banner (a different banner,
    // deliberately kept) and the download offer.
    expect(SHELL_CODE).toContain('id="updateBanner"');
    expect(SHELL_CODE).toContain('id="apkBtn"');
    expect(CSS_CODE).toContain('#updateBanner.visible');
  });

  for (const token of FORBIDDEN_IN_SHELL) {
    test(`app/index.html carries no "${token}"`, () => {
      expect(
        SHELL_CODE,
        `"${token}" is back in the shell — the web channel is a showcase and an entry point, not an app that offers to install itself (PDR-034 §1, FIU-DL-003)`
      ).not.toContain(token);
    });
  }

  test('app/index.html links no web-app manifest', () => {
    const links = Array.from(SHELL_CODE.matchAll(/<link\b([^>]*)>/gi)).map((m) => m[1]);
    const manifestLinks = links.filter((attrs) => /\brel\s*=\s*["']manifest["']/i.test(attrs));
    expect(
      manifestLinks,
      'the shell links a web-app manifest again — with one, the browser can offer the install itself, which is the offer this packet removed (FIU-DL-003)'
    ).toEqual([]);
  });

  for (const selector of ['#installBanner', '#iosBanner', '#installBtn', '#iosDismiss', '#installDismiss']) {
    test(`the mount stylesheet carries no rule for ${selector}`, () => {
      expect(
        CSS_CODE,
        `${selector} has rules but no element — a stylesheet that still dresses a deleted surface is how the surface comes back`
      ).not.toContain(selector);
    });
  }
});
