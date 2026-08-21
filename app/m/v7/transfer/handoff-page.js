// Страница передачи истории из браузера в приложение (DIA-P1, /transfer.html).
//
// ЭТОТ МОДУЛЬ ЧИТАЕТ И НИКОГДА НЕ ПИШЕТ. Это не соглашение и не аккуратность —
// это единственное свойство, ради которого написана половина проверок пакета.
//
// WHY, IN ENGLISH, BECAUSE THE NEXT PERSON TO EDIT THIS FILE MUST NOT MISS IT.
// The browser's localStorage under the production origin holds the ONLY copy of
// this family's history. Not the newest copy — the only one. There is no backup,
// no cloud, no second device: the app's own store is empty until this transfer
// succeeds, which is the entire reason this page exists. So this module:
//
//   * imports EXACTLY ONE binding from core/storage.js — `readProfilesRaw` —
//     and no writer. That is structural, not disciplinary: a module that never
//     imports a writer cannot become one by a later edit to its body. It is the
//     same form LSC-P4-INV-002 property (3) already holds over the importer;
//   * touches Web Storage nowhere else, which app/tests/handoff-source.spec.js
//     asserts over this whole module graph (band-invariant leg (a));
//   * is exercised by app/tests/handoff-transfer.spec.js, which seeds a real
//     source in a real browser, PRESSES THE BUTTON, and compares the whole of
//     localStorage before and after (band-invariant leg (b)).
//
// Leg (a) alone would not count. It proves a property of a file, not a
// behaviour (AGENTS.md §11), and this is a behaviour worth executing.
//
// CLEARING THE BROWSER IS A SEPARATE, EXPLICIT OWNER ACTION AND IS NOT HERE, NOR
// ANYWHERE IN THIS MILESTONE. After a confirmed transfer the parent decides;
// no packet performs it.
//
// ------------------------------------------------------------------------
// ДВА ПУТИ, И РОДИТЕЛЬ ВЫБИРАЕТ МЕЖДУ НИМИ РОВНО НОЛЬ РАЗ.
//
//   Ссылка. Обычный путь: одна кнопка, Android открывает приложение, перенос
//   продолжается там.
//
//   Файл. Запасной путь, включается САМ в двух случаях: ссылку некому открыть
//   (Chrome возвращает нас сюда с флагом browser_fallback_url) или история
//   длиннее потолка TRANSFER_CONFIG.linkMaxBytes. Решение принимается ДО того,
//   как ссылка построена, а не «попробуем и посмотрим» — ADR-048 §3 и та же
//   форма, что у XPT-P1: отказ раньше, чем построен intent.
//
// В обоих случаях родитель видит одну и ту же кнопку и одну строку объяснения.
// Развилки ему не показывают.
// ------------------------------------------------------------------------

import { readProfilesRaw } from '../core/storage.js';
import { TRANSFER_CONFIG } from './config.js';
import { TransferFormatError } from './errors.js';
import { buildEnvelope, digestHex, encodePayload, envelopeBytes } from './format.js';

function el(id) {
    return document.getElementById(id);
}

function setStatus(message) {
    const status = el('handoffStatus');
    status.textContent = message;
    status.hidden = !message;
}

function setInstruction(message) {
    const line = el('handoffInstruction');
    line.textContent = message;
    line.hidden = !message;
}

/**
 * Профили из браузерного хранилища, или пустой список.
 *
 * Разбор в try по образцу surfaces/import.js: испорченный JSON — не повод
 * уронить страницу, а повод не обещать перенос. Обещание, которое некому
 * выполнить, — это ADR-015 ровно наоборот.
 */
function legacyProfiles() {
    const raw = readProfilesRaw();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[handoff] the legacy profiles could not be read:', error?.name);
        return [];
    }
}

/**
 * Полный intent-URI для передачи, или null, если он вышел за потолок.
 *
 * NULL IS A DECISION, NOT A FAILURE. Returning it is how the ceiling is enforced
 * BEFORE the link exists: the caller emits the file instead. Nothing here ever
 * builds an over-long URI and hands it to the browser to find out.
 */
function buildTransferLink({ payload, bytes, digest }) {
    if (payload.length > TRANSFER_CONFIG.linkMaxBytes) return null;

    const { linkScheme, linkHost, linkPackage, linkParams } = TRANSFER_CONFIG;
    const query = new URLSearchParams();
    query.set(linkParams.payload, payload);
    query.set(linkParams.bytes, String(bytes));
    query.set(linkParams.digest, digest);
    query.set(linkParams.version, String(1));

    // browser_fallback_url is the no-handler DETECTOR: with no app registered
    // for this scheme, Chrome navigates here instead of failing, and the flag
    // puts this page into file mode on arrival. That is what makes the fallback
    // automatic rather than something the parent has to notice.
    const fallback = new URL(window.location.href);
    fallback.search = `?${TRANSFER_CONFIG.fallbackFlag}=1`;
    fallback.hash = '';

    // The `package=` component is what keeps this deliverable to THIS app and to
    // nothing else — see TRANSFER_CONFIG.linkPackage for why that is a privacy
    // mechanism rather than plumbing.
    return (
        `intent://${linkHost}/?${query.toString()}`
        + `#Intent;scheme=${linkScheme};package=${linkPackage}`
        + `;S.browser_fallback_url=${encodeURIComponent(fallback.href)};end`
    );
}

/**
 * Отдаёт историю файлом — запасной путь A.
 *
 * Файл ТРАНЗИТНЫЙ: единственный его читатель — импортёр на той стороне. Это не
 * архив (тот собирается в приложении, из данных на устройстве, и живёт годами);
 * см. заголовок ./config.js. Смешивать их нельзя.
 */
function emitFile(envelope) {
    const blob = new Blob([envelope], { type: TRANSFER_CONFIG.fallbackMimeType });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = TRANSFER_CONFIG.fallbackFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoked on the next turn: revoking synchronously races the download the
    // click just started in some engines, and an object URL that outlives the
    // page would keep the family's history alive in this tab's memory.
    setTimeout(() => URL.revokeObjectURL(href), 0);
}

/** Режим страницы: ссылка (обычный) или файл (запасной). */
function fallbackRequested() {
    return new URLSearchParams(window.location.search).has(TRANSFER_CONFIG.fallbackFlag);
}

/**
 * Всё, что нужно решить ДО того, как что-то произойдёт.
 *
 * SEPARATED FROM THE ACTING HALF ON PURPOSE, and the purpose is testability of
 * the real thing rather than tidiness. Navigating to an `intent://` URL cannot
 * be observed in a desktop browser — the scheme has no handler there — so a test
 * that wanted to assert what the link CARRIES would otherwise have to rebuild it
 * out of the same primitives and end up proving itself. Exporting the decision
 * lets app/tests/handoff-transfer.spec.js call the function the button calls, on
 * the real page, against the real browser storage. What stays unexecuted
 * off-device is one assignment to location.href, and the spec says so rather
 * than implying otherwise.
 *
 * (That sentence originally ended on the storage identifier, and the full stop
 * after it matched the property-access form app/tests/storage-seam.spec.js
 * scans for. That guard does not strip comments, on purpose, because stripping
 * them is how it would fail open — see its header. Prose in a shipped module
 * therefore names Web Storage without punctuating it into an access, and this
 * paragraph deliberately does not quote the shape it is about either.)
 *
 * Returns `{ mode: 'empty' | 'link' | 'file', ... }`. The mode is decided here,
 * before the link exists — ADR-048 §3, and the XPT-P1 shape of refusing before
 * the intent is built rather than trying and seeing.
 */
export async function prepareHandoff() {
    const profiles = legacyProfiles();
    if (profiles.length === 0) return { mode: 'empty' };

    const envelope = buildEnvelope(profiles);
    const bytes = envelopeBytes(envelope);
    const payload = encodePayload(bytes);
    const digest = await digestHex(bytes);

    const link = fallbackRequested()
        ? null
        : buildTransferLink({ payload, bytes: bytes.length, digest });

    return {
        mode: link === null ? 'file' : 'link',
        envelope,
        payload,
        digest,
        bytes: bytes.length,
        link,
    };
}

async function handoff() {
    const button = el('handoffBtn');
    button.disabled = true;
    try {
        const prepared = await prepareHandoff();

        if (prepared.mode === 'empty') {
            // Обратите внимание на формулировку: пусто ИМЕННО ЗДЕСЬ, в этом
            // браузере. Это утверждение об источнике, а не о ребёнке и не о том,
            // что переносить нечего вообще.
            setStatus(
                'В этом браузере не сохранено ни одного профиля.'
                    + ' Возможно, история осталась в другом браузере или на другом устройстве.'
            );
            return;
        }

        if (prepared.mode === 'file') {
            emitFile(prepared.envelope);
            setStatus(
                'Файл с историей сохранён в загрузки.'
                    + ' Откройте приложение и выберите его — перенос продолжится там.'
            );
            return;
        }

        setStatus('Открываю приложение…');
        window.location.href = prepared.link;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[handoff] the transfer could not be prepared:', error?.name, error?.message);
        const known = error instanceof TransferFormatError;
        setStatus(
            known
                ? 'История в этом браузере записана в неожиданном виде, и перенести её не удалось.'
                : 'Подготовить перенос не удалось. В браузере всё осталось на месте.'
        );
    } finally {
        button.disabled = false;
    }
}

export function wireHandoff() {
    const button = el('handoffBtn');
    if (!button) return;
    button.addEventListener('click', handoff);

    if (fallbackRequested()) {
        // ОДНА СТРОКА ОБЪЯСНЕНИЯ И ТА ЖЕ КНОПКА — развилки нет. Сюда браузер
        // возвращает нас сам, когда открыть ссылку оказалось некому.
        setInstruction(
            'Приложение не открылось по ссылке. Нажмите кнопку — история сохранится файлом,'
                + ' а в приложении его нужно будет выбрать.'
        );
        button.textContent = 'Сохранить файл с историей';
    }
}

wireHandoff();
