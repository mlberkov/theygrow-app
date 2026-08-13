// Поверхность: перенос истории из браузера (#importModal, L1-P4).
//
// ЧТО ЗДЕСЬ НЕ ОБСУЖДАЕТСЯ. Этот модуль ЧИТАЕТ localStorage и никогда в него не
// пишет. Он не импортирует ни одной функции записи из core/storage.js — не «не
// вызывает», а именно не импортирует, — и app/tests/import-legacy.spec.js
// проверяет это по исходнику. Очистка источника после переноса — отдельное
// явное действие владельца, и его в этом пакете нет: живой PWA держит
// единственную копию истории этой семьи.
//
// СОГЛАСИЕ — ПОШТУЧНОЕ. Модалка перечисляет профили по имени с числом отметок и
// галочкой, все отмечены по умолчанию. Причина в необратимости: журнал —
// append-only, и строку ребёнка из него уже не убрать, а вот НЕ перенесённый
// профиль можно перенести позже. Из двух вариантов выбран тот, который
// оставляет открытым обратимый путь.
//
// РАСХОЖДЕНИЕ КАНАЛОВ НАЗВАНО ДО НАЖАТИЯ, а не после, — по образцу модалки
// архива, где важное предложение стоит перед кнопкой. После переноса браузерная
// версия продолжает писать в своё хранилище, и отметка, поставленная там, здесь
// не появится, пока перенос не будет запущен снова. Родитель не должен
// обнаружить это сам, спустя месяц и без объяснения.

import { readProfilesRaw } from '../core/storage.js';
import { reloadHistory } from '../core/state.js';
import { emitSignal } from '../core/signals.js';
import { pendingImport, runImport, storeHandle } from '../store/boot.js';

function el(id) {
    return document.getElementById(id);
}

/**
 * Профили из браузерного хранилища, или пустой список.
 *
 * Разбор в try: испорченный JSON здесь — это не повод уронить приложение, а
 * повод не предлагать перенос. Предложить перенос того, что не читается, было бы
 * обещанием, которое некому выполнить (ADR-015).
 */
function legacyProfiles() {
    const raw = readProfilesRaw();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the legacy profiles could not be read:', error?.name);
        return [];
    }
}

function setStatus(message) {
    const status = el('importStatus');
    status.textContent = message;
    status.hidden = !message;
}

function renderChoices(pending) {
    const list = el('importChoices');
    list.textContent = '';
    for (const profile of pending.profiles) {
        const row = document.createElement('label');
        row.className = 'import-choice';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.dataset.profileId = profile.id;

        const text = document.createElement('span');
        const marks = profile.marks === 0 ? 'без отметок' : `отметок: ${profile.marks}`;
        text.textContent = `${profile.name} — ${marks}`;

        row.appendChild(box);
        row.appendChild(text);
        list.appendChild(row);
    }
}

function selectedIds() {
    return Array.from(el('importChoices').querySelectorAll('input[type="checkbox"]'))
        .filter((box) => box.checked)
        .map((box) => box.dataset.profileId);
}

async function runImportFromUi() {
    const button = el('importRunBtn');
    const handle = storeHandle();
    if (!handle) return;

    button.disabled = true;
    setStatus('Переношу…');
    const startedAt = Date.now();
    try {
        const summary = await runImport({
            profiles: legacyProfiles(),
            selectedProfileIds: selectedIds(),
            authorParticipantId: handle.selfParticipantId,
        });
        await reloadHistory();
        const importMs = Date.now() - startedAt;
        emitSignal('history.import', {
            outcome: 'complete',
            children: summary.children,
            attributes: summary.attributes,
            assertions: summary.assertions,
            confirmations: summary.confirmations,
            skipped: summary.skipped,
            import_ms: importMs,
        });
        setStatus(
            `Перенесено: детей ${summary.children}, отметок ${summary.assertions}.`
                + ' Данные в браузере остались на месте.'
        );
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the import did not finish:', error?.name, error?.message);
        const importMs = Date.now() - startedAt;
        emitSignal('history.import', { outcome: 'interrupted', import_ms: importMs });
        // Честно: часть могла записаться, и именно поэтому повторный запуск
        // безопасен — он допишет остаток, а не задвоит перенесённое.
        setStatus(
            'Перенос прервался. Ничего не потеряно: в браузере всё на месте,'
                + ' а повторный запуск допишет остаток, не повторяя перенесённое.'
        );
    } finally {
        button.disabled = false;
    }
}

function closeImportModal() {
    el('importModal').classList.remove('show');
}

/**
 * Предлагает перенос, если что-то ещё не перенесено.
 *
 * Условие — именно «осталось непере­несённое», а не «переносили ли мы вообще»:
 * поэтому предложение возвращается и после прерванного переноса, и после того,
 * как родитель поставил новые отметки в браузере.
 */
export async function offerImportIfPending() {
    const handle = storeHandle();
    if (!handle) return;
    const profiles = legacyProfiles();
    if (profiles.length === 0) return;

    let pending;
    try {
        pending = await pendingImport({
            profiles,
            authorParticipantId: handle.selfParticipantId,
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the pending check failed:', error?.name, error?.message);
        return;
    }
    if (pending.profiles.length === 0) return;

    setStatus('');
    renderChoices(pending);
    el('importModal').classList.add('show');
}

export function wireImport() {
    const modal = el('importModal');
    if (!modal) return;
    el('importModalClose').addEventListener('click', closeImportModal);
    el('importCloseBtn').addEventListener('click', closeImportModal);
    el('importRunBtn').addEventListener('click', runImportFromUi);
    modal.addEventListener('click', (e) => {
        if (e.target.id === 'importModal') closeImportModal();
    });
}
