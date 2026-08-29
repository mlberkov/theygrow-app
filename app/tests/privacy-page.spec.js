'use strict';

// The privacy policy page, as a property of the tree (PPR-P1).
//
// WHAT THIS FILE IS FOR. app/privacy.html is a CONVERSION of the CURRENT
// edition of the document — docs/privacy-policy-v1.3.md since NAV-P2 — written
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
const EDITION = '1.3';
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

// THE DOCUMENT NAMES THE CONTROL BY ITS NAME, NOT BY THE SIGN PAINTED ON IT
// (UIP-P7).
//
// Section 1 of the policy tells a parent where the link to the document lives,
// and one of the two places is a control in the header. Until this packet both
// sentences named it «?» — the glyph. UIP-P3 changed that glyph to «i» while
// the control's id, handler, window and accessible name stayed byte-unchanged
// (`UIP-DL-003` (j)), and the published document went on describing a button
// that no longer existed under that name for a month.
//
// The wording was corrected in place inside edition 1.1 (owner gate decision
// 2026-08-27) and is now GLYPH-INDEPENDENT: it quotes «О приложении», which is
// the control's `title`/`aria-label` and the one part of it the product has
// committed to keeping — the name was deliberately chosen wider than today's
// contents so that a change BEHIND the button does not change the button.
//
// That commitment lived in a decision-log entry and in nothing executable, and
// this milestone has now been bitten twice by exactly that shape: the effective
// date at UIP-P6, this control's name here. So the coupling is made a DERIVED
// one instead of a remembered one, the same move UIP-P2 made for the four date
// literals. The name is read out of the shell's own markup, and both files must
// quote that string — rename the control and this reds; edit one file and not
// the other and this reds too.
//
// The second leg is the one that closes a hole this file's pairing has always
// had: the describe above pairs HEADINGS, the edition block and the history
// table, and compares no body text at all. The two sentences UIP-P7 edited are
// body text, so nothing here would have caught them diverging. Rather than
// pinning them as literals — which would force a test edit on every legitimate
// reword — the sentences are DERIVED from the Markdown by the name they carry,
// and each must appear verbatim in the page.

// The tag the shell gives the control that opens the intro window.
function aboutControlTag(shell) {
  const tag = /<button\b[^>]*\bid="aboutBtn"[^>]*>/.exec(shell);
  if (!tag) throw new Error('privacy-page: no #aboutBtn in the shell — the control the policy names is gone');
  return tag[0];
}

// Its accessible name, which is what the document quotes.
function aboutControlName(shell) {
  const label = /\baria-label="([^"]+)"/.exec(aboutControlTag(shell));
  if (!label) throw new Error('privacy-page: #aboutBtn carries no aria-label — the document quotes a name the control does not have');
  return label[1];
}

// Every sentence of the source document that names the control, in source order.
// Derived rather than pinned: a reword stays green as long as it lands in BOTH
// files, and reds the moment it lands in only one.
function sentencesNaming(source, name) {
  const quoted = `«${name}»`;
  return source
    .split('\n')
    .flatMap((line) => line.split('. '))
    .filter((part) => part.includes(quoted))
    .map((part) => (part.endsWith('.') ? part : `${part}.`));
}

test.describe('the document names the header control by its name, not its glyph (UIP-P7)', () => {
  const NAME = aboutControlName(SHELL);
  const QUOTED = `«${NAME}»`;
  // The glyph the control carried until UIP-P3, and which both sentences used
  // to name. Kept as a literal on purpose: it is the defect, not the state.
  const RETIRED_GLYPH = '«?»';

  test('the shell still carries the control, and it still has the name', () => {
    // Anti-vacuity for everything below: both legs are comparisons against a
    // string read out of the shell, and an empty string is contained by
    // everything.
    expect(NAME.length, 'the control has an empty accessible name').toBeGreaterThan(0);
    expect(aboutControlTag(SHELL)).toContain('id="aboutBtn"');
  });

  test('both files quote the name the control actually carries, twice each', () => {
    // Counted rather than merely found: section 1 names the control in two
    // separate paragraphs, and a conversion that dropped one of them would
    // still contain the string.
    for (const [what, text] of [[SOURCE_NAME, MARKDOWN], ['app/privacy.html', PAGE_CODE]]) {
      const occurrences = text.split(QUOTED).length - 1;
      expect(
        occurrences,
        `${what} quotes ${QUOTED} ${occurrences} time(s); section 1 names the control twice. Either the control was renamed in app/index.html and the document was not, or one of the two paired files was edited alone`
      ).toBe(2);
    }
  });

  test('neither file names the control by the glyph UIP-P3 retired', () => {
    // The negative half, and it is the whole point of the packet: the document
    // must survive the NEXT change of sign. Comments are stripped from the
    // page, so its head comment may explain this history without the
    // explanation reading as the defect.
    for (const [what, text] of [[SOURCE_NAME, MARKDOWN], ['app/privacy.html', PAGE_CODE]]) {
      expect(
        text,
        `${what} names the header control by a painted character (${RETIRED_GLYPH}) instead of by its accessible name — that is the UIP-P7 defect returning`
      ).not.toContain(RETIRED_GLYPH);
    }
  });

  test('every sentence that names the control says the same thing in both files', () => {
    // The body-text pairing the describe above does not do, scoped to the
    // sentences this coupling actually covers.
    const sentences = sentencesNaming(MARKDOWN, NAME);
    expect(
      sentences.length,
      'no sentence of the source document names the control — the derivation stopped covering anything'
    ).toBe(2);
    for (const sentence of sentences) {
      expect(
        PAGE_CODE,
        `the source document says "${sentence}" and app/privacy.html does not — the two files diverged in body text, which the heading pairing cannot see`
      ).toContain(sentence);
    }
  });

  test('the derivation is armed, and proves it on inputs it builds in-run', () => {
    // Self-proving rather than argued: the same extractors the legs above use
    // are run over fragments written here, so no shipped file is mutated and
    // each detector is shown catching the shape it exists for.
    const SHELL_RENAMED = '<button type="button" id="aboutBtn" aria-label="Справка">x</button>';
    const SHELL_UNNAMED = '<button type="button" id="aboutBtn">x</button>';

    expect(aboutControlName(SHELL_RENAMED), 'the extractor did not read the name off the tag').toBe('Справка');
    expect(() => aboutControlName(SHELL_UNNAMED), 'a control with no accessible name passed').toThrow(/no aria-label/);
    expect(() => aboutControlName('<p>no control here</p>'), 'a shell without the control passed').toThrow(/no #aboutBtn/);

    expect(
      sentencesNaming(`А. Б ${QUOTED} в. Г.`, NAME),
      'the sentence extractor did not isolate the sentence carrying the name'
    ).toEqual([`Б ${QUOTED} в.`]);
    expect(sentencesNaming('nothing here.', NAME), 'the extractor invented a sentence').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE DOCUMENT SAYS THE APP CANNOT ERASE ONE RECORD, AND THAT IS COUPLED TO THE
// CODE RATHER THAN REMEMBERED (UIP-P8).
//
// Edition 1.1 told a parent, in four places, that they could delete an
// individual family record in the app, and one of those places named the
// control to press. No such control exists: surfaces/diary.js states the
// deferral and its reason, store/records.js says the same thing one layer down,
// and the shell carries no delete affordance at all. Edition 1.2 corrects the
// description. What it must not do is go stale in the OTHER direction — the day
// someone builds the delete surface, this document becomes the last thing
// anyone remembers instead of the first thing that reds.
//
// So the claim is DERIVED from the code that would have to change to falsify
// it. Every write a surface can perform passes through one door — the mount's
// store/boot.js export block, which the storage-seam scan already walks — and
// its web-channel twin core/repo-local.js, whose writers are declared in one
// place. If a record- or profile-deleting operation ever appears in either, the
// legs below red and name the document.
//
// The second half is the body-text pairing, and it exists because the edition
// pairing above compares HEADINGS, the edition block and the history table and
// no body text at all. UIP-P7 measured that hole on two sentences; this is the
// same measurement on the sentences that carry a data-subject-facing promise.
// The statements are derived from the Markdown by the stems any wording of them
// must contain, rather than pinned as literals, so a legitimate reword stays
// green as long as it lands in BOTH files.

// The mount's store door, as the set of names it exports.
function doorExports(source, where) {
  const block = /\bexport\s*\{([^}]*)\}/.exec(source);
  if (!block) throw new Error(`${where}: no \`export { ... }\` block — the store door cannot be read`);
  const names = block[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/).pop().trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error(`${where}: the store door exports nothing`);
  return names;
}

// The web-channel repository's declared writers and readers, by name.
function declaredFunctions(source, where) {
  const names = Array.from(source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)).map(
    (m) => m[1]
  );
  if (names.length === 0) throw new Error(`${where}: no exported functions — the web repository cannot be read`);
  return names;
}

// A name that would put an erasure operation on either surface. Kept as a
// vocabulary rather than a list of two spellings: the defect is "the app grew a
// way to erase one thing", and it does not matter what the verb is called.
const ERASING_OPERATION = /(delete|remove|erase|purge|wipe|destroy|drop|clear|forget)/i;

function erasingOperations(names) {
  return names.filter((name) => ERASING_OPERATION.test(name));
}

// Every sentence of the source document that carries one of these stems, in
// source order. Same extractor shape as sentencesNaming() above, and the same
// reason: derive the promise, do not pin its wording.
//
// TABLE ROWS ARE SKIPPED, and that is not a convenience — it was measured. The
// change-history row for edition 1.2 describes the same change in the same
// words, and its Markdown carries the `| version | date |` cells that the page
// spells as <td>, so pairing it as prose compares two spellings of one row that
// markdownHistory()/pageHistory() above already compare cell for cell. What is
// derived here is the document's PROSE promise; the table is somebody else's leg.
function sentencesWithStem(source, stem) {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('|'))
    .flatMap((line) => line.split('. '))
    .filter((part) => part.includes(stem))
    .map((part) => (part.endsWith('.') ? part : `${part}.`));
}

test.describe('the document says what the app can erase, and the code is what says it (UIP-P8)', () => {
  const MOUNT_V9 = currentMount(SHELL);
  const DOOR_PATH = path.join(APP_ROOT, 'm', MOUNT_V9.dir, 'store', 'boot.js');
  const WEB_REPO_PATH = path.join(APP_ROOT, 'm', MOUNT_V9.dir, 'core', 'repo-local.js');
  const DOOR = doorExports(fs.readFileSync(DOOR_PATH, 'utf8'), `m/${MOUNT_V9.dir}/store/boot.js`);
  const WEB_REPO = declaredFunctions(
    fs.readFileSync(WEB_REPO_PATH, 'utf8'),
    `m/${MOUNT_V9.dir}/core/repo-local.js`
  );

  // The stems the promise is derived by. Deletion is stated in three sections
  // and the child's own fields in one; each stem is a phrase any honest wording
  // of that statement has to contain.
  const NO_RECORD_DELETE = ['отдельной записи', 'отдельную запись'];
  const NO_CHILD_FIELD_EDIT = 'дата его рождения';

  // The claim shapes edition 1.1 shipped, and which UIP-DL-007 (k) measured as
  // false. Literals on purpose: they are the defect, not the state.
  const RETIRED_CLAIMS = [
    'используйте действие удаления',
    'удалите их в приложении',
    'экспортируете и удаляете',
    'экспорт и удаление',
    'исправлении, экспорте и удалении',
    'до их удаления вами в приложении',
    'удаления пользователем в приложении',
  ];

  test('both code surfaces were parsed, and they are the ones that would have to change', () => {
    // Anti-vacuity, and it is not decoration: every leg below is a NEGATIVE —
    // "no erasing operation is exported" is true of an empty list, of a file
    // that moved, and of a regex that stopped matching. So the two parsers are
    // required to have found the operations that are known to be there.
    expect(DOOR, 'the store door does not export the diary write path — this guard is reading the wrong file').toEqual(
      expect.arrayContaining(['createRecord', 'overwriteRecord', 'loadRecords', 'appendMark', 'appendChild'])
    );
    expect(
      WEB_REPO,
      'the web repository does not declare its known writers — this guard is reading the wrong file'
    ).toEqual(expect.arrayContaining(['createChild', 'markSkill', 'saveHistory']));
  });

  test('neither the store door nor the web repository offers a way to erase one record or one child', () => {
    // The property the document states, read off the code that states it. When
    // the delete surface lands (surfaces/diary.js defers it to L5, with its
    // reason), this is the leg that reds, and it names the sentences to revisit.
    for (const [what, names] of [
      [`m/${MOUNT_V9.dir}/store/boot.js`, DOOR],
      [`m/${MOUNT_V9.dir}/core/repo-local.js`, WEB_REPO],
    ]) {
      expect(
        erasingOperations(names),
        `${what} exports an erasure operation, and the published policy says the app has none. Either the document is now false, or the operation is not meant to be on this surface — §3.4 and §8 of ${SOURCE_NAME} are what have to move`
      ).toEqual([]);
    }
  });

  test('both files state the absence, in the same words, and state it where a parent will find it', () => {
    // Body text, which the edition pairing above does not compare at all.
    const deletion = NO_RECORD_DELETE.flatMap((stem) => sentencesWithStem(MARKDOWN, stem));
    expect(
      deletion.length,
      `${SOURCE_NAME} states the absence of a per-record deletion in ${deletion.length} sentence(s); the summary, section 3.4 and section 8 each carry one, and a parent who reads only one of the three still has to be told`
    ).toBeGreaterThanOrEqual(3);

    const childFields = sentencesWithStem(MARKDOWN, NO_CHILD_FIELD_EDIT);
    expect(
      childFields.length,
      `${SOURCE_NAME} does not say what happens to the child's name and birthdate after the profile is created`
    ).toBeGreaterThanOrEqual(1);

    for (const sentence of [...deletion, ...childFields]) {
      expect(
        PAGE_CODE,
        `the source document says "${sentence}" and app/privacy.html does not — the two files diverged on a data-subject-facing promise, which the heading pairing cannot see`
      ).toContain(sentence);
    }
  });

  test('neither file still carries the claim edition 1.1 shipped', () => {
    // The negative half. Comments are stripped from the page, so its head
    // comment may narrate this history without the narration reading as the
    // defect returning.
    for (const [what, text] of [[SOURCE_NAME, MARKDOWN], ['app/privacy.html', PAGE_CODE]]) {
      for (const claim of RETIRED_CLAIMS) {
        expect(
          text,
          `${what} still says "${claim}" — that is the UIP-DL-007 (k) defect returning: the app offers no such action`
        ).not.toContain(claim);
      }
    }
  });

  test('the derivation is armed, and proves it on inputs it builds in-run', () => {
    // Self-proving rather than argued: the same parsers and the same detector
    // are run over fragments written here, so no shipped file is mutated and
    // each one is shown catching the shape it exists for.
    const DOOR_WITH_DELETE = 'export {\n  createRecord,\n  deleteRecord,\n  loadRecords,\n};\n';
    const REPO_WITH_DELETE = 'export function createChild(a) {}\nexport async function removeChild(b) {}\n';

    expect(doorExports(DOOR_WITH_DELETE, 'fixture'), 'the door parser did not read the export block').toEqual([
      'createRecord',
      'deleteRecord',
      'loadRecords',
    ]);
    expect(
      erasingOperations(doorExports(DOOR_WITH_DELETE, 'fixture')),
      'a store door carrying deleteRecord passed the detector'
    ).toEqual(['deleteRecord']);
    expect(
      erasingOperations(declaredFunctions(REPO_WITH_DELETE, 'fixture')),
      'a web repository carrying removeChild passed the detector'
    ).toEqual(['removeChild']);
    expect(erasingOperations(DOOR), 'the detector fires on the real door, which has no erasure').toEqual([]);

    expect(() => doorExports('const x = 1;\n', 'fixture'), 'a file with no export block passed').toThrow(
      /no `export \{ \.\.\. \}` block/
    );
    expect(() => declaredFunctions('const x = 1;\n', 'fixture'), 'a file with no exports passed').toThrow(
      /no exported functions/
    );

    expect(
      sentencesWithStem('А. Удаления отдельной записи в приложении нет. Г.', 'отдельной записи'),
      'the sentence extractor did not isolate the sentence carrying the stem'
    ).toEqual(['Удаления отдельной записи в приложении нет.']);
    expect(sentencesWithStem('nothing here.', 'отдельной записи'), 'the extractor invented a sentence').toEqual([]);
    expect(
      sentencesWithStem('| 1.2 | 28.08.2026 | удаления отдельной записи в приложении нет |', 'отдельной записи'),
      'a change-history row was pulled into the prose pairing'
    ).toEqual([]);
  });
});
// NAV-P4 — THE PRE-INSTALL WINDOW QUOTES THE POLICY, IT DOES NOT PARAPHRASE IT.
//
// The window a visitor opens before installing (`#installModal`) now says what
// the update check sends. That is a statement about DATA HANDLING on a surface
// the policy also covers, and there are exactly two ways to keep the two in
// agreement: remember to, or derive it. This milestone has already been bitten
// twice by the first (the effective date at UIP-P6, the control's name at
// UIP-P7), so the sentence in the shell IS the policy's sentence, byte for byte,
// and this pairing is what says so.
//
// THE DIRECTION IS THE POLICY → THE SHELL, AND THAT IS NOT ARBITRARY. The
// document is the published promise; the showcase copy is a quotation of it. So
// the sentence is DERIVED from the Markdown by a stem — a reword of the policy
// is legitimate and stays green as long as it reaches all three files — and the
// shell and the page must then contain what the document says. Deriving from the
// shell instead would let product copy set the wording of a published document.
//
// STATIC, AND IT SAYS SO ABOUT ITSELF (AGENTS.md §11). It reads three files and
// boots nothing. What it carries is the shape of the tree — three files carrying
// one string — which is the admissible kind. What a rendered window actually
// shows is app/tests/channel-composition.spec.js in `behavior`, deliberately not
// this file, and that guard was NOT edited by the packet that rewrote the copy.

test.describe('the pre-install window quotes the policy on the update request (NAV-P4)', () => {
  // The stem any honest wording of that promise has to contain. It is the list
  // of things the request does not carry, which is the whole content of the
  // sentence; a reword that dropped it would be a different promise.
  const UPDATE_PAYLOAD_STEM = 'устройстве, установке или ребёнке';

  const SENTENCES = sentencesWithStem(MARKDOWN, UPDATE_PAYLOAD_STEM);

  // The markup of the window, isolated so "the shell contains it" cannot be
  // satisfied by the sentence living somewhere else in a 1000-line file.
  function installWindow(shell) {
    const start = shell.indexOf('<div id="installModal"');
    if (start === -1) {
      throw new Error('privacy-page: no #installModal in the shell — the window the policy is quoted in is gone');
    }
    const end = shell.indexOf('<div class="modal-buttons">', start);
    if (end === -1) {
      throw new Error('privacy-page: #installModal has no button row — the window markup is not the shape this pairing reads');
    }
    return shell.slice(start, end);
  }

  const WINDOW = installWindow(SHELL).replace(/<!--[\s\S]*?-->/g, '');

  test('the document states it exactly once, outside the change-history table', () => {
    // Anti-vacuity, and the load-bearing half: an empty derivation would make
    // every assertion below vacuously true, and two matches would make "the
    // sentence" a statement about whichever one the loop happened to take. The
    // history row naming the same fields in different words is excluded by the
    // extractor, which is why this is exactly one and not two.
    expect(
      SENTENCES.length,
      `${SOURCE_NAME} states the update-request promise ${SENTENCES.length} time(s) in prose; this pairing needs exactly one sentence to quote`
    ).toBe(1);
    expect(SENTENCES[0].length, 'the derived sentence is empty').toBeGreaterThan(40);
  });

  test('the window really is the window, and it really carries copy', () => {
    expect(WINDOW.length, 'the pre-install window collapsed to almost nothing').toBeGreaterThan(500);
    expect(WINDOW, 'the window no longer carries its own heading').toContain('Приложение TheyGrow для Android');
  });

  test('the shell and the page carry the document\'s sentence, verbatim', () => {
    const sentence = SENTENCES[0];
    expect(
      WINDOW,
      `the pre-install window no longer carries the policy's own sentence «${sentence}» — a promise about what leaves the device must be the document's words, not a paraphrase of them`
    ).toContain(sentence);
    expect(
      PAGE_CODE,
      `app/privacy.html and ${SOURCE_NAME} disagree about the update-request promise — one of the paired files was edited alone`
    ).toContain(sentence);
  });

  test('the pairing is armed, and proves it on inputs it builds in-run', () => {
    // Self-proving rather than argued: the same extractor is run over fragments
    // written here, so no shipped file is mutated and it is shown catching both
    // the shape it exists for and the shape that would make it vacuous.
    expect(
      sentencesWithStem('А. Сведения о вас, устройстве, установке или ребёнке при этом не передаются. Б.', UPDATE_PAYLOAD_STEM),
      'the extractor did not isolate the sentence carrying the stem'
    ).toEqual(['Сведения о вас, устройстве, установке или ребёнке при этом не передаются.']);
    expect(
      sentencesWithStem('| 1.3 | 29.08.2026 | не передаёт сведений о пользователе, устройстве, установке или ребёнке |', UPDATE_PAYLOAD_STEM),
      'a change-history row was pulled into the prose pairing'
    ).toEqual([]);
    expect(
      sentencesWithStem('nothing here.', UPDATE_PAYLOAD_STEM),
      'the extractor invented a sentence'
    ).toEqual([]);
    expect(
      () => installWindow('<p>no window here</p>'),
      'a shell without the pre-install window passed'
    ).toThrow(/no #installModal/);
  });
});
