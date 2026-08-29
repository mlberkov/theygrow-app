// Поверхность: аппаратная кнопка «назад» на Android (NAV-P3).
//
// ЧТО ОНА ЗНАЧИЛА ДО ЭТОГО ПАКЕТА. Ничего внутри приложения: нажатие уходило
// системе, и приложение уходило в фон — из открытого окна, из середины формы,
// откуда угодно. Именно поэтому внутри окон стояли собственные стрелки «назад»:
// они существовали не потому, что окну нужна стрелка, а потому, что кнопка не
// работала. Теперь работает.
//
// ТРИ СЛУЧАЯ, В ЭТОМ ПОРЯДКЕ, И ПОРЯДОК — ЭТО ПОВЕДЕНИЕ:
//
//   1. Открыто окно поверх экрана — закрывается САМОЕ ВЕРХНЕЕ из них, нажатием
//      его собственного контрола закрытия (nav/overlays.js). Не «скрывается
//      элемент»: нажимается кнопка, поэтому отрабатывает тот же обработчик,
//      что и у пальца, со всем, что он делает попутно.
//   2. Окон нет, но листатель не на начальном экране — шаг ВЛЕВО по списку
//      экранов (surfaces/pager.js).
//   3. Ни того, ни другого — происходит СИСТЕМНОЕ ДЕЙСТВИЕ ПО УМОЛЧАНИЮ.
//      Не наша выдумка о нём: плагин отключает свой перехватчик и заново
//      отправляет нажатие диспетчеру, то есть решение принимает платформа.
//      Подтверждения выхода, двойного нажатия и всплывающей подсказки здесь
//      нет и не заводится — ни одно из трёх не было запрошено, и каждое
//      добавляло бы шаг между родителем и тем, что он нажал.
//
// КАК НАЖАТИЕ СЮДА ПОПАДАЕТ. Первосторонний плагин TheyGrowBack (прецедент
// ExportSinkPlugin и BuildInfoPlugin — без зависимости из npm) вешает
// OnBackPressedCallback и на нажатии присылает событие окна `theygrowback`
// через Bridge.triggerWindowJSEvent. Это работает БЕЗ единого байта npm-кода:
// Capacitor.triggerEvent объявлен в native-bridge.js, который оболочка
// впрыскивает сама. Плагин @capacitor/app сюда не годится не только ценой
// зависимости: его событие доставляется через Plugins-прокси из @capacitor/core,
// а этот продукт собирается без сборщика и не грузит из npm ничего.
//
// НА КАЖДОЕ НАЖАТИЕ ПРИХОДИТ РОВНО ОДИН ОТВЕТ, и это не вежливость, а условие
// того, что случай 3 вообще возможен: плагин должен узнать, что делать, от
// того, кто один знает состояние экрана. handled() значит «мы это разобрали»,
// passThrough() — «нам нечего разбирать, действуй как обычно».
//
// ТЕЛЕМЕТРИИ НЕТ: ни счётчика нажатий, ни события навигации. См. тот же абзац
// в surfaces/pager.js — отсутствие сигнала здесь решение, а не упущение.

import { NAV_CONFIG } from '../nav/config.js';
import { topmostOpenOverlay } from '../nav/overlays.js';
import { pagerBack } from './pager.js';

const PLUGIN_NAME = 'TheyGrowBack';

// Имя события окна, которое присылает плагин. Одно на продукт; константа
// протокола, а не ручка — она не настраивает поведение, а называет канал связи,
// поэтому живёт здесь, а не на конфиг-поверхности (тот же довод, что у ACCEPT
// в surfaces/update.js).
export const BACK_EVENT = 'theygrowback';

function capacitor() {
    if (typeof window === 'undefined') return null;
    return window.Capacitor ?? null;
}

/**
 * True только внутри оболочки Capacitor и только когда мост действительно есть.
 *
 * Обе половины важны по доводу store/bridge.js, export/sink.js и
 * surfaces/update.js: подставленный глобал Capacitor иначе выглядел бы нативной
 * платформой и отказал бы позже, глубже и менее внятно. У второй половины здесь
 * есть и прямой смысл: без моста плагину нечем ответить, а перехватчик, который
 * некому разоружить, — это кнопка «назад», переставшая работать.
 */
function isBackButtonAvailable() {
    const cap = capacitor();
    if (!cap) return false;
    if (typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    return typeof cap.nativePromise === 'function';
}

/**
 * Один вызов плагина. Отказ проглатывается намеренно: ответ на нажатие — не то
 * место, где родителю можно что-то сказать, а неперехваченное отклонение здесь
 * означало бы необработанный promise на каждом нажатии.
 */
function tellPlugin(method, options = {}) {
    if (!isBackButtonAvailable()) return;
    try {
        const answered = capacitor().nativePromise(PLUGIN_NAME, method, options);
        if (answered && typeof answered.catch === 'function') answered.catch(() => {});
    } catch (reason) {
        void reason;
    }
}

/**
 * Разбирает одно нажатие. Экспортируется, потому что это и есть предмет
 * NAV-P3-INV-001: app/tests/back-button.spec.js посылает то же событие окна,
 * которое посылает плагин, и смотрит, что произошло.
 */
function onBackPressed() {
    let overlay = null;
    try {
        overlay = topmostOpenOverlay();
    } catch (reason) {
        void reason;
    }

    if (overlay) {
        const closer = document.getElementById(overlay.closerId);
        // Контрола закрытия нет — оболочка сломана. Не выходим: увести
        // родителя из приложения ИЗ ОТКРЫТОГО ОКНА — единственный исход,
        // который этот пакет обещал не допускать. Отвечаем «разобрали» и не
        // делаем ничего.
        if (closer) closer.click();
        tellPlugin('handled');
        return;
    }

    let stepped = false;
    try {
        stepped = pagerBack();
    } catch (reason) {
        // Листатель не может назвать текущий экран. Тот же выбор, что выше, и
        // по той же причине: молчаливый выход хуже неработающего нажатия.
        // eslint-disable-next-line no-console
        console.error('[back] the pager could not say where it is:', reason?.name);
        tellPlugin('handled');
        return;
    }

    if (stepped) {
        tellPlugin('handled');
        return;
    }

    tellPlugin('passThrough');
}

export { onBackPressed };

/**
 * Вешает разбор нажатия и вооружает плагин — только на нативном канале.
 *
 * ПОРЯДОК ЗДЕСЬ — ПОВЕДЕНИЕ. Слушатель вешается ДО arm(): между «плагин начал
 * перехватывать» и «в странице есть кому ответить» не должно быть окна, в
 * котором нажатие перехвачено и не разобрано.
 *
 * Срок ответа передаётся из NAV_CONFIG, а не записан в Java: одно объявление, в
 * объявленном месте, и никакой второй копии, которая разойдётся с этой
 * (BackButtonPlugin.java говорит то же самое со своей стороны).
 */
export function wireBack() {
    if (!isBackButtonAvailable()) return;
    window.addEventListener(BACK_EVENT, onBackPressed);
    tellPlugin('arm', { deadlineMs: NAV_CONFIG.backAnswerDeadlineMs });
}
