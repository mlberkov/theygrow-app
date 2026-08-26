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
function quotedConcatenation(body, label) {
    const parts = body.match(/'[^']*'/g);
    if (!parts) {
        throw new Error(`${label} is not a concatenation of quoted literals`);
    }
    const between = body.replace(/'[^']*'/g, '');
    if (/[A-Za-z_$]/.test(between)) {
        throw new Error(
            `${label} interpolates something this reader cannot see;`
                + ' the seam would be answering a different statement from the app'
        );
    }
    return parts.map((part) => part.slice(1, -1)).join('');
}

function jsStringConstant(source, name, where) {
    const declaration = new RegExp(`^const ${name} =([\\s\\S]*?);$`, 'm').exec(source);
    if (!declaration) throw new Error(`${where} declares no \`const ${name}\``);
    return quotedConcatenation(declaration[1], `\`const ${name}\` in ${where}`);
}

/**
 * The same reading, one level in: `const NAME = Object.freeze({ key: '...' })`.
 *
 * UIP-P4 needs `DETAIL_SQL.child_attribute`, which is a named constant living
 * inside a frozen map rather than at the top level. Reading it is the same
 * choice `READ_FROM_SOURCE` makes everywhere else — a retyped copy is what
 * drifts — and it fails closed in the same three directions: no such object, no
 * such key, and a value this reader cannot see whole. The keys are found by
 * their indentation so the value may span lines, exactly as the shipped file
 * writes it.
 */
function jsObjectStringConstant(source, name, key, where) {
    const declaration = new RegExp(
        `^const ${name} = Object\\.freeze\\(\\{\\n([\\s\\S]*?)\\n\\}\\);$`,
        'm'
    ).exec(source);
    if (!declaration) {
        throw new Error(`${where} declares no \`const ${name} = Object.freeze({...})\``);
    }
    const lines = declaration[1].split('\n');
    const starts = [];
    lines.forEach((line, at) => {
        const found = /^ {4}([A-Za-z_$][\w$]*):/.exec(line);
        if (found) starts.push({ key: found[1], at });
    });
    const index = starts.findIndex((entry) => entry.key === key);
    if (index === -1) {
        throw new Error(`\`const ${name}\` in ${where} has no key "${key}"`);
    }
    const from = starts[index].at;
    const to = index + 1 < starts.length ? starts[index + 1].at : lines.length;
    const body = lines
        .slice(from, to)
        .join('\n')
        .replace(new RegExp(`^ {4}${key}:`), '')
        .replace(/,\s*$/, '');
    return quotedConcatenation(body, `\`${name}.${key}\` in ${where}`);
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
    // UIP-P4 adds ENTRY_SQL: creating a profile is now driven through the UI in
    // a browser leg, so the seam has to answer the journal spine as well as the
    // diary.
    'store/journal.js': ['CHILDREN_SQL', 'MARKS_SQL', 'ENTRY_SQL'],
});

// The same reading for statements that are named constants inside a frozen map.
// `DETAIL_SQL.child_attribute` is the row that carries a child's name and
// birthdate, and the seam needs it to answer `CHILDREN_SQL` with the child the
// app has just made (UIP-P4).
const READ_FROM_OBJECTS = Object.freeze({
    'store/journal.js': [['DETAIL_SQL', 'child_attribute']],
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
    // UIP-P4 — the `child` row `repo-journal.js::childRow()` returns from inside
    // an object literal, so there is no constant to read. Same terms as the rest
    // of this map: exact equality, and a drift reds with its own text.
    childInsert:
        'INSERT INTO child (id, created_at_utc) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
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
    for (const [rel, entries] of Object.entries(READ_FROM_OBJECTS)) {
        const file = path.join(appRoot, 'm', mountDir, rel);
        const source = fs.readFileSync(file, 'utf8');
        for (const [name, key] of entries) {
            statements[`${name}_${key}`] = jsObjectStringConstant(source, name, key, rel);
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
            // WHICH CHILD EACH ROW BELONGS TO, held beside the rows rather than
            // in them, so what the seam hands back keeps exactly the column set
            // `RECORDS_SQL` declares (UIP-P4). `record` has no child column —
            // the real query reaches the child through `area_child`, and so does
            // this: `areaOfChild` is filled from the shipped
            // `AREA_CHILD_INSERT_SQL`, never invented here.
            const areaOfChild = new Map();
            const childOfArea = new Map();
            const childOfRecord = new Map();

            // The family the store holds. An ARRAY since UIP-P4, because a
            // profile can now be created through the UI: the seam has to answer
            // `CHILDREN_SQL` with the child the app just wrote rather than with
            // the one the leg seeded. A fresh install is still `child: null`.
            const children = family
                ? [
                    {
                        id: family.id,
                        created_at_utc: family.createdAtUtc,
                        name: family.name,
                        birthdate: family.birthdate,
                    },
                ]
                : [];
            // journal_entry id -> subject_child_id, so a `child_attribute` row
            // can be attached to the child its entry is about. Read out of the
            // shipped ENTRY_SQL values; the seam guesses nothing.
            const subjectOfEntry = new Map();

            // What the next search is to be answered with, and what it becomes
            // once the index has been rebuilt. Set by the leg, never by the
            // seam: see the RECORD_SEARCH_SQL branch below for why.
            window.__pageBridgeSearch = { answer: [], answerAfterRebuild: null, failWith: null };

            // What the next LIST read is to be answered with — or refused with
            // (FIU-P2). Same staging idiom, same reason as the search above: the
            // message is thrown across the boundary the plugin rejects on, so
            // store/errors.js classifies it exactly as it would classify the
            // engine's own words. This is what arms the two claims DIA-DL-010
            // debts 10 and 11 are about — a list that will not load, and a save
            // the store ACCEPTED whose confirmation refresh then fails.
            window.__pageBridgeList = { failWith: null };

            // And the same for the WRITE, so the repair of debt 11 can be armed
            // in the direction it must NOT change: a save the store really
            // refused has to go on saying «Запись НЕ сохранена». Fixing a false
            // failure report by making the surface quiet would be the same
            // defect facing the other way.
            window.__pageBridgeWrite = { failWith: null };

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

            /** The rows in one child's diary, reached the way the query reaches them. */
            const ownedBy = (childId) =>
                records.filter((row) => childOfRecord.get(row.id) === childId);

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

            const answerQuery = async (statement, values) => {
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
                    // A FRESH INSTALL IS `child: null` (FIU-P2). The store
                    // opened and holds nobody — the state every first launch is
                    // in, and the one state in which the journal backend and
                    // "no profile" are true at once. Nothing else in this seam
                    // needs to know: the app's own zero-child branches take over
                    // from here.
                    //
                    // The ORDER is the one CHILDREN_SQL declares — created_at,
                    // then id — because `core/state.js` takes `profiles[0]` when
                    // the remembered selection is not among them.
                    return children
                        .slice()
                        .sort((a, b) =>
                            a.created_at_utc === b.created_at_utc
                                ? (a.id < b.id ? -1 : 1)
                                : a.created_at_utc - b.created_at_utc
                        )
                        .map((row) => ({ ...row }));
                }
                if (statement === sql.MARKS_SQL) return [];

                if (statement === sql.AREA_LOOKUP_SQL) {
                    // No diary area until the first entry creates one, which is
                    // the first-write case the surface has to handle. Keyed by
                    // the CHILD the statement binds (slot 2) since UIP-P4: with
                    // two children in the store, answering from one shared pile
                    // would let a leg about the second child pass while the
                    // surface wrote into the first one's diary.
                    return areaOfChild.has(values[1])
                        ? [{ id: areaOfChild.get(values[1]) }]
                        : [];
                }
                if (statement === sql.RECORDS_SQL) {
                    const stagedList = window.__pageBridgeList;
                    if (stagedList.failWith) throw new Error(stagedList.failWith);
                    return newestFirst(ownedBy(values[1]));
                }

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
                    // SLOT 3, NOT SLOT 2, and the difference is the whole
                    // reason this is bound rather than assumed: the search
                    // statement binds the MATCH expression first, so the child
                    // sits one place further along than it does in every other
                    // statement here.
                    return newestFirst(
                        ownedBy(values[2]).filter((row) => staged.answer.includes(row.id))
                    );
                }
                if (statement === sql.RECORD_COUNT_SQL) return [{ n: ownedBy(values[1]).length }];
                return unknown('query', statement);
            };

            const applyMutation = (statement, values) => {
                if (statement === sql.AREA_INSERT_SQL) return;
                if (statement === sql.AREA_CHILD_INSERT_SQL) {
                    // area_id, child_id — the pair the real query joins through.
                    areaOfChild.set(values[1], values[0]);
                    childOfArea.set(values[0], values[1]);
                    return;
                }
                // A PROFILE CREATED THROUGH THE UI (UIP-P4). Three statements,
                // in the order `repo-journal.js::appendChild` sends them inside
                // one transaction: the child row in the prelude, then a spine
                // entry and its attribute row per attribute. The seam holds what
                // they say and nothing more — it applies no DDL, enforces no
                // foreign key, and models no `v_child_attribute_current`. That
                // a child really comes back out of a journal is `DiaryEntryTest`
                // on a device, and `FIU-P2-INV-001`'s Scope says so.
                if (statement === sql.childInsert) {
                    children.push({
                        id: values[0],
                        created_at_utc: values[1],
                        name: null,
                        birthdate: null,
                    });
                    return;
                }
                if (statement === sql.ENTRY_SQL) {
                    // id, kind, author, subject_child_id, ...
                    subjectOfEntry.set(values[0], values[3]);
                    return;
                }
                if (statement === sql.DETAIL_SQL_child_attribute) {
                    // journal_id, attribute, value, sensitive.
                    const childId = subjectOfEntry.get(values[0]);
                    const child = children.find((row) => row.id === childId);
                    if (!child) {
                        throw new Error(
                            '[page-bridge] a child_attribute row arrived for a journal entry this'
                                + ' seam never saw, so it refuses rather than inventing a child: '
                                + JSON.stringify(values[0])
                        );
                    }
                    if (values[1] !== 'name' && values[1] !== 'birthdate') {
                        throw new Error(
                            '[page-bridge] a child_attribute this seam does not model: '
                                + JSON.stringify(values[1])
                        );
                    }
                    child[values[1]] = values[2];
                    return;
                }
                if (statement === sql.markOpen) return;
                if (statement === sql.markClean) return;
                if (statement === sql.projectionContext) return;
                if (statement === sql.RECORD_INSERT_SQL) {
                    const stagedWrite = window.__pageBridgeWrite;
                    if (stagedWrite.failWith) throw new Error(stagedWrite.failWith);
                    // Positional, as the shipped statement declares it: id,
                    // area, author, kind, body, event_date_local, entry_at_utc,
                    // entry_utc_offset_min, updated_at_utc.
                    const owner = childOfArea.get(values[1]);
                    if (owner === undefined) {
                        throw new Error(
                            '[page-bridge] a record arrived for an area no `area_child` row ever'
                                + ' named, so the seam cannot say whose diary it is: '
                                + JSON.stringify(values[1])
                        );
                    }
                    childOfRecord.set(values[0], owner);
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

                    // NO `TheyGrowTransfer` BRANCH SINCE L3-P2, AND ITS ABSENCE
                    // IS LOAD-BEARING (FIU-DL-002). It used to answer
                    // `pendingTransfer` so the boot-time import offer could take
                    // its "nothing to offer" branch quietly. The offer went at
                    // L3-P2 and the plugin itself at PPR-P2, so there is no such
                    // plugin on any device now — and this seam fails closed, so
                    // a call to any plugin but the store names the plugin in the
                    // throw below rather than passing unnoticed through a leg
                    // about something else.
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
                        return {
                            values: await answerQuery(options.statement, options.values ?? []),
                        };
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

module.exports = {
    installPageBridge,
    jsObjectStringConstant,
    jsStringConstant,
    shippedStatements,
};
