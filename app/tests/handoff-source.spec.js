'use strict';

// DIA-P1-INV-001, LEG (a) — the handoff page cannot write to the browser source.
// STATIC. It reads the tree and boots nothing (AGENTS.md §11).
//
// READ THIS FIRST: LEG (a) ALONE DOES NOT CARRY THIS INVARIANT, AND IS NOT MEANT
// TO. It proves a property of a set of files — that no writer is imported and no
// write is called. Whether the page, when a real browser runs it and a parent
// presses the button, leaves localStorage exactly as it found it is a
// BEHAVIOUR, and behaviours are established by executing them. That is leg (b),
// app/tests/handoff-transfer.spec.js, which seeds a real source, presses the
// button and compares the whole of storage before and after. Each leg reds on
// its own failure and neither substitutes for the other; the export guard that
// asserted markup for a surface no user could reach (EMV-DL-001) is what this
// arrangement exists to avoid repeating.
//
// WHAT IS AT STAKE, so the strictness reads as proportionate. The browser's
// localStorage under the production origin holds the ONLY copy of this family's
// history — not the freshest copy, the only one. The app's own store is empty
// until this transfer succeeds, which is why the transfer exists. The band
// invariant of the whole milestone is that no code in it clears or mutates that
// source; the importer already holds its half (LSC-P4-INV-002 property 3), and
// this is the other half, over the page that stands in front of it.
//
// THE STRONGEST FORM AVAILABLE IS THE IMPORT ONE, AND IT IS WHAT IS ASSERTED.
// "Does not call a writer" is weaker than "does not import one": a module that
// never imports a writer cannot become a door by a later edit to its body, so
// the property survives edits nobody reviews carefully. core/storage.js is the
// single declared door (LSC-P1-INV-001) and it exports readers and writers side
// by side, so the check is on the SPECIFIERS, not on the module.
//
// THE ONE THAT WOULD HAVE BITTEN. app.js — the app's own entry — calls
// removeOrphanedAgeFilter() at boot, a localStorage.removeItem. A handoff page
// implemented as a route inside index.html, or one that reused the app entry to
// "get the profile loading for free", would therefore have written to the source
// on every open, before the parent pressed anything. The shell being separate is
// what prevents it, and the entry assertion below is what keeps it separate.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const {
  htmlModuleEntries,
  htmlPreloadHints,
  moduleDependencies,
  currentMount,
} = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = 'transfer.html';
const SHELL_SOURCE = fs.readFileSync(path.join(APP_ROOT, SHELL), 'utf8');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

// The page's own execution roots, and everything they import — the same rooting
// the ship-list walker and the storage seam use, for the same reason: a hint is
// not an evaluation root, and rooting anywhere else makes the walk collapse
// (A1-DL-007 (d)).
const ENTRIES = htmlModuleEntries(SHELL_SOURCE, `app/${SHELL}`);
const HINTS = htmlPreloadHints(SHELL_SOURCE, `app/${SHELL}`);
const GRAPH = [...ENTRIES, ...moduleDependencies(ENTRIES, APP_ROOT)];

const SOURCES = [
  { where: `app/${SHELL}`, source: SHELL_SOURCE },
  ...GRAPH.map((url) => ({
    where: url,
    source: fs.readFileSync(path.join(APP_ROOT, url.replace(/^\//, '')), 'utf8'),
  })),
];

// Every mutating Web Storage verb, in property-access form. Matching the access
// expression rather than stripping comments is deliberate and is the lesson
// app/tests/storage-seam.spec.js records: stripping `//` to end of line also
// eats the rest of any line carrying an `https://` literal, so a real write
// sitting after one would become invisible — a guard that fails open.
const WRITE_ACCESS =
  /\b(?:localStorage|sessionStorage)\s*\.\s*(setItem|removeItem|clear)\s*\(/g;

// Any Web Storage access at all, mutating or not. Counted so an access whose
// verb this guard cannot NAME — a computed method, a destructured one, a
// `length` read — cannot pass by being unrecognised.
const ANY_ACCESS = /\b(?:localStorage|sessionStorage|indexedDB|openDatabase)\s*[.[]/g;

// The one read the page is allowed, and the module it must come from.
const STORAGE_MODULE = `${MOUNT.prefix}core/storage.js`;
const ALLOWED_READ_BINDINGS = ['readProfilesRaw'];

function importedBindings(source, fromSuffix) {
  const out = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!match[2].endsWith(fromSuffix)) continue;
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

test.describe('handoff source — the page reads the browser and never writes to it (DIA-P1-INV-001 leg a)', () => {
  test('the walk reaches the page and its whole graph', () => {
    // A walk that collapsed would make every assertion below vacuously green.
    expect(ENTRIES.length, 'transfer.html declares no module entry').toBeGreaterThan(0);
    expect(SOURCES.length, 'the handoff graph collapsed to almost nothing').toBeGreaterThan(3);
    expect(
      GRAPH,
      'the handoff graph does not reach the storage door — then this guard is watching nothing'
    ).toContain(STORAGE_MODULE);
  });

  test('the page does not boot the app entry', () => {
    // THE LOAD-BEARING ONE. app.js calls removeOrphanedAgeFilter() at boot,
    // which is a localStorage.removeItem against the only copy of the family's
    // history. Reaching it from here — as an entry, as a hint, or as an import
    // anywhere in the graph — would make this page a writer before the parent
    // touched anything.
    const appEntry = `${MOUNT.prefix}app.js`;
    expect(
      ENTRIES,
      `app/${SHELL} executes ${appEntry}, whose boot writes to localStorage`
    ).not.toContain(appEntry);
    expect(
      GRAPH,
      `${appEntry} is reachable from app/${SHELL}, and its boot writes to Web Storage`
    ).not.toContain(appEntry);

    // ASSERTED ON WHAT THE SHELL NAMES, PARSED — never on a substring of the
    // file. The first form of this check was `SHELL_SOURCE.includes(...)`, and
    // it red on the shell's own COMMENT explaining that it does not do this:
    // the over-matching-substring class AGENTS.md §11 records as the second of
    // the four L1 defects, reproduced here inside the guard meant to prevent
    // the class. The named set is entries plus delivery hints, which is exactly
    // the set A1-P6-INV-001's classifier says a shell may name.
    const named = [...ENTRIES, ...HINTS];
    expect(
      named.filter((url) => url.endsWith('sw-register.js')),
      `app/${SHELL} names a service-worker registrar; the origin already has a worker`
    ).toEqual([]);
    expect(
      named.filter((url) => url.endsWith('/app.js')),
      `app/${SHELL} names the app entry, whose boot writes to Web Storage`
    ).toEqual([]);
  });

  test('no module in the handoff graph imports a writer from the storage door', () => {
    // Stronger than "calls no writer": a module that never imports one cannot
    // become a door by a later edit to its body. Same form as LSC-P4-INV-002
    // property (3), over the other half of the same source.
    const imported = [];
    for (const { where, source } of SOURCES) {
      for (const binding of importedBindings(source, 'core/storage.js')) {
        if (!ALLOWED_READ_BINDINGS.includes(binding)) imported.push(`${where} imports ${binding}`);
      }
    }
    expect(
      imported,
      'the handoff graph imports a binding from core/storage.js that is not on its'
        + ` read-only allowlist (${ALLOWED_READ_BINDINGS.join(', ')}). Under the production`
        + ' origin, localStorage is the only copy of this family history.'
    ).toEqual([]);
  });

  test('no module in the handoff graph writes to Web Storage', () => {
    const writes = [];
    for (const { where, source } of SOURCES) {
      // The declared door is exempt, and the exemption is the point rather than
      // a hole: core/storage.js IS where the writers live (LSC-P1-INV-001), and
      // it is in this graph because the page imports its READER. The property
      // asserted here is that nothing in the graph CALLS a write — the test
      // above is what keeps the door's writers from being imported in the
      // first place, which is the stronger of the two and the reason both exist.
      if (where === STORAGE_MODULE) continue;
      for (const match of source.matchAll(WRITE_ACCESS)) {
        writes.push(`${where} calls ${match[1]}`);
      }
    }
    expect(
      writes,
      'the handoff page must read the browser and leave it exactly as it found it'
    ).toEqual([]);
  });

  test('every Web Storage access in the graph is one this guard could name', () => {
    // FAIL-CLOSED, and the reason it is separate from the check above: the write
    // pattern can only find verbs it knows. An access through a computed method
    // name, a destructured reference or a property read would be invisible to
    // it and would look like a pass. So every access is counted, and the total
    // must be accounted for by accesses whose verb was actually named.
    const named = [];
    const all = [];
    for (const { where, source } of SOURCES) {
      // The declared door is exempt: core/storage.js IS the writer module, and
      // the property asserted here is that the handoff graph does not import
      // those writers — not that the door stops having them.
      if (where === STORAGE_MODULE) continue;
      for (const match of source.matchAll(ANY_ACCESS)) all.push(`${where}: ${match[0]}`);
      for (const match of source.matchAll(WRITE_ACCESS)) named.push(`${where}: ${match[0]}`);
      for (const match of source.matchAll(/\b(?:localStorage|sessionStorage)\s*\.\s*getItem\s*\(/g)) {
        named.push(`${where}: ${match[0]}`);
      }
    }
    expect(
      all.length,
      `the handoff graph touches Web Storage ${all.length} times but only ${named.length}`
        + ' of those accesses have a verb this guard can name. An access it cannot name is'
        + ` not an access it has cleared: ${all.join(', ')}`
    ).toBe(named.length);
  });

  test('the guard reds on a write it has not seen before', () => {
    // SELF-PROVING. The assertions above are green against an empty set, and
    // would stay green if the patterns matched nothing at all — so the patterns
    // are fired here at inputs this test builds, in the three shapes a write
    // actually takes.
    const setItem = "localStorage.setItem('childDevTracker_profiles', '[]');";
    const removeItem = "localStorage.removeItem('childDevTracker_profiles');";
    const clear = 'localStorage.clear();';
    for (const [label, snippet] of [
      ['setItem', setItem],
      ['removeItem', removeItem],
      ['clear', clear],
    ]) {
      expect(
        Array.from(snippet.matchAll(WRITE_ACCESS)).length,
        `the write pattern does not see a ${label} call`
      ).toBe(1);
    }
    // …and an access it cannot name is still SEEN by the counting pattern, which
    // is what makes the fail-closed check above meaningful.
    const computed = "localStorage['set' + 'Item']('k', 'v');";
    expect(
      Array.from(computed.matchAll(ANY_ACCESS)).length,
      'a computed-key access is invisible to the counting pattern'
    ).toBe(1);
    expect(
      Array.from(computed.matchAll(WRITE_ACCESS)).length,
      'a computed-key access must NOT be nameable, or the fail-closed check proves nothing'
    ).toBe(0);

    // The import check fires too, against the writer the page would most
    // plausibly reach for.
    expect(
      importedBindings(
        "import { readProfilesRaw, writeProfilesJson } from '../core/storage.js';",
        'core/storage.js'
      )
    ).toEqual(['readProfilesRaw', 'writeProfilesJson']);
  });
});
