'use strict';

// The privacy policy page, as a property of the tree (PPR-P1).
//
// WHAT THIS FILE IS FOR. app/privacy.html is a CONVERSION of
// docs/privacy-policy-v1.0.md, hand-written because this repository is
// buildless by contract — there is no renderer to trust and no build step to
// blame. A conversion drifts silently: someone fixes a sentence in one file,
// the other keeps saying the old thing, and the one that is WRONG is the one a
// parent reads at the published address. So the two files are paired here, by
// every heading and by the effective date, and a divergence is a red test
// rather than a discovery months later.
//
// The second subject is what the page must NOT be. It ships no script — not its
// own, not gtag — no stylesheet from the module mount, no manifest, and no
// link of any kind. Those are absences, which is the admissible static kind
// (AGENTS.md §11): properties of the tree, read from the tree. What a real
// browser does when it opens the address — that no request leaves for a third
// party, that no worker is registered, that the app shell's offline copy
// survives the visit — is executed in app/tests/privacy-surface.spec.js, and
// deliberately not claimed here.
//
// The third subject is the ORDER. PPR-P1 published the document and did not
// announce it; PPR-P3 flipped the declaration, and the two ship in the SAME
// image, so the gap the order protects against — a declaration ahead of its
// document — never opened. The legs at the bottom hold the post-flip half of
// that order: the declaration reads exactly the published token, and the shell
// STILL links /privacy nowhere in markup, because the address is set at runtime
// from CHANNEL_CONFIG.policyUrl. A packet that hard-codes it into the markup
// reds here.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { shippedPaths, offlineUrls, currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

const PAGE_URL = '/privacy.html';
const ROUTE = '/privacy';

const SOURCE_DOCUMENT = path.join(REPO_ROOT, 'docs', 'privacy-policy-v1.0.md');

const SHIP = shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8'));
const PRECACHED = offlineUrls(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8'));
const PAGE = fs.readFileSync(path.join(APP_ROOT, 'privacy.html'), 'utf8');
const MARKDOWN = fs.readFileSync(SOURCE_DOCUMENT, 'utf8');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');

// Comments are stripped before matching, so the page can EXPLAIN in its own
// head why it carries no script without the explanation reading as a script.
// Same technique as app/tests/install-channel.spec.js:44.
const PAGE_CODE = PAGE.replace(/<!--[\s\S]*?-->/g, '');

// The markdown's headings, in source order, as { level, text }.
function markdownHeadings(source) {
  return source
    .split('\n')
    .map((line) => /^(#{1,6})\s+(.*?)\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ level: m[1].length, text: m[2] }));
}

// The effective date, from both places the document states it. Fails CLOSED on
// either: a document whose date this guard cannot find is a document whose
// date nothing checks, and an unresolved template slot is the exact defect.
function effectiveDates(source) {
  const header = /\*\*Дата вступления в силу:\*\*\s*(\S+)/.exec(source);
  if (!header) throw new Error('privacy-page: no effective date in the document header');
  const history = /\|\s*1\.0\s*\|\s*([^|]+?)\s*\|/.exec(source);
  if (!history) throw new Error('privacy-page: no 1.0 row in the change history table');
  return { header: header[1], history: history[1] };
}

test.describe('the policy page is shipped, and shipped as a document', () => {
  test('app/Dockerfile ships it', () => {
    expect(
      SHIP.files.has(PAGE_URL),
      'app/privacy.html is not in the COPY list — /privacy would 404 in production while this suite stays green'
    ).toBe(true);
    expect(fs.existsSync(path.join(APP_ROOT, 'privacy.html'))).toBe(true);
  });

  test('it is NOT precached, and that is the decision rather than an oversight', () => {
    // cache.addAll is atomic and OFFLINE_URLS is the app's offline boot set. The
    // policy is a document a parent reads once, online, usually before they have
    // installed anything — spending an installed client's cache budget on it
    // would buy nothing. Precaching it would also put a SECOND html document in
    // the worker's cache under a navigable key, which is the neighbourhood the
    // shell-poisoning defect lives in.
    for (const url of [ROUTE, PAGE_URL]) {
      expect(
        PRECACHED.has(url),
        `"${url}" is in OFFLINE_URLS — the policy document is not part of the offline app`
      ).toBe(false);
    }
  });

  test('the scan is looking at the real page', () => {
    // Anti-vacuity: every assertion in the next block is an absence, and
    // absences all hold against an empty string.
    expect(PAGE_CODE.length, 'the page collapsed to almost nothing').toBeGreaterThan(8000);
    expect(PAGE_CODE).toContain('Краткая сводка');
    expect(PAGE_CODE).toContain('<h1>');
  });
});

test.describe('the policy page loads nothing and links nowhere', () => {
  // Each of these is a delivery property, and each one has a reason that is not
  // tidiness. A script would make a document about collecting no data collect
  // data. A mount stylesheet would tie a document that outlives every mount
  // generation to one of them. A manifest turns a page into an install offer.
  // A link is the one thing this page must not be doing: the address is
  // declared once, in CHANNEL_CONFIG, and the document quotes it rather than
  // offering it.
  const FORBIDDEN = [
    ['<script', 'the page carries a script — including analytics, which this document says it does not run'],
    ['rel="stylesheet"', 'the page links a stylesheet — its style is inline so it survives a mount bump'],
    ['rel="modulepreload"', 'the page hints a module — it evaluates none'],
    ['rel="manifest"', 'the page offers itself as an installable app'],
    ['<a ', 'the page carries a link — the document links to nothing, which is what keeps the address declared once'],
    ['/m/', 'the page references the module mount — its style is inline so it survives every generation'],
    ['{{', 'the page still carries an unresolved template slot'],
  ];

  for (const [token, why] of FORBIDDEN) {
    test(`app/privacy.html contains no "${token}"`, () => {
      expect(PAGE_CODE, why).not.toContain(token);
    });
  }

  test('it declares its language and a viewport, because it is read on a phone', () => {
    expect(PAGE).toContain('<html lang="ru">');
    expect(PAGE).toMatch(/<meta\s+name="viewport"/);
  });

  test('it asks no robot to forget it', () => {
    // Not decoration: a `noindex` added while the page was unannounced would
    // outlive this packet, and the address has to be reachable and indexable
    // for the Google Play listing (ADR-050 §5).
    expect(PAGE_CODE).not.toMatch(/<meta[^>]*name=["']robots["']/i);
  });
});

test.describe('the page and the source document say the same thing', () => {
  const HEADINGS = markdownHeadings(MARKDOWN);

  test('the source document was parsed, and has the structure this pairing assumes', () => {
    expect(HEADINGS.length, 'no headings parsed out of the source document').toBeGreaterThan(10);
    expect(HEADINGS[0].level).toBe(1);
    expect(MARKDOWN).not.toContain('{{');
  });

  for (const { level, text } of markdownHeadings(MARKDOWN)) {
    test(`heading "${text}" survived the conversion at its own level`, () => {
      expect(
        PAGE_CODE,
        `docs/privacy-policy-v1.0.md has "${text}" as an h${level}; app/privacy.html does not`
      ).toContain(`<h${level}>${text}</h${level}>`);
    });
  }

  test('the title is the document title, not a page name someone wrote', () => {
    const h1 = HEADINGS.find((h) => h.level === 1).text;
    expect(/<title>([^<]*)<\/title>/.exec(PAGE)[1]).toBe(h1);
    expect(PAGE_CODE).toContain(`<h1>${h1}</h1>`);
  });

  test('the effective date is resolved, and is the same date in both files', () => {
    const dates = effectiveDates(MARKDOWN);
    expect(dates.header, 'the effective date slot is unresolved in the source').toMatch(
      /^\d{2}\.\d{2}\.\d{4}$/
    );
    expect(
      dates.history,
      'the header and the change-history row state different effective dates'
    ).toBe(dates.header);
    // Both places in the page, counted rather than merely found: the page
    // states the date in its header block and in its change-history row, and a
    // conversion that dropped one of them would still contain the string.
    const occurrences = PAGE_CODE.split(dates.header).length - 1;
    expect(
      occurrences,
      `app/privacy.html states the effective date ${occurrences} time(s); the document states it twice`
    ).toBe(2);
  });
});

test.describe('the document is published AND announced (PPR-P3)', () => {
  // The fail-closed order from docs/RUNBOOK.md § Privacy policy: document
  // first, declaration second. PPR-P1 took the first half and asserted the
  // second had not happened; PPR-P3 takes the second, and these legs turn over
  // to the state that now ships. What they still make checkable is the half of
  // the order that never expires: the declaration is the ONE token that reveals
  // the link, and the markup names the address nowhere.
  const MOUNT = currentMount(SHELL);
  const CONFIG = fs.readFileSync(
    path.join(APP_ROOT, 'm', MOUNT.dir, 'channel', 'config.js'),
    'utf8'
  );
  const POLICY_URL = /policyUrl:\s*'([^']+)'/.exec(CONFIG)[1];
  const POLICY_META = /policyStateMeta:\s*'([^']+)'/.exec(CONFIG)[1];
  const POLICY_PUBLISHED = /policyStatePublished:\s*'([^']+)'/.exec(CONFIG)[1];

  test('the shell declares the document published, in the exact token', () => {
    // Read out of the knob source rather than re-typed: a near-miss token in
    // the shell means "no document" to shouldOfferPolicy, and would leave a
    // published document unlinked with nothing red.
    expect(
      SHELL,
      'the shell does not declare the policy published — the document is served at /privacy and nothing links it'
    ).toContain(`<meta name="${POLICY_META}" content="${POLICY_PUBLISHED}">`);
  });

  test('nothing in the shell links the policy address', () => {
    const hrefs = Array.from(SHELL.matchAll(/href\s*=\s*["']([^"']*)["']/g)).map((m) => m[1]);
    expect(
      hrefs.filter((href) => href === POLICY_URL || href === ROUTE || href === PAGE_URL),
      'the shell links /privacy in markup — the link has one home, the intro window, and its address is set at runtime from CHANNEL_CONFIG.policyUrl rather than written into the markup'
    ).toEqual([]);
  });

  test('the knob still names the address this page answers', () => {
    // The pairing that makes the two legs above mean anything: the page is at
    // the address the app was told to link, not at a second address that
    // happens to serve a document.
    expect(POLICY_URL.endsWith(ROUTE)).toBe(true);
  });
});
