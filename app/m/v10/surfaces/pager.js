// Поверхность: упорядоченный листатель экранов (NAV-P3).
//
// ЧТО ЭТОТ ПАКЕТ ЗАМЕНЯЕТ. До него дневник был КНОПКОЙ В ШАПКЕ (#diaryBtn):
// одно окно, открываемое из одного места. Теперь это ВТОРОЙ ЭКРАН в
// упорядоченном списке, и попасть в него можно жестом влево из таблицы навыков
// или строкой «Дневник» в переключателе разделов. Кнопка из шапки убрана: жест
// её не дополняет, а заменяет.
//
// СПИСОК, А НЕ ЖЕСТ «ОТКРОЙ ДНЕВНИК». Это решение владельца и главное в файле.
// Целевая навигация — три экрана в порядке Спросить / Навыки / Дневник, со
// «Спросить» как начальным (заявление владельца в открытии этой вехи,
// подтверждённое журналом проектных сессий 2026-08-26 в хранилище). Сегодня
// существуют два из трёх, поэтому список сегодня — [навыки, дневник]. Когда
// придёт третий, он ВСТАВЛЯЕТСЯ В ЛЕВЫЙ КОНЕЦ этого же массива: начальный экран
// — всегда самый левый, то есть индекс 0, поэтому вставка слева сама по себе
// переносит начальный экран туда, куда владелец его и поместил, и ни строки
// механизма при этом не меняется. Заготовки «Спросить» здесь нет и не должно
// быть: строка, которая ничего не делает, — обещание, а не подготовка (тот же
// довод, которым NAV-P1 отказался ставить «Обновление» заранее).
//
// У ЛИСТАТЕЛЯ НЕТ СОБСТВЕННОГО СОСТОЯНИЯ, И ЭТО НЕ ЭКОНОМИЯ. Видимость дневника
// меняют ЧЕТЫРЕ пути помимо этого модуля: ✕ окна, кнопка «Закрыть», щелчок по
// фону и offerFirstEntry() — форма первой записи, которая приходит сама за
// созданием профиля (UIP-P4). Хранимый индекс разошёлся бы с экраном на каждом
// из них, и разошёлся бы молча. Поэтому currentIndex() ВЫЧИСЛЯЕТСЯ: каждый
// экран сам отвечает, он ли сейчас перед родителем, и все четыре чужих пути
// оказываются верны бесплатно. Расхождение — то есть «текущих» экранов ноль или
// больше одного — не подавляется, а бросается: это состояние, из которого
// листать некуда, и молчать о нём значило бы листать наугад.
//
// НА ВЕБЕ ЗДЕСЬ НЕ ПРОИСХОДИТ НИЧЕГО. wirePager() уходит до единого слушателя,
// если канал не нативный, — по решению surfaces/channel.js, тому же самому,
// которое прячет переключатель разделов. В браузере дневника нет вообще
// (store/bridge.js там инертен по построению, LSC-P1-INV-001), и жест,
// ведущий в окно, где нечего ни прочитать, ни записать, — обещание пустого
// экрана. Отрицательное утверждение доказывается исполнением, а не чтением
// этого абзаца: app/tests/surface-pager.spec.js синтезирует один и тот же
// жест на обоих каналах и требует, чтобы на нативном он перелистнул, а на
// вебе не сделал ничего.
//
// ТЕЛЕМЕТРИИ НЕТ. Ни счётчика жестов, ни события перехода, ни маячка —
// аналитики нет ни на одном канале с UIP-P1, и сигнал о навигации был бы
// счётчиком движений родителя по приложению. Отсутствие — решение (ADR-013 /
// контракт §4.7), а не упущение; core/signals.js этим пакетом не тронут.

import { NAV_CONFIG } from '../nav/config.js';
import { anyOverlayOpen } from '../nav/overlays.js';
import { shouldOfferSurfacePager } from './channel.js';
import { closeDiaryModal, openDiaryModal } from './diary.js';

// Каждая локальная переменная связана РОВНО с одним id — то же правило, что в
// surfaces/channel.js и surfaces/diary.js (EMV-P1-INV-001).
function el(id) {
    return document.getElementById(id);
}

// Элемент, который ЕСТЬ экран дневника. Объявлен один раз: на него смотрит
// предикат ниже, его же называет запись экрана в списке, и его же читает
// app/tests/overlay-coverage.spec.js, разделяя «окна поверх экрана» и «экраны».
// Второе написание того же идентификатора было бы вторым источником правды о
// том, что вообще является экраном.
const DIARY_SURFACE_ID = 'diaryModal';

/** Открыт ли сейчас экран дневника. */
function diaryIsCurrent() {
    const diarySurface = el(DIARY_SURFACE_ID);
    return diarySurface !== null && diarySurface.classList.contains('show');
}

/**
 * Экраны В ПОРЯДКЕ СЛЕВА НАПРАВО. Индекс 0 — начальный.
 *
 * Каждый экран объявляет три вещи: чем его открывают из переключателя разделов
 * (controlId), он ли сейчас перед родителем (isCurrent) и как на него перейти
 * (enter). Экран навыков «открывается» закрытием того, что над ним, — сегодня
 * это единственное, что над ним бывает.
 */
export const PAGER_SURFACES = Object.freeze([
    Object.freeze({
        key: 'skills',
        // У экрана навыков нет своего элемента: это то, что видно, когда над ним
        // ничего нет. Объявлено null, а не опущено, — сканер разделения экранов
        // и окон читает это поле у каждой записи.
        surfaceId: null,
        controlId: 'surfaceSkillsBtn',
        isCurrent: () => !diaryIsCurrent(),
        enter: () => closeDiaryModal(),
    }),
    Object.freeze({
        key: 'diary',
        surfaceId: DIARY_SURFACE_ID,
        controlId: 'surfaceDiaryBtn',
        isCurrent: () => diaryIsCurrent(),
        // openDiaryModal асинхронна (она перечитывает список), но класс .show
        // ставится ДО первого await, поэтому refreshSurfaceNav() ниже видит уже
        // переключённый экран. Результат намеренно не ожидается: отказ чтения
        // списка — предмет самого дневника, он его ловит и говорит о нём сам.
        enter: () => { void openDiaryModal(); },
    }),
]);

/**
 * Индекс экрана, который сейчас перед родителем.
 *
 * Отказ по умолчанию: ноль «текущих» экранов или больше одного — это не
 * состояние, из которого можно листать, и оно бросается, а не округляется до
 * нуля. Сегодня такого не бывает по построению (два экрана, второй предикат —
 * отрицание первого); проверка стоит для того дня, когда экранов станет три.
 */
export function currentIndex() {
    const current = [];
    PAGER_SURFACES.forEach((surface, at) => {
        if (surface.isCurrent()) current.push(at);
    });
    if (current.length !== 1) {
        throw new Error(
            `the pager cannot say which surface is current: ${current.length} of `
            + `${PAGER_SURFACES.length} report themselves current`
        );
    }
    return current[0];
}

/** Переставляет отметку текущего раздела в переключателе. */
export function refreshSurfaceNav() {
    const surfaceNav = el('surfaceNav');
    if (!surfaceNav) return;
    const at = currentIndex();
    PAGER_SURFACES.forEach((surface, index) => {
        const control = el(surface.controlId);
        if (!control) return;
        // aria-current="page", а не aria-selected: это обычные кнопки в обычном
        // порядке обхода, а не вкладки role="tab" — по тому же доводу, по
        // которому surfaces/menu.js отказался от role="menu". Объявлено ровно
        // то, что исполняется.
        if (index === at) control.setAttribute('aria-current', 'page');
        else control.removeAttribute('aria-current');
    });
}

/**
 * Переходит на экран по индексу. Возвращает true, если экран сменился.
 *
 * За края списка не выходит и не заворачивается: слева от начального экрана
 * ничего нет, справа от последнего тоже, и жест туда — это жест, на который
 * приложение честно не отвечает.
 */
export function goTo(index) {
    if (!Number.isInteger(index) || index < 0 || index >= PAGER_SURFACES.length) return false;
    if (index === currentIndex()) return false;
    PAGER_SURFACES[index].enter();
    refreshSurfaceNav();
    return true;
}

/**
 * Шаг ВЛЕВО по списку — то, что аппаратная кнопка «назад» делает с листателем.
 *
 * Возвращает false на начальном экране: там листателю нечего сказать, и решение
 * переходит дальше по цепочке в surfaces/back.js.
 */
export function pagerBack() {
    const at = currentIndex();
    if (at === 0) return false;
    return goTo(at - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// РАСПОЗНАВАНИЕ ЖЕСТА
//
// КАК ПЕРЕЛИСТЫВАНИЕ ОТЛИЧАЕТСЯ ОТ ПРОКРУТКИ И ОТ КАСАНИЯ.
//
//   От КАСАНИЯ — расстоянием. Касание не проходит ни один из двух порогов
//   (60px для медленного ведения, 24px для быстрого броска), и проходит их не
//   «почти», а на порядок.
//
//   От ВЕРТИКАЛЬНОЙ ПРОКРУТКИ — углом: |dy| <= 0.6 * |dx|, то есть примерно 31
//   градус от горизонтали. И вторым, более надёжным способом: браузер, начавший
//   прокрутку, присылает pointercancel, и жест на этом кончается.
//
//   От ГОРИЗОНТАЛЬНОЙ ПРОКРУТКИ СОДЕРЖИМОГО — местом начала. Жест, начатый
//   внутри элемента, который действительно прокручивается вбок (сегодня это
//   .table-wrapper с широкой таблицей навыков), отклоняется в момент нажатия и
//   уже не может ожить.
//
// ЗДЕСЬ НИ РАЗУ НЕ ЗОВЁТСЯ preventDefault, и это важнее любого порога.
// Слушатели пассивные. Отклонённый жест — это жест, о котором мы не спорим с
// браузером: прокрутка, выделение и масштабирование работают ровно так же, как
// работали до этого пакета. Поэтому ошибка «не распознали перелистывание»
// стоит одного повторного движения, а ошибка в другую сторону стоила бы
// родителю потерянного места в таблице.
// ─────────────────────────────────────────────────────────────────────────────

// Начало текущего жеста, либо null. Второй одновременный указатель (щипок,
// масштабирование) отклоняет жест целиком — см. onPointerDown.
let gestureStart = null;
let gestureDeclined = false;

// ВВОД ТЕКСТА: там горизонтальное ведение — это выделение, а не
// перелистывание. Галочки и переключатели сюда НЕ входят намеренно: выделять в
// них нечего, а исключить их значило бы объявить нелистаемой всю таблицу
// навыков, у которой в каждой строке стоит чекбокс.
const TEXT_ENTRY = 'textarea, select, [contenteditable],'
    + ' input:not([type="checkbox"]):not([type="radio"]):not([type="button"])'
    + ':not([type="submit"]):not([type="reset"])';

function beganInTextEntry(target) {
    if (!(target instanceof Element)) return false;
    return target.closest(TEXT_ENTRY) !== null;
}

/**
 * Начат ли жест внутри элемента, который ДЕЙСТВИТЕЛЬНО прокручивается вбок.
 *
 * Оба условия обязательны и ни одно не следует из другого: overflow-x: auto на
 * узком содержимом не прокручивается ничем, а широкое содержимое под
 * overflow: hidden не прокручивается родителем. Проверяется именно пара, потому
 * что отклонять жест по одному лишь объявлению стиля значило бы отключить
 * перелистывание на всей таблице навыков, которая шире экрана только иногда.
 */
function beganInHorizontalScroller(target) {
    for (let node = target; node instanceof Element; node = node.parentElement) {
        if (node.scrollWidth <= node.clientWidth) continue;
        const sideways = window.getComputedStyle(node).overflowX;
        if (sideways === 'auto' || sideways === 'scroll') return true;
    }
    return false;
}

function discardGesture() {
    gestureStart = null;
    gestureDeclined = false;
}

function onPointerDown(event) {
    // Второй указатель поверх уже начатого жеста — это щипок, а не
    // перелистывание. Отклоняем целиком и не пытаемся угадать, какой из двух
    // «настоящий».
    if (gestureStart !== null) {
        gestureStart = null;
        gestureDeclined = true;
        return;
    }
    gestureDeclined = false;
    if (beganInTextEntry(event.target)
        || beganInHorizontalScroller(event.target)
        // Окно поверх экрана — это не экран. Палец внутри него не листает
        // приложение, а работает с тем, что родитель открыл.
        || anyOverlayOpen()) {
        gestureDeclined = true;
        return;
    }
    gestureStart = { x: event.clientX, y: event.clientY, at: event.timeStamp };
}

/** Считается ли это ведение перелистыванием, и в какую сторону. */
function pageTurnFrom(dx, dy, dt) {
    const sideways = Math.abs(dx);
    const askew = Math.abs(dy);
    if (askew > NAV_CONFIG.pageTurnMaxOffAxisRatio * sideways) return 0;
    const longEnough = sideways >= NAV_CONFIG.pageTurnMinDistancePx;
    const flicked = sideways >= NAV_CONFIG.pageTurnFlickMinDistancePx
        && dt > 0
        && sideways / dt >= NAV_CONFIG.pageTurnFlickMinVelocityPxPerMs;
    if (!longEnough && !flicked) return 0;
    // Палец влево — следующий экран приходит справа. Палец вправо — назад.
    return dx < 0 ? 1 : -1;
}

function onPointerUp(event) {
    const started = gestureStart;
    const declined = gestureDeclined;
    discardGesture();
    if (declined || started === null) return;
    const step = pageTurnFrom(
        event.clientX - started.x,
        event.clientY - started.y,
        event.timeStamp - started.at
    );
    if (step === 0) return;
    goTo(currentIndex() + step);
}

/**
 * Вешает переключатель разделов и жест — только на нативном канале.
 *
 * Решение о канале живёт там же, где остальные решения о составе канала
 * (surfaces/channel.js), и спрашивается тем же способом, каким его спрашивает
 * surfaces/update.js: чистая функция от факта «мы в оболочке». Второго
 * канального механизма пакет не заводит.
 */
export function wirePager() {
    if (!shouldOfferSurfacePager(inNativeShell())) return;

    // Длительность появления экрана — ОДИН литерал на продукт (NAV_CONFIG), и
    // сюда он попадает свойством, а не вторым числом в таблице стилей. Тот же
    // приём, что у заливки строки «Обновление» (NAV-DL-002): app.css читает это
    // свойство БЕЗ запасного значения, поэтому непоставленное свойство означает
    // отсутствие анимации, а не другую длительность. На вебе оно и не ставится
    // — сюда управление не доходит.
    document.documentElement.style.setProperty(
        '--surface-transition-ms',
        `${NAV_CONFIG.surfaceTransitionMs}ms`
    );

    PAGER_SURFACES.forEach((surface, index) => {
        const control = el(surface.controlId);
        if (control) control.addEventListener('click', () => goTo(index));
    });

    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointerup', onPointerUp, { passive: true });
    // Браузер, начавший прокрутку или отобравший указатель, присылает это —
    // и жест на этом кончается. Это ВТОРАЯ, независимая защита от того, чтобы
    // прокрутка была прочитана как перелистывание.
    document.addEventListener('pointercancel', discardGesture, { passive: true });

    refreshSurfaceNav();
}

/**
 * True только внутри оболочки Capacitor.
 *
 * Обе половины важны по доводу store/bridge.js и surfaces/channel.js:
 * подставленный глобал Capacitor иначе выглядел бы нативной платформой.
 */
function inNativeShell() {
    const cap = typeof window === 'undefined' ? null : window.Capacitor;
    if (!cap) return false;
    return typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
}
