'use strict';

// UIP-P1-INV-001 — nothing this image ships loads, configures or reports to an
// analytics service, on any delivery channel.
//
// THIS GUARD IS STATIC, AND SAYS SO ABOUT ITSELF (AGENTS.md §11). It reads the
// files app/Dockerfile ships and boots nothing — no page, no worker, no
// emulator. What it carries is an ABSENCE, which is a property of the tree and
// the admissible kind of static claim. Its executing twin is
// app/tests/analytics-egress.spec.js, which drives a real browser and watches
// the requests it makes; on the native channel the same claim is settled by
// WebViewStorageTest inside a real WebView. Nothing here stands in for either.
//
// WHY THE SCAN IS TWO-TIERED, AND WHY THAT IS HONESTY RATHER THAN LENIENCY.
// Published mount generations are FROZEN (vault ADR-024, A1-DL-004): their bytes
// are never rewritten, app/Dockerfile COPYs the whole mount root, so /m/v1/ …
// /m/v8/ all ship and all carry trackEvent() call sites that this packet is not
// allowed to edit. A single flat token list over everything would therefore be
// red forever, and the only ways to make it green would be to edit frozen bytes
// or to quietly stop scanning the tree. So the two tiers say two different true
// things:
//
//   TIER 1 — THE WHOLE SHIPPED TREE. No analytics ORIGIN, no loader URL, no
//   measurement id, anywhere in anything this image serves. This is the tier
//   that carries "zero analytics loaders on every channel", and it is provable
//   over the frozen generations as they stand: measured at UIP-P1, no mount
//   generation has ever contained one. The loader only ever lived in the shell.
//
//   TIER 2 — THE SHELL AND THE LIVE MOUNT. No analytics VOCABULARY either:
//   trackEvent, dataLayer, gtag, the seam name, the debug key. This is the tier
//   that says the product cannot report anything even in principle, and it is
//   scoped to what actually runs, because that is the honest scope for it.
//
// WHAT IS DELIBERATELY NOT THE SUBJECT. data/mvp_masterplan.md carries the old
// measurement id and is a SUPERSEDED historical artifact (AGENTS.md §12) that
// ships on no channel; this guard scans the ship list, not the repository, and
// widening it to the repository would make it a documentation gate wearing a
// delivery gate's name.

const fs = require('fs');
const path = require('path');

const { test, expect } = require('@playwright/test');
const { shippedPaths, expandShippedFiles, currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');
const MOUNT = currentMount(SHELL);

const SHIP = expandShippedFiles(
    shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8')),
    APP_ROOT
);

// Text the browser would EVALUATE or RENDER, with the explanations stripped out.
//
// A CHARACTER SCANNER, NOT A REGEX, AND THE REASON IS A BUG THIS FILE SHIPPED
// FOR ONE AFTERNOON. The first draft ran three `.replace()` passes with the
// block-comment pass BEFORE the line-comment pass. `surfaces/diary.js:40` ends a
// Russian sentence with `…импортирует только core/*.`; that `/*` paired with the
// `*/` closing a JSDoc twenty lines below, and the pass deleted the imports,
// `function el()` and `editingRecordId` before any leg looked at them. Measured
// when it was found: **18 files of the live mount lost real text, 296 characters
// of it in `diary.js` alone.** A `trackEvent(` in a swallowed region would have
// been invisible to every leg here, and the guard would have been green about
// nothing. That is a regex failing OPEN, which is the failure class `LSC-DL-004`
// already cost this repository once.
//
// Folding the three passes into one left-to-right alternation fixes the case
// that was found, and leaves a second one standing: a `/*` or `//` inside a
// STRING LITERAL — `'https://www.googletagmanager.com/gtag/js'` is exactly that
// shape, and it is the string this guard exists to find. A scanner that tracks
// quotes cannot make either mistake, so the guard uses one.
//
// WHAT IT DELIBERATELY DOES NOT MODEL: regular-expression literals. `/*` cannot
// begin one (it is a comment in JavaScript too), and a `//` inside a character
// class is the only remaining shape; the shipped tree contains none, and the
// detector below is what would notice if one arrived, because the removed chunk
// would not begin with a comment opener.
//
// Stripping at all is what lets a removal be EXPLAINED in the file it happened
// in without the explanation reading as the thing it removed — and
// `the stripper removes comments and nothing else` below is what keeps that
// licence from becoming a hole.
function stripComments(source, isHtml) {
    const removed = [];
    let out = '';
    let i = 0;
    let quote = null; // "'", '"', '`' — inside a string or template
    while (i < source.length) {
        const two = source.slice(i, i + 2);
        if (quote) {
            if (source[i] === '\\') {
                out += source.slice(i, i + 2);
                i += 2;
                continue;
            }
            if (source[i] === quote) quote = null;
            out += source[i];
            i += 1;
            continue;
        }
        if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
            quote = source[i];
            out += source[i];
            i += 1;
            continue;
        }
        if (isHtml && source.startsWith('<!--', i)) {
            const close = source.indexOf('-->', i + 4);
            const stop = close === -1 ? source.length : close + 3;
            removed.push(source.slice(i, stop));
            i = stop;
            continue;
        }
        if (two === '/*') {
            const close = source.indexOf('*/', i + 2);
            const stop = close === -1 ? source.length : close + 2;
            removed.push(source.slice(i, stop));
            i = stop;
            continue;
        }
        if (two === '//') {
            const nl = source.indexOf('\n', i);
            const stop = nl === -1 ? source.length : nl;
            removed.push(source.slice(i, stop));
            i = stop;
            continue;
        }
        out += source[i];
        i += 1;
    }
    return { code: out, removed };
}

function rawOf(urlPath) {
    return fs.readFileSync(path.join(APP_ROOT, urlPath.replace(/^\//, '')), 'utf8');
}

function scanOf(urlPath) {
    return stripComments(rawOf(urlPath), path.extname(urlPath) === '.html');
}

function codeOf(urlPath) {
    return scanOf(urlPath).code;
}

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.sql', '.txt']);

// The extensions this scan SKIPS, declared rather than implied. A filter that
// silently drops a file type reads as "everything was covered" when it was not,
// and the leg below turns that from a promise into a check: anything shipped
// whose extension is in neither set reds, so adding a `.svg`, a `.md` or a
// `.webmanifest` to the image forces a decision here instead of quietly
// escaping the scan. Measured at UIP-P1: the ship list is 482 files, and the
// only unscanned ones are 16 `.png`, 9 `.ttf` and 9 `.icc` — all genuinely
// binary, none of which can carry a loader a browser would execute.
const BINARY_EXTENSIONS = new Set(['.png', '.ttf', '.icc']);

const SCANNED = SHIP.filter((urlPath) => TEXT_EXTENSIONS.has(path.extname(urlPath)));

// Tier 1: the egress itself. A service that is never addressed is never reached.
const ORIGIN_TOKENS = [
    'googletagmanager.com',
    'google-analytics.com',
    'analytics.google.com',
    'gtag/js',
    'ga-disable-',
];
// A GA4 measurement id, in the form the shell used to declare it. Written as a
// pattern rather than as the retired literal: what must not come back is an id,
// not that particular id.
const MEASUREMENT_ID = /\bG-[A-Z0-9]{8,}\b/;

// Tier 2: the vocabulary. Scoped to what is LIVE — every shipped text file that
// is not a frozen generation — see the header and the LIVE definition below.
const VOCABULARY = [
    'trackEvent',
    'dataLayer',
    'gtag(',
    'theygrowAnalytics',
    'analyticsEnabled',
    'ga_debug',
];
// THE LIVE SCOPE IS EVERY SHIPPED TEXT FILE THAT IS NOT A FROZEN GENERATION —
// not just the shell and the mount. `app/sw.js` and `app/offline.html` are live,
// browser-executed and editable, and an earlier form of this list named only the
// shell and the mount prefix, so a `trackEvent` or a `dataLayer` in the service
// worker would have passed tier 2 without anything saying so. The worker is the
// one file in this image that runs on EVERY navigation of an installed client,
// which makes it the worst place for that hole to have been.
const FROZEN = /^\/m\/v\d+\//;
const LIVE = SCANNED.filter(
    (urlPath) => !FROZEN.test(urlPath) || urlPath.startsWith(MOUNT.prefix)
);

test.describe(`nothing shipped loads or reports to analytics — /m/${MOUNT.dir}/ (UIP-P1-INV-001, static)`, () => {
    // ANTI-VACUITY, AND THIS FILE NEEDS MORE OF IT THAN MOST. Every leg below is
    // "a string is absent", which is green against an empty file, an empty list
    // and a typo in a path — the failure shape this repository keeps paying for.
    // So: the ship list is real and big, the live scope inside it is real and
    // big, the shell was actually read, and three surfaces that MUST still exist
    // are asserted present. If any of those four is wrong, the absences below
    // are facts about the reader rather than about the tree.
    test('the scan is looking at the real shipped tree', () => {
        expect(SHIP.length, 'the ship list collapsed — nothing would be scanned').toBeGreaterThan(30);
        expect(
            SCANNED.length,
            'no text file survived the extension filter — every leg below would be vacuous'
        ).toBeGreaterThan(20);
        expect(
            LIVE.length,
            'the live scope is empty — the mount prefix and the ship list disagree'
        ).toBeGreaterThan(20);
        expect(SCANNED, 'the shell is not in the scanned set').toContain('/index.html');
        // Every live, editable, browser-executed text file has to be in the live
        // scope, and each is named rather than assumed — this list is what tier 2
        // actually covers, and a member quietly dropping out of it is the hole
        // this leg exists to keep shut.
        for (const live of ['/index.html', '/sw.js', '/offline.html', `${MOUNT.prefix}app.css`, `${MOUNT.prefix}app.js`]) {
            expect(LIVE, `${live} is not in the live scope — tier 2 does not cover it`).toContain(live);
        }
        // And no frozen generation may be: those carry trackEvent() call sites
        // that ADR-024 forbids editing, so including one would red tier 2 forever.
        expect(
            LIVE.filter((u) => FROZEN.test(u) && !u.startsWith(MOUNT.prefix)),
            'a frozen generation leaked into the live scope'
        ).toEqual([]);

        const shellCode = codeOf('/index.html');
        expect(shellCode.length, 'the shell collapsed to almost nothing').toBeGreaterThan(10000);
        // Three things that must still be there, so "absent" is a fact about the
        // forbidden strings and not about the stripper having eaten the file.
        expect(shellCode).toContain('id="updateBanner"');
        expect(shellCode).toContain('id="apkBtn"');
        expect(shellCode).toContain('IS_NATIVE_SHELL');
    });

    // THE STRIPPER REMOVES COMMENTS AND NOTHING ELSE. Every leg below reads
    // stripped text, so a stripper that swallowed code would make them green
    // about the part of the tree it ate — which is exactly what the first draft
    // of this file did to 18 mount files. The property is checked on the removed
    // text itself rather than by guessing which lines were code: every chunk the
    // scanner took out must BEGIN with a real comment opener, which is false for
    // any region entered by mistake.
    test('the stripper removes comments and nothing else', () => {
        const bad = [];
        let chunks = 0;
        for (const urlPath of SCANNED) {
            for (const chunk of scanOf(urlPath).removed) {
                chunks += 1;
                if (!/^(\/\/|\/\*|<!--)/.test(chunk)) {
                    bad.push(`${urlPath}: removed a region starting ${JSON.stringify(chunk.slice(0, 40))}`);
                }
            }
        }
        expect(
            bad,
            'the stripper deleted a region that does not begin with a comment opener, so every leg'
                + ' below is reading less than the file'
        ).toEqual([]);
        // Anti-vacuity, both directions: it must actually have removed comments,
        // and it must have left the code behind. `function el(` is the exact
        // declaration the first draft of this file swallowed.
        expect(chunks, 'the stripper removed nothing — it is not running').toBeGreaterThan(500);
        const diary = `${MOUNT.prefix}surfaces/diary.js`;
        expect(
            codeOf(diary),
            'function el() is missing from the stripped diary surface — the swallowing bug is back'
        ).toContain('function el(');
        expect(
            codeOf(diary),
            'the imports are missing from the stripped diary surface'
        ).toContain("from '../store/boot.js'");
        // And it must still do the job it exists for: a comment that names an
        // analytics origin has to disappear, or tier 1 would red on prose.
        //
        // FOUND RATHER THAN NAMED. An earlier form of this assertion pointed at
        // `/m/v8/surfaces/consent.js` by path, which is a reference under
        // app/tests/ to a generation the shell does not run — exactly what
        // mount-reference.spec.js forbids (DIA-P1-INV-003 half a), and it red
        // there. Deriving the file instead of naming it is also the stronger
        // form: it asserts the property for EVERY file that has such a comment,
        // not for the one that happened to be remembered.
        const prose = SCANNED.filter((urlPath) =>
            ORIGIN_TOKENS.some((token) => rawOf(urlPath).includes(token))
        );
        expect(
            prose.length,
            'no shipped file mentions an analytics origin even in prose, so this leg cannot show the'
                + ' stripper doing the one job tier 1 depends on'
        ).toBeGreaterThan(0);
        for (const urlPath of prose) {
            for (const token of ORIGIN_TOKENS) {
                if (!rawOf(urlPath).includes(token)) continue;
                expect(
                    codeOf(urlPath),
                    `${urlPath} mentions "${token}" in a comment and the stripper left it, so tier 1`
                        + ' would red on prose rather than on code'
                ).not.toContain(token);
            }
        }
    });

    // NO SILENT TRUNCATION. Coverage that is bounded has to say what it dropped.
    test('every shipped file is either scanned or a declared binary', () => {
        const unaccounted = SHIP.filter((urlPath) => {
            const ext = path.extname(urlPath);
            return !TEXT_EXTENSIONS.has(ext) && !BINARY_EXTENSIONS.has(ext);
        });
        expect(
            unaccounted,
            `${unaccounted.join(', ')} ships with an extension this scan neither reads nor declares`
                + ' binary, so it escapes every leg below without anything saying so. Add the'
                + ' extension to TEXT_EXTENSIONS if a browser could execute or render its contents,'
                + ' or to BINARY_EXTENSIONS if it could not, and say which in the comment there'
        ).toEqual([]);
        // Anti-vacuity for this leg itself: the two sets must actually be
        // partitioning something, and neither may swallow the whole list.
        expect(SCANNED.length, 'nothing was scanned').toBeGreaterThan(20);
        expect(
            SHIP.length - SCANNED.length,
            'every shipped file was classified as text — the binary set is doing no work, which'
                + ' means the partition is not being exercised and this leg proves nothing'
        ).toBeGreaterThan(0);
    });

    // TIER 1 — every shipped text file, frozen generations included.
    for (const token of ORIGIN_TOKENS) {
        test(`no shipped file addresses "${token}"`, () => {
            const hits = SCANNED.filter((urlPath) => codeOf(urlPath).includes(token));
            expect(
                hits,
                `${hits.join(', ')} addresses an analytics origin — this image reaches no analytics`
                    + ' service on any channel, and the loader is the whole of the egress: the request'
                    + ' itself carries the visitor address and the user agent'
            ).toEqual([]);
        });
    }

    test('no shipped file carries a measurement id', () => {
        const hits = SCANNED.filter((urlPath) => MEASUREMENT_ID.test(codeOf(urlPath)));
        expect(
            hits,
            `${hits.join(', ')} declares a GA4 measurement id — an id in the ship list is a property`
                + ' waiting for a loader'
        ).toEqual([]);
    });

    // TIER 2 — the shell and the live mount only.
    for (const token of VOCABULARY) {
        test(`no live file carries "${token}"`, () => {
            const hits = LIVE.filter((urlPath) => codeOf(urlPath).includes(token));
            expect(
                hits,
                `${hits.join(', ')} carries "${token}" — the analytics vocabulary left the product at`
                    + ' UIP-P1 (vault ADR-043 annotation 2026-08-25), and a helper, a queue or a seam'
                    + ' with no loader behind it is how the loader comes back. The live scope is every'
                    + ' shipped text file except the frozen generations, whose bytes ADR-024 forbids'
                    + ' editing'
            ).toEqual([]);
        });
    }

    // The consent surface went with its object rather than staying switched off,
    // and a stylesheet that still dresses a deleted surface is how the surface
    // comes back — the shape install-channel.spec.js guards for the install
    // prompt, and the same shape here.
    test('the consent gate is gone from the live mount, module and rules together', () => {
        for (const gone of ['consent/config.js', 'surfaces/consent.js']) {
            expect(
                fs.existsSync(path.join(APP_ROOT, 'm', MOUNT.dir, gone)),
                `/m/${MOUNT.dir}/${gone} is back — the consent gate retired with the analytics it gated`
            ).toBe(false);
        }
        const css = codeOf(`${MOUNT.prefix}app.css`);
        for (const selector of ['.cookie-banner', '.footer-legal-btn']) {
            expect(
                css,
                `${selector} has rules but no element — a stylesheet that still dresses a deleted`
                    + ' surface is how the surface comes back'
            ).not.toContain(selector);
        }
        const shellCode = codeOf('/index.html');
        for (const id of ['cookieBanner', 'cookieEnableBtn', 'cookieDeclineBtn', 'cookieSettingsBtn']) {
            expect(shellCode, `the shell still carries #${id}`).not.toContain(id);
        }
    });

    // THE CHANNEL COMPOSITION, STATED RATHER THAN IMPLIED. "Every channel" is
    // carried by this file plus one other property, and naming the pairing here
    // is what stops a reader taking a web-shaped scan for a two-channel claim.
    // native/www is a byte copy of app/Dockerfile's COPY list, asserted in both
    // directions and by content hash in native-shell.spec.js (LSC-P1-INV-002).
    // The subject of the scan above IS that COPY list, so what holds for the web
    // channel holds for the APK's web root by composition. This leg pins the
    // premise: if the native channel ever stopped shipping this list, the
    // composition would break silently.
    test('the native channel ships this same list, so the scan covers it too', () => {
        const nativeShell = fs.readFileSync(
            path.join(__dirname, 'native-shell.spec.js'),
            'utf8'
        );
        expect(
            nativeShell,
            'native-shell.spec.js no longer derives the APK web root from app/Dockerfile — the'
                + ' composition this invariant depends on for the native channel is broken, and the'
                + ' scan above has become a web-only claim wearing a two-channel name'
        ).toContain('shippedPaths');
    });
});
