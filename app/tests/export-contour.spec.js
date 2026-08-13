// The export contour's own gates (L1-P3).
//
// Three properties are asserted here that no other spec covers, because the
// export contour is the first shipped surface that (a) writes UNENCRYPTED family
// data anywhere, (b) reaches a second native plugin, and (c) publishes a format
// this project has to keep readable for decades.
//
// The storage scan is deliberately duplicated from storage-seam.spec.js rather
// than added to it: LSC-P1-INV-001's scan walks the shipped HTML and the modules
// it statically reaches, so it already covers these files — and a second,
// narrower scan here means the export directory keeps its own guard even if the
// import graph is rearranged later.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const {
    shippedPaths,
    expandShippedFiles,
    offlineUrls,
    currentMount,
} = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8');

// The mount the SHELL references, never the literal 'v1' (EMV-DL-001): a
// copy-forward bump leaves the old generation on disk and shipped, so a pinned
// literal would keep guarding bytes nothing runs.
const MOUNT = currentMount(SHELL);
const EXPORT_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'export');
const SHIPPED = expandShippedFiles(
    shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8')),
    APP_ROOT
);
const PRECACHED = offlineUrls(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8'));

const EXPORT_SOURCES = fs
    .readdirSync(EXPORT_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, source: fs.readFileSync(path.join(EXPORT_DIR, name), 'utf8') }));

const CONFIG_SOURCE = fs.readFileSync(path.join(EXPORT_DIR, 'config.js'), 'utf8');
const SURFACE = fs.readFileSync(
    path.join(APP_ROOT, 'm', MOUNT.dir, 'surfaces', 'export.js'),
    'utf8'
);
const DECLARATION = JSON.parse(
    fs.readFileSync(path.join(EXPORT_DIR, 'declaration.json'), 'utf8')
);

test.describe('the conformance gate can actually pass', () => {
    // WHY THIS EXISTS. The first version of the veraPDF step grepped the report
    // for `compliant="true"`. veraPDF writes `isCompliant="true"` — capital C —
    // so the lowercase substring never occurs, and the gate could ONLY go red.
    // It failed run 31637683475 on a file the validator had just reported PASS
    // with 144 rules passed and 0 failed.
    //
    // A gate that cannot pass is as worthless as one that cannot fail, and the
    // per-push suite could not see either, because the defect was in CI rather
    // than in the PDF. This is the part of that class which IS expressible for
    // free: the workflow's success condition is checked against the attribute
    // veraPDF actually emits, captured here from a real report.
    const WORKFLOW = fs.readFileSync(
        path.join(APP_ROOT, '..', '.github', 'workflows', 'ci.yml'),
        'utf8'
    );

    test('the verdict is read from the attribute veraPDF really writes', () => {
        expect(WORKFLOW).toContain('isCompliant');
        // Scanned line by line and comments skipped on purpose: the workflow
        // DOCUMENTS the broken pattern so it cannot be reintroduced by someone
        // who never saw it fail, and a naive substring scan would fire on that
        // explanation instead of on a command.
        const offenders = WORKFLOW.split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
            .filter((line) => /compliant="true"/.test(line) && !/isCompliant/.test(line));
        expect(
            offenders,
            'a command matches `compliant="true"`, which no veraPDF report contains'
        ).toEqual([]);
    });

    test('the gate still asks for the flavour the artifact claims', () => {
        // Asking for a weaker flavour than the file claims would turn the gate
        // decorative while keeping it green.
        expect(WORKFLOW).toContain('--flavour 2b');
        expect(DECLARATION.print_layer.conformance).toBe('PDF/A-2b');
    });

    test('the validator version is asserted rather than logged', () => {
        expect(WORKFLOW).toContain('VERAPDF_EXPECTED_VERSION');
        expect(WORKFLOW).toMatch(/VERAPDF_EXPECTED_VERSION:\s*'\d+\.\d+\.\d+'/);
    });
});

test.describe('the print layer binaries are pinned', () => {
    // These two are the only non-icon binaries this app ships, they are read
    // from the APK at export time, and copies of both end up inside every
    // artifact a family keeps. A changed byte is a supply-chain event, so it
    // reds here rather than travelling silently. Provenance and licences are in
    // the mount's export/assets/PROVENANCE.txt.
    const PINNED = {
        'PTSans-Regular.ttf':
            '9cc831490532009bae2b3ce0d39c62adfc889060beb421593bfd9d2396d0f10a',
        'sRGB-v2-micro.icc':
            '0a8a33aea66a6f154a5642ebe168ef287e73265d9f7b51c42a45e6eedbacda7a',
        'PTSans-OFL.txt': '2758cf7a872827f39661cf8cc24188113c030447aefb5ca7145993650076ca8c',
    };

    for (const [name, digest] of Object.entries(PINNED)) {
        test(`${name} matches its pinned digest`, () => {
            const file = path.join(EXPORT_DIR, 'assets', name);
            const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            expect(actual, `${name} is not the vendored file this packet reviewed`).toBe(digest);
        });
    }

    test('the font licence travels with the font', () => {
        // The OFL requires the licence to accompany any redistribution of the
        // font file. Shipping the binary without it would be a licence breach,
        // not a documentation gap.
        const ofl = fs.readFileSync(path.join(EXPORT_DIR, 'assets', 'PTSans-OFL.txt'), 'utf8');
        expect(ofl).toContain('SIL OPEN FONT LICENSE');
        expect(ofl).toContain('ParaType');
        expect(SHIPPED).toContain(`${MOUNT.prefix}export/assets/PTSans-OFL.txt`);
    });

    test('the two binaries ship but are deliberately NOT precached', () => {
        // The DDL precedent (app/sw.js): only the native channel reads them,
        // that channel does not use the service worker, and the web channel
        // cannot export at all — so precaching would cost an installed web
        // client ~443 KB of cache it can never use.
        for (const name of ['PTSans-Regular.ttf', 'sRGB-v2-micro.icc']) {
            expect(SHIPPED).toContain(`${MOUNT.prefix}export/assets/${name}`);
            expect(
                PRECACHED.has(`${MOUNT.prefix}export/assets/${name}`),
                `${name} is precached; the web channel cannot use it`
            ).toBeFalsy();
        }
        // Anti-vacuity: the precache list was parsed and is not empty.
        expect(PRECACHED.size).toBeGreaterThan(10);
        expect(PRECACHED.has(`${MOUNT.prefix}export/pdf.js`)).toBeTruthy();
    });
});

test.describe('the contour actually ships', () => {
    test('the export modules and the declaration are in the ship list', () => {
        // Anti-vacuity: every scan below is about shipped bytes, and proves
        // nothing if these files reach neither channel.
        expect(SHIPPED).toContain(`${MOUNT.prefix}export/build.js`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}export/sink.js`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}export/zip.js`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}export/declaration.json`);
        expect(SHIPPED).toContain(`${MOUNT.prefix}surfaces/export.js`);
        expect(EXPORT_SOURCES.length).toBeGreaterThan(5);
    });
});

test.describe('the artifact is written locally and nowhere else', () => {
    test('no export module can reach the network', () => {
        // The artifact is unencrypted family data. "We never transmit it" is a
        // standing product promise, so it is compiled into a gate rather than
        // left as an intention: no request primitive may appear at all.
        const forbidden = ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'navigator.'];
        for (const { name, source } of EXPORT_SOURCES) {
            for (const token of forbidden) {
                expect(source.includes(token), `${name} reaches for ${token}`).toBeFalsy();
            }
        }
    });

    test('every fetch reads the app own origin through a declared knob', () => {
        // A literal URL would be the way an off-device read gets in unnoticed.
        // The only fetch the contour makes is of its own declaration, addressed
        // through EXPORT_CONFIG — so a new fetch has to declare its target in
        // the config surface before it can compile past this gate.
        const calls = [];
        for (const { name, source } of EXPORT_SOURCES) {
            for (const match of source.matchAll(/fetch\(\s*([^)]+?)\s*\)/g)) {
                calls.push({ name, argument: match[1] });
            }
        }
        expect(calls.length, 'no fetch call sites found — the scan would be vacuous').toBeGreaterThan(
            0
        );
        for (const call of calls) {
            expect(
                call.argument.startsWith('EXPORT_CONFIG.'),
                `${call.name} fetches ${call.argument}, which is not a declared knob`
            ).toBeTruthy();
        }
    });

    test('no export module touches WebView storage', () => {
        const pattern = /\b(localStorage|sessionStorage|indexedDB|openDatabase)\s*[.[]/;
        for (const { name, source } of EXPORT_SOURCES) {
            expect(pattern.test(source), `${name} touches WebView storage directly`).toBeFalsy();
        }
        expect(pattern.test(SURFACE), 'the export surface touches WebView storage').toBeFalsy();
    });

    test('nothing schedules an export', () => {
        // "Never automatically, never on a schedule, never as a side effect."
        // An unencrypted archive appearing on the filesystem without a human
        // asking for it in that moment is the failure this forbids.
        const forbidden = ['setInterval', 'setTimeout', 'requestIdleCallback', 'addEventListener'];
        for (const { name, source } of EXPORT_SOURCES) {
            for (const token of forbidden) {
                expect(source.includes(token), `${name} arms ${token}`).toBeFalsy();
            }
        }
        // The surface wires listeners, as a surface must — but only to elements
        // a person presses, never to a lifecycle or visibility event.
        for (const match of SURFACE.matchAll(/addEventListener\(\s*'([^']+)'/g)) {
            expect(match[1], 'the export surface listens to a non-click event').toBe('click');
        }
    });
});

test.describe('the sink is one method wide', () => {
    test('every sink method called is on the declared allowlist', () => {
        const block = /ALLOWED_SINK_METHODS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(CONFIG_SOURCE);
        expect(block, 'config.js declares no ALLOWED_SINK_METHODS').not.toBeNull();
        const allowed = new Set(Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]));

        // One method, and the count is asserted: an allowlist that grows quietly
        // is an allowlist that has stopped being a boundary.
        expect(allowed).toEqual(new Set(['createDocument']));

        const called = new Set();
        for (const { source } of EXPORT_SOURCES) {
            for (const match of source.matchAll(/callSink\(\s*'([^']+)'/g)) {
                called.add(match[1]);
            }
        }
        expect(called.size, 'no sink call sites found — the scan would be vacuous').toBeGreaterThan(
            0
        );
        for (const method of called) {
            expect(allowed.has(method), `"${method}" is called but not on the allowlist`).toBeTruthy();
        }
    });

    test('the sink reaches its plugin through the injected bridge, not an import', () => {
        for (const { name, source } of EXPORT_SOURCES) {
            const specifiers = Array.from(source.matchAll(/from\s*['"]([^'"]+)['"]/g)).map(
                (m) => m[1]
            );
            for (const specifier of specifiers) {
                expect(
                    specifier.startsWith('./') || specifier.startsWith('../'),
                    `${name} imports the bare specifier "${specifier}" — buildless delivery cannot resolve it`
                ).toBeTruthy();
            }
        }
    });
});

test.describe('the config surface carries its provenance', () => {
    test('every knob names the decision that set it', () => {
        const block = /EXPORT_CONFIG = Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(CONFIG_SOURCE);
        expect(block, 'config.js declares no EXPORT_CONFIG').not.toBeNull();
        const knobs = Array.from(block[1].matchAll(/^\s{4}([a-zA-Z]+):/gm)).map((m) => m[1]);
        expect(knobs.length).toBeGreaterThan(8);
        const provenance = (block[1].match(/changed_in:/g) ?? []).length;
        expect(
            provenance,
            'every knob group in the config surface needs changed_in provenance (ADR-013)'
        ).toBeGreaterThanOrEqual(9);
    });

    test('the app version in the config surface matches the one the shell reports', () => {
        // The shell's inline GA4 shim carries the same literal and A1-P5
        // deliberately left it inline. Two copies with a drift guard beats one
        // copy that required moving a parse-time global.
        const shell = /const APP_VERSION = '([^']+)'/.exec(SHELL);
        const config = /appVersion: '([^']+)'/.exec(CONFIG_SOURCE);
        expect(shell, 'index.html no longer declares APP_VERSION').not.toBeNull();
        expect(config, 'the export config declares no appVersion').not.toBeNull();
        expect(config[1]).toBe(shell[1]);
    });

    test('the declaration and the config surface agree on the format', () => {
        expect(DECLARATION.format).toBe(/formatId: '([^']+)'/.exec(CONFIG_SOURCE)[1]);
        expect(String(DECLARATION.format_version)).toBe(
            /formatVersion: (\d+)/.exec(CONFIG_SOURCE)[1]
        );
    });
});

test.describe('the interface says the two things it must not soften', () => {
    // These are asserted VERBATIM. A test on a paraphrase would let the sentence
    // drift into a hedge one word at a time, and the failure being prevented is
    // a parent believing they have a backup when they do not.
    const PLAIN = [
        'Фотографии, видео и звукозаписи в архив не входят.',
        'Резервной копии этих данных в облаке нет.',
    ];

    for (const sentence of PLAIN) {
        test(`the shell states: ${sentence}`, () => {
            expect(SHELL.includes(sentence), 'the sentence is missing from the shell').toBeTruthy();
        });
    }

    test('both sentences are shown before the action, not after it', () => {
        const modal = /<div id="exportModal"[\s\S]*?<div class="modal-buttons">/.exec(SHELL);
        expect(modal, 'the export modal is missing from the shell').not.toBeNull();
        for (const sentence of PLAIN) {
            expect(
                modal[0].includes(sentence),
                'the sentence is not inside the modal that precedes the button'
            ).toBeTruthy();
        }
    });

    test('the export control lives in the header, immediately left of the chat control', () => {
        // Owner act (LSC-DL-003 (u)): the control sits in the header, not the
        // footer. Asserted as ORDER rather than as a pixel position, because
        // "immediately to the left" is the intent and a coordinate would just
        // re-encode today's stylesheet.
        const header = /<header>[\s\S]*?<\/header>/.exec(SHELL);
        expect(header, 'the shell has no header').not.toBeNull();
        const exportAt = header[0].indexOf('id="exportBtn"');
        const chatAt = header[0].indexOf('class="telegram-button"');
        expect(exportAt, 'the export control is not in the header').toBeGreaterThan(-1);
        expect(chatAt, 'the chat control is not in the header').toBeGreaterThan(-1);
        expect(exportAt, 'the export control must precede the chat control').toBeLessThan(chatAt);

        const footer = /<footer class="control-footer">[\s\S]*?<\/footer>/.exec(SHELL);
        expect(footer, 'the shell has no control footer').not.toBeNull();
        expect(
            footer[0].includes('id="exportBtn"'),
            'the export control is still in the footer'
        ).toBeFalsy();
    });

    test('the chat control does not reproduce a third party brand mark', () => {
        // A plain paper plane is the convention; the Telegram logo is their
        // trademark. Asserted as the absence of the enclosing-circle path the
        // brand mark needs, plus the absence of a filled glyph.
        const chat = /<a[^>]*class="telegram-button"[\s\S]*?<\/a>/.exec(SHELL);
        expect(chat, 'the chat control is missing').not.toBeNull();
        expect(chat[0]).toContain('stroke="currentColor"');
        expect(
            /fill="(?!none)[^"]+"/.test(chat[0]),
            'the chat glyph is filled — a brand mark rather than an outline paper plane'
        ).toBeFalsy();
    });

    test('every icon-only control carries a non-empty accessible name', () => {
        // The class of defect that rots silently: a glyph with no name is
        // unreachable to a screen reader and unguessable to everyone else. The
        // export action is the only material form of a permanent promise, so it
        // does not get to be guessable-only.
        const controls = Array.from(SHELL.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g));
        expect(controls.length, 'no controls found — the scan would be vacuous').toBeGreaterThan(4);

        const iconOnly = controls.filter(([, , attrs, inner]) => {
            if (/\bhidden\b/.test(attrs)) return false;
            // Visible text with at least one word character; a bare glyph
            // (×, ↩) does not count as a name.
            const text = inner.replace(/<[^>]*>/g, '').replace(/&\w+;/g, '').trim();
            return !/\p{L}/u.test(text);
        });
        expect(iconOnly.length, 'no icon-only controls found — the scan would be vacuous')
            .toBeGreaterThan(0);

        for (const [, tag, attrs] of iconOnly) {
            const label = /aria-label\s*=\s*"([^"]*)"/.exec(attrs);
            expect(
                label && label[1].trim().length > 0,
                `an icon-only <${tag}> carries no aria-label: ${attrs.trim().slice(0, 80)}`
            ).toBeTruthy();
        }
    });

    test('the export control name is one string in three places', () => {
        // aria-label, title and the visible desktop label must not drift apart:
        // the mobile control is the same button with the label hidden, so a
        // reworded label that left the two attributes behind would give the two
        // viewports different names for the same action.
        const control = /<button[^>]*id="exportBtn"[\s\S]*?<\/button>/.exec(SHELL);
        expect(control, 'the export control is missing').not.toBeNull();
        const aria = /aria-label\s*=\s*"([^"]*)"/.exec(control[0]);
        const title = /title\s*=\s*"([^"]*)"/.exec(control[0]);
        const visible = /<span class="header-action-label">([^<]*)<\/span>/.exec(control[0]);
        expect(aria).not.toBeNull();
        expect(title).not.toBeNull();
        expect(visible).not.toBeNull();
        expect(title[1]).toBe(aria[1]);
        expect(visible[1].trim()).toBe(aria[1]);
    });

    test('the web channel says where the archive comes from instead of hiding', () => {
        // The action is unavailable off-device because there is no journal to
        // project. A missing button would teach a parent nothing about where
        // their data actually lives, so the surface states it.
        expect(SHELL).toContain('id="exportUnavailable"');
        expect(SURFACE).toContain('isExportSinkAvailable');
    });
});

test.describe('the artifact format is pinned where it is published', () => {
    test('the declaration explains every field it declares', () => {
        for (const dataset of DECLARATION.datasets) {
            for (const column of dataset.columns) {
                expect(
                    column.description_ru.trim().length,
                    `${dataset.name}.${column.name} has no explanation`
                ).toBeGreaterThan(10);
            }
        }
    });

    test('the archive is stored uncompressed, by declaration and by knob', () => {
        expect(DECLARATION.determinism.compression).toBe('stored');
        expect(/zipCompressionMethod: (\d+)/.exec(CONFIG_SOURCE)[1]).toBe('0');
    });

    test('the declared scope is the requesting participant, not every private area', () => {
        expect(DECLARATION.scope.kind).toBe('requesting_participant');
        // Every scope-filtered query binds the requester. A dataset carrying
        // visibility that forgot to filter would widen a published promise.
        for (const dataset of DECLARATION.datasets) {
            if (!/visibility_class|private_to_participant_id|owner_participant_id/.test(dataset.query)) {
                continue;
            }
            expect(
                dataset.params,
                `dataset "${dataset.name}" reads a visibility column without binding the requester`
            ).toContain('self_participant_id');
        }
    });
});
