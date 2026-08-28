// Поверхность: модальное окно архива (#exportModal).
//
// TWO SENTENCES IN THIS SURFACE ARE NOT NEGOTIABLE and are asserted by
// app/tests/export-contour.spec.js: media is not in the archive, and there is no
// cloud backup of this data. They are shown BEFORE the parent presses anything,
// not after, and they are not softened, hedged or folded into a longer sentence.
// The failure this prevents is a parent believing they have a backup and finding
// out otherwise at the worst possible moment.
//
// THIS SURFACE IS REACHED ON THE NATIVE CHANNEL ONLY, SINCE DIA-P2, and the
// position it replaces is worth stating because it was argued the other way for
// two milestones. It used to ship to both channels and explain itself on the
// web: the run button hidden, and a paragraph saying the archive is built from
// the app's data on the phone. That paragraph is gone with the branch, because
// the control that opened this modal is now revealed only where an archive can
// actually be produced (surfaces/channel.js) — offering an action a channel
// cannot perform is the defect PDR-034 §1 named, and an explanation inside a
// window nobody can open is not an explanation.
//
// WHAT THE WEB CHANNEL SAYS INSTEAD, so this is not read as the fact being
// dropped: #webChannelNote, above the table, states that the browser copy is the
// only copy and has no backup. It is on screen without opening anything, which
// is a better place for it than here ever was.
//
// The modal still ships to both channels byte-identically (LSC-P1-INV-002).
//
// No analytics event is emitted here, and since UIP-P1 none is emitted anywhere:
// the question LSC-DL-001 (o) opened was closed by removal rather than by
// consent, and the shell carries no trackEvent() for a surface to call. Since
// XPT-P1 this one does emit one `export.run` signal per run —
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
    hideExportDone();
    el('exportModal').classList.add('show');
}

function closeExportModal() {
    el('exportModal').classList.remove('show');
}

// THE CONFIRMATION LIVES OUTSIDE THE DIALOG, AND THAT IS THE WHOLE POINT
// (DIA-P2). Two findings from the owner smoke on 2026-08-16 are one defect: the
// dialog stayed open after a successful save, and the parent got no
// confirmation they registered. The success line was being written into
// #exportStatus — inside the window the parent expects to disappear, and behind
// the file picker they had just come back from. A confirmation that lives in a
// surface which is about to close is a confirmation nobody is sure they got.
//
// So the dialog closes on success and the confirmation stands on its own, in the
// shell's banner language, until it is dismissed. NO TIMER: an auto-dismissing
// banner is a message a parent can miss entirely and an assertion that flakes.
//
// The count is the journal's, not the archive's, and it is the one number that
// answers "did it take everything" — the same number the surface has shown since
// L1-P3.
function showExportDone(journalEntries) {
    el('exportDoneText').textContent =
        `Архив сохранён. Записей в журнале: ${journalEntries}.`;
    el('exportDoneBanner').classList.add('show');
}

function hideExportDone() {
    el('exportDoneBanner').classList.remove('show');
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
        // Order matters and is deliberate: the confirmation is raised BEFORE the
        // dialog is closed, so there is no frame in which the parent has neither.
        showExportDone(summary.journalEntries);
        closeExportModal();
    } catch (error) {
        const exportMs = Date.now() - startedAt;
        if (error?.name === 'ExportCancelledError') {
            emitSignal('export.run', { outcome: 'nothing_selected', export_ms: exportMs });
            // A closed picker is a decision, not a failure. Say nothing about it.
            setStatus('');
        } else {
            // A FAILURE KEEPS THE DIALOG. It is not moved out to the banner with
            // the success: a message that says the archive was not written
            // belongs where the parent pressed the button, and closing the
            // window under a failure would read as the failure being handled.
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
    el('exportDoneDismiss').addEventListener('click', hideExportDone);
    el('exportModal').addEventListener('click', (e) => {
        if (e.target.id === 'exportModal') {
            closeExportModal();
        }
    });
}
