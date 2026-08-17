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
import {
    discardTransfer,
    drainTransfer,
    isTransferAvailable,
    openHandoff,
    pendingImport,
    pendingTransfer,
    pickTransfer,
    runImport,
    storeHandle,
} from '../store/boot.js';

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
        // DIA-P1: whichever source delivered them. `delivered` is set only on
        // the native channel, by a staged transfer; on the web it stays null and
        // this is the same call L1-P4 made.
        const summary = await runImport({
            profiles: delivered ?? legacyProfiles(),
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

// ГДЕ ЛЕЖИТ ИСТОРИЯ — И ПОЧЕМУ ЕЁ ЗДЕСЬ НЕТ (DIA-P1).
//
// До этого пакета источником были профили из localStorage этой же страницы. На
// нативном канале их там нет и не было НИКОГДА: WebView живёт на origin
// https://localhost, а история семьи — в браузере, на production-origin. Это
// другое хранилище, и `readProfilesRaw()` в приложении всегда возвращал null.
// Предложение переноса существовало и было мёртвым.
//
// Теперь источников два, и импортёр не знает об этом ничего: он как принимал
// параметр `profiles`, так и принимает (LSC-P4-INV-002, контракт не тронут).
//
//   web      — localStorage этой страницы, как и раньше;
//   native   — то, что застейджил плагин: ссылка из браузера или файл,
//              выбранный родителем.

/** Профили, которые дал натив, или null — если ничего не застейджено. */
let delivered = null;

function setFallbackLine(message) {
    const line = el('importFallback');
    if (!line) return;
    line.textContent = message;
    line.hidden = !message;
    const pick = el('importPickBtn');
    if (pick) pick.hidden = !message;
}

// Каждая локальная переменная здесь связана РОВНО с одним id, и это не стиль.
// app/tests/show-rule-coverage.spec.js разрешает call site `classList.add('show')`
// в элемент по этим привязкам и падает, если одно имя означает два элемента, —
// он отказывается угадывать (EMV-P1-INV-001). Имя `button` в этом файле уже
// занято под importRunBtn.
function showHandoffOffer(visible) {
    const handoffButton = el('importHandoffBtn');
    const offer = el('importHandoffOffer');
    if (handoffButton) handoffButton.hidden = !visible;
    if (offer) offer.hidden = !visible;
    const choices = el('importChoices');
    if (choices) choices.hidden = visible;
    const runButton = el('importRunBtn');
    if (runButton) runButton.hidden = visible;
}

/**
 * Показывает список профилей и кнопку «Перенести» для уже полученных данных.
 *
 * Общая для обоих источников: что бы ни принесло профили, дальше путь один и
 * тот же — тот, который L1-P4 уже написал и проверил.
 */
async function offerFor(profiles) {
    const handle = storeHandle();
    if (!handle) return false;
    if (profiles.length === 0) return false;

    let pending;
    try {
        pending = await pendingImport({
            profiles,
            authorParticipantId: handle.selfParticipantId,
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the pending check failed:', error?.name, error?.message);
        return false;
    }
    if (pending.profiles.length === 0) return false;

    setStatus('');
    setFallbackLine('');
    renderChoices(pending);
    showHandoffOffer(false);
    el('importModal').classList.add('show');
    return true;
}

/**
 * Забирает застейдженный перенос и показывает список профилей.
 *
 * ОДНА СТРОКА ОБЪЯСНЕНИЯ ВМЕСТО РАЗВИЛКИ. Любой отказ — обрезанная ссылка,
 * неизвестная версия формата, чужой ключ — приводит сюда: родителю говорят
 * одной строкой, что переносим файлом, и показывают ту же кнопку. Выбирать
 * между путями его не просят (ADR-048 §3).
 */
async function takeDelivered(staged, transport) {
    const startedAt = Date.now();
    try {
        const drained = await drainTransfer(staged);
        delivered = drained.profiles;
        const offered = await offerFor(delivered);
        // Every value hoisted into a local before it reaches the payload: the
        // payload guard refuses a call inside one outright, because an inline
        // call is where family text gets in unseen (LSC-P4-INV-003).
        const outcome = offered ? 'complete' : 'nothing_selected';
        const arrived = delivered.length;
        const took = Date.now() - startedAt;
        emitSignal('history.handoff', {
            outcome,
            transport,
            refusal: 'none',
            bytes: drained.bytes,
            chunks: drained.chunks,
            profiles: arrived,
            handoff_ms: took,
        });
        await discardTransfer(staged.transferId);
        if (!offered) {
            setStatus('Всё, что было в браузере, уже перенесено. Ничего нового не нашлось.');
            el('importModal').classList.add('show');
        }
        return offered;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the staged transfer was not usable:', error?.name, error?.message);
        // Закрытый код, не текст ошибки: подробности — в консоли устройства и в
        // логе плагина, а в сигнал попадает только то, что считается.
        const refusal = safeRefusal(error?.reason, 'format_version');
        const took = Date.now() - startedAt;
        emitSignal('history.handoff', {
            outcome: 'refused',
            transport,
            refusal,
            handoff_ms: took,
        });
        offerFileFallback();
        return false;
    }
}

// Ровно те коды, которые объявлены в core/signals.js. Проверка здесь, а не
// доверие: код приходит с ТОЙ стороны моста, а незадекларированное значение
// сигнал отверг бы молча — и событие исчезло бы вместе с ним.
const SAFE_REFUSALS = [
    'none',
    'no_handler',
    'foreign_key',
    'options_ceiling',
    'size_mismatch',
    'checksum_mismatch',
    'format_version',
    'cancelled',
    'handoff_unconfigured',
];

/** Приводит код с той стороны моста к объявленному, или к запасному. */
function safeRefusal(code, fallback) {
    return SAFE_REFUSALS.includes(code) ? code : fallback;
}

function offerFileFallback() {
    showHandoffOffer(true);
    setFallbackLine(
        'Перенести по ссылке не получилось. В браузере на странице переноса сохраните файл,'
            + ' а потом выберите его здесь.'
    );
    el('importModal').classList.add('show');
}

/** «Перенести данные из браузера?» — одна кнопка, дальше браузер. */
async function startHandoff() {
    const startedAt = Date.now();
    try {
        await openHandoff();
        const took = Date.now() - startedAt;
        emitSignal('history.handoff', {
            outcome: 'handed_off',
            transport: 'link',
            refusal: 'none',
            handoff_ms: took,
        });
        setStatus('Открыл браузер. Вернитесь сюда, когда нажмёте кнопку на странице переноса.');
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the handoff did not open:', error?.name, error?.message);
        const refusal = safeRefusal(error?.code, 'no_handler');
        const took = Date.now() - startedAt;
        emitSignal('history.handoff', {
            outcome: 'refused',
            transport: 'link',
            refusal,
            handoff_ms: took,
        });
        offerFileFallback();
    }
}

/** Запасной путь A: родитель выбирает сохранённый файл. */
async function pickTransferFile() {
    let staged;
    try {
        staged = await pickTransfer();
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[import] the document picker failed:', error?.name, error?.message);
        setFallbackLine('Файл не удалось прочитать. Попробуйте выбрать его ещё раз.');
        return;
    }
    if (!staged.present) {
        if (staged.refusal !== 'cancelled') {
            setFallbackLine('Этот файл не подошёл. Он должен быть тем, что сохранила страница переноса.');
        }
        return;
    }
    await takeDelivered(staged, 'file');
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

    // Web: источник там же, где был.
    if (!isTransferAvailable()) {
        await offerFor(legacyProfiles());
        return;
    }

    // Native: что-нибудь застейджено?
    const staged = await pendingTransfer();
    if (staged.present) {
        await takeDelivered(staged, 'link');
        return;
    }
    if (staged.refusal !== 'none') {
        // Отказ уже случился — плагин объяснил его в логе устройства, а
        // родителю нужна одна строка и та же кнопка.
        const refusal = safeRefusal(staged.refusal, 'format_version');
        emitSignal('history.handoff', {
            outcome: 'refused',
            transport: 'link',
            refusal,
        });
        offerFileFallback();
        return;
    }

    // Ничего не пришло: предлагаем начать перенос. Предложение не зависит от
    // того, есть ли что-то в localStorage ЭТОГО origin — там ничего и не будет.
    if (delivered) return;
    showHandoffOffer(true);
    setStatus('');
    setFallbackLine('');
    el('importModal').classList.add('show');
}

export function wireImport() {
    const modal = el('importModal');
    if (!modal) return;
    el('importModalClose').addEventListener('click', closeImportModal);
    el('importCloseBtn').addEventListener('click', closeImportModal);
    el('importRunBtn').addEventListener('click', runImportFromUi);
    const handoffBtn = el('importHandoffBtn');
    if (handoffBtn) handoffBtn.addEventListener('click', startHandoff);
    const pickBtn = el('importPickBtn');
    if (pickBtn) pickBtn.addEventListener('click', pickTransferFile);
    modal.addEventListener('click', (e) => {
        if (e.target.id === 'importModal') closeImportModal();
    });

    // ВОЗВРАТ ИЗ БРАУЗЕРА. Родитель уходит на страницу переноса и приходит
    // обратно — активность не пересоздаётся (launchMode=singleTask), поэтому
    // никакого «запуска» здесь не происходит и опрашивать надо по видимости.
    //
    // Обычное событие DOM, а не плагин @capacitor/app: добавлять зависимость в
    // поставляемую поверхность — это акт цепочки поставок (см. довод
    // ALLOWED_PLUGIN_METHODS), и ради одного события он не оправдан.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!isTransferAvailable()) return;
        offerImportIfPending();
    });
}
