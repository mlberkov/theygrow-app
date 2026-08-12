// Opening, keying, checking and migrating the local store (L1-P2).
//
// The order of the sequence below is the packet, in miniature:
//   secret -> connection -> pragmas -> integrity -> schema -> bootstrap
// Each step exists because skipping it loses data that exists nowhere else.
//
// ENCRYPTION IS CHOSEN WITH THE WRAPPER, NOT AFTER IT (LSC-DL-002). The store is
// SQLCipher-encrypted from CREATION, so no plaintext database file ever exists
// on the device. The passphrase is minted here from crypto.getRandomValues,
// never derived from anything the parent types, and handed to the plugin, which
// keeps it in EncryptedSharedPreferences behind an AndroidKeyStore MasterKey
// (AES256_GCM) — verified in the vendored plugin source, not assumed.
//
// THIS KEY HAS NO SECOND JOB. The export contour (P3) writes an UNENCRYPTED
// artifact and uses no key: privacy wants encryption, decades of readability
// forbid it, and one object cannot serve both, so they were split into two
// (LSC-DL-003). The encrypted operational snapshot — the one that is key-bound —
// is L7 work, addressed there together with the relay and key-scope model that
// are its only consumers.

import { STORE_CONFIG } from './config.js';
import { callPlugin, execute, isNativeStore, pragma, query, run } from './bridge.js';
import { StoreCorruptError, StoreError } from './errors.js';

const SELF_PARTICIPANT_ID_KEY = 'self_participant_id';

// Slot 16: identifiers are minted at creation and never handed out
// retroactively. UUIDv4 needs no coordination (so it survives the L7 merge),
// leaks no timestamp, and needs no dependency — local ordering is the journal's
// seq, so a sortable id would buy nothing.
export function mintId() {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
        throw new StoreError('crypto.randomUUID is unavailable; ids cannot be minted');
    }
    return crypto.randomUUID();
}

function mintPassphrase(bits = STORE_CONFIG.passphraseBits) {
    const bytes = new Uint8Array(bits / 8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureSecret() {
    const stored = await callPlugin('isSecretStored', {});
    if (stored?.result === true) return;
    await callPlugin('setEncryptionSecret', { passphrase: mintPassphrase() });
}

async function tableExists(name) {
    const rows = await query(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        [name]
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

function compareVersions(actual, floor) {
    const a = String(actual).split('.').map(Number);
    const f = String(floor).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, f.length); i += 1) {
        const left = a[i] ?? 0;
        const right = f[i] ?? 0;
        if (left !== right) return left - right;
    }
    return 0;
}

async function assertEngineFloor() {
    const version = await pragma('SELECT sqlite_version() AS v');
    if (compareVersions(version, STORE_CONFIG.sqliteVersionFloor) < 0) {
        throw new StoreError(
            `SQLite ${version} is below the ${STORE_CONFIG.sqliteVersionFloor} floor this schema needs`
        );
    }
    return version;
}

// The DDL is fetched rather than inlined so that ONE artifact serves the app,
// the desktop tests and the Android instrumented test. Inside the WebView this
// is a local asset read (capacitor serves the staged web root); there is no
// network involved on any platform, at any point.
async function loadSchemaSql() {
    const response = await fetch(STORE_CONFIG.schemaUrl);
    if (!response.ok) {
        throw new StoreError(`schema artifact ${STORE_CONFIG.schemaUrl} is unreadable`);
    }
    return response.text();
}

async function applySchema(nowUtc) {
    const sql = await loadSchemaSql();
    // One execute() call with transaction:true — the DDL applies whole or not at
    // all. The wrapper splits the file itself; app/tests/schema/ applies it
    // through a faithful port of that same splitter, so the split is checked on
    // a machine that can actually run the tests.
    await execute(sql, { transaction: true });
    await run(
        'INSERT INTO schema_migration (version, name, applied_at_utc) VALUES (?, ?, ?)',
        [STORE_CONFIG.schemaVersion, STORE_CONFIG.schemaName, nowUtc]
    );
}

async function checkIntegrity() {
    const verdict = await pragma('PRAGMA integrity_check');
    if (String(verdict).toLowerCase() !== 'ok') {
        throw new StoreCorruptError(`integrity_check returned ${verdict}`);
    }
    return verdict;
}

// A default CHILD is deliberately not created here. Auto-creating one was
// rejected as an owner decision (A0 spa-polish, "it invents a family record the
// owner did not ask for"); what this packet turns into code is the structural
// half of that decision instead — no family datum can exist without a subject
// and an author, enforced by NOT NULL and foreign keys (LSC-P2-INV-005). The
// self participant is not a family record: attribution needs an id to point at.
async function bootstrapSelfParticipant(nowUtc) {
    const rows = await query('SELECT value FROM schema_meta WHERE key = ?', [
        SELF_PARTICIPANT_ID_KEY,
    ]);
    if (rows.length > 0) return String(rows[0].value);

    const participantId = mintId();
    await run('INSERT INTO participant (id, is_self, created_at_utc) VALUES (?, 1, ?)', [
        participantId,
        nowUtc,
    ]);
    await run('INSERT INTO schema_meta (key, value) VALUES (?, ?)', [
        SELF_PARTICIPANT_ID_KEY,
        participantId,
    ]);
    return participantId;
}

async function markOpen(nowUtc) {
    await run(
        'INSERT INTO store_lifecycle (id, opened_at_utc, clean_shutdown) VALUES (1, ?, 0)'
            + ' ON CONFLICT (id) DO UPDATE SET opened_at_utc = excluded.opened_at_utc,'
            + ' clean_shutdown = 0',
        [nowUtc]
    );
}

/**
 * Opens the local store, applying the schema on first run.
 *
 * Returns a handle describing what actually happened — including whether the
 * previous run ended cleanly and whether integrity_check had to run — so the
 * caller reports facts rather than assuming them.
 */
export async function openStore({ now = () => Date.now() } = {}) {
    const nowUtc = now();

    await ensureSecret();
    await callPlugin('createConnection', {
        database: STORE_CONFIG.databaseName,
        version: STORE_CONFIG.schemaVersion,
        encrypted: true,
        mode: 'secret',
        readonly: false,
    });
    await callPlugin('open', { database: STORE_CONFIG.databaseName, readonly: false });

    const journalMode = await pragma(`PRAGMA journal_mode = ${STORE_CONFIG.journalMode}`);
    await pragma('PRAGMA foreign_keys = ON');
    await pragma(`PRAGMA busy_timeout = ${STORE_CONFIG.busyTimeoutMs}`);
    const sqliteVersion = await assertEngineFloor();

    const hadSchema = await tableExists('schema_meta');
    let cleanShutdown = true;
    let integrity = 'not-run';

    if (hadSchema) {
        const rows = await query('SELECT clean_shutdown FROM store_lifecycle WHERE id = 1');
        cleanShutdown = Number(rows[0]?.clean_shutdown ?? 1) === 1;
        if (!cleanShutdown && STORE_CONFIG.integrityCheckPolicy === 'after-unclean-shutdown') {
            integrity = await checkIntegrity();
        }
    } else {
        await applySchema(nowUtc);
    }

    const selfParticipantId = await bootstrapSelfParticipant(nowUtc);
    await markOpen(nowUtc);

    return Object.freeze({
        databaseName: STORE_CONFIG.databaseName,
        schemaVersion: STORE_CONFIG.schemaVersion,
        sqliteVersion,
        journalMode,
        freshlyCreated: !hadSchema,
        previousRunClean: cleanShutdown,
        integrity,
        selfParticipantId,
    });
}

// Graceful close. The clean_shutdown marker is what tells the NEXT open whether
// integrity_check is owed; a process killed before this point leaves it clear,
// which is exactly the signal wanted.
export async function closeStore({ now = () => Date.now() } = {}) {
    await run('UPDATE store_lifecycle SET clean_shutdown = 1, opened_at_utc = ? WHERE id = 1', [
        now(),
    ]);
    await callPlugin('close', { database: STORE_CONFIG.databaseName, readonly: false });
    await callPlugin('closeConnection', {
        database: STORE_CONFIG.databaseName,
        readonly: false,
    });
}

export { isNativeStore };
