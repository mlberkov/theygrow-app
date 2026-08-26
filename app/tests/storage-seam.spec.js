'use strict';

// LSC-P1-INV-001 — WebView storage has exactly one door (L1-P1).
//
// WHAT THIS IS FOR. Milestone L1 inverts the platform: the device-native store
// becomes the source of truth and WebView storage is demoted to a cache that
// may be lost without consequence (ADR-043 §1). The native store is L1-P2 and
// the write path is L1-P3, so this packet cannot assert "family data is not in
// localStorage" — today it still is, which is exactly the state P2/P3 fix.
//
// What CAN be enforced now, and is: every access to Web Storage from the
// shipped surface goes through ONE module, the mount's `core/storage.js`, plus two
// sites in the shell that are named here individually. A new access anywhere
// else is red. That is the seam P2 swaps out — and the reason it is worth a
// gate rather than a paragraph is that the swap is only tractable if the set of
// call sites cannot quietly grow in the meantime (ADR-030 §2: invariants are
// compiled into structural checks, not left advisory).
//
// WHY MATCH ACCESS EXPRESSIONS RATHER THAN STRIP COMMENTS. The obvious
// implementation — strip comments, then grep for the identifier — is wrong
// here. Stripping `//` to end-of-line also eats the remainder of any line
// carrying a `https://` literal, so a real storage access sitting after one
// would become INVISIBLE to the scan: a guard that fails open. Matching the
// property-access form instead (`localStorage.` / `localStorage[`) needs no
// stripping at all, because the prose comments that mention storage by name in
// `surfaces/accordion.js` and `surfaces/zpd-filter.js` do not continue into an
// access. A commented-OUT access still matches, and that is intended: dead
// storage code in a surface module is drift worth seeing.
//
// Cache Storage (`caches`) is deliberately NOT scanned. It is the service
// worker's precache — precisely the losable cache the invariant permits, and
// banning it would forbid the offline boot the app already ships.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  htmlModuleEntries,
  moduleDependencies,
  currentMount,
} = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');

// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

// The Web Storage surfaces this invariant governs, in property-access form.
// `openDatabase` is the legacy WebSQL entry point: removed from Chromium, but
// naming it costs nothing and a guard that lists only what it remembered is a
// guard with a hole.
const STORAGE_ACCESS = /\b(localStorage|sessionStorage|indexedDB|openDatabase)\s*[.[]/g;

// The one door. Every persistent key the app reads or writes is declared here
// (A1-P4), which is what makes it swappable in one place in L1-P2.
const STORAGE_MODULE = `${MOUNT.prefix}core/storage.js`;

// The accesses that are NOT behind the door, declared individually rather than
// by file. SINCE UIP-P1 THE LIST IS EMPTY, for the first time since A1-P4, and
// an empty list is the strongest state this declaration can be in: every Web
// Storage key any shipped shell touches now goes through one module.
//
// THERE WERE TWO, AND BOTH LEFT THE SAME WAY — their writer was deleted, and the
// mirror assertion at the foot of this file, "every declared shell exception
// still exists", obliged the declaration to go with it rather than rot into a
// permission nobody uses.
//
//   `iosInstallDismissed` belonged to the install-prompt IIFE, which registered
//   `beforeinstallprompt` at parse time — an event no level of the parity suite
//   could observe, so the move to a module could not be proven equivalent
//   (A1-DL-006 (f)). L3-P3 removed the offer, the IIFE and the key's only writer
//   (FIU-DL-003).
//
//   `ga_debug` was read and written by the inline <head> gtag shim, before any
//   module evaluated, behind the ?dbg=1|0 switch. UIP-P1 removed analytics from
//   the web showcase entirely (vault ADR-043 annotation 2026-08-25), and the
//   shim, the switch and the key's only accessor went with it.
//
// Neither was family data and neither is a counter-example to the platform
// inversion; both were doors, which is why they were named while they existed.
// Either key may still sit in a browser that saw an older shell — nothing reads
// them, and clearing them would be a write with no reason behind it.
const DECLARED_SHELL_ACCESSES = [];

// A declared access, in the exact form the shell uses: a literal string key.
// A computed key would not match, and would therefore be reported as
// undeclared — which is the correct outcome, not a gap.
const KEYED_ACCESS =
  /\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*'([^']+)'/g;

// DIA-P1 added transfer.html — the shell with the most at stake for this
// invariant, since it ran on the production origin where localStorage holds the
// only copy of the family's history — and PPR-P2 removes it with the whole
// transfer mechanism. The scanned surface shrinks by one shell and the seam is
// unchanged: what this guard is about is that every Web Storage access in any
// shipped graph goes through one door, and the door did not move. The page's own
// property, that it read the browser and never wrote to it, is not weakened here
// — it is gone, along with the page that had to have it.
const SHIPPED_HTML = ['index.html', 'offline.html'];

const HTML_SOURCES = SHIPPED_HTML.map((file) => ({
  where: file,
  source: fs.readFileSync(path.join(APP_ROOT, file), 'utf8'),
}));

const EXEC_ENTRIES = Array.from(
  new Set(HTML_SOURCES.flatMap(({ where, source }) => htmlModuleEntries(source, `app/${where}`)))
);

// The scanned surface is exactly what the browser evaluates: the two shipped
// shells, the module entries, and everything they transitively import. Rooted
// the same way the ship-list walker is rooted, for the same reason (A1-DL-007 (d)).
const SCANNED = [
  ...HTML_SOURCES.map(({ where }) => ({ where, url: `/${where}` })),
  ...EXEC_ENTRIES.map((url) => ({ where: url.replace(/^\//, ''), url })),
  ...moduleDependencies(EXEC_ENTRIES, APP_ROOT).map((url) => ({
    where: url.replace(/^\//, ''),
    url,
  })),
];

function sourceOf(url) {
  return fs.readFileSync(path.join(APP_ROOT, url.replace(/^\//, '')), 'utf8');
}

test.describe('storage seam — WebView storage has exactly one door (LSC-P1-INV-001)', () => {
  test('the scan reaches a non-trivial surface', () => {
    // A walker that silently resolved to nothing would make every assertion
    // below vacuously green — the A1-DL-007 (d) failure mode, in a new place.
    expect(EXEC_ENTRIES.length, 'no module entry points found in the shipped shells').toBeGreaterThan(0);
    expect(SCANNED.length, 'the scanned surface collapsed to almost nothing').toBeGreaterThan(10);
    expect(
      SCANNED.map((s) => s.url),
      'the storage module itself must be inside the scanned surface, or the seam is unverified'
    ).toContain(STORAGE_MODULE);
  });

  for (const { where, url } of SCANNED) {
    if (url === STORAGE_MODULE) continue; // the door itself

    test(`"${where}" reaches Web Storage only through declared doors`, () => {
      const source = sourceOf(url);
      const hits = Array.from(source.matchAll(STORAGE_ACCESS)).map((m) => m[1]);
      if (!hits.length) return;

      // Every hit in this file must be accounted for by a DECLARED access.
      const declaredKeys = DECLARED_SHELL_ACCESSES.filter((d) => d.file === where).map((d) => d.key);
      expect(
        declaredKeys.length,
        `"${where}" touches Web Storage (${hits.join(', ')}) but declares no exception — persistent state must go through ${STORAGE_MODULE} (LSC-P1-INV-001)`
      ).toBeGreaterThan(0);

      const keyed = Array.from(source.matchAll(KEYED_ACCESS)).map((m) => m[1]);
      for (const key of keyed) {
        expect(
          declaredKeys,
          `"${where}" accesses the undeclared storage key "${key}" — add it to DECLARED_SHELL_ACCESSES with its reason, or move it behind ${STORAGE_MODULE}`
        ).toContain(key);
      }

      // Counting closes the hole the key check leaves open: a `clear()`, a
      // `length` read or a computed key produces a storage hit with no key
      // literal, so it would pass the loop above by simply not being seen.
      expect(
        keyed.length,
        `"${where}" has ${hits.length} Web Storage access(es) but only ${keyed.length} with a declarable literal key — an access this guard cannot name is an undeclared door`
      ).toBe(hits.length);
    });
  }

  test('every declared shell exception still exists', () => {
    // The mirror direction. A declared exception that no longer appears means
    // the list has rotted into a permission nobody uses — and the next person
    // reads it as sanctioned precedent.
    //
    // THE LIST IS EMPTY SINCE UIP-P1, so the loop below does not run — and a leg
    // whose whole body is a loop over an empty list reports a green for having
    // done nothing, which is the shape this repository keeps paying for. What
    // replaces the missing work is not a bare `toEqual([])` on the list itself:
    // that would red on a legitimately-added future exception before the loop
    // could ever check it, so the loop would stay dead in both states. Instead
    // the EMPTY case asserts the stronger property the empty list actually
    // means — that no shipped shell reaches Web Storage by a literal key at all,
    // so there is nothing an exception could be needed for. When the list is
    // non-empty the loop does the checking and this branch stands aside.
    if (DECLARED_SHELL_ACCESSES.length === 0) {
      const strays = HTML_SOURCES.flatMap(({ where, source }) =>
        Array.from(source.matchAll(KEYED_ACCESS)).map((m) => `${where}: ${m[1]}`)
      );
      expect(
        strays,
        'a shipped shell reaches Web Storage by a literal key while DECLARED_SHELL_ACCESSES is'
          + ` empty — declare it there with its reason, or move it behind ${STORAGE_MODULE}`
      ).toEqual([]);
      // Anti-vacuity for the branch: the scan must be looking at real shells.
      expect(HTML_SOURCES.length, 'no shipped shell was read').toBeGreaterThan(1);
      for (const { where, source } of HTML_SOURCES) {
        expect(source.length, `${where} collapsed to almost nothing`).toBeGreaterThan(2000);
      }
    }

    for (const { file, key } of DECLARED_SHELL_ACCESSES) {
      const source = fs.readFileSync(path.join(APP_ROOT, file), 'utf8');
      const keys = Array.from(source.matchAll(KEYED_ACCESS)).map((m) => m[1]);
      expect(
        keys,
        `"${key}" is declared as a shell storage exception but no longer appears in ${file} — drop the declaration`
      ).toContain(key);
    }
  });
});
