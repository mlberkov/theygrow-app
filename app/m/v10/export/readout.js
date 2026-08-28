// Reading the journal out for export (L1-P3).
//
// Every query lives in declaration.json, not here. That is the point: the same
// file the builder reads, the same file app/tests/export/ drives its assertions
// from, and the same bytes a verbatim copy of which lands inside every archive.
// A query written in this module would be a fourth copy of a public commitment,
// free to drift from the three that a reader can actually check.
//
// SCOPE IS BOUND HERE, AND ONLY HERE. Every scope-filtered query takes the
// requesting participant's id as a parameter; the declaration names the
// parameter and this module refuses to bind a name it does not know. The failure
// that matters is not a crash — it is a filter that silently binds NULL and
// widens the archive past the participant who asked for it, which is why the
// unknown-name branch throws instead of defaulting.

import { query } from '../store/bridge.js';
import { ExportError } from './errors.js';

function bind(params, values) {
    return params.map((name) => {
        if (!(name in values)) {
            throw new ExportError(`the declaration asks for an unknown parameter "${name}"`);
        }
        return values[name];
    });
}

/**
 * Runs every declared dataset query and returns the read-out the builder wants.
 *
 * Sequential rather than concurrent on purpose: these are reads of one SQLite
 * connection behind one bridge, and a burst of parallel calls buys nothing but a
 * less legible failure when one of them is the one that fails.
 */
export async function readOut(declaration, { selfParticipantId }) {
    if (!selfParticipantId) {
        throw new ExportError('the export needs the requesting participant id to scope itself');
    }
    const values = { self_participant_id: selfParticipantId };
    const datasets = {};
    for (const dataset of declaration.datasets) {
        datasets[dataset.name] = await query(dataset.query, bind(dataset.params, values));
    }
    return datasets;
}

/**
 * The three versions the manifest records, read from the DEVICE.
 *
 * `schema_meta` is what the database actually holds, which is not necessarily
 * what this build expects — recording the build's opinion instead would let an
 * archive claim a schema its own data was never written under.
 */
export async function readManifestFacts({ canonVersion, appVersion, selfParticipantId, now }) {
    const rows = await query('SELECT key, value FROM schema_meta');
    const meta = Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
    return {
        exportedAtUtc: now,
        appVersion,
        canonVersion,
        schemaContract: meta.kb_journal_contract,
        schemaVersion: Number(meta.schema_version),
        selfParticipantId,
    };
}
