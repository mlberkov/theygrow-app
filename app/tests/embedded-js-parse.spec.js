'use strict';

// The JavaScript that lives inside Java string literals, parsed (DIA-P4).
//
// WHY THIS EXISTS. Three instrumented suites drive the app by handing scripts to
// a WebView, and those scripts are written as Java string concatenations —
// hundreds of lines of JavaScript that no gate in this repository reads. They
// compile as Java whatever they say, they dex, they install, and a missing brace
// surfaces as a leg that times out on an emulator, several minutes and one
// dispatch later. The ad-hoc version of this check has been run twice by hand
// and found a live syntax error BOTH times (`DIA-DL-006`, `DIA-DL-007`). This
// makes it a gate that runs on every push.
//
// WHAT C3 MEASURED BEFORE THIS FILE EXISTED, AND WHY IT IS BUILT THIS WAY. The
// ad-hoc tool had a FALSE-POSITIVE mode. Its literal scanner treated a
// double-quoted phrase inside a `//` comment as a Java string, which split the
// concatenation in half and left both halves unparseable — it red on
// `DiaryEntryTest.fillToCeiling`, a chain that had been GREEN on a real device
// (run 31982061125). A guard that cries wolf is worse than no guard, because the
// first thing anyone does with one is stop reading it. So two rules here are
// requirements rather than taste:
//
//   1. COMMENTS ARE STRIPPED BEFORE LITERALS ARE SCANNED, by a character walker
//      that knows what a string is — never by a regex over raw source.
//   2. A CHAIN THIS SCANNER CANNOT FULLY RECONSTRUCT IS NEVER GUESSED AT. It
//      goes in the declared skip table below, with its file, its line and its
//      reason, and an UNDECLARED one reds. The guard would rather refuse to
//      answer than answer about a snippet it half-read.
//
// WHAT IT DOES NOT COVER, stated because a guard's reach is part of its result.
// It reads the JavaScript argument of four calls — `evaluate`, `pollFor`,
// `probe`, `evaluateJavascript` — resolving a bare identifier there back to its
// initialiser in the same file. JavaScript that reaches the device by ANY other
// path is invisible to it: a snippet assembled across method boundaries, one
// built by a loop or a StringBuilder, one passed through a collection, one
// composed from a constant defined in another file, and anything a Java helper
// wraps around a snippet after this scanner has read it. It is also only a
// PARSE. A script that parses can still ask for an element that is not there,
// which is why the device legs report what they did rather than that they ran.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');

const ANDROID_TEST_DIR = path.resolve(
    __dirname,
    '..',
    '..',
    'native',
    'android',
    'app',
    'src',
    'androidTest',
    'java',
    'app',
    'theygrow'
);

// The four calls that hand a string to a WebView, and WHICH argument is the
// script. Declared rather than guessed: the JS is argument 1 of the three
// helpers this repository writes and argument 0 of the platform call they all
// end at.
// `await` IS IN THIS LIST BECAUSE THE GUARD'S OWN ARM-CHECK PUT IT THERE. Built
// with only the four calls below it, this guard went GREEN against a brace
// deliberately removed from `DiaryEntryTest.searchFromTheSurface` — because that
// suite dispatches its async scripts through a helper of its own, `await(scenario,
// slot, body)`, and the body never reaches `evaluate` as a literal. The largest
// and most intricate scripts in that file — the seeding, the disk-full arming,
// the release, the search — were invisible. The ad-hoc tool this replaces did
// read them, so the guard was briefly NARROWER than the thing it was replacing.
// The census leg below exists so this class of blindness reds instead of passing.
const JS_POSITIONS = Object.freeze({
    evaluate: 1,
    pollFor: 1,
    probe: 1,
    await: 2,
    evaluateJavascript: 0,
});

// THE DECLARED SKIP TABLE. Every entry is a JavaScript argument this scanner
// refuses to reconstruct, with the reason it cannot. An argument that is not
// checkable and NOT listed here fails the suite — that is the half that keeps
// this table from becoming a way to make the guard quiet.
//
// `line` is the line of the call in the file as committed. It is asserted, so a
// drifting entry reds and has to be re-read rather than re-trusted.
// Three kinds of entry, and no fourth. (1) THE PLUMBING: a suite's own
// `evaluate`/`pollFor` forwarding its own `String expression` parameter. There is
// no snippet at those lines at all — the snippets are at the call sites, where
// this guard already reads them, so these are the guard meeting its own
// scaffolding. (2) A CHAIN WITH A NON-LITERAL OPERAND: a Java value is
// concatenated into the script, so no correct reconstruction exists and the
// guard refuses rather than approximates. (3) A LOCAL OR CONSTANT built from
// one of those.
const DECLARED_SKIPS = Object.freeze([
    {
        file: 'BridgeSmokeTest.java',
        line: 247,
        // Where the chain itself starts, which is what the census counts. Only
        // the two entries that ARE chains carry it; the plumbing entries name a
        // parameter and have no chain of their own.
        chainLine: 249,
        argument: 'a chain carrying MountAddress.prefix()',
        reason:
            'the store-probe script builds its import URL from a Java call, so the chain has a'
            + ' non-literal operand. Substituting a stand-in would be this guard approximating'
            + ' a script instead of reading one',
    },
    {
        file: 'BridgeSmokeTest.java',
        line: 221,
        chainLine: 66,
        argument: 'SHELL_ENTRY',
        reason:
            'the constant it names is itself a chain carrying the BOOTED constant, so it is'
            + ' unreadable for the same reason one step further out',
    },
    {
        file: 'BridgeSmokeTest.java',
        line: 307,
        argument: 'expression',
        reason:
            "the suite's own pollFor() plumbing — `expression` is its parameter, and every"
            + ' snippet it forwards is read at the call site that supplies it',
    },
    {
        file: 'BridgeSmokeTest.java',
        line: 324,
        argument: 'expression',
        reason: "the suite's own evaluate() plumbing, same as above",
    },
    {
        file: 'BridgeSmokeTest.java',
        line: 342,
        argument: 'diagnostic',
        reason:
            "pollFor()'s optional diagnostic parameter, evaluated only on a timeout. Its"
            + ' snippets are read at the call sites that pass them',
    },
    {
        file: 'DeviceLogTest.java',
        // Moved from 645 by PPR-P2, which removed this suite's transfer leg and
        // the refuseTwice() helper above these lines. The line is asserted rather
        // than trusted, so a drift like this one reds and gets re-read.
        line: 520,
        argument: '"window." + slot',
        reason:
            "the same shape as DiaryEntryTest's await(): the async slot name is a Java variable,"
            + ' so the chain has a non-literal operand and no correct reconstruction reaches it',
    },
    {
        file: 'DeviceLogTest.java',
        // Moved from 653 by PPR-P2, for the same reason as the entry above.
        line: 528,
        argument: 'expression',
        reason: "the suite's own pollFor() plumbing, same as BridgeSmokeTest's",
    },
    {
        file: 'DiaryEntryTest.java',
        line: 1063,
        argument: '"window." + slot',
        reason:
            'a chain with a non-literal operand: the async slot name is a Java variable. C3'
            + ' measured this exact shape — it was the one snippet of twenty-one that no'
            + ' correct reconstruction reaches',
    },
    {
        file: 'DiaryEntryTest.java',
        line: 1071,
        argument: 'expression',
        reason: "the suite's own evaluate() plumbing, same as BridgeSmokeTest's",
    },
    {
        file: 'ExportSinkTest.java',
        line: 146,
        argument: 'expression',
        reason: "the suite's own evaluate() plumbing, same as BridgeSmokeTest's",
    },
    {
        file: 'StoreLifecycleTest.java',
        line: 200,
        argument: '"window." + slot',
        reason:
            "the same shape as DeviceLogTest's await(): the async slot name is a Java variable,"
            + ' so the chain has a non-literal operand and no correct reconstruction reaches it',
    },
    {
        file: 'StoreLifecycleTest.java',
        line: 284,
        argument: 'expression',
        reason: "the suite's own evaluate() plumbing, same as BridgeSmokeTest's",
    },
    {
        file: 'ExportTransferTest.java',
        // Moved from 575 by L3-P4, which added the diary-scope case and its
        // fixture above this method. The line is asserted rather than trusted,
        // so a drift like this one reds and gets re-read — which is the whole
        // point of carrying the number.
        line: 779,
        argument: 'expression',
        reason: "the suite's own evaluate() plumbing, same as BridgeSmokeTest's",
    },
    {
        file: 'WebViewStorageTest.java',
        line: 271,
        argument: '"(" + BOOTED + ") ? \'booted\' : null"',
        reason:
            'a chain with a non-literal operand: the boot sentinel is a Java constant spliced'
            + ' into a ternary',
    },
    {
        file: 'WebViewStorageTest.java',
        line: 285,
        argument: '"(" + BOOTED + ") ? (" + expression + ") : null"',
        reason:
            'the same splice, wrapping a caller-supplied snippet as well — two non-literal'
            + ' operands, and the inner snippet is read where the caller writes it',
    },
    {
        file: 'WebViewStorageTest.java',
        line: 297,
        argument: 'expression',
        reason: "the suite's own evaluate() plumbing, same as BridgeSmokeTest's",
    },
]);

// Placeholder tokens the suites substitute at runtime (`__DATE__`, `__CHILD__`,
// `__BODY__` …). They are replaced with a benign identifier before parsing: the
// guard is about the SHAPE of the script, and what a fixture puts in the hole is
// the fixture's business. `x` rather than a string, so both `'__CHILD__'` and a
// bare `__BODY__` reduce to something a parser accepts.
const PLACEHOLDER = /__[A-Z0-9_]+__/g;

/**
 * Java comments blanked out, offsets and line numbers preserved.
 *
 * A character walker rather than a regex, and that is the whole point of it: a
 * regex over raw source cannot tell a `"` inside a `//` comment from the start of
 * a literal, which is exactly the false positive C3 measured. Comment bodies
 * become spaces so every later index and line number still refers to the real
 * file.
 */
function stripComments(source) {
    const out = new Array(source.length);
    let at = 0;
    const blank = (from, to) => {
        for (let i = from; i < to; i += 1) out[i] = source[i] === '\n' ? '\n' : ' ';
    };
    while (at < source.length) {
        const c = source[at];
        if (c === '"' || c === "'") {
            out[at] = c;
            at += 1;
            while (at < source.length) {
                out[at] = source[at];
                if (source[at] === '\\' && at + 1 < source.length) {
                    out[at + 1] = source[at + 1];
                    at += 2;
                    continue;
                }
                if (source[at] === c) {
                    at += 1;
                    break;
                }
                at += 1;
            }
            continue;
        }
        if (c === '/' && source[at + 1] === '/') {
            let end = source.indexOf('\n', at);
            if (end === -1) end = source.length;
            blank(at, end);
            at = end;
            continue;
        }
        if (c === '/' && source[at + 1] === '*') {
            let end = source.indexOf('*/', at + 2);
            end = end === -1 ? source.length : end + 2;
            blank(at, end);
            at = end;
            continue;
        }
        out[at] = c;
        at += 1;
    }
    return out.join('');
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** Walks one balanced `(...)`, respecting string literals. Returns the inside. */
function balanced(source, open) {
    let depth = 0;
    for (let at = open; at < source.length; at += 1) {
        const c = source[at];
        if (c === '"' || c === "'") {
            at += 1;
            while (at < source.length && source[at] !== c) {
                if (source[at] === '\\') at += 1;
                at += 1;
            }
            continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, at);
        }
    }
    throw new Error('an argument list is never closed; this scan cannot read the file');
}

/** Top-level comma split, respecting strings and every kind of bracket. */
function splitArguments(text) {
    const args = [];
    let depth = 0;
    let start = 0;
    for (let at = 0; at < text.length; at += 1) {
        const c = text[at];
        if (c === '"' || c === "'") {
            at += 1;
            while (at < text.length && text[at] !== c) {
                if (text[at] === '\\') at += 1;
                at += 1;
            }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ',' && depth === 0) {
            args.push(text.slice(start, at));
            start = at + 1;
        }
    }
    args.push(text.slice(start));
    return args.map((a) => a.trim());
}

const JAVA_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\' };

/** One Java string literal's actual characters. */
function unescape(literal) {
    const body = literal.slice(1, -1);
    let out = '';
    for (let at = 0; at < body.length; at += 1) {
        if (body[at] !== '\\') {
            out += body[at];
            continue;
        }
        const next = body[at + 1];
        if (next === 'u') {
            out += String.fromCharCode(parseInt(body.slice(at + 2, at + 6), 16));
            at += 5;
            continue;
        }
        out += JAVA_ESCAPES[next] ?? next;
        at += 1;
    }
    return out;
}

const LITERAL = /"(?:\\.|[^"\\])*"/g;

/** `Type name` — the shape a parameter has and an argument expression does not. */
const PARAMETER = /^(?:final\s+)?[A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\s*\])?\s+[A-Za-z_$][\w$]*$/;

/**
 * The script an expression reconstructs to, or null when it cannot be read.
 *
 * ACCEPTED: string literals joined by `+`, optionally wrapped in parentheses,
 * optionally followed by any number of `.replace(<literal>, <anything>)` calls —
 * which is how every suite here parameterises a snippet. REFUSED: anything else,
 * and refused OUT LOUD rather than approximated.
 */
function reconstruct(expression) {
    let text = expression.trim();
    // Peel `.replace(...)` tails from the right. Their arguments are dropped: the
    // placeholder they fill is substituted with a benign token below, because a
    // fixture value is not what this guard is about.
    for (;;) {
        const tail = text.lastIndexOf('.replace(');
        if (tail === -1) break;
        const inside = balanced(text, tail + '.replace'.length);
        const after = text.slice(tail + '.replace('.length + inside.length + 1).trim();
        if (after !== '') return null;
        text = text.slice(0, tail).trim();
    }
    while (text.startsWith('(') && balanced(text, 0).length === text.length - 2) {
        text = text.slice(1, -1).trim();
    }

    const literals = text.match(LITERAL);
    if (!literals) return null;
    // Everything between the literals must be `+` and whitespace. A single
    // identifier left over means an operand this scanner cannot see.
    const between = text.replace(LITERAL, '');
    if (/[^\s+]/.test(between)) return null;
    return literals.map(unescape).join('').replace(PLACEHOLDER, 'x');
}

/**
 * `String name = <expr>;` — the one NEAREST ABOVE the call site, or null.
 *
 * Nearest, not first, and the difference is a coverage hole rather than a
 * nicety: `HistoryTransferTest` built six different scripts into locals all
 * called `script`, so taking the first match in the file resolved five call
 * sites to the wrong snippet and left their real ones unread. The census leg
 * found that; this is what closed it. That suite is retired (PPR-P2) and the
 * rule is not: any suite that reuses a local name has the same shape, and
 * `nearest` is what keeps this reader honest about which snippet it read.
 */
function initialiserOf(stripped, name, before) {
    const declaration = new RegExp(`(?:^|[^.\\w])(?:String\\s+)?${name}\\s*=\\s*`, 'gm');
    const all = [];
    let hit = declaration.exec(stripped);
    while (hit) {
        all.push(hit);
        hit = declaration.exec(stripped);
    }
    // The nearest one ABOVE the call site, and only if there is one: a static
    // field is often declared below the methods that use it, and falling back to
    // the first match keeps those resolvable. Locals shadow fields in practice
    // because a local is always above its own call site.
    const found = all.filter((match) => match.index < before).pop() ?? all[0];
    if (!found) return null;
    const start = found.index + found[0].length;
    let depth = 0;
    for (let at = start; at < stripped.length; at += 1) {
        const c = stripped[at];
        if (c === '"' || c === "'") {
            at += 1;
            while (at < stripped.length && stripped[at] !== c) {
                if (stripped[at] === '\\') at += 1;
                at += 1;
            }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ';' && depth === 0) return stripped.slice(start, at);
    }
    return null;
}

/**
 * Every fully-literal concatenation in a file, with the line it starts on.
 *
 * Used only by the census: it does not decide what gets CHECKED, it decides
 * what the guard has to account for. Chains are cut at any character that is
 * neither a literal, `+`, nor whitespace, which is the same rule reconstruct()
 * applies — so a chain with a Java operand in the middle yields its literal runs
 * and none of them opens `(function`, which is exactly the outcome wanted.
 */
function literalChains(stripped) {
    const chains = [];
    let run = [];
    let start = 0;
    let at = 0;
    const flush = () => {
        if (run.length > 0) {
            chains.push({ line: lineOf(stripped, start), script: run.join('').replace(PLACEHOLDER, 'x') });
        }
        run = [];
    };
    while (at < stripped.length) {
        const c = stripped[at];
        if (c === '"') {
            LITERAL.lastIndex = at;
            const found = LITERAL.exec(stripped);
            if (found && found.index === at) {
                if (run.length === 0) start = at;
                run.push(unescape(found[0]));
                at = found.index + found[0].length;
                continue;
            }
        }
        if (!/[\s+]/.test(c)) flush();
        at += 1;
    }
    flush();
    return chains;
}

/** The expression a `String name(...)` method returns, or null. */
function returnOf(stripped, name) {
    const declaration = new RegExp(`String\\s+${name}\\s*\\(`).exec(stripped);
    if (!declaration) return null;
    const from = stripped.indexOf('return ', declaration.index);
    if (from === -1) return null;
    const start = from + 'return '.length;
    let depth = 0;
    for (let at = start; at < stripped.length; at += 1) {
        const c = stripped[at];
        if (c === '"' || c === "'") {
            at += 1;
            while (at < stripped.length && stripped[at] !== c) {
                if (stripped[at] === '\\') at += 1;
                at += 1;
            }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ';' && depth === 0) return stripped.slice(start, at);
    }
    return null;
}

/**
 * The script one expression carries, following at most ONE step to find it.
 *
 * Three shapes, and the second and third exist because the suites really use
 * them rather than because generality is nice:
 *
 *   1. The chain itself.
 *   2. A bare identifier — the two suites that wrap every snippet in a common
 *      template build it into a local first, and refusing to follow one step
 *      would leave the largest template in the tree unread.
 *   3. A call to a script FACTORY. `offerScript(surface)` returns a chain with
 *      the surface substituted in; `probeScript("(function …)")` takes the
 *      snippet as its argument and only substitutes. So the factory's own
 *      `return` is tried first, and its arguments after — one of those two is
 *      where the JavaScript actually is.
 *
 * Anything else returns null and lands in the skip table, which is the point:
 * this follows named steps it can name, and refuses the rest out loud.
 */
function resolveScript(stripped, expression, before) {
    const direct = reconstruct(expression);
    if (direct !== null) return direct;

    if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
        const initialiser = initialiserOf(stripped, expression, before);
        return initialiser === null ? null : reconstruct(initialiser);
    }

    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expression);
    if (call) {
        const inside = balanced(expression, call[0].length - 1);
        if (expression.slice(call[0].length + inside.length).trim() === ')') {
            const returned = returnOf(stripped, call[1]);
            const fromBody = returned === null ? null : reconstruct(returned);
            if (fromBody !== null) return fromBody;
            for (const argument of splitArguments(inside)) {
                const asScript = reconstruct(argument);
                if (asScript !== null) return asScript;
            }
        }
    }
    return null;
}

/** Every JavaScript argument in one file, checkable or not. */
function scriptArguments(file) {
    const raw = fs.readFileSync(path.join(ANDROID_TEST_DIR, file), 'utf8');
    const stripped = stripComments(raw);
    const found = [];
    for (const [call, index] of Object.entries(JS_POSITIONS)) {
        const site = new RegExp(`(?:^|[^.\\w])${call}\\s*\\(`, 'g');
        let hit = site.exec(stripped);
        while (hit) {
            const open = hit.index + hit[0].length - 1;
            const args = splitArguments(balanced(stripped, open));
            const argument = args[index];
            // A METHOD DECLARATION IS NOT A CALL SITE. `private String
            // evaluate(ActivityScenario<MainActivity> scenario, String
            // expression)` matches the same pattern as a call and would enter the
            // skip table as an argument nobody passes — nine entries of pure
            // noise in a table whose whole value is that a reader goes through it.
            // A parameter list is recognised by its shape: `Type name`, which no
            // argument expression has.
            const declaration = args.some((arg) => PARAMETER.test(arg));
            if (!declaration && argument !== undefined && argument !== '') {
                const script = resolveScript(stripped, argument, hit.index);
                found.push({
                    file,
                    line: lineOf(stripped, hit.index),
                    call,
                    argument,
                    script,
                });
            }
            site.lastIndex = open + 1;
            hit = site.exec(stripped);
        }
    }
    return found;
}

const FILES = fs
    .readdirSync(ANDROID_TEST_DIR)
    .filter((name) => name.endsWith('.java'))
    .sort();

const ALL = FILES.flatMap(scriptArguments);
const CHECKABLE = ALL.filter((entry) => entry.script !== null);
const UNCHECKABLE = ALL.filter((entry) => entry.script === null);

/**
 * `node --check` over one snippet. Returns the parser's own words on failure.
 *
 * The snippet is written as-is and parsed as a script, with no wrapper: these
 * are statements and expression statements as the WebView receives them, and a
 * wrapper would change what is legal at the top level.
 */
function parses(script) {
    const at = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-embedded-js-')),
        'snippet.js'
    );
    try {
        fs.writeFileSync(at, script);
        execFileSync(process.execPath, ['--check', at], { stdio: 'pipe' });
        return { ok: true, message: '' };
    } catch (failure) {
        return { ok: false, message: String(failure.stderr ?? failure.message).slice(0, 800) };
    } finally {
        fs.rmSync(path.dirname(at), { recursive: true, force: true });
    }
}

test.describe('every embedded script the instrumented suites hand to a WebView parses', () => {
    for (const entry of CHECKABLE) {
        test(`${entry.file}:${entry.line} ${entry.call}(…) parses`, () => {
            const verdict = parses(entry.script);
            expect(
                verdict.ok,
                `${entry.file}:${entry.line} hands the WebView JavaScript that does not parse.`
                    + ' On a device this is a leg that times out minutes into a dispatch.\n'
                    + `${verdict.message}\n--- reconstructed ---\n${entry.script}`
            ).toBe(true);
        });
    }
});

test.describe('the guard is not decorative', () => {
    test('it reads a real number of snippets across a real number of files', () => {
        // Anti-vacuity. A scanner that silently stopped matching would make every
        // test above pass by not existing. The floors are well under what is
        // there today (40+ across 4 suites), so ordinary editing does not move
        // them and a collapse does.
        expect(CHECKABLE.length, 'the scanner found almost no embedded scripts').toBeGreaterThan(29);
        const files = new Set(CHECKABLE.map((entry) => entry.file));
        expect(files.size, 'the scanner reached only one or two suites').toBeGreaterThan(3);
    });

    test('no script of the standard shape is invisible to it', () => {
        // THE CENSUS, AND IT IS HERE BECAUSE THE GUARD FAILED ITS OWN ARM-CHECK
        // ONCE. Every embedded snippet in these suites opens `(function () {`.
        // This counts those chains WHEREVER they appear — independently of call
        // sites, positions, helpers and resolution — and requires each to be
        // covered by something this guard actually checked. A future suite that
        // dispatches its scripts through a helper nobody added to JS_POSITIONS
        // then reds HERE, rather than passing quietly with its scripts unread.
        const covered = new Set(CHECKABLE.map((entry) => entry.script));
        const invisible = [];
        for (const file of FILES) {
            const stripped = stripComments(
                fs.readFileSync(path.join(ANDROID_TEST_DIR, file), 'utf8')
            );
            for (const chain of literalChains(stripped)) {
                if (!chain.script.startsWith('(function')) continue;
                const seen = [...covered].some((script) => script.includes(chain.script));
                // A chain the skip table already accounts for is not invisible:
                // it is declared unreadable, with its reason, one entry away.
                const declared = DECLARED_SKIPS.some(
                    (skip) => skip.file === file && skip.chainLine === chain.line
                );
                if (!seen && !declared) invisible.push(`${file}:${chain.line}`);
            }
        }
        expect(
            invisible,
            'a script of the standard shape is in the tree and this guard never read it.'
                + ' Add the call that dispatches it to JS_POSITIONS, or declare it in'
                + ' DECLARED_SKIPS with the reason it cannot be read.'
        ).toEqual([]);
    });

    test('it rejects a snippet that does not parse — proven on its own input', () => {
        // SELF-PROVING, in the house style: the failing input is generated
        // in-run from a snippet this suite really checks, so the leg cannot rot
        // into asserting something about a fixture nobody uses. Dropping the last
        // brace is the exact defect the two ad-hoc runs found.
        const donor = CHECKABLE.map((entry) => entry.script).find((script) => script.includes('}'));
        expect(donor, 'no checked snippet contains a brace to remove').toBeTruthy();

        const wounded = donor.slice(0, donor.lastIndexOf('}')) + donor.slice(donor.lastIndexOf('}') + 1);
        expect(donor).not.toBe(wounded);

        // Both sides, because either alone proves nothing: the healthy snippet
        // must pass and the wounded one must fail, through the SAME checker.
        expect(parses(donor).ok, 'the donor snippet does not parse to begin with').toBe(true);
        const verdict = parses(wounded);
        expect(
            verdict.ok,
            'the checker accepted JavaScript with an unbalanced brace — it cannot go red,'
                + ' so none of the green above means anything'
        ).toBe(false);
        expect(verdict.message).toMatch(/SyntaxError/);
    });
});

test.describe('what the scanner cannot read is declared, not guessed', () => {
    test('every unreadable script argument is in the skip table', () => {
        const declared = new Set(DECLARED_SKIPS.map((skip) => `${skip.file}:${skip.line}`));
        const undeclared = UNCHECKABLE.filter(
            (entry) => !declared.has(`${entry.file}:${entry.line}`)
        );
        expect(
            undeclared.map((entry) => `${entry.file}:${entry.line} ${entry.call}(${entry.argument})`),
            'a script argument this guard cannot reconstruct is not declared in DECLARED_SKIPS.'
                + ' Either make it a literal chain, or add it with the reason it cannot be one —'
                + ' silently skipping it is how a guard goes quiet.'
        ).toEqual([]);
    });

    test('every skip-table entry still names a real unreadable argument', () => {
        // The other direction, and it is the half that keeps the table honest: an
        // entry left behind after its call site became checkable, or moved, is a
        // standing excuse nobody re-reads.
        const unreadable = new Set(UNCHECKABLE.map((entry) => `${entry.file}:${entry.line}`));
        const stale = DECLARED_SKIPS.filter((skip) => !unreadable.has(`${skip.file}:${skip.line}`));
        expect(
            stale.map((skip) => `${skip.file}:${skip.line} ${skip.argument}`),
            'a skip-table entry no longer matches an unreadable argument at that line'
        ).toEqual([]);
    });

    test('every skip-table entry carries a reason a reader can act on', () => {
        for (const skip of DECLARED_SKIPS) {
            expect(skip.reason.length, `${skip.file}:${skip.line} has no real reason`).toBeGreaterThan(
                24
            );
        }
    });
});
