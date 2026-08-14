'use strict';

// EMV-P1-INV-001 — every class-driven `show` has a rule that resolves it visible.
//
// WHY THIS EXISTS. `app/m/v1/app.css` declared `.modal { display: none }` and no
// `.modal.show`. Three shipped surfaces — the export modal, the legacy-import
// offer and the store-unavailable notice — are opened by
// `classList.add('show')` on a bare `.modal` element, so their handlers ran to
// completion and the window stayed invisible. Nothing in the suite noticed:
// every guard over those surfaces read SOURCE TEXT, and the source text was
// correct. The class was added. The sentence was in the shell. The button was
// wired. Only the rule that turns all of that into a visible modal was missing.
//
// WHAT THIS GUARD IS, EXACTLY. Its subject is RULE COVERAGE — a static property
// of the stylesheet, which is why a static scan is the right instrument for it.
// It asserts: for every `classList.add('show')` in the shipped mount, the
// element it targets carries a class for which `app.css` declares a `.show`
// rule.
//
// WHAT IT IS NOT, said plainly because this packet exists to punish exactly
// this confusion: it proves NOTHING about runtime behaviour. Empty
// `openExportModal()`'s body and every coverage assertion below stays green —
// the call site is gone, so there is nothing left to cover. (Measured, not
// assumed: that mutation was run. The only thing that reds is the anti-vacuity
// test, and only because it names `exportModal` by hand; empty ANY other
// surface's handler and this file is green end to end.) The behavioural claim
// — "clicking the export control produces a modal the parent can see" — is
// carried by `app/tests/behavior.spec.js`, which clicks the control and reads
// the computed style. That test, not this one, reds when the handler stops
// working. This one reds when the RULE goes missing, which is the half nothing
// was watching.
//
// FAIL-CLOSED. Every resolution step below throws on a form it does not fully
// understand, mirroring `tests/support/ship-list.js`. A call site whose target
// cannot be resolved is a loud false negative (recoverable); a silently skipped
// one is the false positive this guard exists to prevent.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');

// The mount the shell references, never a literal. A copy-forward bump leaves
// the frozen generation on disk, correctly without the new rule; scanning
// `app/m/**` would red on bytes that are right to leave alone (EMV-DL-001).
const MOUNT = currentMount(SHELL);
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);
const CSS = fs.readFileSync(path.join(MOUNT_DIR, 'app.css'), 'utf8');

// Every .js under the mount, so a new surface is covered the day it lands
// rather than the day someone remembers to add it here.
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

// `document.getElementById('x')` and the `el('x')` alias several surfaces use.
const DIRECT_TARGET = /(?:document\.getElementById|el)\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)\s*\.classList\.add\(\s*['"]show['"]\s*\)/;
// `modal.classList.add('show')` — resolved through the variable's binding.
const VAR_TARGET = /(?:^|[^.\w])([A-Za-z_$][\w$]*)\.classList\.add\(\s*['"]show['"]\s*\)/;
// Any add('show') at all, so nothing can slip past both patterns unseen.
const ANY_ADD = /\.classList\.add\(\s*['"]show['"]\s*\)/;

// Resolves `const modal = document.getElementById('id')` bindings in a file.
// Ambiguity throws: two bindings of the same name to different ids means this
// scanner cannot know which one a call site meant.
function bindings(source, where) {
    const found = new Map();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\.getElementById|el)\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g;
    for (const m of source.matchAll(re)) {
        const [, name, id] = m;
        const seen = found.get(name);
        if (seen && seen !== id) {
            throw new Error(
                `${where}: "${name}" is bound to both "${seen}" and "${id}" — the show-coverage scanner cannot resolve which element a call site means`
            );
        }
        found.set(name, id);
    }
    return found;
}

// Every add('show') call site in the mount, resolved to the element id it acts on.
const CALL_SITES = SOURCES.flatMap(({ where, source }) => {
    const bound = bindings(source, where);
    return source
        .split('\n')
        .map((line, i) => ({ line, at: `${where}:${i + 1}` }))
        .filter(({ line }) => ANY_ADD.test(line))
        .map(({ line, at }) => {
            const direct = DIRECT_TARGET.exec(line);
            if (direct) return { at, id: direct[1] };

            const viaVar = VAR_TARGET.exec(line);
            if (viaVar) {
                const id = bound.get(viaVar[1]);
                if (!id) {
                    throw new Error(
                        `${at}: adds 'show' to "${viaVar[1]}", which this file never binds with getElementById — the show-coverage scanner fails closed rather than skipping it`
                    );
                }
                return { at, id };
            }

            throw new Error(
                `${at}: adds 'show' in a form the show-coverage scanner does not understand — extend the scanner rather than leaving the call site uncovered`
            );
        });
});

// The class list the shell gives an element id.
function classesOf(id) {
    const tag = new RegExp(`<[a-z]+\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, 'i').exec(SHELL);
    if (!tag) {
        throw new Error(
            `app/index.html declares no element with id "${id}", but a shipped module adds 'show' to it`
        );
    }
    const cls = /\bclass\s*=\s*["']([^"']*)["']/.exec(tag[0]);
    if (!cls) {
        throw new Error(
            `app/index.html: #${id} carries no class attribute, so no .show rule can ever match it`
        );
    }
    return cls[1].split(/\s+/).filter(Boolean);
}

// Does app.css declare a rule whose selector is `.cls.show` (in either order,
// possibly inside a selector list)?
function hasShowRule(cls) {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\.${escaped}\\.show\\b|\\.show\\.${escaped}\\b`).test(CSS);
}

test.describe(`show-rule coverage — /m/${MOUNT.dir}/ (EMV-P1-INV-001)`, () => {
    // Anti-vacuity. A scanner that silently found nothing would pass every
    // assertion below, which is the shape of failure this milestone is about.
    test('the scan found the call sites it exists to cover', () => {
        expect(SOURCES.length).toBeGreaterThan(20);
        expect(CALL_SITES.length).toBeGreaterThanOrEqual(6);
        expect(CSS.length).toBeGreaterThan(1000);
        // The defect's own surface must be among them, by name.
        expect(CALL_SITES.map((c) => c.id)).toContain('exportModal');
    });

    for (const { at, id } of CALL_SITES) {
        test(`#${id} (${at}) has a .show rule that resolves it visible`, () => {
            const classes = classesOf(id);
            const covered = classes.filter((cls) => hasShowRule(cls));
            expect(
                covered.length,
                `${at} adds 'show' to #${id} (class="${classes.join(' ')}"), but app/m/${MOUNT.dir}/app.css declares no matching .show rule — the handler will run to completion and the element will stay display: none, which is exactly the export-modal defect`
            ).toBeGreaterThan(0);
        });
    }
});
