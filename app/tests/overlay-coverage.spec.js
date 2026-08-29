'use strict';

// NAV-P3-INV-003 — every overlay the app opens is declared as one of exactly
// three things.
//
// WHY THIS EXISTS. Since NAV-P3 the hardware back button decides what a press
// means by asking one question first: is anything standing in front of the
// current surface? It answers from the DECLARED table in
// `app/m/v{N}/nav/overlays.js`. A surface added later that opens a window
// nobody declared would not break loudly — it would make back skip that window
// and step the pager instead, or leave the app, from inside something the
// parent had opened. That is a silent wrong answer to the one question this
// packet exists to answer, and nothing else in the suite watches for it.
//
// WHAT THIS GUARD IS, EXACTLY. Its subject is DECLARATION COVERAGE, a static
// property of the shipped source, which is why a static scan is the right
// instrument for it — the same shape and for the same reason as
// `show-rule-coverage.spec.js` one layer down. It asserts: every element a
// shipped module makes visible is either
//
//   (1) a row of OVERLAYS — a window the back button closes; or
//   (2) a SURFACE of the pager — something back navigates between, not out of; or
//   (3) on the EXEMPT list below, with its reason written next to it.
//
// WHAT IT IS NOT. It proves nothing about runtime behaviour: what the back
// button actually does with those declarations is
// `app/tests/back-button.spec.js` off-device and `BackButtonTest` on a device.
// This one reds when a declaration goes missing, which is the half neither of
// those can see.
//
// FAIL-CLOSED. Every resolution step throws on a form it does not fully
// understand, mirroring `show-rule-coverage.spec.js` and `support/ship-list.js`.
// A call site whose target cannot be resolved is a loud false negative
// (recoverable); a silently skipped one is the false positive this guard exists
// to prevent.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');

// The mount the shell references, never a literal (EMV-DL-001).
const MOUNT = currentMount(SHELL);
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);

function jsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(abs));
        else if (entry.name.endsWith('.js')) out.push(abs);
    }
    return out.sort();
}

const SOURCES = jsFiles(MOUNT_DIR).map((abs) => ({
    where: `app/m/${MOUNT.dir}/${path.relative(MOUNT_DIR, abs).split(path.sep).join('/')}`,
    source: fs.readFileSync(abs, 'utf8'),
}));

// ─── the three declarations, read out of the shipped modules ────────────────

const OVERLAYS_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'nav', 'overlays.js'), 'utf8');
const PAGER_SOURCE = fs.readFileSync(path.join(MOUNT_DIR, 'surfaces', 'pager.js'), 'utf8');

// Read as PAIRS, so a row that lost its closer cannot pass as a row.
const DECLARED_OVERLAYS = Array.from(
    OVERLAYS_SOURCE.matchAll(/\{\s*id:\s*'([^']+)',\s*closerId:\s*'([^']+)'\s*\}/g)
).map(([, id, closerId]) => ({ id, closerId }));

// The pager names its surfaces by one constant each; the base surface declares
// `surfaceId: null` rather than omitting the field, so «no element» is a stated
// answer instead of a missing one.
const PAGER_SURFACE_CONSTANT = /const\s+DIARY_SURFACE_ID\s*=\s*'([^']+)'/.exec(PAGER_SOURCE);
const DECLARED_SURFACES = PAGER_SURFACE_CONSTANT ? [PAGER_SURFACE_CONSTANT[1]] : [];

// ─── the third group, and the only hand-written list in this file ───────────
//
// Every entry here is something a shipped module makes visible that the back
// button deliberately does NOT act on, with the reason. An addition to this
// list is a decision about what the back button means, which is why it is a
// list of exemptions with reasons rather than a pattern.
const EXEMPT = Object.freeze({
    headerMenuPanel:
        'a panel, not a window: it has no close control to press, and it already '
        + 'closes on any click outside it and on Escape (surfaces/menu.js). Scope '
        + 'item 5 of NAV-P3 says «modal».',
    profileDropdown:
        'the profile list, which closes the same way and for the same reason as '
        + 'the header panel above.',
    exportDoneBanner:
        'an announcement that deliberately OUTLIVES the window it came from '
        + '(DIA-P2): it is not in front of anything, and dismissing it with the '
        + 'hardware button would take a confirmation away from a parent who has '
        + 'not read it.',
});

// ─── the scan ───────────────────────────────────────────────────────────────

// `document.getElementById('x')`, the `el('x')` alias, and the injected
// `doc.getElementById('x')` — the same three receivers show-rule-coverage
// resolves, and for the same stated reason: a NAMED alias rather than «any
// receiver», which could be any object at all.
const GET = String.raw`(?:document\.getElementById|doc\.getElementById|el)\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)`;

const REVEALS = [
    {
        what: "classList.add('show')",
        any: /\.classList\.add\(\s*['"]show['"]\s*\)/,
        direct: new RegExp(`${GET}\\s*\\.classList\\.add\\(\\s*['"]show['"]\\s*\\)`),
        viaVar: /(?:^|[^.\w])([A-Za-z_$][\w$]*)\.classList\.add\(\s*['"]show['"]\s*\)/,
    },
    {
        // #skillModal has never used the class idiom; it opens with an inline
        // style. A scanner that knew only the class would have left the one
        // window that can be stacked over another entirely unseen.
        what: "style.display = 'block'",
        any: /\.style\.display\s*=\s*['"]block['"]/,
        direct: new RegExp(`${GET}\\s*\\.style\\.display\\s*=\\s*['"]block['"]`),
        viaVar: /(?:^|[^.\w])([A-Za-z_$][\w$]*)\.style\.display\s*=\s*['"]block['"]/,
    },
];

/** Resolves `const modal = document.getElementById('id')` bindings in a file. */
function bindings(source, where) {
    const found = new Map();
    const re = new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${GET}`, 'g');
    for (const match of source.matchAll(re)) {
        const [, name, id] = match;
        const seen = found.get(name);
        if (seen && seen !== id) {
            throw new Error(
                `${where}: "${name}" is bound to both "${seen}" and "${id}" — the overlay `
                + 'scanner cannot resolve which element a call site means'
            );
        }
        found.set(name, id);
    }
    return found;
}

const CALL_SITES = SOURCES.flatMap(({ where, source }) => {
    const bound = bindings(source, where);
    return source.split('\n').flatMap((line, i) => {
        const at = `${where}:${i + 1}`;
        return REVEALS.filter(({ any }) => any.test(line)).map(({ what, direct, viaVar }) => {
            const named = direct.exec(line);
            if (named) return { at, what, id: named[1] };

            const throughVar = viaVar.exec(line);
            if (throughVar) {
                const id = bound.get(throughVar[1]);
                if (!id) {
                    throw new Error(
                        `${at}: reveals "${throughVar[1]}" with ${what}, which this file never `
                        + 'binds with getElementById — the overlay scanner fails closed rather '
                        + 'than skipping it'
                    );
                }
                return { at, what, id };
            }

            throw new Error(
                `${at}: reveals an element with ${what} in a form the overlay scanner does not `
                + 'understand — extend the scanner rather than leaving the call site undeclared'
            );
        });
    });
});

test.describe(`overlay declaration coverage — /m/${MOUNT.dir}/ (NAV-P3-INV-003)`, () => {
    test('the scan found the declarations and the call sites it exists to cover', () => {
        // Anti-vacuity. A scanner that silently found nothing would satisfy
        // every assertion below, which is the shape of failure this guard is
        // about in the first place.
        expect(SOURCES.length).toBeGreaterThan(20);
        expect(CALL_SITES.length).toBeGreaterThanOrEqual(10);
        expect(DECLARED_OVERLAYS.length).toBeGreaterThanOrEqual(7);
        expect(DECLARED_SURFACES).toEqual(['diaryModal']);

        // Both reveal shapes were actually seen, by name — a regex that stopped
        // matching one of them would otherwise reduce this file to half a scan.
        const shapes = new Set(CALL_SITES.map((site) => site.what));
        expect(shapes).toContain("classList.add('show')");
        expect(shapes).toContain("style.display = 'block'");

        // And the two windows whose treatment differs are among them by name.
        const ids = CALL_SITES.map((site) => site.id);
        expect(ids).toContain('skillModal');
        expect(ids).toContain('diaryModal');
    });

    for (const { at, what, id } of CALL_SITES) {
        test(`#${id} (${at}) is declared as a window, a surface or an exemption`, () => {
            const asOverlay = DECLARED_OVERLAYS.some((row) => row.id === id);
            const asSurface = DECLARED_SURFACES.includes(id);
            const asExemption = Object.prototype.hasOwnProperty.call(EXEMPT, id);

            const groups = [asOverlay, asSurface, asExemption].filter(Boolean).length;
            expect(
                groups,
                `${at} reveals #${id} with ${what}, and it is in ${groups} of the three `
                + 'declarations. It must be in exactly one: a row of OVERLAYS in '
                + `app/m/${MOUNT.dir}/nav/overlays.js if the hardware back button should close `
                + 'it, a pager surface if back should navigate between it and its neighbours, '
                + 'or an exemption in this file with the reason written down.'
            ).toBe(1);
        });
    }

    test('every declared window names a close control that exists in the shell', () => {
        // A row whose closer is gone is a window the back button cannot close —
        // and surfaces/back.js answers «handled» in that case rather than
        // leaving the app, so the failure would be a back button that does
        // nothing at all.
        const missing = DECLARED_OVERLAYS.filter(
            ({ closerId }) => !new RegExp(`\\bid\\s*=\\s*["']${closerId}["']`).test(SHELL)
        );
        expect(
            missing.map((row) => `${row.id} -> ${row.closerId}`),
            'app/index.html declares no element with these close-control ids'
        ).toEqual([]);
    });

    test('every declared window is an element the shell actually has', () => {
        const missing = DECLARED_OVERLAYS.filter(
            ({ id }) => !new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(SHELL)
        );
        expect(missing.map((row) => row.id)).toEqual([]);
    });

    test('the diary is a surface and not a window', () => {
        // The packet in one assertion: #diaryModal wears the .modal class and
        // opens the way the windows do, but the back button must STEP THE PAGER
        // rather than «close» it. Putting it back in the overlay table would
        // make back close it as a window, which is the same screen change today
        // and the wrong mechanism the moment a third surface arrives.
        expect(DECLARED_OVERLAYS.map((row) => row.id)).not.toContain('diaryModal');
        expect(DECLARED_SURFACES).toContain('diaryModal');
    });
});
