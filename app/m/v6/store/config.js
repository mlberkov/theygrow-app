// Native-store knobs (L1-P2).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob the store
// introduces lives HERE, once, with changed_in provenance — never as a literal
// scattered through store.js or journal.js. The typed versioned config surface
// of ADR-013 is api/parameters.py, which belongs to the server side this
// milestone does not touch; the front-side precedent for a device-local knob is
// CACHE_VERSION in app/sw.js (PWA-DL-001), and this module follows it.
//
// This file ships to BOTH delivery channels byte-identically (LSC-P1-INV-002).
// It is inert on the web: nothing here reads or writes anything by itself.

// The mount-relative address of an artifact that lives beside this module.
//
// changed_in: DIA-DL-001 — see the twin in `export/config.js` for the whole
// argument. In one sentence: this URL used to be repointed by hand at every
// mount bump, a missed repoint RESOLVES rather than 404s because the frozen
// generation stays shipped, and deriving the address from this module's own
// address removes both the edit and the failure. `.pathname` keeps the value
// byte-for-byte what the literal was on both delivery channels.
const mountAsset = (name) => new URL(name, import.meta.url).pathname;

export const STORE_CONFIG = Object.freeze({
    // changed_in: LSC-DL-002 — the database file name. Frozen with the schema:
    // renaming it after the first live record orphans that record.
    databaseName: 'theygrow',

    // changed_in: LSC-DL-002 — schema version this build expects. The device
    // records the version it actually applied in schema_meta/schema_migration.
    schemaVersion: 1,

    // changed_in: LSC-DL-002 — the DDL artifact, fetched from the app's own
    // origin inside the WebView. Version lives in the FILE NAME, so a v2
    // migration adds a file rather than editing a published one.
    // changed_in: EMV-DL-001 — VALUE repointed at the /m/v2/ mount, not a
    // design change: this URL is mount-relative, so a copy-forward that left it
    // at /m/v1/ would make the new generation fetch the frozen one's DDL and
    // would break outright when v1 is retired. The DDL bytes are unchanged.
    // changed_in: XPT-DL-001 — VALUE repointed again, at /m/v3/, by the
    // export-transfer bump. The DDL bytes are unchanged apart from the comment
    // that names which generation fetches them.
    // changed_in: DIA-DL-001 — VALUE now DERIVED rather than repointed, and
    // this is the last time this line changes at a bump. The DDL bytes are
    // unchanged again, apart from that same comment, which no longer names a
    // generation at all. See mountAsset above.
    schemaUrl: mountAsset('schema/001-core.sql'),
    schemaName: '001-core.sql',

    // changed_in: LSC-DL-002 — STRICT tables need 3.37. Asserted against the
    // real engine by the Android instrumented test and against the desktop
    // engine by app/tests/schema/.
    sqliteVersionFloor: '3.37.0',

    // changed_in: LSC-DL-002 — WAL plus a bounded wait. WAL is what keeps a
    // reader from blocking the write that records an observation.
    journalMode: 'WAL',
    busyTimeoutMs: 5000,

    // changed_in: LSC-DL-002 — run PRAGMA integrity_check at open only when the
    // previous run did not close cleanly. Always-on would cost a full scan of
    // the family history on every launch.
    integrityCheckPolicy: 'after-unclean-shutdown',

    // changed_in: LSC-DL-002 — how many journal entries a cursor read returns.
    // Background filing is L5; the shape it will page through is this one.
    cursorBatchSize: 100,

    // changed_in: LSC-DL-002 — bits of entropy in the database passphrase. The
    // passphrase is minted on the device, never derived from user input, and
    // never leaves it. It keys THIS database and nothing else: the L1-P3 export
    // artifact is unencrypted and needs no key at all (LSC-DL-003), and the
    // encrypted operational snapshot that does need one belongs to L7 together
    // with the relay and the key-scope model that are its only consumers.
    passphraseBits: 256,

    // changed_in: LSC-DL-004 — the namespace the legacy import hashes its
    // deterministic ids under. It is the whole idempotence mechanism: the same
    // profile and the same skill always derive the same journal id, so a second
    // run recognises its own earlier work by reading the journal rather than by
    // consulting a ledger that could disagree with it.
    //
    // THE VERSION IS INSIDE THE VALUE, and changing it re-imports the family's
    // entire history as a second set of entries that the append-only journal can
    // never be rid of. It is not a knob to turn casually.
    derivedIdNamespace: 'theygrow/legacy-import/v1',

    // changed_in: LSC-DL-004 — how many candidate ids are checked for existence
    // per round trip. SQLite's default parameter ceiling is 999, so this stays
    // well under it; it bounds the probe, not the import.
    legacyImportProbeBatch: 200,

    // changed_in: DIA-DL-005 — the title of the area a diary entry lives in. A
    // STABLE TOKEN, not a display string: this area is an internal container
    // that no surface shows, and a title in the product's language would become
    // a string to translate and, once written into a family's history, to
    // migrate. What a parent reads is the diary surface's own heading.
    diaryAreaTitle: 'diary',

    // changed_in: DIA-DL-005 — the visibility class of that area, and the class
    // the read path filters on. `participant_private` is not a cautious guess:
    // PDR-026's annotation of 2026-08-11 keeps the grounding quote in the
    // author's private area and gives the second parent a pointer to the
    // author's records instead, "otherwise copying the quote into a shared
    // assertion would leak private diary text". The quote comes out of a
    // record, so the record is private by construction. A knob rather than a
    // literal because it is asserted in three places — insert, lookup, read —
    // and three literals are three chances to disagree.
    diaryAreaVisibility: 'participant_private',

    // changed_in: DIA-DL-005 — how many diary entries the list surface renders.
    // A bound on the RENDER, never on what is stored: nothing truncates a
    // parent's text and no write consults this number.
    diaryListLimit: 200,

    // changed_in: DIA-DL-008 — how many search RESULTS the surface renders.
    // Declared apart from diaryListLimit rather than sharing it: the two bound
    // different panes, and one number serving both would move both the day
    // either is tuned. Same discipline as the list bound — a render limit, not
    // a limit on what is searched or stored.
    diarySearchLimit: 200,

    // THE THREE KNOBS BELOW ARE THE WORD-FORM STRATEGY (ADR-046 §2.5), AND
    // THEY COST NOTHING TO CHANGE. That is the whole reason the strategy is
    // query-side. The index stores no normalisation decision (PDR-026 §4 rule
    // 4), the tokenizer is frozen with the schema, and everything below happens
    // when a parent presses the search control — so moving these values needs
    // neither a migration NOR a rebuild. Read store/records.js buildDiaryMatch
    // for the mechanism and DIA-DL-008 for the measurement they came from.

    // changed_in: DIA-DL-008 — how many leading characters of a typed word are
    // searched, before the prefix operator.
    //
    // MEASURED, AND THE MEASUREMENT CHOSE IT. Forty queries a parent might type
    // against fifteen diary sentences, on the real frozen DDL:
    //
    //     3 -> 37/40 found their entry, 4 extra documents across 4 queries
    //     4 -> 31/40 found their entry, 1 extra document
    //     5 -> 26/40 found their entry, 1 extra document
    //
    // A prefix bridges the END of a word only, so a query LONGER than what was
    // written cannot reach it: `села` does not find `сел` unless the ceiling
    // cuts both down to `сел`. Going from 3 to 4 loses nine everyday queries —
    // `села`, `сели`, `спать`, `спит`, `есть`, `зубы`, `пошёл` … — to remove
    // ONE extra result.
    //
    // So this trades precision for recall on purpose, because the two failures
    // are not equal: an extra entry is one line a parent skims past in a short
    // list, and a miss tells them they never wrote something they did write.
    // The extra it buys is legible rather than mysterious — `сел` also finds
    // «Сельский дом бабушки». The whole table is in DIA-DL-008 and every row of
    // it is executed by app/tests/schema/test_diary_search.py.
    diarySearchStemChars: 3,

    // changed_in: DIA-DL-008 — how many е/ё spellings of one typed word are
    // searched at once. The index does NOT fold ё to е (measured on the device
    // engine by StoreEngineTest::russian_tokenization_behaves_as_measured_off_
    // device), so a query folded either way would miss the other spelling; both
    // are searched instead. A word with n such letters has 2^n spellings, so
    // the count is bounded and a word past the bound is searched exactly as the
    // parent typed it — a miss rather than a slow query.
    diarySearchVariantCeiling: 8,

    // changed_in: DIA-DL-008 — WHO REPAIRS A DERIVED INDEX, AND WHEN.
    //
    // PDR-026 §4 rule 3 says the retrieval index is derived and rebuilt; it does
    // not say who triggers that, and this is the answer. Not the parent: a
    // parent cannot tell a stale index from a word-form miss, and a "rebuild the
    // index" control would ask them to diagnose our internals (ADR-015). Not the
    // open path either — store/store.js runs PRAGMA integrity_check there and,
    // because closeStore() is never called, that already happens on effectively
    // every launch; adding a full re-index to it would be paid at every start.
    //
    // So: the app, at the one moment staleness is OBSERVABLE — a search that
    // found nothing in a diary that has entries — and at most once per app
    // session. See store/records.js searchRecords.
    ftsRepairPolicy: 'rebuild-on-empty-result',
});

// The complete set of plugin methods this app is allowed to call.
//
// This is a supply-chain boundary, not documentation: @capacitor-community/
// sqlite also ships JSON import/export, its own upgrade versioning, sync tables
// and TypeORM plumbing, none of which may become load-bearing here. The wrapper
// is replaceable; the schema is not. app/tests/store-supply-chain.spec.js fails
// if a call site reaches for a method outside this list, AND if this list grows
// beyond the exact set named there — the second half is what stops the list
// drifting open one convenient method at a time.
//
// changed_in: DIA-DL-007 — the last three. What this list bounds is a CLASS OF
// CAPABILITY, and that is the test the three had to pass: none of them can
// address a path, enumerate anything, or delete anything. They begin, commit and
// roll back a transaction on a database this app has already opened, which is
// strictly less reach than `execute` and `run` already carry. They are here
// because store/bridge.js now drives the transaction itself rather than asking
// the wrapper to drive it: the wrapper rolls back inside a `finally` and throws
// the ROLLBACK's own failure from there, which discards the failure that caused
// it — on a full disk that turns SQLITE_FULL into "cannot rollback", and the
// parent is told to retry rather than to free space (ADR-046 §1.1, ADR-015).
export const ALLOWED_PLUGIN_METHODS = Object.freeze([
    'echo',
    'isSecretStored',
    'setEncryptionSecret',
    'createConnection',
    'closeConnection',
    'open',
    'close',
    'execute',
    'executeSet',
    'query',
    'run',
    'beginTransaction',
    'commitTransaction',
    'rollbackTransaction',
]);
