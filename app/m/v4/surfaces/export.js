// Поверхность: модальное окно архива (#exportModal).
//
// TWO SENTENCES IN THIS SURFACE ARE NOT NEGOTIABLE and are asserted by
// app/tests/export-contour.spec.js: media is not in the archive, and there is no
// cloud backup of this data. They are shown BEFORE the parent presses anything,
// not after, and they are not softened, hedged or folded into a longer sentence.
// The failure this prevents is a parent believing they have a backup and finding
// out otherwise at the worst possible moment.
//
// THE SURFACE SHIPS TO BOTH CHANNELS AND BEHAVES DIFFERENTLY IN EACH, which is
// the P1/P2 pattern: identical bytes, runtime capability detection. On the web
// there is no native store and therefore no journal to project, so the action is
// not offered — and the modal says that plainly instead of hiding, because a
// missing button teaches a parent nothing about where their data actually is.
//
// No GA4 event is emitted here, deliberately. The surrounding surfaces call the
// shell's trackEvent(); this one does not, because the analytics egress question
// opened by LSC-DL-001 (o) is still open and an export is not the packet that
// should widen it. Since XPT-P1 it does emit one `export.run` signal per run —
// that is a line on the DEVICE CONSOLE and nothing else, with no network leg of
// any kind, which is precisely why it is not the same decision.

// Statically imported, not loaded on demand: the ship-list walker
// (app/tests/support/ship-list.js) models static imports only and fails closed
// on a dynamic one, because a module it cannot see is a module it cannot prove
// is shipped and precached. The store graph pays the same cost for the same
// reason (LSC-DL-002), and what it costs is a modulepreload hint the browser
// fetches without evaluating.
//
// Note for anyone editing this file: that guard is a TEXTUAL scan, so the two
// words must not appear adjacent in a comment either. It is a blunt rule with a
// good reason — a walker that parsed JavaScript properly would be a second
// toolchain in a deliberately buildless path.
import { emitSignal } from '../core/signals.js';
import { runExport } from '../export/run.js';
import { isExportSinkAvailable } from '../export/sink.js';

function el(id) {
    return document.getElementById(id);
}

function setStatus(message) {
    const status = el('exportStatus');
    status.textContent = message;
    status.hidden = !message;
}

export function openExportModal() {
    setStatus('');
    const button = el('exportRunBtn');
    const unavailable = el('exportUnavailable');
    const available = isExportSinkAvailable();

    button.hidden = !available;
    button.disabled = !available;
    unavailable.hidden = available;

    el('exportModal').classList.add('show');
}

function closeExportModal() {
    el('exportModal').classList.remove('show');
}

// THE SIGNAL IS EMITTED HERE AND NOT IN export/run.js (XPT-P1), for the reason
// import.js and skill-completion.js emit theirs at the surface: the three
// outcomes only exist here, where the cancelled case is told apart from the
// failed one. The payload is counts and timings — see core/signals.js, which
// refuses a free string structurally rather than by anyone remembering to.
async function runExportFromUi() {
    const button = el('exportRunBtn');
    button.disabled = true;
    setStatus('Собираю архив…');
    const startedAt = Date.now();
    try {
        const summary = await runExport();
        // Computed into a local first, never inline in the payload: an inline
        // call is where family text would get in unseen, and
        // app/tests/signal-payload.spec.js refuses one.
        const exportMs = Date.now() - startedAt;
        emitSignal('export.run', {
            outcome: 'complete',
            archive_bytes: summary.bytes,
            chunks: summary.chunks,
            export_ms: exportMs,
        });
        setStatus(`Архив сохранён. Записей в журнале: ${summary.journalEntries}.`);
    } catch (error) {
        const exportMs = Date.now() - startedAt;
        if (error?.name === 'ExportCancelledError') {
            emitSignal('export.run', { outcome: 'nothing_selected', export_ms: exportMs });
            // A closed picker is a decision, not a failure. Say nothing about it.
            setStatus('');
        } else {
            emitSignal('export.run', { outcome: 'failed', export_ms: exportMs });
            // eslint-disable-next-line no-console
            console.error('[export] the archive was not written:', error?.name, error?.message);
            setStatus('Архив не удалось сохранить. Данные на устройстве не изменились.');
        }
    } finally {
        button.disabled = false;
    }
}

export function wireExport() {
    el('exportBtn').addEventListener('click', openExportModal);
    el('exportModalClose').addEventListener('click', closeExportModal);
    el('exportCloseBtn').addEventListener('click', closeExportModal);
    el('exportRunBtn').addEventListener('click', runExportFromUi);
    el('exportModal').addEventListener('click', (e) => {
        if (e.target.id === 'exportModal') {
            closeExportModal();
        }
    });
}
