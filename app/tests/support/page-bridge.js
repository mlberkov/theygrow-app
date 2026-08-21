'use strict';

// A store seam that RESOLVES, installed in the page at the bridge boundary
// (DIA-P3R).
//
// WHY THIS EXISTS, AND WHY IT DID NOT BEFORE. `store-unit.spec.js` and
// `support/fake-bridge.js` both state the rule this file has to answer for:
// pretending to cover the bridge with a fake proves the fake rather than the
// plugin, and `DIA-DL-005` alternative 9 rejected exactly that shape for the
// DISK-FULL refusal. That rejection stands and is untouched — reaching a full
// disk needs a store that opens, and no browser can produce SQLITE_FULL.
//
// What run 31971968427 showed is that the rule had been applied one step too
// far. The diary's SUCCESS path had no executor anywhere off-device:
// `diary-surface.spec.js` simulates the native channel with `isNativePlatform`
// and nothing behind it, so `isNativeStore()` is false, the store never opens,
// and every leg there ends in a refusal BEFORE the try block. A bare
// `ReferenceError` on the line that calls the store therefore lived comfortably
// inside 1104 green tests, and the first thing to notice was an emulator.
//
// So this seam exists to execute the one claim nothing else could: that the
// shipped surface asks the shipped store for the right thing and renders what
// comes back. It proves the CONTRACT between `surfaces/diary.js` and
// `store/boot.js`. It proves NOTHING about SQLite: it executes no SQL, applies
// no DDL, has no schema, no constraints, no triggers, no transactions, no index
// and no encryption. What the statements MEAN is `pytest app/tests/schema`; that
// an entry LANDS is `DiaryEntryTest` on a device.
//
// DIA-P4 ADDS SEARCH ON EXACTLY THOSE TERMS. There is no FTS5 here, so the seam
// does not decide which rows a query finds: a leg STAGES the answer and the seam
// records the expression it was asked with. Which rows an expression really
// matches is `test_diary_search.py` against the real frozen DDL.
//
// IT FAILS CLOSED, AND IT DOES NOT MATCH ON SUBSTRINGS. This milestone has been
// bitten four times by substring matching over code and SQL — a comment about
// `sw-register.js`, `onNewIntentDISABLED`, `.includes('autoVerify')`, and
// `"UPDATE"` found inside `updated_at_utc`. A responder that answered an
// unrecognised statement with an empty result would let a leg pass while the
// surface asked for something else entirely, which is the identical failure one
// layer out. So every statement is matched by EXACT EQUALITY, the diary and
// journal statements are read out of the shipped modules rather than retyped
// (the same reading `app/tests/schema/harness.py` does with
// `js_string_constant`), the pragmas are built from the shipped knobs the page
// itself imports, and anything unmatched THROWS with the statement in the
// message.

const fs = require('fs');
const path = require('path');

/**
 * Reads a `const NAME = '...' + '...';` string out of shipped JavaScript.
 *
 * A port of `js_string_constant` in `app/tests/schema/harness.py`, and it fails
 * closed in the same three directions for the same reason: an absent constant, a
 * right-hand side that is not a concatenation of single-quoted literals, and a
 * right-hand side carrying anything this reader cannot see all raise. A reader
 * that quietly returned '' would make every statement below match nothing, and
 * a responder that matched nothing would throw on the first call — loudly, but
 * about the wrong thing.
 */
function jsStringConstant(source, name, where) {
    const declaration = new RegExp(`^const ${name} =([\\s\\S]*?);$`, 'm').exec(source);
    if (!declaration) throw new Error(`${where} declares no \`const ${name}\``);
    const body = declaration[1];
    const parts = body.match(/'[^']*'/g);
    if (!parts) {
        throw new Error(`\`const ${name}\` in ${where} is not a concatenation of quoted literals`);
    }
    const between = body.replace(/'[^']*'/g, '');
    if (/[A-Za-z_$]/.test(between)) {
        throw new Error(
            `\`const ${name}\` in ${where} interpolates something this reader cannot see;`
                + ' the seam would be answering a different statement from the app'
        );
    }
    return parts.map((part) => part.slice(1, -1)).join('');
}

// The statements the app issues that ARE declared as named constants. Read, not
// retyped: a copy is what drifts, and a drifted copy here would make the seam
// answer a question the surface never asked.
const READ_FROM_SOURCE = Object.freeze({
    'store/records.js': [
        'AREA_LOOKUP_SQL',
        'AREA_INSERT_SQL',
        'AREA_CHILD_INSERT_SQL',
        'RECORD_INSERT_SQL',
        'RECORD_UPDATE_SQL',
        'RECORDS_SQL',
        'RECORD_SEARCH_SQL',
        'RECORD_COUNT_SQL',
        'FTS_REBUILD_SQL',
    ],
    'store/journal.js': ['CHILDREN_SQL', 'MARKS_SQL'],
});

// The statements `store/store.js` and `store/journal.js` INLINE at their call
// sites, so there is no constant to read. They are declared here, and the copy
// is safe in the only way that matters: the responder matches by exact equality
// and throws on a miss, so a statement that drifts reds with its own text in the
// failure rather than being quietly answered.
const INLINED_BY_THE_APP = Object.freeze({
    tableExists: "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    lifecycle: 'SELECT clean_shutdown FROM store_lifecycle WHERE id = 1',
    selfParticipant: 'SELECT value FROM schema_meta WHERE key = ?',
    engineFloor: 'SELECT sqlite_version() AS v',
    markOpen:
        'INSERT INTO store_lifecycle (id, opened_at_utc, clean_shutdown) VALUES (1, ?, 0)'
        + ' ON CONFLICT (id) DO UPDATE SET opened_at_utc = excluded.opened_at_utc,'
        + ' clean_shutdown = 0',
    projectionContext: 'UPDATE projection_context SET as_of_date = ? WHERE id = 1',
    // FIU-P1 — the marker `closeStore()` writes on its way out. It is the whole
    // point of the close: the NEXT open reads it and decides whether a full
    // `PRAGMA integrity_check` over the family's history is owed. Declared here
    // because the seam matches by exact equality and throws on a miss, so
    // without it the first park in any behavior leg would throw the statement's
    // own text rather than being quietly answered — which is the fail-closed
    // direction, and also a red in a suite that has nothing to do with parking.
    markClean:
        'UPDATE store_lifecycle SET clean_shutdown = 1, opened_at_utc = ? WHERE id = 1',
});

/** Every statement the seam knows, keyed by name, read where it can be read. */
function shippedStatements(appRoot, mountDir) {
    const statements = { ...INLINED_BY_THE_APP };
    for (const [rel, names] of Object.entries(READ_FROM_SOURCE)) {
        const file = path.join(appRoot, 'm', mountDir, rel);
        const source = fs.readFileSync(file, 'utf8');
        for (const name of names) {
            statements[name] = jsStringConstant(source, name, rel);
        }
    }
    return statements;
}

/**
 * Installs the seam before any page script runs.
 *
 * `child` is the family the store hands back — one child, in the shape
 * `CHILDREN_SQL` projects. `selfParticipantId` is the id the store minted and
 * `core/state.js` keeps; the diary's whole author attribution comes from it,
 * which is what makes "the surface asked with the right author" assertable.
 */
async function installPageBridge(page, { mountBase, statements, child, selfParticipantId }) {
    await page.addInitScript(
        ({ mountBase: base, statements: sql, child: family, selfParticipantId: selfId }) => {
            const calls = [];
            // The rows the seam is holding, in the shape `RECORDS_SQL` declares.
            // NOT a table: nothing here parses, plans or executes anything. The
            // INSERT's bound values are remembered and handed back under the
            // column names the shipped read query itself asks for.
            const records = [];

            // What the next search is to be answered with, and what it becomes
            // once the index has been rebuilt. Set by the leg, never by the
            // seam: see the RECORD_SEARCH_SQL branch below for why.
            window.__pageBridgeSearch = { answer: [], answerAfterRebuild: null, failWith: null };

            // The order RECORDS_SQL declares, applied once for both reads so
            // the list and the search cannot disagree about it.
            const newestFirst = (rows) =>
                rows
                    .slice()
                    .sort((a, b) =>
                        a.event_date_local === b.event_date_local
                            ? b.entry_at_utc - a.entry_at_utc
                            : a.event_date_local < b.event_date_local ? 1 : -1
                    )
                    .map((row) => ({ ...row }));

            const unknown = (method, statement) => {
                throw new Error(
                    `[page-bridge] ${method} asked for a statement this seam does not know,`
                        + ' so it refuses rather than answering an empty result: '
                        + JSON.stringify(statement)
                );
            };

            // The knobs, out of the shipped module rather than out of this file.
            // The page has already imported it by the time anything calls in, so
            // this resolves immediately and never races the boot.
            let knobs = null;
            const config = async () => {
                if (!knobs) {
                    const at = new URL('store/config.js', new URL(base, window.location.origin));
                    const mod = await import(at.href);
                    knobs = mod.STORE_CONFIG;
                }
                return knobs;
            };

            const answerQuery = async (statement) => {
                const cfg = await config();
                // Built from the shipped knobs, so a changed journal mode or
                // busy timeout moves both sides at once.
                if (statement === `PRAGMA journal_mode = ${cfg.journalMode}`) {
                    return [{ journal_mode: String(cfg.journalMode).toLowerCase() }];
                }
                if (statement === 'PRAGMA foreign_keys = ON') return [];
                if (statement === `PRAGMA busy_timeout = ${cfg.busyTimeoutMs}`) return [];

                if (statement === sql.engineFloor) return [{ v: cfg.sqliteVersionFloor }];
                // The schema is already there, so `applySchema` — and the fetch
                // of the real DDL it would do — is never reached. This seam has
                // no business applying a schema it cannot execute.
                if (statement === sql.tableExists) return [{ n: 1 }];
                if (statement === sql.lifecycle) return [{ clean_shutdown: 1 }];
                if (statement === sql.selfParticipant) return [{ value: selfId }];

                if (statement === sql.CHILDREN_SQL) {
                    return [
                        {
                            id: family.id,
                            created_at_utc: family.createdAtUtc,
                            name: family.name,
                            birthdate: family.birthdate,
                        },
                    ];
                }
                if (statement === sql.MARKS_SQL) return [];

                if (statement === sql.AREA_LOOKUP_SQL) {
                    // No diary area until the first entry creates one, which is
                    // the first-write case the surface has to handle.
                    return records.length > 0 ? [{ id: 'area-page-bridge' }] : [];
                }
                if (statement === sql.RECORDS_SQL) return newestFirst(records);

                // THIS SEAM MATCHES NOTHING, AND THAT IS THE POINT (DIA-P4).
                // There is no FTS5 here, no tokenizer, no index and no MATCH —
                // so it does not decide which rows a query finds. The leg
                // STAGES an answer (`window.__pageBridgeSearch.answer`, a list
                // of record ids), and the seam hands back exactly those rows
                // while RECORDING the expression it was given. That keeps the
                // two claims apart: what an expression matches is
                // `pytest app/tests/schema/test_diary_search.py` against the
                // real frozen DDL, and what the SURFACE asked for is readable
                // here. A seam that faked matching would be a fake proving a
                // fake — the rule this file's header already states about
                // transactions.
                if (statement === sql.RECORD_SEARCH_SQL) {
                    // A search the STORE refuses. Staged rather than simulated:
                    // the message is thrown across the same boundary the plugin
                    // rejects on, so store/errors.js classifies it exactly as it
                    // would classify the engine's own words.
                    const staged = window.__pageBridgeSearch;
                    if (staged.failWith) throw new Error(staged.failWith);
                    return newestFirst(
                        records.filter((row) => staged.answer.includes(row.id))
                    );
                }
                if (statement === sql.RECORD_COUNT_SQL) return [{ n: records.length }];
                return unknown('query', statement);
            };

            const applyMutation = (statement, values) => {
                if (statement === sql.AREA_INSERT_SQL) return;
                if (statement === sql.AREA_CHILD_INSERT_SQL) return;
                if (statement === sql.markOpen) return;
                if (statement === sql.markClean) return;
                if (statement === sql.projectionContext) return;
                if (statement === sql.RECORD_INSERT_SQL) {
                    // Positional, as the shipped statement declares it: id,
                    // area, author, kind, body, event_date_local, entry_at_utc,
                    // entry_utc_offset_min, updated_at_utc.
                    records.push({
                        id: values[0],
                        body: values[4],
                        event_date_local: values[5],
                        entry_at_utc: values[6],
                        entry_utc_offset_min: values[7],
                        updated_at_utc: values[8],
                        sensitivity: null,
                    });
                    return;
                }
                if (statement === sql.FTS_REBUILD_SQL) {
                    // The only OBSERVABLE of a rebuild, modelled and nothing
                    // more: what the index answers afterwards. The seam holds
                    // no index to rebuild, so it changes the staged answer and
                    // says so out loud rather than pretending to re-index.
                    const staged = window.__pageBridgeSearch;
                    if (staged.answerAfterRebuild !== null) {
                        staged.answer = staged.answerAfterRebuild;
                    }
                    return;
                }
                if (statement === sql.RECORD_UPDATE_SQL) {
                    // body, event_date_local, updated_at_utc, id.
                    const row = records.find((entry) => entry.id === values[3]);
                    if (row) {
                        row.body = values[0];
                        row.event_date_local = values[1];
                        row.updated_at_utc = values[2];
                    }
                    return;
                }
                unknown('mutation', statement);
            };

            window.Capacitor = {
                isNativePlatform: () => true,
                nativePromise: async (plugin, method, options) => {
                    calls.push({ plugin, method, options });

                    if (plugin === 'TheyGrowTransfer') {
                        // Nothing was ever staged for this page. Answered rather
                        // than left to throw, so the boot-time import offer takes
                        // its "nothing to offer" branch instead of logging.
                        if (method === 'pendingTransfer') {
                            return { present: false, refusal: 'none' };
                        }
                        throw new Error(`[page-bridge] no answer for TheyGrowTransfer.${method}`);
                    }
                    if (plugin !== 'CapacitorSQLite') {
                        throw new Error(`[page-bridge] no answer for plugin ${plugin}`);
                    }

                    if (method === 'isSecretStored') return { result: true };
                    if (method === 'createConnection' || method === 'open') return {};
                    // FIU-P1 — the close path. Answered rather than simulated,
                    // on the same terms as the transaction envelope below: this
                    // seam holds rows in an array and has no connection to close.
                    // What it must not do is REFUSE them, because the app now
                    // closes its store whenever the page goes hidden, and a
                    // fail-closed throw there would surface as a store that
                    // broke on a tab switch.
                    if (method === 'close' || method === 'closeConnection') return {};
                    // The envelope store/bridge.js issues around a set since
                    // DIA-DL-007. Answered rather than simulated: this seam holds
                    // rows in an array and has no transaction to begin, so
                    // pretending otherwise would be a fake proving a fake. What
                    // it must do is not REFUSE them — the app now asks for these
                    // on every create, and a fail-closed throw here would make
                    // the success path look broken when it is not.
                    if (
                        method === 'beginTransaction'
                        || method === 'commitTransaction'
                        || method === 'rollbackTransaction'
                    ) {
                        return { changes: { changes: 0 } };
                    }
                    if (method === 'query') {
                        return { values: await answerQuery(options.statement) };
                    }
                    if (method === 'run') {
                        applyMutation(options.statement, options.values ?? []);
                        return { changes: { changes: 1 } };
                    }
                    if (method === 'executeSet') {
                        for (const item of options.set) {
                            applyMutation(item.statement, item.values ?? []);
                        }
                        return { changes: { changes: options.set.length } };
                    }
                    throw new Error(`[page-bridge] no answer for CapacitorSQLite.${method}`);
                },
            };

            // The transcript, so a leg can assert what the surface ASKED FOR and
            // not only what it rendered. `...who` broke the asking, not the
            // rendering, and a leg that only read the list would have missed it.
            window.__pageBridgeCalls = calls;
        },
        { mountBase, statements, child, selfParticipantId }
    );
}

module.exports = { installPageBridge, jsStringConstant, shippedStatements };
