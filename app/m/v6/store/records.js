// The diary record: the parent's own text (DIA-P3).
//
// A RECORD IS NOT A JOURNAL ENTRY, AND THE DIFFERENCE IS THE WHOLE FILE.
// PDR-026 §4 amendment 2026-08-04 makes ASSERTIONS historical: a mark is an
// attributed claim about a child, so changing one is a NEW assertion over the
// previous one and `journal_entry` carries eight triggers that refuse UPDATE and
// DELETE outright (LSC-P2-INV-001). A diary entry is not a claim about a child's
// skill — it is the author's own text — so PDR-026 §4 rule 1 says it is edited
// by OVERWRITE, and `record` is deliberately absent from those triggers.
//
// So: `overwriteRecord` below issues an UPDATE, on purpose, and that is not a
// hole in the append-only rule. A reader who "fixes" it into an append would
// give the family a diary that cannot be corrected; a reader who copies its
// shape into `journal.js` would give them a history that can be rewritten. The
// schema states the same split at the `record` table and at the trigger block.
//
// WHERE A RECORD LIVES. Every record belongs to an `area`, and the area is
// `participant_private`, owned by its author. That is not caution: PDR-026's
// annotation of 2026-08-11 places the grounding quote in the AUTHOR'S PRIVATE
// AREA and gives the second parent a pointer to the author's records rather
// than the quote, "otherwise copying the quote into a shared assertion would
// leak private diary text". The quote is lifted out of a record, so the record
// is in the private area by construction. `v_shared_journal` agrees: the set L7
// may ever ship carries no record text at all.
//
// SEARCH LIVES HERE TOO, FROM DIA-P4, and deliberately not in a module of its
// own: searching records is the record's concern, the scoping predicates are the
// SAME three the read path uses, and a second module would be a second place for
// "whose diary is this" to be answered. The strategy behind it — a query-side
// answer to ADR-046 §2.5 — is documented at the search section below, not here.
//
// WHAT IS DELIBERATELY NOT HERE. No delete: erasing a record cascades to the
// quotes copied out of it and leaves its marks standing with degraded
// provenance (ADR-015), which is behaviour the schema already implements and
// `app/tests/schema/test_store_append_only.py` already executes. Surfacing it
// needs a warning the parent can act on and marks with quotes to warn about,
// and both are L5. Shipping an exported deleteRecord() nothing calls would be
// dead code carrying a destructive cascade.

import { STORE_CONFIG } from './config.js';
import { executeSet, query, run } from './bridge.js';
import { StoreError } from './errors.js';
import { mintId } from './store.js';

// The local calendar date, which is the date a parent would say out loud. Same
// two helpers as store/repo-journal.js and deliberately not imported from it:
// that module is about the JOURNAL, and a dependency from the record path onto
// it is the first step of the confusion this file's header exists to prevent.
function localDate(now) {
    const at = new Date(now);
    const year = at.getFullYear();
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Minutes east of UTC, which is the sign the schema stores. */
function utcOffset(now) {
    return -new Date(now).getTimezoneOffset();
}

// The author's diary area for one child, if it already exists. Keyed on the
// three facts that define it — owner, child, visibility class — rather than on
// an id remembered somewhere else, so there is no second place that can be
// wrong about which area the diary is.
const AREA_LOOKUP_SQL =
    'SELECT a.id AS id FROM area a JOIN area_child ac ON ac.area_id = a.id'
    + ' WHERE a.owner_participant_id = ? AND ac.child_id = ?'
    + ' AND a.visibility_class = ? LIMIT 1';

// ON CONFLICT DO NOTHING for the same reason repo-journal.js's childRow() has
// it: re-asserting a container is a no-op, and a pre-read plus an insert is two
// round trips where one statement will do.
const AREA_INSERT_SQL =
    'INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)'
    + ' VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING';

const AREA_CHILD_INSERT_SQL =
    'INSERT INTO area_child (area_id, child_id) VALUES (?, ?)'
    + ' ON CONFLICT (area_id, child_id) DO NOTHING';

// THE THREE COLUMNS THIS STATEMENT DOES NOT GUESS.
//
// `sensitivity` is written NULL, and NULL is a value here rather than an
// omission: the schema gives the column no default on purpose, because "never
// declared" is a different fact from "declared not sensitive" (PDR-026 §4
// amendment item 3). This surface asks the parent nothing about sensitivity, so
// writing 'not_sensitive' would record a declaration they never made and would
// make an accumulated corpus indistinguishable from a reviewed one.
//
// `event_at_utc` and `event_utc_offset_min` are written NULL TOGETHER, which the
// schema's paired CHECK is what makes expressible. The surface collects a DAY,
// not a moment: a parent writing in the evening about the morning knows which
// day it was and not which minute, and inventing `now` for the instant would be
// false precision. `appendMark` sets the instant only because ticking a skill IS
// the observation, happening now.
//
// `entry_at_utc` / `entry_utc_offset_min` always carry the real moment of
// writing, so event time and entry time stay distinct in every row (PDR-026 §4
// amendment item 2) — that is the whole point of the two pairs.
const RECORD_INSERT_SQL =
    'INSERT INTO record (id, area_id, author_participant_id, kind, body, media_ref,'
    + ' sensitivity, event_date_local, event_at_utc, event_utc_offset_min,'
    + ' entry_at_utc, entry_utc_offset_min, updated_at_utc)'
    + ' VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?)';

// The overwrite. `entry_at_utc` is NOT touched: the entry time is when the text
// was first written, and `updated_at_utc` is the column the frozen schema
// provides for the change. The FTS index follows through the shipped
// record_fts_after_update trigger — nothing re-indexes by hand.
const RECORD_UPDATE_SQL =
    'UPDATE record SET body = ?, event_date_local = ?, updated_at_utc = ? WHERE id = ?';

// Newest first by the day the parent named, then by when they wrote it. Scoped
// through the area rather than by a child column, because `record` has none: a
// record's subject is the area's child (slot 4), and keeping the join here means
// the two can never drift apart.
const RECORDS_SQL =
    'SELECT r.id AS id, r.body AS body, r.event_date_local AS event_date_local,'
    + ' r.entry_at_utc AS entry_at_utc, r.entry_utc_offset_min AS entry_utc_offset_min,'
    + ' r.updated_at_utc AS updated_at_utc, r.sensitivity AS sensitivity'
    + ' FROM record r JOIN area a ON a.id = r.area_id'
    + ' JOIN area_child ac ON ac.area_id = a.id'
    + ' WHERE a.owner_participant_id = ? AND ac.child_id = ?'
    + ' AND a.visibility_class = ? AND r.kind = ?'
    + ' ORDER BY r.event_date_local DESC, r.entry_at_utc DESC, r.id DESC LIMIT ?';

// SEARCH (DIA-P4). The same seven columns, the same scoping and the same order
// as RECORDS_SQL — one list, one shape, whether it is filtered or not — with the
// derived index joined in front of it.
//
// THE JOIN IS ON `rowid`, WHICH IS WHAT `content='record'` MAKES TRUE. The FTS
// table is an EXTERNAL-CONTENT index (schema/001-core.sql), so its rowid is the
// record's rowid and nothing else has to be kept in step.
//
// THE SCOPING IS NOT DECORATION. `record_fts` indexes EVERY record in the store
// — every area, every participant, every child. A MATCH alone would return the
// other parent's private diary. The three scope predicates are what make this a
// search of the searcher's own entries about the child on screen, and they are
// the same three RECORDS_SQL uses, so the two panes cannot disagree about whose
// diary this is (DIA-P4-INV-001).
const RECORD_SEARCH_SQL =
    'SELECT r.id AS id, r.body AS body, r.event_date_local AS event_date_local,'
    + ' r.entry_at_utc AS entry_at_utc, r.entry_utc_offset_min AS entry_utc_offset_min,'
    + ' r.updated_at_utc AS updated_at_utc, r.sensitivity AS sensitivity'
    + ' FROM record_fts f JOIN record r ON r.rowid = f.rowid'
    + ' JOIN area a ON a.id = r.area_id'
    + ' JOIN area_child ac ON ac.area_id = a.id'
    + ' WHERE f.record_fts MATCH ?'
    + ' AND a.owner_participant_id = ? AND ac.child_id = ?'
    + ' AND a.visibility_class = ? AND r.kind = ?'
    + ' ORDER BY r.event_date_local DESC, r.entry_at_utc DESC, r.id DESC LIMIT ?';

// Has this parent written anything about this child at all? It separates the two
// reasons a search comes back empty — nothing written, or nothing matched — and
// it is the precondition on the index repair below: a diary with no entries has
// no index to be wrong about.
const RECORD_COUNT_SQL =
    'SELECT count(*) AS n FROM record r JOIN area a ON a.id = r.area_id'
    + ' JOIN area_child ac ON ac.area_id = a.id'
    + ' WHERE a.owner_participant_id = ? AND ac.child_id = ?'
    + ' AND a.visibility_class = ? AND r.kind = ?';

// FTS5's own rebuild, issued through the shipped seam like any other write. The
// COMMAND is a bound value rather than a literal inside the statement, for the
// reason RECORD_KIND_TEXT is one: the constants in this file are read out of it
// and executed against the real frozen DDL, and a quoted literal inside a quoted
// string is a constant the reader cannot see whole.
//
// This re-reads `record` and rewrites the index from it. It touches no journal
// row and no record: the index is DERIVED (PDR-026 §4 rule 3), which is exactly
// why repairing it is a rebuild and never a migration.
const FTS_REBUILD_SQL = 'INSERT INTO record_fts (record_fts) VALUES (?)';
const FTS_REBUILD_COMMAND = 'rebuild';

// Slot 5's text/media flag. A BOUND VALUE rather than a literal inside the SQL:
// media is not a feature of this product yet, and the statements above are read
// out of this file and executed against the real frozen DDL by
// app/tests/schema/test_diary_write_path.py, whose reader refuses a constant it
// cannot see whole — a quoted literal inside a quoted string is exactly that.
const RECORD_KIND_TEXT = 'text';

/** The text as it will be stored, or '' when there is nothing to store. */
function bodyText(body) {
    return typeof body === 'string' ? body.trim() : '';
}

/**
 * The author's diary area for this child, and the statements that create it.
 *
 * Returns the statements rather than running them, so that the area and the
 * first record it holds go in ONE transaction: a record cannot exist without
 * its area (the foreign key would refuse it), and an area with no record is a
 * container for nothing.
 */
async function diaryArea({ authorParticipantId, subjectChildId, now }) {
    const rows = await query(AREA_LOOKUP_SQL, [
        authorParticipantId,
        subjectChildId,
        STORE_CONFIG.diaryAreaVisibility,
    ]);
    const existing = rows[0]?.id;
    if (existing) return { areaId: String(existing), statements: [] };

    const areaId = mintId();
    return {
        areaId,
        statements: [
            {
                statement: AREA_INSERT_SQL,
                values: [
                    areaId,
                    STORE_CONFIG.diaryAreaTitle,
                    STORE_CONFIG.diaryAreaVisibility,
                    authorParticipantId,
                    now,
                ],
            },
            { statement: AREA_CHILD_INSERT_SQL, values: [areaId, subjectChildId] },
        ],
    };
}

/**
 * Writes one diary entry, with its area if this is the first one.
 *
 * `eventDateLocal` is the day the entry is ABOUT and defaults to today; the
 * moment of writing is taken from `now` either way.
 */
export async function createRecord({
    authorParticipantId,
    subjectChildId,
    body,
    eventDateLocal = null,
    now = Date.now(),
    utcOffsetMin = null,
}) {
    if (!authorParticipantId || !subjectChildId) {
        throw new StoreError('a diary entry needs both an author and a subject (LSC-P2-INV-005)');
    }
    const text = bodyText(body);
    if (!text) {
        // Refused here rather than at the engine: kind='text' binds a non-null
        // body by CHECK, so an empty entry would fail as a constraint violation
        // that reads like a defect instead of like a refusal.
        throw new StoreError('a diary entry with no text is not an entry');
    }

    const eventDate = eventDateLocal ?? localDate(now);
    const offset = utcOffsetMin ?? utcOffset(now);
    const area = await diaryArea({ authorParticipantId, subjectChildId, now });
    const recordId = mintId();

    await executeSet(
        [
            ...area.statements,
            {
                statement: RECORD_INSERT_SQL,
                values: [
                    recordId,
                    area.areaId,
                    authorParticipantId,
                    RECORD_KIND_TEXT,
                    text,
                    eventDate,
                    now,
                    offset,
                    now,
                ],
            },
        ],
        { transaction: true }
    );
    return recordId;
}

/**
 * Overwrites one diary entry in place (PDR-026 §4 rule 1).
 *
 * Returns nothing and throws when it changed no row: an edit that hit nothing
 * reporting success is the silent-failure shape ADR-046 §1 exists to prevent —
 * the parent would be told their correction was saved when it was not.
 */
export async function overwriteRecord({ recordId, body, eventDateLocal, now = Date.now() }) {
    if (!recordId) throw new StoreError('an edit needs the id of the entry it edits');
    const text = bodyText(body);
    if (!text) throw new StoreError('a diary entry with no text is not an entry');
    if (!eventDateLocal) throw new StoreError('an edit needs the day the entry is about');

    // NOT `{ transaction: true }`, and the change is about the refusal rather
    // than about speed (DIA-DL-007). One UPDATE is already atomic, so a wrapper
    // transaction buys nothing here — and it costs: the wrapper rolls back
    // inside a `finally` and throws the ROLLBACK's failure from there, which
    // discards the failure that caused it. A parent whose disk fills while they
    // are CORRECTING an entry is on the write path too, and must be told to free
    // space rather than to press Save again. See store/bridge.js for the
    // measured version of this on the create path.
    const result = await run(RECORD_UPDATE_SQL, [text, eventDateLocal, now, recordId], {
        transaction: false,
    });
    const changed = Number(result?.changes?.changes ?? 0);
    if (changed < 1) {
        throw new StoreError('the entry this edit names is not in the store');
    }
}

/** One child's diary, newest first, bounded by the declared render limit. */
export function loadRecords({
    authorParticipantId,
    subjectChildId,
    limit = STORE_CONFIG.diaryListLimit,
}) {
    return query(RECORDS_SQL, [
        authorParticipantId,
        subjectChildId,
        STORE_CONFIG.diaryAreaVisibility,
        RECORD_KIND_TEXT,
        limit,
    ]);
}

// --- search (DIA-P4) -----------------------------------------------------
//
// THE WORD-FORM STRATEGY LIVES HERE, IN THE QUERY, AND NOT IN THE INDEX. That is
// the whole answer to ADR-046 §2.5, and the reason it is cheap rather than
// momentous:
//
//   * The tokenizer is FROZEN with the schema — `unicode61 remove_diacritics 2`,
//     pinned in schema/001-core.sql. Changing it is a DDL edit.
//   * FTS5 is compiled WITHOUT ICU (LSC-DL-002, asserted on the device by
//     StoreEngineTest::the_bundled_engine_compiles_fts5_in), and ICU would not
//     have helped: it neither folds ё to е nor lemmatises Russian.
//   * So there is no stemmer to install and no tokenizer to swap. What is left
//     is what the QUERY asks for — and a query costs nothing to change. Not a
//     migration, and not even a rebuild.
//
// WHAT THE STRATEGY IS, IN ONE SENTENCE: every word the parent typed is searched
// as a PREFIX, in every е/ё spelling of itself, and all the words must appear.
//
// WHAT IT GETS WRONG, SAID OUT LOUD BECAUSE THE PARENT MUST NOT DISCOVER IT
// ALONE (ADR-015, and see surfaces/diary.js for the sentence they actually read):
//
//   1. IT DOES NOT KNOW WORD FORMS, so a word whose STEM changes is out of
//      reach: `сесть` does not find `сел`, `пойти` does not find `пошла`,
//      `спит` does not find `спал`. A prefix bridges an ending and nothing
//      else. Measured, not assumed — three queries in forty, and the table is
//      in DIA-DL-008.
//   2. IT OVER-MATCHES, deliberately. `сел` also finds «Сельский дом бабушки».
//      That is the price of (1) being as small as it is: raising the ceiling to
//      remove this one extra result costs nine everyday queries — `села`,
//      `спать`, `есть`, `зубы` — because a prefix cannot reach a written word
//      SHORTER than the one typed. An extra entry is a line skimmed past; a
//      miss tells a parent they never wrote what they wrote.
//   3. IT RANKS NOTHING. Results keep the list's own order — newest first — so
//      one pane has one order. bm25 was available and was not used.
//
// The three knobs behind it are in store/config.js with their provenance.

/**
 * The words a query contains, as FTS5's own tokenizer would cut them.
 *
 * MEASURED AGAINST unicode61 RATHER THAN GUESSED: letters and digits are token
 * characters and everything else separates, including `_` — `раз_два` indexes as
 * two tokens, `три4четыре` as one. Splitting the query the same way is what
 * keeps the terms we ask for and the terms that were indexed the same terms.
 */
function tokenise(typed) {
    if (typeof typed !== 'string') return [];
    return typed
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 0);
}

/**
 * Every е/ё spelling of one word, or the word alone when there are too many.
 *
 * THE INDEX DOES NOT FOLD ё TO е. That is measured on the real engine
 * (StoreEngineTest::russian_tokenization_behaves_as_measured_off_device asserts
 * `ЁЛКА` is NOT found by `елка`), so folding the query in either direction would
 * simply move the miss to the other spelling. Both are asked for instead.
 *
 * The count doubles per such letter, so it is bounded. Past the bound the word is
 * searched exactly as it was typed — a miss the parent can act on, rather than a
 * query that grows on its own.
 */
function spellings(word, ceiling) {
    const positions = [];
    for (let i = 0; i < word.length; i += 1) {
        if (word[i] === 'е' || word[i] === 'ё') positions.push(i);
    }
    if (positions.length === 0 || 2 ** positions.length > ceiling) return [word];

    let forms = [word];
    for (const at of positions) {
        const next = [];
        for (const form of forms) {
            const chars = Array.from(form);
            chars[at] = 'е';
            next.push(chars.join(''));
            chars[at] = 'ё';
            next.push(chars.join(''));
        }
        forms = next;
    }
    return Array.from(new Set(forms));
}

/**
 * The FTS5 MATCH expression for what a parent typed. PURE — no store, no clock.
 *
 * EVERY TERM IS QUOTED, AND THAT IS A SAFETY PROPERTY RATHER THAN A STYLE. A
 * parent writing about their child types apostrophes, dashes, quotation marks and
 * the occasional `*`, and every one of those is an OPERATOR in FTS5's query
 * grammar. Unquoted, `сел "OR` is a syntax error and the search dies in front of
 * someone who did nothing wrong. Quoted, it is two ordinary words. Nothing has to
 * be escaped inside the quotes either: tokenise() has already dropped everything
 * that is not a letter or a digit, so a `"` cannot survive to reach one.
 *
 * The prefix operator sits OUTSIDE the quotes — `"сел"*` — which is where FTS5's
 * grammar puts it.
 *
 * Returns '' when the query holds no words at all. The caller does not search on
 * that: an empty MATCH is a syntax error, and there is nothing to look for.
 */
export function buildDiaryMatch(
    typed,
    {
        stemChars = STORE_CONFIG.diarySearchStemChars,
        variantCeiling = STORE_CONFIG.diarySearchVariantCeiling,
    } = {}
) {
    const groups = [];
    for (const word of tokenise(typed)) {
        const terms = Array.from(
            new Set(
                spellings(word, variantCeiling).map((form) => `"${form.slice(0, stemChars)}"*`)
            )
        ).sort();
        // OR within a word (its spellings), AND across words: two words typed
        // mean both are wanted, which is what a person expects of a search box.
        groups.push(`(${terms.join(' OR ')})`);
    }
    return groups.join(' AND ');
}

// THE INDEX REPAIR HAPPENS AT MOST ONCE PER APP SESSION, and the flag is set
// BEFORE the rebuild runs rather than after it. A rebuild that fails will fail
// again, and retrying it on every empty result would make every ordinary
// word-form miss slow for the rest of the session.
let indexRepaired = false;

/**
 * One child's diary, filtered to what the parent typed.
 *
 * Returns `{ rows, tokens, rebuilt, searched }` rather than bare rows: the
 * surface needs to tell "nothing matched" from "nothing was asked", and the
 * signal needs counts. `tokens` is a COUNT of words, never the words.
 *
 * WHY THE REPAIR IS HERE AND NOT ANYWHERE ELSE. The index is derived and
 * rebuildable (PDR-026 §4 rule 3), which says it CAN be repaired and not who
 * asks. A parent cannot tell a stale index from a word-form miss, so a
 * "rebuild the index" control would hand them our internals to diagnose
 * (ADR-015); and the store's open path already runs PRAGMA integrity_check on
 * effectively every launch, so a re-index bolted there would be paid at every
 * start. An empty result over a diary that HAS entries is the one moment
 * staleness is observable at all — so that is where the repair is, once, and
 * the parent is told nothing about it because nothing was asked of them.
 */
export async function searchRecords({
    authorParticipantId,
    subjectChildId,
    typed,
    limit = STORE_CONFIG.diarySearchLimit,
}) {
    if (!authorParticipantId || !subjectChildId) {
        throw new StoreError('a search needs both a searcher and a subject (LSC-P2-INV-005)');
    }

    const words = tokenise(typed);
    if (words.length === 0) {
        return { rows: [], tokens: 0, rebuilt: false, searched: false };
    }

    const expression = buildDiaryMatch(typed);
    const scope = [
        authorParticipantId,
        subjectChildId,
        STORE_CONFIG.diaryAreaVisibility,
        RECORD_KIND_TEXT,
    ];

    let rows = await query(RECORD_SEARCH_SQL, [expression, ...scope, limit]);
    let rebuilt = false;

    if (rows.length === 0 && !indexRepaired) {
        const counted = await query(RECORD_COUNT_SQL, scope);
        if (Number(counted[0]?.n ?? 0) > 0) {
            indexRepaired = true;
            // { transaction: false } for the reason overwriteRecord passes it
            // (DIA-DL-007): one statement is already atomic, and asking the
            // wrapper for a transaction re-opens the window where its own
            // rollback failure speaks for the write.
            await run(FTS_REBUILD_SQL, [FTS_REBUILD_COMMAND], { transaction: false });
            rebuilt = true;
            rows = await query(RECORD_SEARCH_SQL, [expression, ...scope, limit]);
        }
    }

    return { rows, tokens: words.length, rebuilt, searched: true };
}
