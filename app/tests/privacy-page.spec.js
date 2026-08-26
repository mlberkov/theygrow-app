'use strict';

// The privacy policy page, as a property of the tree (PPR-P1).
//
// WHAT THIS FILE IS FOR. app/privacy.html is a CONVERSION of the CURRENT
// edition of the document — docs/privacy-policy-v1.1.md since UIP-P2 — written
// by hand because this repository is buildless by contract: there is no
// renderer to trust and no build step to blame. A conversion drifts silently:
// someone fixes a sentence in one file, the other keeps saying the old thing,
// and the one that is WRONG is the one a parent reads at the published address.
// So the two files are paired here, by every heading and by the whole edition
// block — version, effective date, and every row of the change history — and a
// divergence is a red test rather than a discovery months later.
//
// THE EDITION PAIRING IS WIDER THAN IT WAS, AND THAT IS UIP-P2's SUBJECT.
// Until that packet this file read the effective date out of a change-history
// row pinned to the literal `1.0`, which on a v1.1 document would have paired
// the page against the HISTORICAL date and stayed green while the current one
// went unchecked. The date also lives in four hand-kept places that a promotion
// date shift must move together, addressed in docs/RUNBOOK.md by line numbers
// that had already gone stale. There is nowhere for a single literal to live —
// PPR-DL-001 (a) refused a renderer for the one page whose value is that it
// runs none — so the four are made a DERIVED set instead: the version and date
// are read out of the Markdown header, the history table is compared row for
// row, and any one of the four moving alone is red.
//
// The second subject is what the page must NOT be. It ships no script — not its
// own, not gtag — no stylesheet from the module mount and no manifest. Those
// are absences, which is the admissible static kind (AGENTS.md §11): properties
// of the tree, read from the tree. What a real browser does when it opens the
// address — that no request leaves for a third party, that no worker is
// registered, that the back link actually lands on the app, that the app
// shell's offline copy survives the visit — is executed in
// app/tests/privacy-surface.spec.js, and deliberately not claimed here.
//
// LINKS ARE NO LONGER FORBIDDEN; THEIR COMPOSITION IS CHECKED INSTEAD (UIP-P2).
// PPR-P1 asserted the page carried no <a> at all. That bought one property and
// cost another: a reader had no way back to the app, and four third-party
// policies plus the supervisory authority's address were typed as <code> and
// could not be opened. What replaces it is narrower to state and no weaker
// where it mattered: every href is either "/" or an https address on a declared
// list, and NO href is ever the document's own address — that is what keeps
// export-contour.spec.js's "quote, never link" property and the FIU-P3-INV-002
// amendment true.
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

// The edition this page converts. Named once; every leg below derives from it,
// and the "no newer edition on disk" leg is what stops it going stale silently.
const EDITION = '1.1';
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const SOURCE_NAME = `privacy-policy-v${EDITION}.md`;
const SOURCE_DOCUMENT = path.join(DOCS_DIR, SOURCE_NAME);

// The link allowlist (UIP-P2). Two kinds and nothing else: the way back into
// the app, and the external documents the text names. Written out rather than
// derived from the page, so a link ADDED to the page is a red test rather than
// a self-approving one.
const BACK_TO_APP = '/';
const EXTERNAL_LINKS = [
  'https://policies.google.com/privacy',
  'https://www.cloudflare.com/privacypolicy/',
  'https://docs.github.com/site-policy/privacy-policies/github-privacy-statement',
  'https://www.gov.il/en/departments/the_privacy_protection_authority',
];

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

// The edition block, from the document header. Fails CLOSED on either half: a
// document whose version or date this guard cannot find is a document whose
// version or date nothing checks, and an unresolved template slot is the exact
// defect.
function editionHeader(source) {
  const version = /\*\*Версия:\*\*\s*(\S+)/.exec(source);
  if (!version) throw new Error('privacy-page: no version in the document header');
  const date = /\*\*Дата вступления в силу:\*\*\s*(\S+)/.exec(source);
  if (!date) throw new Error('privacy-page: no effective date in the document header');
  return { version: version[1], date: date[1] };
}

// The change-history table, as [{ version, date, change }] in source order.
// Header and separator rows are dropped by shape, not by position.
function markdownHistory(source) {
  const after = source.split('### История изменений')[1];
  if (after === undefined) throw new Error('privacy-page: no change-history heading in the document');
  return after
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => cells.length === 3 && /^\d+\.\d+$/.test(cells[0]))
    .map(([version, date, change]) => ({ version, date, change }));
}

// The same table as the page states it.
function pageHistory(page) {
  const after = page.split('<h3>История изменений</h3>')[1];
  if (after === undefined) throw new Error('privacy-page: no change-history heading in the page');
  return Array.from(
    after.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><\/tr>/g)
  ).map((m) => ({ version: m[1].trim(), date: m[2].trim(), change: m[3].trim() }));
}

// Every href the page carries, in source order.
function hrefs(page) {
  return Array.from(page.matchAll(/<a\s[^>]*href="([^"]*)"/g)).map((m) => m[1]);
}

// The allowlist predicate, as a function so the self-proving leg can run the
// SAME code over inputs it builds rather than a paraphrase of it.
function disallowedHrefs(page) {
  return hrefs(page).filter((h) => h !== BACK_TO_APP && !EXTERNAL_LINKS.includes(h));
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
  // `<a ` was on this list until UIP-P2 and is deliberately not on it now: the
  // page carries links, and what holds the property that used to matter — the
  // address is declared once, in CHANNEL_CONFIG, and the document QUOTES it
  // rather than offering it — is the allowlist describe below.
  const FORBIDDEN = [
    ['<script', 'the page carries a script — the document is inert, and since UIP-P1 nothing on any page of this product loads analytics either'],
    ['rel="stylesheet"', 'the page links a stylesheet — its style is inline so it survives a mount bump'],
    ['rel="modulepreload"', 'the page hints a module — it evaluates none'],
    ['rel="manifest"', 'the page offers itself as an installable app'],
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

test.describe('the page links back, links out, and never links itself (UIP-P2)', () => {
  test('the scan found links at all', () => {
    // Anti-vacuity: every leg below is a filter over hrefs(), and a filter over
    // an empty list is empty. A page that lost its links entirely — or an
    // extractor that stopped matching — would satisfy them all in silence.
    expect(hrefs(PAGE_CODE).length, 'no href parsed out of app/privacy.html').toBeGreaterThan(4);
  });

  test('every href is either the way back or a declared external document', () => {
    expect(
      disallowedHrefs(PAGE_CODE),
      'the page links somewhere that is neither "/" nor a declared external policy — a public document grew an outbound link nobody declared'
    ).toEqual([]);
  });

  test('the way back into the app is offered, and it is relative', () => {
    // Relative on purpose: the same bytes ship to both channels
    // (LSC-P1-INV-002), and an absolute address here would be a second literal
    // of something declared once.
    expect(
      hrefs(PAGE_CODE).filter((h) => h === BACK_TO_APP).length,
      'the page offers no way back to the app'
    ).toBeGreaterThan(0);
  });

  test('every declared external document is actually reachable from the text', () => {
    // The other direction of the allowlist: a list entry nothing links is a
    // guard that has quietly stopped covering a paragraph.
    const present = new Set(hrefs(PAGE_CODE));
    expect(
      EXTERNAL_LINKS.filter((url) => !present.has(url)),
      'a declared external policy is not linked anywhere in the page'
    ).toEqual([]);
  });

  test('no link is the document\u2019s own address, in any spelling', () => {
    // This is the clause that survives from PPR-P1's blanket ban, and it is the
    // one that was load-bearing: it keeps `export-contour.spec.js`'s "the
    // document quotes policyUrl and never links it" true, and with it the
    // narrowness of the FIU-P3-INV-002 amendment.
    const CONFIG = fs.readFileSync(
      path.join(APP_ROOT, 'm', currentMount(SHELL).dir, 'channel', 'config.js'),
      'utf8'
    );
    const policyUrl = /policyUrl:\s*'([^']+)'/.exec(CONFIG)[1];
    const self = [policyUrl, ROUTE, PAGE_URL];
    expect(
      hrefs(PAGE_CODE).filter((h) => self.includes(h)),
      'the page LINKS its own address instead of quoting it'
    ).toEqual([]);
    // And the address is still quoted, so the property is "quoted, not linked"
    // rather than "absent".
    expect(PAGE_CODE).toContain(`<code>${policyUrl}</code>`);
  });

  test('every external link is opened without handing the third party a referrer', () => {
    // A referrer would tell Google, Cloudflare, GitHub or the supervisory
    // authority that this reader was on the privacy policy. That is a small
    // disclosure and it is the one this document is least entitled to make.
    for (const url of EXTERNAL_LINKS) {
      const anchor = new RegExp(`<a\\s[^>]*href="${url.replace(/[.*+?^$()|[\]\\/]/g, '\\$&')}"[^>]*>`, 'g');
      for (const [tag] of PAGE_CODE.matchAll(anchor)) {
        expect(tag, `an external link is missing rel="noopener noreferrer": ${url}`).toContain(
          'rel="noopener noreferrer"'
        );
      }
    }
  });

  test('the allowlist is armed, and proves it on inputs it builds in-run', () => {
    // Self-proving rather than argued: the same predicate the legs above use is
    // run over fragments written here, so no shipped file is mutated and the
    // detector is shown catching both shapes it exists for.
    const OK = '<a href="/">back</a><a href="https://policies.google.com/privacy">g</a>';
    const OUTBOUND = '<a href="https://example.invalid/tracker">x</a>';
    const SELF = `<a href="${ROUTE}">the document itself</a>`;

    expect(disallowedHrefs(OK)).toEqual([]);
    expect(
      disallowedHrefs(OUTBOUND),
      'an undeclared outbound link passed the allowlist'
    ).toEqual(['https://example.invalid/tracker']);
    expect(disallowedHrefs(SELF), 'a self-link passed the allowlist').toEqual([ROUTE]);
    expect(hrefs('<p>no links here</p>'), 'the extractor invented an href').toEqual([]);
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
        `docs/${SOURCE_NAME} has "${text}" as an h${level}; app/privacy.html does not`
      ).toContain(`<h${level}>${text}</h${level}>`);
    });
  }

  test('the title is the document title, not a page name someone wrote', () => {
    const h1 = HEADINGS.find((h) => h.level === 1).text;
    expect(/<title>([^<]*)<\/title>/.exec(PAGE)[1]).toBe(h1);
    expect(PAGE_CODE).toContain(`<h1>${h1}</h1>`);
  });

  test('the conversion tracks the newest edition on disk', () => {
    // The staleness this guard exists for: publishing docs/privacy-policy-v1.2.md
    // while the page still converts v1.1 would leave every other leg here green
    // and the published document a version behind.
    const editions = fs
      .readdirSync(DOCS_DIR)
      .map((name) => /^privacy-policy-v(\d+)\.(\d+)\.md$/.exec(name))
      .filter(Boolean)
      .map((m) => ({ name: m[0], key: Number(m[1]) * 1000 + Number(m[2]) }));
    expect(editions.length, 'no privacy-policy-v{N}.{M}.md found in docs/').toBeGreaterThan(0);
    const newest = editions.reduce((a, b) => (b.key > a.key ? b : a));
    expect(
      newest.name,
      `docs/ carries a newer edition than the one app/privacy.html converts (${SOURCE_NAME})`
    ).toBe(SOURCE_NAME);
  });

  test('the edition is resolved, and the page states the same one', () => {
    const { version, date } = editionHeader(MARKDOWN);
    expect(version, 'the version slot is unresolved in the source').toBe(EDITION);
    expect(date, 'the effective date slot is unresolved in the source').toMatch(
      /^\d{2}\.\d{2}\.\d{4}$/
    );
    expect(PAGE_CODE, 'the page states a different edition than the source document').toContain(
      `<strong>Версия:</strong> ${version}<br>`
    );
    expect(
      PAGE_CODE,
      'the page states a different effective date than the source document'
    ).toContain(`<strong>Дата вступления в силу:</strong> ${date}`);
  });

  test('the change history is the same table in both files, row for row', () => {
    // This is what makes the four date literals one derived set rather than four
    // things a promotion has to remember: the current edition's row is checked
    // against the header above, and every PRESERVED row is checked against its
    // twin, so a retroactive edit of a shipped edition is red too.
    const rows = markdownHistory(MARKDOWN);
    expect(rows.length, 'no change-history rows parsed out of the source document').toBeGreaterThan(0);
    expect(
      pageHistory(PAGE_CODE),
      'the page and the source document state different change histories'
    ).toEqual(rows);
  });

  test('the newest history row IS the current edition', () => {
    const { version, date } = editionHeader(MARKDOWN);
    const [newest] = markdownHistory(MARKDOWN);
    expect(
      newest,
      'the top row of the change history is not the edition the header declares'
    ).toMatchObject({ version, date });
  });

  test('the effective date is stated exactly twice in the page', () => {
    // Counted rather than merely found: the page states the current date in its
    // header block and in its own history row, and a conversion that dropped one
    // of them would still contain the string. Comments are stripped first, so
    // the head comment's reference to the PREVIOUS edition's date cannot pad the
    // count.
    const { date } = editionHeader(MARKDOWN);
    const occurrences = PAGE_CODE.split(date).length - 1;
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
