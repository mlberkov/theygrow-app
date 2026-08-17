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
// The other side of the sink seam (XPT-P1). Read rather than imagined: the bound
// the app declares has to be the bound the plugin enforces.
const PLUGIN_SOURCE_PATH = path.resolve(
    APP_ROOT,
    '..',
    'native/android/app/src/main/java/app/theygrow/ExportSinkPlugin.java'
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

test.describe('the sink is a closed set of write-only methods', () => {
    test('every sink method called is on the declared allowlist', () => {
        const block = /ALLOWED_SINK_METHODS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(CONFIG_SOURCE);
        expect(block, 'config.js declares no ALLOWED_SINK_METHODS').not.toBeNull();
        const allowed = new Set(Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]));

        // THE SET IS ASSERTED, NOT ITS SIZE, and that is the same boundary this
        // check has always drawn: an allowlist that grows quietly has stopped
        // being one. It grew from one method to three at XPT-P1, when the
        // archive stopped riding the call that opens the file picker — two of
        // these stage bytes inside the app's own process and the third is the
        // one that writes, to the single document the parent picked. None of
        // them can read, list or delete, which is what the boundary is about.
        expect(allowed).toEqual(new Set(['beginTransfer', 'appendChunk', 'createDocument']));

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

    test('the launch-options ceiling is the same number on both sides of the bridge', () => {
        // The knob lives in the app's config surface and the bound has to be
        // held by the plugin, and the two languages share no config surface. So
        // the number is written twice by hand and asserted equal here — the same
        // arrangement STORE_CONFIG.sqliteVersionFloor has with
        // app/tests/schema/harness.py, and for the same reason: a bound that
        // drifts on one side stops being a bound at all.
        const declared = /sinkLaunchOptionsMaxBytes: (\d+)/.exec(CONFIG_SOURCE);
        expect(declared, 'the export config declares no sinkLaunchOptionsMaxBytes').not.toBeNull();

        const plugin = fs.readFileSync(PLUGIN_SOURCE_PATH, 'utf8');
        const enforced = /LAUNCH_OPTIONS_MAX_BYTES = (\d+)/.exec(plugin);
        expect(enforced, 'the sink plugin declares no LAUNCH_OPTIONS_MAX_BYTES').not.toBeNull();

        expect(enforced[1]).toBe(declared[1]);

        // The other half of the same guard: the plugin refuses any option key it
        // does not declare, so that list IS the shape of the launching call.
        const keys = /LAUNCH_OPTION_KEYS =\s*Arrays\.asList\(([^)]*)\)/.exec(plugin);
        expect(keys, 'the sink plugin declares no LAUNCH_OPTION_KEYS').not.toBeNull();
        expect(new Set(Array.from(keys[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]))).toEqual(
            new Set(['transferId', 'filename', 'mimeType', 'totalBytes'])
        );
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

    test('the export control lives in the header, and ships unrevealed', () => {
        // Owner act (LSC-DL-003 (u)): the control sits in the header, not the
        // footer. DIA-P2 adds the second half — it ships `hidden`, and only the
        // channel that can produce an archive reveals it. STATIC (AGENTS.md
        // §11): this is the composition of the markup. That the WEB channel
        // really does not offer it, and that the NATIVE branch really does, is
        // app/tests/channel-composition.spec.js, which loads the page.
        const header = /<header>[\s\S]*?<\/header>/.exec(SHELL);
        expect(header, 'the shell has no header').not.toBeNull();
        const control = /<button[^>]*id="exportBtn"[^>]*>/.exec(header[0]);
        expect(control, 'the export control is not in the header').not.toBeNull();
        expect(
            /\bhidden\b/.test(control[0]),
            'the export control ships revealed — the web channel would offer an archive it cannot produce'
        ).toBeTruthy();

        const footer = /<footer class="control-footer">[\s\S]*?<\/footer>/.exec(SHELL);
        expect(footer, 'the shell has no control footer').not.toBeNull();
        expect(
            footer[0].includes('id="exportBtn"'),
            'the export control is still in the footer'
        ).toBeFalsy();
    });

    test('the chat control is gone from the shell entirely', () => {
        // DIA-P2: the capture bridge is retired with this milestone, so the
        // community-chat link goes with it — markup, stylesheet and the one GA4
        // call site that hung on it. Asserted as absence in both files, because
        // a leftover rule for a control nobody ships is the kind of residue that
        // gets copied forward at the next mount bump.
        const css = fs.readFileSync(path.join(APP_ROOT, 'm', MOUNT.dir, 'app.css'), 'utf8');
        expect(SHELL).not.toContain('telegram-button');
        expect(SHELL).not.toContain('t.me/');
        expect(css, 'the stylesheet still dresses a control the shell no longer has')
            .not.toContain('telegram');
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

    test('the download control name is one string in three places', () => {
        // The same rule the export control carries, for the same reason: the
        // mobile control is this control with the label hidden, so a reworded
        // label that left the two attributes behind would give the two viewports
        // different names for the same action.
        const control = /<a[^>]*id="apkBtn"[\s\S]*?<\/a>/.exec(SHELL);
        expect(control, 'the download control is missing').not.toBeNull();
        const aria = /aria-label\s*=\s*"([^"]*)"/.exec(control[0]);
        const title = /title\s*=\s*"([^"]*)"/.exec(control[0]);
        const visible = /<span class="header-action-label">([^<]*)<\/span>/.exec(control[0]);
        expect(aria).not.toBeNull();
        expect(title).not.toBeNull();
        expect(visible).not.toBeNull();
        expect(title[1]).toBe(aria[1]);
        expect(visible[1].trim()).toBe(aria[1]);
    });

    test('the download control ships unrevealed and carries no address of its own', () => {
        // TWO PROPERTIES, ONE DEFECT BETWEEN THEM. The control must not be
        // offered before an asset exists — the repository has no tag and no
        // release, so a visible link would open an empty page dressed as a
        // download — and its address must be declared once, in the knob surface,
        // rather than written into markup where the next reader would find two
        // of them. STATIC: whether it is actually withheld at runtime, and
        // whether it appears once the shell declares a published release, is
        // app/tests/channel-composition.spec.js.
        const control = /<a[^>]*id="apkBtn"[^>]*>/.exec(SHELL);
        expect(control, 'the download control is missing').not.toBeNull();
        expect(
            /\bhidden\b/.test(control[0]),
            'the download control ships revealed — a visitor would meet a page with nothing on it'
        ).toBeTruthy();
        expect(
            /\bhref\s*=/.test(control[0]),
            'the download control carries a hard-coded href — the address is declared in channel/config.js'
        ).toBeFalsy();
        expect(SHELL).toContain('name="theygrow-apk-release"');

        // The address exists exactly once in the shipped tree, in the knob.
        //
        // DIA-P3: "once" means one DECLARATION SITE, not one file on disk. The
        // exclusion below is `m/v{N}/channel/config.js` for ANY generation, not
        // only the running one, because a copy-forward bump leaves the frozen
        // generation shipped and it carries the same knob — the same
        // declaration, not a second one. This first went red at the /m/v5/ ->
        // /m/v6/ bump, which is the first bump since DIA-P2 introduced the knob,
        // so the guard had never met a second generation of it before. The
        // defect it is really about — the address written into markup or into a
        // module beside the knob — is still caught: every other shipped .js and
        // .html is scanned, including the frozen generations' surfaces.
        const declared = fs.readFileSync(
            path.join(APP_ROOT, 'm', MOUNT.dir, 'channel', 'config.js'),
            'utf8'
        );
        expect(declared, 'the knob surface does not declare the release address')
            .toContain('apkReleaseUrl:');
        const elsewhere = SHIPPED.filter((rel) => rel.endsWith('.js') || rel.endsWith('.html'))
            .filter((rel) => !/m\/v\d+\/channel\/config\.js$/.test(rel))
            .filter((rel) =>
                fs.readFileSync(path.join(APP_ROOT, rel), 'utf8').includes('/releases/')
            );
        expect(
            elsewhere,
            'the release address appears outside the knob surface — it is declared once or not at all'
        ).toEqual([]);
    });

    test('the web channel still says the copy it holds is the only one', () => {
        // SUPERSEDES 'the web channel says where the archive comes from instead
        // of hiding' (L1-P3). That test asserted the shape of the OLD answer:
        // the modal shipped to both channels, hid its run button on the web and
        // explained itself in a paragraph. DIA-P2 stops offering the control on
        // a channel that cannot perform it, which makes that paragraph
        // unreachable — markup no user can open, guarded by a test, is the
        // EMV-DL-001 defect exactly.
        //
        // THE FACT DID NOT GO WITH IT, and that is what this test now holds. It
        // is true, it is time-bounded (ADR-048 §5 — until a transfer is
        // confirmed, the browser holds the only copy), and it now sits where a
        // parent meets it without opening anything.
        expect(SHELL, 'the unreachable paragraph is back').not.toContain('id="exportUnavailable"');
        const note = /<p id="webChannelNote"[\s\S]*?<\/p>/.exec(SHELL);
        expect(note, 'the web channel says nothing about where the only copy is').not.toBeNull();
        expect(note[0]).toContain('только в этом браузере');
        expect(note[0]).toContain('резервной копии');
        // Ships unrevealed, like both channel actions: it is the web channel
        // that reveals it, and it must not appear inside the app.
        expect(/\bhidden\b/.test(note[0])).toBeTruthy();
        // That it is actually on screen in a browser and absent in the app is
        // app/tests/channel-composition.spec.js — this half is markup.
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
