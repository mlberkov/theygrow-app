// Поверхность: дневник (#diaryModal) — DIA-P3.
//
// ЗДЕСЬ РОДИТЕЛЬ ВПЕРВЫЕ ПИШЕТ В ПРИЛОЖЕНИЕ. До этого пакета продукт умел
// принимать только галочки: отметка — приписанное утверждение о ребёнке
// (PDR-025 §2), она уходит в неизменяемый журнал, и «снять» её значит написать
// поверх новое утверждение. Запись дневника — не утверждение о навыке, а
// собственный текст родителя, и правится она ПЕРЕЗАПИСЬЮ (PDR-026 §4, правило
// 1). Это разные объекты с разной семантикой правки, и путать их дорого: тот,
// кто «починит» перезапись в добавление, оставит семью с дневником, который
// нельзя исправить.
//
// ЧТО ЭТО ОКНО НЕ ДЕЛАЕТ. Не удаляет записи. Удаление стирает цитаты,
// скопированные из записи, и оставляет отметки с деградированным основанием
// (ADR-015) — поведение в схеме уже есть и уже проверено
// (app/tests/schema/test_store_append_only.py), но предупреждение, на которое
// родитель может опереться, требует отметок с цитатами, а они появляются на L5.
// Не спрашивает про чувствительность записи: слот есть, поверхности для него
// нет, и записать «не чувствительно» значило бы объявить за родителя то, о чём
// его не спросили.
//
// ПОИСК (DIA-P4) ЖИВЁТ В ТОМ ЖЕ ОКНЕ И В ТОМ ЖЕ СПИСКЕ. Не вторая поверхность:
// это тот же дневник, только показанный не весь. Отсюда и три РАЗНЫЕ пустые
// строки, которые нельзя схлопывать в одну, потому что родитель делает после
// каждой разное: записей нет вовсе (#diaryEmpty), записи есть, но по этим словам
// ничего не нашлось (#diarySearchEmpty), и поиск не выполнился (#diarySearchStatus).
// Последнее — утверждение о нас, а не о дневнике; см. SEARCH_REFUSAL ниже.
//
// ВРЕМЯ СОБЫТИЯ И ВРЕМЯ ЗАПИСИ — РАЗНЫЕ. Форма спрашивает ДЕНЬ, о котором
// запись, и по умолчанию это сегодня; момент написания store/records.js берёт
// сам. Родитель пишет вечером про утро, и обе даты остаются в строке (PDR-026
// §4, поправка, пункт 2).
//
// Импорт статический — по доводу surfaces/export.js: ходок по графу поставки
// моделирует только статические импорты и падает на всём остальном.

import { emitSignal } from '../core/signals.js';
import { BACKEND, getCurrentProfile, historyBackend, selfParticipant } from '../core/state.js';
import {
    createRecord,
    loadRecords,
    overwriteRecord,
    searchRecords,
    storeFailureCode,
} from '../store/boot.js';

// Каждая локальная переменная связана РОВНО с одним id — то же правило, что в
// surfaces/import.js: угадывать, какой элемент имеет в виду имя, тесты
// отказываются (EMV-P1-INV-001, app/tests/show-rule-coverage.spec.js).
function el(id) {
    return document.getElementById(id);
}

// Запись, которую сейчас правят, или null — тогда «Сохранить» создаёт новую.
let editingRecordId = null;

/** Сегодняшний календарный день — тот же вид, что у store/records.js. */
function today(now) {
    const at = new Date(now);
    const year = at.getFullYear();
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const day = String(at.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function setStatus(message) {
    const status = el('diaryStatus');
    status.textContent = message;
    status.hidden = !message;
}

// ТЕКСТ СЕМЬИ СТАВИТСЯ ТОЛЬКО ЧЕРЕЗ textContent. Ни здесь, ни ниже нет
// innerHTML: то, что родитель написал про своего ребёнка, не должно проходить
// через разбор разметки ни одного раза — не из-за внешнего злоумышленника,
// которого у локального дневника нет, а потому что апостроф или «<» в тексте
// про ребёнка не повод потерять запись.
function entryItem(row) {
    const item = document.createElement('li');
    item.className = 'diary-entry';
    item.dataset.recordId = row.id;

    const when = document.createElement('div');
    when.className = 'diary-entry-date';
    when.textContent = row.event_date_local;

    const body = document.createElement('div');
    body.className = 'diary-entry-body';
    body.textContent = row.body;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'diary-entry-edit';
    edit.dataset.recordId = row.id;
    edit.textContent = 'Изменить';

    item.append(when, body, edit);
    return item;
}

// ПОЧЕМУ ПИСАТЬ НЕКУДА — ДВЕ РАЗНЫЕ ПРИЧИНЫ, И ОНИ НЕ СХЛОПЫВАЮТСЯ В ОДНУ.
// «Хранилище не открылось» лечится перезапуском приложения, «профиля нет» —
// созданием профиля, и сказать второе вместо первого значит отправить родителя
// делать то, что не поможет. Одна функция на обе поверхности — список и
// сохранение, — чтобы окно и его форма не могли назвать разные причины.
const NO_SUBJECT = 'subject';
const NO_STORE = 'store';

function whyNotWritable() {
    if (historyBackend() !== BACKEND.journal) return NO_STORE;
    if (!selfParticipant() || !getCurrentProfile()) return NO_SUBJECT;
    return null;
}

/** Кто пишет и о ком — или null, если писать сейчас некуда. */
function author() {
    if (whyNotWritable()) return null;
    return {
        authorParticipantId: selfParticipant(),
        subjectChildId: getCurrentProfile().id,
    };
}

async function renderList() {
    const list = el('diaryList');
    const empty = el('diaryEmpty');
    const noChild = el('diaryNoChild');
    const noStore = el('diaryNoStore');
    const newButton = el('diaryNewBtn');
    const searchForm = el('diarySearchForm');
    list.replaceChildren();

    // Обе поисковые строки гасятся здесь, и это единственное место, где они
    // гаснут: список без поиска не может показывать ни «не нашлось», ни «поиск
    // не выполнен» — оба относятся к запросу, которого сейчас нет.
    el('diarySearchEmpty').hidden = true;
    el('diarySearchStatus').hidden = true;
    el('diarySearchClearBtn').hidden = true;

    // ЧЕСТНАЯ ДЕГРАДАЦИЯ (ADR-015): кнопка «Новая запись» НЕ предлагается, когда
    // писать некуда. Предложить форму, которая заведомо откажет на сохранении,
    // значит заставить родителя написать текст про своего ребёнка и потерять
    // его — а это ровно то, чего ADR-046 §1 велит не допускать.
    const blocked = whyNotWritable();
    noStore.hidden = blocked !== NO_STORE;
    noChild.hidden = blocked !== NO_SUBJECT;
    newButton.hidden = blocked !== null;
    if (blocked) {
        empty.hidden = true;
        searchForm.hidden = true;
        emitSignal('write.refused', {
            reason: blocked === NO_STORE ? 'store_unavailable' : 'no_subject',
        });
        return;
    }

    const rows = await loadRecords(author());
    for (const row of rows) {
        list.append(entryItem(row));
    }
    empty.hidden = rows.length > 0;
    // Искать предлагается, только когда есть что искать. В пустом дневнике поиск
    // мог бы вернуть только «ничего не нашлось» — строку, которая прочиталась бы
    // как поломка, хотя всё в порядке и записей просто нет.
    searchForm.hidden = rows.length === 0;
}

// ЧТО РОДИТЕЛЬ ЧИТАЕТ, КОГДА ПОИСК НЕ ВЫПОЛНИЛСЯ — и почему это отдельный
// набор строк, а не «ничего не нашлось».
//
// «Ничего не нашлось» — утверждение о ДНЕВНИКЕ: такой записи нет. Отказ
// хранилища — утверждение о НАС: мы не смогли посмотреть. Сказать первое вместо
// второго значит сообщить родителю, что он чего-то не писал, хотя он писал, — и
// это ровно тот класс тихой лжи, ради которого существует ADR-046 §1. Поэтому
// каждая строка ниже говорит две вещи: поиск НЕ выполнен, и записи на месте.
const SEARCH_REFUSAL = Object.freeze({
    disk_full:
        'Поиск не выполнен: на устройстве закончилось место. Записи на месте —'
        + ' освободите место и попробуйте ещё раз.',
    unavailable:
        'Поиск не выполнен: хранилище сейчас недоступно. Записи на месте — закройте'
        + ' и откройте приложение, потом попробуйте ещё раз.',
    corrupt:
        'Поиск не выполнен: хранилище не отвечает как обычно. Записи, которые вы уже'
        + ' написали, никуда не делись — закройте и откройте приложение.',
    other: 'Поиск не выполнен. Записи на месте — попробуйте ещё раз.',
});

/** Снимает фильтр и показывает весь дневник заново. */
async function clearSearch() {
    el('diarySearchInput').value = '';
    await renderList();
}

/**
 * Ищет по дневнику и показывает результат в том же списке.
 *
 * ЧТО ЗДЕСЬ НЕ ПРОИСХОДИТ, И ЭТО ГЛАВНОЕ (DIA-P4-INV-002). То, что родитель
 * набрал, — самая опознаваемая строка, какую это приложение когда-либо держало:
 * это его собственные слова про своего ребёнка. Она уходит РОВНО в два места —
 * в связанный параметр запроса (store/records.js строит из неё выражение MATCH)
 * и в поле ввода, где родитель её и оставил. В сигнал не уходит ни она, ни её
 * длина, ни её кусок; в консоль — только имя класса ошибки, без сообщения
 * движка. Считанные величины кладутся в локальные переменные ДО полезной
 * нагрузки: вызов внутри неё — место, где семейный текст проходит незамеченным,
 * и app/tests/signal-payload.spec.js такой вызов отказывается пропускать.
 */
async function runSearch(event) {
    event.preventDefault();
    const searchButton = el('diarySearchBtn');
    const list = el('diaryList');
    const searchStatus = el('diarySearchStatus');
    const searchEmpty = el('diarySearchEmpty');
    const typed = el('diarySearchInput').value;

    searchStatus.hidden = true;
    searchEmpty.hidden = true;

    // Форма предлагается только там, где список уже отрисовался, так что сюда с
    // закрытым хранилищем почти не попасть. «Почти» — не «никогда»: хранилище
    // может закрыться между отрисовкой и нажатием, и тогда это надо сказать.
    const blocked = whyNotWritable();
    if (blocked) {
        emitSignal('write.refused', {
            reason: blocked === NO_STORE ? 'store_unavailable' : 'no_subject',
        });
        searchStatus.textContent = SEARCH_REFUSAL.unavailable;
        searchStatus.hidden = false;
        return;
    }

    const who = author();
    searchButton.disabled = true;
    const startedAt = Date.now();
    try {
        const found = await searchRecords({ ...who, typed });
        const searchMs = Date.now() - startedAt;
        const resultCount = found.rows.length;
        const tokenCount = found.tokens;
        const wasRebuilt = found.rebuilt;
        const searchOutcome = found.searched ? 'complete' : 'refused';
        emitSignal('diary.search', {
            outcome: searchOutcome,
            failure_class: 'none',
            tokens: tokenCount,
            results: resultCount,
            search_ms: searchMs,
            rebuilt: wasRebuilt,
        });

        // Пустой запрос — это не поиск, а просьба показать всё. Ровно так он и
        // читается: отдельного отказа тут не нужно, нужен весь дневник.
        if (!found.searched) {
            await clearSearch();
            return;
        }

        list.replaceChildren();
        for (const row of found.rows) {
            list.append(entryItem(row));
        }
        el('diaryEmpty').hidden = true;
        el('diarySearchClearBtn').hidden = false;
        searchEmpty.hidden = resultCount > 0;
    } catch (error) {
        const searchMs = Date.now() - startedAt;
        const failureClass = storeFailureCode(error);
        emitSignal('diary.search', {
            outcome: 'failed',
            failure_class: failureClass,
            search_ms: searchMs,
        });
        // ТОЛЬКО ИМЯ КЛАССА, И ЭТО ОТЛИЧАЕТСЯ ОТ ПУТИ ЗАПИСИ НАМЕРЕННО. Там в
        // консоль идёт и сообщение движка: текст записи там — связанное
        // значение, и движок его не повторяет. Здесь повторить было бы что: из
        // набранного строится выражение MATCH, и сообщение об ошибке разбора
        // такого выражения содержало бы его целиком. Класса достаточно, чтобы
        // понять, что случилось, во время прогона по RUNBOOK.
        // eslint-disable-next-line no-console
        console.error('[diary] the search did not run:', error?.name, failureClass);
        searchStatus.textContent = SEARCH_REFUSAL[failureClass] ?? SEARCH_REFUSAL.other;
        searchStatus.hidden = false;
    } finally {
        searchButton.disabled = false;
    }
}

function showList() {
    el('diaryForm').hidden = true;
    el('diaryListPane').hidden = false;
}

function showForm({ recordId = null, body = '', eventDate = null, now = Date.now() } = {}) {
    editingRecordId = recordId;
    setStatus('');
    el('diaryEventDate').value = eventDate ?? today(now);
    el('diaryBody').value = body;
    el('diaryListPane').hidden = true;
    el('diaryForm').hidden = false;
    el('diaryBody').focus();
}

export async function openDiaryModal() {
    showList();
    el('diaryModal').classList.add('show');
    // clearSearch, а не renderList: окно открывается на всём дневнике, а не на
    // фильтре, который родитель набрал в прошлый раз и уже не видит.
    await clearSearch();
}

function closeDiaryModal() {
    el('diaryModal').classList.remove('show');
}

// ЧТО РОДИТЕЛЬ ЧИТАЕТ, КОГДА ЗАПИСЬ НЕ СОХРАНИЛАСЬ.
//
// Каждая строка говорит три вещи: что записи НЕТ (а не «что-то пошло не так»),
// что текст никуда не делся, и что делать дальше. Ни одна не сообщает родителю,
// что он сделал не так, — он не сделал ничего не так, и в момент, когда он
// только что написал про своего ребёнка, тон этой строки важнее её точности.
//
// Ниже два набора. NOT_WRITABLE — те же две причины, что и в списке, но
// сказанные в форме, где текст уже написан. REFUSAL — отказы самого хранилища,
// по закрытому коду из store/errors.js: полный диск лечится освобождением
// места, а не перезапуском, и одна строка на оба случая отправляла бы родителя
// делать то, что не поможет.
const NOT_WRITABLE = Object.freeze({
    [NO_STORE]:
        'Запись НЕ сохранена: хранилище на этом устройстве не открылось. Ваш текст остался'
        + ' в поле — закройте и откройте приложение, потом нажмите «Сохранить» ещё раз.',
    [NO_SUBJECT]:
        'Запись НЕ сохранена: профиль ребёнка не выбран. Ваш текст остался в поле —'
        + ' создайте профиль в меню вверху и нажмите «Сохранить» ещё раз.',
});

const REFUSAL = Object.freeze({
    disk_full:
        'Запись НЕ сохранена: на устройстве закончилось место. Ваш текст остался в поле —'
        + ' освободите место и нажмите «Сохранить» ещё раз.',
    unavailable:
        'Запись НЕ сохранена: хранилище сейчас недоступно. Ваш текст остался в поле —'
        + ' закройте и откройте приложение, потом нажмите «Сохранить» ещё раз.',
    // ЭТА СТРОКА БЫЛА НЕВЕРНОЙ РОВНО ОДИН ПАКЕТ, И ЭТО СТОИЛО БЫ ДОРОГО.
    // Она советовала «сохранить архив» — а архив (export/readout.js) собирает
    // журнал и schema_meta, но НЕ таблицу record. То есть в худшую минуту
    // продукт предлагал родителю единственное действие, которое не спасает
    // ровно то, на что он смотрит. Теперь сказано, что архив сохраняет, а что
    // нет, — потому что человек, читающий это, решает, что делать в ближайшие
    // пять минут, и «сохраните что-нибудь» не решение.
    corrupt:
        'Запись НЕ сохранена: хранилище не отвечает как обычно. Ваш текст остался в поле —'
        + ' скопируйте его себе прямо сейчас, пока это окно открыто. Архив приложения'
        + ' сохранит отметки и историю журнала, но текста записей дневника в нём пока нет.',
    other:
        'Запись НЕ сохранена. Ваш текст остался в поле — попробуйте нажать «Сохранить»'
        + ' ещё раз.',
});

async function saveEntry(event) {
    event.preventDefault();
    const saveButton = el('diarySaveBtn');
    const eventDate = el('diaryEventDate').value;
    const written = el('diaryBody').value.trim();
    // Считается в локальную переменную заранее и НЕ внутри полезной нагрузки:
    // вызов внутри payload — это место, где семейный текст проходит незамеченным,
    // и app/tests/signal-payload.spec.js такой вызов отказывается пропускать.
    const charCount = written.length;

    if (!written || !eventDate) {
        // Отказ ДО хранилища: ничего не писалось, и сказать надо ровно это.
        // Две причины названы порознь: «или» заставило бы родителя проверять
        // оба поля, чтобы понять, какое из них имелось в виду.
        emitSignal('diary.write', { outcome: 'refused', failure_class: 'none', chars: charCount });
        setStatus(
            written
                ? 'Запись НЕ сохранена: не выбран день, о котором она. Ваш текст остался в поле.'
                : 'Запись НЕ сохранена: в ней пока нет текста. Напишите, что произошло.'
        );
        return;
    }

    const blocked = whyNotWritable();
    if (blocked) {
        emitSignal('write.refused', {
            reason: blocked === NO_STORE ? 'store_unavailable' : 'no_subject',
        });
        setStatus(NOT_WRITABLE[blocked]);
        return;
    }

    // КТО ПИШЕТ И О КОМ — СЧИТАЕТСЯ ЗДЕСЬ, ПОСЛЕ ПРОВЕРКИ ВЫШЕ, где author() уже
    // не может вернуть null. Отдельной строкой, а не вызовом внутри аргумента
    // createRecord: в этом файле рядом стоит правило, по которому вызов внутри
    // полезной нагрузки — место, где что-то проходит незамеченным.
    //
    // Ровно этой строки не было один пакет, и стоило это всего дневника: ниже
    // стоял `...who`, а имени `who` в модуле не существовало, поэтому КАЖДОЕ
    // сохранение падало ReferenceError'ом ДО обращения к хранилищу и родитель
    // получал общий отказ. Путь успеха не выполнялся нигде вне устройства — это
    // и было настоящей находкой; исполнитель для него теперь есть
    // (app/tests/diary-save.spec.js).
    const who = author();

    saveButton.disabled = true;
    setStatus('Сохраняю…');
    const startedAt = Date.now();
    try {
        if (editingRecordId) {
            await overwriteRecord({
                recordId: editingRecordId,
                body: written,
                eventDateLocal: eventDate,
            });
        } else {
            await createRecord({ ...who, body: written, eventDateLocal: eventDate });
        }
        const writeMs = Date.now() - startedAt;
        emitSignal('diary.write', {
            outcome: 'complete',
            failure_class: 'none',
            chars: charCount,
            write_ms: writeMs,
        });
        // Окно НЕ закрывается: подтверждение — это список, в котором запись
        // теперь стоит первой. Сначала список, потом переключение панели, чтобы
        // не было кадра с пустым списком.
        //
        // clearSearch, а не renderList, и это про то же подтверждение: если в
        // списке стоял фильтр, только что сохранённая запись могла бы в него не
        // попасть — и родитель увидел бы список без своей записи ровно в тот
        // момент, когда список ЕСТЬ подтверждение (DIA-DL-005 (g)).
        await clearSearch();
        showList();
    } catch (error) {
        const writeMs = Date.now() - startedAt;
        const failureClass = storeFailureCode(error);
        emitSignal('diary.write', {
            outcome: 'failed',
            failure_class: failureClass,
            chars: charCount,
            write_ms: writeMs,
        });
        // В консоль — имя класса и сообщение движка, как в store/boot.js: там
        // нет семейного текста, а в RUNBOOK эта строка нужна.
        // eslint-disable-next-line no-console
        console.error('[diary] the entry was not recorded:', error?.name, error?.message);
        // Панель НЕ переключается, поле НЕ очищается: текст родителя остаётся
        // ровно там, где он его оставил, и вторая попытка — это одно нажатие.
        setStatus(REFUSAL[failureClass] ?? REFUSAL.other);
    } finally {
        saveButton.disabled = false;
    }
}

function startEdit(event) {
    const editButton = event.target.closest('.diary-entry-edit');
    if (!editButton) return;
    const item = editButton.closest('.diary-entry');
    const body = item?.querySelector('.diary-entry-body');
    const when = item?.querySelector('.diary-entry-date');
    if (!body || !when) return;
    // Правка — это ПЕРЕЗАПИСЬ той же строки, а не новая запись поверх старой
    // (PDR-026 §4, правило 1). Форма открывается с тем, что уже написано, и
    // сохранение заменяет текст на месте.
    showForm({
        recordId: editButton.dataset.recordId,
        body: body.textContent,
        eventDate: when.textContent,
    });
}

export function wireDiary() {
    // Одно имя — один id, и это не стиль: сканер покрытия .show-правил
    // (app/tests/show-rule-coverage.spec.js) разрешает вызовы по привязкам и
    // отказывается работать, если одно имя связано с двумя элементами.
    const openButton = el('diaryBtn');
    if (!openButton) return;
    openButton.addEventListener('click', openDiaryModal);
    el('diaryModalClose').addEventListener('click', closeDiaryModal);
    el('diaryCloseBtn').addEventListener('click', closeDiaryModal);
    el('diaryNewBtn').addEventListener('click', () => showForm());
    el('diaryCancelBtn').addEventListener('click', () => {
        setStatus('');
        showList();
    });
    el('diaryForm').addEventListener('submit', saveEntry);
    el('diarySearchForm').addEventListener('submit', runSearch);
    el('diarySearchClearBtn').addEventListener('click', clearSearch);
    el('diaryList').addEventListener('click', startEdit);
    el('diaryModal').addEventListener('click', (e) => {
        if (e.target.id === 'diaryModal') {
            closeDiaryModal();
        }
    });
}
