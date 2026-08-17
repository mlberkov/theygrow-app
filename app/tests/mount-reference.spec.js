'use strict';

// DIA-P1-INV-003 (half a) — nothing under app/tests/ REFERENCES a module mount the shell
// does not run (DIA-P1). The app-side twin of EMV-P5-INV-001, which draws the
// same line under native/.
//
// WHAT THIS IS FOR. A mount bump is copy-forward: the frozen generation stays
// on disk and stays shipped, on purpose, because an already-installed client is
// still holding it. So a reference left behind at the frozen generation does
// NOT 404. It resolves — against bytes nobody runs — and the test that carries
// it goes on passing while asserting something about a file the product does
// not execute. That is not a hypothetical:
//
//   * app/tests/export/build-artifact.mjs built the export artifact with the
//     frozen generation's export/build.js;
//   * app/tests/schema/test_write_path_projection.py read the projection query
//     out of the frozen generation's store/journal.js.
//
// Both stayed pinned across TWO bumps and both stayed green, because the
// generations differed only in values those suites do not read. XPT-P1 repaired
// them by derivation. This guard is what makes the class visible on every push
// instead of at the third bump.
//
// THIS IS A STATIC PROPERTY AND CARRIES NO RUNTIME CLAIM (AGENTS.md §11). It
// boots nothing, starts no browser and no emulator, and reads only the tree.
// Which mount version is written down where IS a property of the tree, and
// reading the tree is the right instrument for it.
//
// ------------------------------------------------------------------------
// WHERE THIS DIVERGES FROM EMV-P5-INV-001, AND WHAT THE DIVERGENCE COSTS.
//
// Under native/ a COMMENT counts: EMV-P5 reds on a javadoc line naming the
// frozen generation, on the argument that prose misdirecting the next reader to
// bytes nobody runs is the same drift as code importing them. This guard
// deliberately does NOT count a comment. Its subject is a reference that
// RESOLVES — a path a test opens, imports or fetches — and prose does not
// resolve.
//
// The reason is the corpus rather than a change of principle. Under app/tests/
// the mount tokens that exist today are eleven historical statements whose
// value IS the number: "EMV-P1 moved the shell to /m/v2/", "the previous
// generation had no .modal.show rule". Adopting "a comment counts" would mean
// rewriting all eleven into version-free prose — deleting precise history in
// files this packet otherwise does not touch — and the failure mode it would
// buy is weaker here than under native/, where the misleading comment sits
// beside the instrumented test it misdirects.
//
// THE COST, STATED RATHER THAN LEFT FOR A READER TO FIND: a comment under
// app/tests/ may name a stale generation and this guard will not say so. If
// such a comment ever describes CURRENT behaviour rather than history, it is
// wrong and nothing here catches it. What is caught is every reference that a
// runtime would follow.
// ------------------------------------------------------------------------
//
// HOW A TOKEN IS CLASSIFIED. Every `m/v…` occurrence is placed by a small
// scanner that tracks, character by character, whether the file is in code, in
// a string, in a line comment or in a block comment:
//
//   * in a string literal  -> a LIVE REFERENCE. Its version must be the one the
//                             shell runs.
//   * in a comment         -> prose. Ignored, per the divergence above.
//   * anywhere else        -> UNCLASSIFIABLE, and red. A bare mount token in
//                             code, or one inside a multi-line template
//                             literal this scanner does not model, is a shape
//                             the guard does not understand — and a shape it
//                             does not understand is a failure, never a skip.
//
// ONE FORM IS DELIBERATELY IGNORED WHEREVER IT SITS: the placeholder `m/v{N}`,
// this repository's own way of writing "a mount version" without naming one. It
// appears in error messages built at run time — `currentMount()` throws "the
// stylesheet <link> names no /m/v{N}/ asset" — and it is the version-free
// phrasing EMV-P5-INV-001's Scope recommends, so a guard that red on it would
// be punishing the fix. It also cannot be the defect: a path containing braces
// resolves to nothing, so it can never quietly address the frozen generation.
// The arm-check pins this, so it is a decision rather than an accident of the
// pattern.
//
// The scanner is chosen by file extension and every extension is handled: .js /
// .mjs / .cjs get the JavaScript flavour, .py gets the Python one (including
// triple-quoted strings), and every other text file is read as PLAIN — no
// comments, no strings, so every token in it is a live reference. That is the
// fail-closed direction: a fixture or a baseline that names a path is naming it
// for real.
//
// SELF-SCANNING. This file is inside the corpus it scans, so it contains no
// mount token in any string literal: the arm-check below ASSEMBLES its stale
// and unclassifiable inputs from the current mount at run time. That is not
// only self-defence — it is what keeps the arm-check stale forever instead of
// until the next bump. Same posture as M1-P3-INV-002, whose patterns live in
// the script rather than in the document the script scans.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const TESTS_ROOT = __dirname;

const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));

// Derived directories, whose content is nobody's reference to maintain. Named
// with the reason, the way EMV-P5-INV-001 names its exclusions, so an exclusion
// cannot quietly become a hiding place.
//
//   __baselines__ — Playwright snapshots, rewritten only by an explicit
//                   --update-snapshots run;
//   __pycache__   — CPython bytecode, gitignored.
const EXCLUDED_DIRS = new Set(['__baselines__', '__pycache__']);

const FLAVOUR_BY_EXTENSION = new Map([
  ['.js', 'js'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.py', 'py'],
]);

// `m/v` followed by whatever characters could plausibly be a version token. The
// capture is deliberately permissive so that `m/vNEXT`, `m/v` and `m/v2x` are
// SEEN and then rejected as unclassifiable, rather than not matching at all —
// a pattern that only matches well-formed versions is a pattern that fails open
// on the malformed ones.
const MOUNT_TOKEN = /\bm\/v([A-Za-z0-9_.{}+-]*)/g;

// The repository's placeholder for "a mount version, unspecified" — see the
// header. Matched exactly rather than by "contains a brace", so `v{N}` and
// `v{N+1}` are placeholders while `v3{` is still the malformed token it is.
const PLACEHOLDER = /^v\{[^{}]*\}$/;

/**
 * Classifies every character of `source` as code / string / comment.
 *
 * Returns a Uint8Array parallel to the source: 0 = code, 1 = string,
 * 2 = comment. One pass, no backtracking, no regex — which is the point. The
 * obvious implementation (strip comments with a regex, then search) is the one
 * app/tests/storage-seam.spec.js documents as failing open: stripping `//` to
 * end of line also eats the remainder of any line carrying an `https://`
 * literal, so a real reference sitting after one becomes invisible.
 */
function classify(source, flavour) {
  const CODE = 0;
  const STRING = 1;
  const COMMENT = 2;

  const marks = new Uint8Array(source.length).fill(CODE);
  if (flavour === 'plain') return marks;

  const js = flavour === 'js';
  let at = 0;

  while (at < source.length) {
    const ch = source[at];
    const next = source[at + 1];

    // --- comments -------------------------------------------------------
    if (js && ch === '/' && next === '/') {
      while (at < source.length && source[at] !== '\n') marks[at++] = COMMENT;
      continue;
    }
    if (js && ch === '/' && next === '*') {
      marks[at++] = COMMENT;
      marks[at++] = COMMENT;
      while (at < source.length && !(source[at] === '*' && source[at + 1] === '/')) {
        marks[at++] = COMMENT;
      }
      if (at < source.length) {
        marks[at++] = COMMENT;
        marks[at++] = COMMENT;
      }
      continue;
    }
    if (!js && ch === '#') {
      while (at < source.length && source[at] !== '\n') marks[at++] = COMMENT;
      continue;
    }

    // --- strings --------------------------------------------------------
    // Python triple quotes first: `"""` must not be read as an empty `""`
    // followed by a quote.
    if (!js && (ch === '"' || ch === "'") && source.substr(at, 3) === ch.repeat(3)) {
      const fence = ch.repeat(3);
      marks[at++] = STRING;
      marks[at++] = STRING;
      marks[at++] = STRING;
      while (at < source.length && source.substr(at, 3) !== fence) marks[at++] = STRING;
      for (let k = 0; k < 3 && at < source.length; k += 1) marks[at++] = STRING;
      continue;
    }
    if (ch === '"' || ch === "'" || (js && ch === '`')) {
      const quote = ch;
      marks[at++] = STRING;
      while (at < source.length) {
        if (source[at] === '\\') {
          marks[at++] = STRING;
          if (at < source.length) marks[at++] = STRING;
          continue;
        }
        if (source[at] === quote) {
          marks[at++] = STRING;
          break;
        }
        // An unterminated single-quoted string would otherwise swallow the rest
        // of the file and hide every token after it. A newline ends it, except
        // in a template literal, where a newline is legal content — which is
        // exactly why a mount token in a multi-line template lands in the
        // unclassifiable bucket below rather than being read as a reference.
        if (source[at] === '\n' && quote !== '`') break;
        marks[at++] = STRING;
      }
      continue;
    }

    at += 1;
  }

  return marks;
}

function flavourOf(file) {
  return FLAVOUR_BY_EXTENSION.get(path.extname(file)) ?? 'plain';
}

/** Every mount token in one source, with where it sits and what it names. */
function mountTokens(source, flavour) {
  const marks = classify(source, flavour);
  const out = [];
  for (const match of source.matchAll(MOUNT_TOKEN)) {
    const state = marks[match.index];
    if (state === 2) continue; // a comment: prose, by the divergence above
    const token = `v${match[1]}`;
    if (PLACEHOLDER.test(token)) continue; // names no generation, resolves to nothing
    const version = /^v\d+$/.test(token) ? token : null;
    out.push({
      raw: match[0],
      version,
      state,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return out;
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    const file = path.join(dir, entry.name);
    const buffer = fs.readFileSync(file);
    if (isBinary(buffer)) continue;
    out.push({ file, rel: path.relative(APP_ROOT, file), source: buffer.toString('utf8') });
  }
  return out;
}

const SCANNED = walk(TESTS_ROOT);

test.describe('mount references — app/tests/ names only the mount the shell runs (DIA-P1-INV-003 half a)', () => {
  test('the walk reaches the files this guard exists for', () => {
    // An exclusion typo that emptied the walk would make every assertion below
    // pass while checking nothing — the A1-DL-007 (d) failure mode, in a new
    // place. The two files named here are the two that actually carried the
    // defect (XPT-DL-001 (k)); the third and fourth are the derivation helpers
    // they were repaired with.
    expect(SCANNED.length, 'the walk over app/tests/ collapsed').toBeGreaterThan(15);
    const seen = new Set(SCANNED.map((entry) => entry.rel));
    for (const required of [
      'tests/export/build-artifact.mjs',
      'tests/schema/test_write_path_projection.py',
      'tests/support/ship-list.js',
      'tests/schema/harness.py',
    ]) {
      expect(seen, `the walk did not reach ${required}`).toContain(required);
    }
  });

  test('the classifier reds on inputs this test builds in-run', () => {
    // SELF-PROVING, and not optional. There are ZERO live mount literals under
    // app/tests/ today — every reference derives — so the assertion below is
    // green against an empty set and would stay green if the classifier were
    // broken, if MOUNT_TOKEN matched nothing, or if `classify` marked the whole
    // world a comment. So the guard fires at its own inputs first.
    //
    // Every input is ASSEMBLED from the current mount rather than written down,
    // for two reasons: this file is inside the corpus it scans, and a stale
    // version written down here would stop being stale at some future bump.
    const currentNumber = Number(MOUNT.version.slice(1));
    const stale = `v${currentNumber - 1}`;
    const prefix = ['m', '/'].join('');

    const staleReference = `const url = '/${prefix}${stale}/app.js';\n`;
    const staleFindings = mountTokens(staleReference, 'js');
    expect(staleFindings, 'a stale reference in a string was not seen at all').toHaveLength(1);
    expect(staleFindings[0].state, 'a token inside quotes was not read as a reference').toBe(1);
    expect(staleFindings[0].version).toBe(stale);

    const currentReference = `const url = '/${prefix}${MOUNT.version}/app.js';\n`;
    expect(mountTokens(currentReference, 'js')[0].version).toBe(MOUNT.version);

    const unclassifiable = `const url = /${prefix}vNEXT/;\n`;
    const unclassifiableFindings = mountTokens(unclassifiable, 'js');
    expect(unclassifiableFindings, 'a malformed mount token was not seen').toHaveLength(1);
    expect(
      unclassifiableFindings[0].version,
      'a malformed mount token was accepted as a version'
    ).toBeNull();

    // Prose is ignored — the divergence from EMV-P5-INV-001, asserted rather
    // than described, so a later edit that quietly starts counting comments
    // fails here and has to be argued for.
    expect(
      mountTokens(`// the shell moved to /${prefix}${stale}/ at some point\n`, 'js'),
      'a mount token in a comment was counted as a reference'
    ).toHaveLength(0);
    expect(
      mountTokens(`# the shell moved to /${prefix}${stale}/ at some point\n`, 'py'),
      'a mount token in a Python comment was counted as a reference'
    ).toHaveLength(0);

    // The trap storage-seam.spec.js documents: a comment marker sitting inside
    // a URL literal must not turn the rest of the line into a comment.
    const afterUrl =
      `const doc = 'https://example.invalid/x'; const url = '/${prefix}${stale}/app.js';\n`;
    expect(
      mountTokens(afterUrl, 'js').map((hit) => hit.version),
      'a reference after an https:// literal became invisible'
    ).toEqual([stale]);

    // A plain file has no strings and no comments, so everything in it counts.
    expect(mountTokens(`/${prefix}${stale}/app.css\n`, 'plain')[0].version).toBe(stale);

    // The placeholder is ignored wherever it sits — a decision, pinned here so
    // it cannot become an accident of the pattern. `currentMount()` builds
    // exactly this string into a thrown message.
    expect(
      mountTokens(`throw new Error('names no /${prefix}v{N}/ asset');\n`, 'js'),
      'the version-free placeholder was treated as a reference'
    ).toHaveLength(0);
    // …and a token that merely CONTAINS a brace is still malformed, not a
    // placeholder, so the exemption cannot be widened by accident.
    expect(mountTokens(`const u = '/${prefix}v3{/app.js';\n`, 'js')[0].version).toBeNull();
  });

  test('no reference under app/tests/ names another generation', () => {
    const stale = [];
    for (const { rel, source, file } of SCANNED) {
      for (const hit of mountTokens(source, flavourOf(file))) {
        if (hit.version && hit.version !== MOUNT.version) {
          stale.push(`${rel}:${hit.line} names ${hit.raw}`);
        }
      }
    }
    expect(
      stale,
      `the shell runs ${MOUNT.prefix}; these references name a generation nothing runs.`
        + ' A copy-forward bump leaves the frozen generation on disk, so each of these'
        + ' RESOLVES against bytes the product does not execute rather than failing.'
        + ' Derive the mount (app/tests/support/ship-list.js currentMount, or'
        + ' app/tests/schema/harness.py current_mount) instead of repointing it.'
    ).toEqual([]);
  });

  test('no mount token under app/tests/ is left unclassified', () => {
    const unknown = [];
    for (const { rel, source, file } of SCANNED) {
      for (const hit of mountTokens(source, flavourOf(file))) {
        if (!hit.version) unknown.push(`${rel}:${hit.line} carries ${hit.raw}`);
      }
    }
    expect(
      unknown,
      'these tokens are mount-shaped but name no v{N} version, so this guard cannot say'
        + ' whether they are current. It fails rather than skipping them: a skipped token'
        + ' is how a stale reference stays invisible.'
    ).toEqual([]);
  });
});

// The mount's own self-references, which are the other place a written-down
// generation used to live (DIA-P1-INV-003 half a, second surface).
//
// Until DIA-P1 four knobs carried absolute literals — STORE_CONFIG.schemaUrl and
// EXPORT_CONFIG's declarationUrl / fontUrl / iccUrl — and each had to be
// repointed by hand at every bump. They were, three times, and docs/RUNBOOK.md
// carried a step to remember it. They are derived from `import.meta.url` now.
//
// THIS IS THE HALF THAT REDS WHEN A LITERAL COMES BACK. Its twin —
// app/tests/mount-derivation.spec.js — boots a browser and asserts the derived
// values address real assets on both delivery channels; it cannot tell a
// derivation from a literal that is correct today, and this cannot tell a
// derivation from one that addresses nothing. Neither substitutes for the other,
// and a reader meeting one should know the other exists.
//
// Scoped to the mount the SHELL runs. app/m/** legitimately names itself in the
// frozen generations, which stay on disk byte-untouched on purpose.
test.describe('mount self-references — the running mount writes no version down (DIA-P1-INV-003 half a)', () => {
  const SELF_REFERENCING = ['store/config.js', 'export/config.js'];

  test('the config modules under test exist and were read', () => {
    for (const name of SELF_REFERENCING) {
      const file = path.join(APP_ROOT, 'm', MOUNT.dir, name);
      expect(fs.existsSync(file), `${MOUNT.prefix}${name} is not on disk`).toBeTruthy();
      expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    }
  });

  test('no knob in the running mount names a mount generation', () => {
    const written = [];
    for (const name of SELF_REFERENCING) {
      const file = path.join(APP_ROOT, 'm', MOUNT.dir, name);
      const source = fs.readFileSync(file, 'utf8');
      for (const hit of mountTokens(source, 'js')) {
        written.push(`${MOUNT.prefix}${name}:${hit.line} carries ${hit.raw}`);
      }
    }
    expect(
      written,
      'a mount version is written down in the running mount instead of derived from'
        + ' import.meta.url. It will be correct until the next bump and wrong after it —'
        + ' and wrong quietly, because a copy-forward bump leaves the frozen generation'
        + ' shipped, so the stale address resolves. (changed_in history in COMMENTS is'
        + ' fine and is not counted; this is about values.)'
    ).toEqual([]);
  });
});
