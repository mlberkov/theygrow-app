'use strict';

// A spread of an identifier that does not exist (DIA-P3R).
//
// WHAT THIS IS FOR. `surfaces/diary.js` shipped `...who` where the module
// declared `author()`, and every diary save threw a `ReferenceError` before it
// reached the store. Nothing in this repository noticed for a whole packet.
//
// WHAT IT IS DELIBERATELY NOT. It is not a linter, and it is not `no-undef`.
// That check is solved, it is solved by eslint, and this repository does not
// carry eslint on purpose — the app is buildless and its dependency surface is
// gated (`store-supply-chain.spec.js`). Doing it by hand needs a scope-accurate
// parser, and the cost of not having one was measured before this file was
// written: a crude free-identifier sweep over the mount surfaces 82 distinct
// unresolved names, of which some 35 are legitimate globals (`document`,
// `Object`, `Uint8Array`, `crypto`, `Blob`, …) and the rest are the sweep's own
// misses on parameters, shorthand and catch bindings. A check that reds 80 times
// to catch one defect is a check that gets deleted.
//
// So this is narrowed to the one shape where the ambiguity disappears: a SPREAD
// of a bare identifier. No shipped module spreads a global, so there is no
// allowlist to keep, and the declared-name set below is built GENEROUSLY on
// purpose — over-approximating what a file declares biases this towards missing
// a defect rather than towards accusing a correct file, which is the only bias
// a guard nobody asked for may have.
//
// AND IT IS HONEST ABOUT ITS REACH. It covers the shape that shipped, not the
// class. The class — "an identifier that does not exist on a path no test runs"
// — is bought by `diary-save.spec.js`, which EXECUTES the path. This file is a
// source scan: it reads bytes and boots nothing, and no green here says any code
// ran.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const MOUNT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir);

/** Every module in the generation the shell references. */
function modules(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...modules(at));
        else if (entry.name.endsWith('.js')) found.push(at);
    }
    return found.sort();
}

/**
 * Comments and string bodies replaced by blanks, so nothing below reads prose.
 *
 * The mount's comments are long, Russian, and full of code fragments, and its
 * SQL constants contain English words; a scan that read either would be reading
 * text nobody executes. Written as a single pass over the characters rather than
 * as regexes, because a regex that tries to skip strings and comments at once is
 * the classic way to produce a scanner that is confidently wrong.
 */
function code(source) {
    let out = '';
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === '/' && next === '/') {
            const end = source.indexOf('\n', i);
            i = end < 0 ? source.length : end;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end < 0 ? source.length : end + 2;
            out += ' ';
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i += 1;
            while (i < source.length && source[i] !== quote) {
                i += source[i] === '\\' ? 2 : 1;
            }
            i += 1;
            out += '""';
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

/**
 * Every name the file binds, over-approximated.
 *
 * Includes rest bindings, which is what makes the check below need no
 * classification of the `...` site: `function derivedId(...parts)` DECLARES
 * `parts`, so the spread of it resolves like any other name.
 */
function declared(source) {
    const names = new Set();
    const add = (blob) => {
        for (const word of blob.match(/[A-Za-z_$][\w$]*/g) || []) names.add(word);
    };

    for (const m of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(m[1]);
    }
    // Import clauses, default and namespace forms included.
    for (const m of source.matchAll(/\bimport\s+([^;]*?)\s+from\b/g)) add(m[1]);
    // Destructuring and array patterns wherever a binding keyword introduces one.
    for (const m of source.matchAll(/\b(?:const|let|var)\s*([{[][^;]*?[}\]])\s*=/g)) add(m[1]);
    // Parameter lists: anything inside parens that a function body or an arrow
    // follows. Generous by construction — a call's arguments can be swept in
    // too, which can only make this miss a defect, never invent one.
    for (const m of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) add(m[1]);
    for (const m of source.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of source.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(m[1]);
    }
    return names;
}

const MODULES = modules(MOUNT_DIR);

test.describe(`no shipped module in /m/${MOUNT.dir}/ spreads a name it never declares`, () => {
    test('the scan reaches the mount at all', () => {
        // ANTI-VACUITY. A scan that walked nothing would be green forever, and
        // green for the same reason a scan that walked everything and found
        // nothing is green.
        expect(MODULES.length, `no modules found under m/${MOUNT.dir}`).toBeGreaterThan(20);
        const spreads = MODULES.flatMap((file) =>
            (code(fs.readFileSync(file, 'utf8')).match(/\.\.\.\s*[A-Za-z_$][\w$]*/g) || []).map(
                (hit) => `${path.relative(APP_ROOT, file)}: ${hit}`
            )
        );
        expect(
            spreads.length,
            'the mount carries no spread at all, so this guard is examining nothing'
        ).toBeGreaterThan(0);
    });

    for (const file of MODULES) {
        const rel = path.relative(APP_ROOT, file);
        test(rel, () => {
            const source = code(fs.readFileSync(file, 'utf8'));
            const names = declared(source);
            const undeclaredNames = [];
            for (const m of source.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
                if (!names.has(m[1])) undeclaredNames.push(m[1]);
            }
            expect(
                undeclaredNames,
                `${rel} spreads a name it never declares — every call down this path throws a`
                    + ' ReferenceError before it reaches whatever it was going to do, which is'
                    + ' the defect run 31971968427 found in surfaces/diary.js'
            ).toEqual([]);
        });
    }
});
