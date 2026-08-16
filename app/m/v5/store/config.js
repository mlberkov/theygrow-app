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
});

// The complete set of plugin methods this app is allowed to call.
//
// This is a supply-chain boundary, not documentation: @capacitor-community/
// sqlite also ships JSON import/export, its own upgrade versioning, sync tables
// and TypeORM plumbing, none of which may become load-bearing here. The wrapper
// is replaceable; the schema is not. app/tests/store-supply-chain.spec.js fails
// if a call site reaches for a method outside this list.
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
]);
