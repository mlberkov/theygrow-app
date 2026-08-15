// One export, end to end (L1-P3).
//
// The whole contour, in the order it happens: declaration -> read-out ->
// manifest facts -> bytes -> the parent's chosen file. Nothing here starts on
// its own. There is no timer, no retry, no queue and no background trigger:
// runExport() runs when a human presses a button and at no other moment, which
// is a privacy property of an unencrypted artifact, not a UI preference.
//
// Nothing leaves the device either. The only fetches are same-origin reads of
// the app's own assets — on the native channel those are local file reads served
// by Capacitor, with no network involved at any point — and the bytes go to a
// document the parent picked. app/tests/export-contour.spec.js asserts that no
// module in this directory can reach the network at all.

import { kbReady } from '../core/kb-boot.js';
import { storeHandle } from '../store/boot.js';
import { artifactFilename, buildArtifact } from './build.js';
import { EXPORT_CONFIG } from './config.js';
import { ExportError } from './errors.js';
import { readManifestFacts, readOut } from './readout.js';
import { saveArtifact } from './sink.js';

async function loadDeclaration() {
    const response = await fetch(EXPORT_CONFIG.declarationUrl);
    if (!response.ok) {
        throw new ExportError(`the export declaration ${EXPORT_CONFIG.declarationUrl} is unreadable`);
    }
    return response.json();
}

// The print layer's two binaries. On the native channel these are local asset
// reads served by Capacitor out of the APK — no network at any point — which is
// also why they are not in the service worker precache: only this channel ever
// reads them, and this channel does not use that worker.
//
// The fetch calls themselves stay at the call site, addressed literally as
// EXPORT_CONFIG knobs, rather than being hidden behind a helper that takes a
// url. app/tests/export-contour.spec.js asserts every fetch argument is a
// declared knob, and a helper parameter would defeat that gate rather than
// satisfy it — the point is that a new off-device read cannot be introduced
// without declaring its target first.
async function toBytes(response, url) {
    if (!response.ok) {
        throw new ExportError(`the print layer asset ${url} is unreadable`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * Builds the artifact and hands it to the system file picker.
 *
 * The clock is injected so the caller — and the test suite — owns the one value
 * that varies between two exports of an unchanged journal.
 *
 * The returned summary is counts and sizes only. No family text, no child's
 * name, no diary body: it is written to the console during the RUNBOOK smoke,
 * and a summary that carried family text would put it in `adb logcat`.
 */
export async function runExport({ now = () => Date.now() } = {}) {
    const handle = storeHandle();
    if (!handle) {
        throw new ExportError('the local store is not open, so there is nothing to export');
    }

    const [declaration, canon, fontResponse, iccResponse] = await Promise.all([
        loadDeclaration(),
        kbReady,
        fetch(EXPORT_CONFIG.fontUrl),
        fetch(EXPORT_CONFIG.iccUrl),
    ]);
    const font = await toBytes(fontResponse, EXPORT_CONFIG.fontUrl);
    const icc = await toBytes(iccResponse, EXPORT_CONFIG.iccUrl);
    const selfParticipantId = handle.selfParticipantId;

    const readout = await readOut(declaration, { selfParticipantId });
    const manifest = await readManifestFacts({
        canonVersion: canon.kb_version,
        appVersion: EXPORT_CONFIG.appVersion,
        selfParticipantId,
        now: now(),
    });
    manifest.assets = { font, icc };

    const bytes = buildArtifact({ declaration, readout, manifest });
    const filename = artifactFilename(manifest.exportedAtUtc);
    const saved = await saveArtifact(bytes, filename);

    return {
        bytes: bytes.length,
        entries: declaration.files.length,
        journalEntries: readout.journal_entry.length,
        // How many bridge calls the archive travelled in (XPT-P1). A count, and
        // the one number that says the transfer actually happened in pieces
        // rather than in one parcel — which is the whole subject of that packet.
        chunks: saved.chunks,
    };
}
