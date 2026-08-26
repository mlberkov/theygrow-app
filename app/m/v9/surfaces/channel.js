// Поверхность: состав действий в шапке — что этот канал вообще предлагает
// (DIA-P2).
//
// ОДНИ И ТЕ ЖЕ БАЙТЫ, РАЗНЫЙ СОСТАВ. Обе кнопки лежат в разметке всегда и обе
// приходят СКРЫТЫМИ; этот модуль открывает ровно одну из них — по тому, где он
// выполняется. Это ветка времени выполнения, а не вторая сборка: каналы
// поставляют байт-в-байт одно и то же (LSC-P1-INV-002, PDR-034 §3).
//
// L3-P3 добавляет сюда ТРЕТИЙ предмет, и он устроен иначе: ссылка на политику
// конфиденциальности раскрывается не по каналу, а по объявлению, и на обоих
// каналах одинаково. Здесь же теперь открывается окно перед установкой — по
// тому же доводу, по которому этот модуль вообще существует: что именно
// предлагает канал, решается в одном месте.
//
// ПОЧЕМУ СКРЫТО ПО УМОЛЧАНИЮ, А НЕ ПОКАЗАНО. Обратный порядок — показать и
// спрятать — на вебе мигал бы обещанием архива при каждой загрузке, а при
// сломанном JS оставлял бы это обещание стоять. Нераскрытое действие — честный
// отказ по умолчанию.
//
// ЧТО ИМЕННО УБРАНО С ВЕБА И ПОЧЕМУ ЭТО НЕ ПОТЕРЯ ФУНКЦИИ. Архив в браузере не
// собирается вообще: в export/sink.js нет и никогда не было веб-ветки
// (LSC-DL-003 (m)). Кнопка предлагала то, чего не происходит. Сам архив ничего
// не теряет — он остаётся нативным путём, и нативная поверхность этим пакетом
// не тронута (PDR-020 §1/§2: архив — долгоживущий артефакт продукта).
//
// НИКАКОЙ ТЕЛЕМЕТРИИ ЗДЕСЬ НЕТ, И ЭТО РЕШЕНИЕ, А НЕ УПУЩЕНИЕ. Эта поверхность
// не эмитит и сигнала. Прежде здесь стояло «соседние поверхности зовут
// trackEvent() шелла, эта — нет», и продолжение про решение владельца
// 2026-08-16 (гейт D), по которому GA4 оставался как есть до аутентификации на
// L4. Оба предложения сняты, потому что их предмета больше нет: аннотация к
// ADR-043 от 2026-08-25 (класс: разворот) убрала GA4 с веб-витрины целиком, и с
// UIP-P1 trackEvent() не зовёт ни одна поверхность — аналитики нет ни на одном
// канале.

import { CHANNEL_CONFIG } from '../channel/config.js';

/**
 * True только внутри оболочки Capacitor.
 *
 * Обе половины важны по доводу store/bridge.js: подставленный глобал Capacitor
 * иначе выглядел бы нативной платформой. Третьей проверки — наличия
 * `nativePromise` — здесь намеренно НЕТ, в отличие от isExportSinkAvailable():
 * тот вопрос про доступность плагина, а этот про то, в каком канале мы
 * выполняемся. Тот же двухчастный вид, что у sw-register.js.
 */
function inNativeShell() {
    const cap = typeof window === 'undefined' ? null : window.Capacitor;
    if (!cap) return false;
    return typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
}

/** Объявленное состояние публикации релиза, как его назвал шелл. */
function declaredReleaseState(doc) {
    const tag = doc.querySelector(`meta[name="${CHANNEL_CONFIG.releaseStateMeta}"]`);
    return tag ? tag.getAttribute('content') : null;
}

/**
 * Предлагать ли ссылку на APK.
 *
 * Чистая функция от двух фактов — состояния публикации и канала, — чтобы обе её
 * ветки можно было выполнить off-device (app/tests/channel-composition.spec.js,
 * блок contract). Отказ по умолчанию: всё, кроме объявленного значения, значит
 * «релиза нет», и тогда ссылки нет. Ссылка на страницу, где ещё ничего не
 * опубликовано, — это 404 или пустая страница под видом загрузки, и она хуже
 * отсутствия кнопки.
 */
export function shouldOfferApk(releaseState, native) {
    if (native) return false;
    return releaseState === CHANNEL_CONFIG.releaseStatePublished;
}

/**
 * Может ли этот посетитель воспользоваться .apk (PPR-P2, долг 21).
 *
 * ПОРЯДОК ИСТОЧНИКОВ — ОБЪЯВЛЕНИЕ ПЕРЕД СТРОКОЙ. navigator.userAgentData.platform
 * — это значение, которое браузер называет сам; userAgent — строка, в которой
 * приходится искать. Где есть первое, второе не спрашивается: объявленное
 * значение точнее сканирования, и на Android Chrome оно равно «Android» даже
 * тогда, когда сокращённый userAgent обеднён. Где первого нет (Firefox, Safari)
 * — читается userAgent, и там токен присутствует.
 *
 * ЭТО ЭВРИСТИКА, И НАПРАВЛЕНИЕ ОШИБКИ ВЫБРАНО. Никакая проверка платформы в
 * браузере не бывает надёжной, поэтому единственное, что здесь гарантируется, —
 * куда ошибка падает: всё, что не распознано (нет navigator, нет строки, чужая
 * платформа), возвращает false, а false означает честное предложение открыть
 * страницу с телефона, а не ссылку на файл, который не установится.
 *
 * Принимает navigator аргументом, а не читает глобал: так таблица истинности
 * проверяется вне браузера (app/tests/download-offer.spec.js), тем же приёмом,
 * которым shouldOfferApk проверяется у себя.
 */
export function isAndroidPlatform(nav) {
    if (!nav) return false;
    const token = CHANNEL_CONFIG.androidPlatformToken;
    const data = nav.userAgentData;
    if (data && typeof data.platform === 'string' && data.platform.length > 0) {
        return data.platform.toLowerCase().includes(token);
    }
    if (typeof nav.userAgent !== 'string') return false;
    return nav.userAgent.toLowerCase().includes(token);
}

/**
 * Предлагать ли САМУ ЗАГРУЗКУ — файл, а не окно с рассказом о приложении.
 *
 * Объявление стоит первым и не сдвигается: неопубликованный релиз не предлагается
 * никому и ни на какой платформе (DIA-P2-INV-002). Платформа — второе условие, не
 * замена первому.
 */
export function shouldOfferDownloadLink(releaseState, native, android) {
    return shouldOfferApk(releaseState, native) && android === true;
}

/** Объявленное состояние публикации политики, как его назвал шелл. */
function declaredPolicyState(doc) {
    const tag = doc.querySelector(`meta[name="${CHANNEL_CONFIG.policyStateMeta}"]`);
    return tag ? tag.getAttribute('content') : null;
}

/**
 * Показывать ли ссылку на политику конфиденциальности (L3-P3).
 *
 * ФУНКЦИЯ ОДНОГО АРГУМЕНТА, И ЭТО РЕШЕНИЕ, А НЕ ЭКОНОМИЯ. У shouldOfferApk два:
 * загрузка бессмысленна там, где приложение уже стоит. У политики канала нет —
 * читает её тот, кто ВВОДИТ ДАННЫЕ (PDR-035 §2), а данные вводят на обоих
 * каналах. Добавить сюда `native` значило бы утверждать, что у родителя с
 * телефоном этого права меньше.
 *
 * Отказ по умолчанию, как и у релиза: всё, кроме объявленного значения, значит
 * «документа нет». Ссылка со словом «конфиденциальность», ведущая в 404, — не
 * недоделанная функция, а нарушенное обещание про данные семьи.
 */
export function shouldOfferPolicy(policyState) {
    return policyState === CHANNEL_CONFIG.policyStatePublished;
}

/**
 * Раскрывает действия, которые этот канал действительно выполняет.
 *
 * Каждая локальная переменная связана РОВНО с одним id — то же правило, что в
 * surfaces/diary.js: угадывать, какой элемент имеет в виду имя, тесты
 * отказываются (EMV-P1-INV-001).
 */
export function wireChannel({ doc = document } = {}) {
    const native = inNativeShell();

    const archiveButton = doc.getElementById('exportBtn');
    if (archiveButton) archiveButton.hidden = !native;

    // Дневник (DIA-P3). Раскрывается там же, где архив, и по той же причине:
    // хранилище дневника — устройственное, а в браузере store/bridge.js инертен
    // по построению, так что на вебе эта кнопка открывала бы окно, в котором
    // ничего нельзя ни прочитать, ни записать.
    const diaryButton = doc.getElementById('diaryBtn');
    if (diaryButton) diaryButton.hidden = !native;

    // ПРЕДЛОЖЕНИЕ ПРИЛОЖЕНИЯ — ТЕПЕРЬ В ДВА ПРЕДМЕТА (L3-P3): кнопка в шапке,
    // которая открывает окно, и ссылка ВНУТРИ окна, которая ведёт на страницу
    // релизов. Между решением поставить и загрузкой встал текст о том, что это
    // за приложение и где живут данные, — до этого пакета там не было ничего.
    const downloadButton = doc.getElementById('apkBtn');
    const installWindow = doc.getElementById('installModal');
    const downloadLink = doc.getElementById('installDownloadLink');

    // Адрес проставляется здесь, а не в разметке: одно объявление на продукт, в
    // объявленном месте (CHANNEL_CONFIG), и статический скан отказывается видеть
    // этот адрес где-либо ещё. Безусловно, как и раньше: ссылка никогда не
    // остаётся ведущей в никуда, даже пока окно недостижимо.
    if (downloadLink) downloadLink.href = CHANNEL_CONFIG.apkReleaseUrl;

    // КАНАЛ МОЖЕТ ПРЕДЛАГАТЬ ТОЛЬКО ТО, ЧТО СПОСОБЕН ОТДАТЬ (PPR-P2, долг 21;
    // PDR-034 §1). Кнопка в шапке остаётся там же и открывает то же окно: она —
    // способ узнать, что приложение есть, и это верно на любой платформе. А вот
    // ПРЕДЛОЖЕНИЕ внутри окна — ссылка на .apk — раскрывается только тому, кто
    // может ей воспользоваться; всем остальным в том же месте достаётся
    // предложение открыть страницу с телефона на Android. Это тот же дефект,
    // который DIA-P2 закрыл для архива, ярусом ниже: архив не предлагался
    // каналу, который не умеет его собрать, а файл .apk не предлагается
    // устройству, которое не умеет его поставить.
    const platformNote = doc.getElementById('installPlatformNote');
    const onAndroid = isAndroidPlatform(typeof navigator === 'undefined' ? null : navigator);
    const offersFile = shouldOfferDownloadLink(declaredReleaseState(doc), native, onAndroid);

    if (downloadLink) downloadLink.hidden = !offersFile;
    // Текст показывается ровно тогда, когда окно достижимо, а файл не
    // предлагается: пустой слот в ряду кнопок ничего не объясняет, а текст под
    // нераскрытым окном никто не увидит.
    if (platformNote) {
        platformNote.hidden = !(shouldOfferApk(declaredReleaseState(doc), native) && !offersFile);
    }

    if (downloadButton) {
        downloadButton.hidden = !shouldOfferApk(declaredReleaseState(doc), native);
    }

    if (downloadButton && installWindow) {
        downloadButton.addEventListener('click', () => {
            installWindow.classList.add('show');
        });
    }

    if (installWindow) {
        const closeInstallWindow = () => installWindow.classList.remove('show');

        const installCross = doc.getElementById('installModalClose');
        if (installCross) installCross.addEventListener('click', closeInstallWindow);

        const installCloseButton = doc.getElementById('installCloseBtn');
        if (installCloseButton) installCloseButton.addEventListener('click', closeInstallWindow);

        installWindow.addEventListener('click', (e) => {
            if (e.target === installWindow) closeInstallWindow();
        });
    }

    // ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ. Один дом — вступительное окно, на обоих
    // каналах; поэтому здесь нет ветки по каналу, только по объявлению. Адрес,
    // как и у загрузки, ставится безусловно: элемент, который однажды покажут,
    // не должен быть в этот момент ссылкой в никуда.
    const policyLink = doc.getElementById('introPolicyLink');
    if (policyLink) {
        policyLink.href = CHANNEL_CONFIG.policyUrl;
        policyLink.hidden = !shouldOfferPolicy(declaredPolicyState(doc));
    }

    // ЧТО ГОВОРИТ ВЕБ-КАНАЛ О СОХРАННОСТИ ДАННЫХ, ПОСЛЕ ТОГО КАК КНОПКА АРХИВА
    // С НЕГО УШЛА. До этого пакета единственным местом, где было сказано «у этих
    // данных нет резервной копии», был текст внутри модалки архива — а модалка
    // на вебе теперь недостижима. Утверждение при этом истинно ровно сейчас и
    // ровно здесь: до подтверждённого переноса (ADR-048 §5) браузерное
    // хранилище держит единственную копию истории этой семьи. Поэтому строка
    // остаётся на канале, к которому она относится, и стоит там, где родитель
    // на неё наткнётся, — а не в окне, которое надо открыть.
    const browserOnlyNote = doc.getElementById('webChannelNote');
    if (browserOnlyNote) browserOnlyNote.hidden = native;
}
