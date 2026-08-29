// Поверхность: проверка обновления (#menuUpdateBtn) — единственное место, откуда
// это приложение ходит в сеть (NAV-P2, vault ADR-052).
//
// ПЕРВЫЙ СЕТЕВОЙ ВЫЗОВ ПРОДУКТА, И ПОТОМУ ЗДЕСЬ НАПИСАНО БОЛЬШЕ ОБЫЧНОГО. До
// этого пакета каждый fetch под маунтом адресовал ассет того же происхождения —
// внутри WebView это чтение локального файла, сети там нет вообще. Здесь сети
// ровно один запрос, и его границы описаны там же, где он живёт:
//
//   ЧТО уходит: GET на CHANNEL_CONFIG.updateApiUrl. Без токена, без строки
//   запроса, без тела. credentials: 'omit' — куки не прикладываются;
//   referrerPolicy: 'no-referrer' — адрес нашей страницы не сообщается;
//   единственный заголовок, который ставим мы, — постоянный Accept. Ни
//   пользовательского, ни устройственного, ни установочного идентификатора, ни
//   отпечатка, ничего производного от семейных данных. GitHub видит IP-адрес и
//   стандартные заголовки HTTP-клиента — это названо теми же словами в §6
//   опубликованной политики (редакция 1.3), а не оставлено читателю на догадку.
//
//   КОГДА уходит: только по нажатию строки. Не на загрузке, не по таймеру, не в
//   service worker, не повторно после отказа — ничего не перезапрашивается
//   автоматически ни разу. Отрицательное утверждение доказывается исполнением, а
//   не чтением этого абзаца: app/tests/update-check.spec.js ведёт настоящую
//   страницу и смотрит сетевой лог (прецедент analytics-egress.spec.js, названный
//   детектором в vault ADR-052 §4).
//
//   ЧТО НЕ ЗАВОДИТСЯ: ни счётчика, ни маячка, ни агрегации. Аналитики нет ни на
//   одном канале с UIP-P1, и этот пакет её не возвращает — исход проверки не
//   эмитится сигналом и НИГДЕ не сохраняется: он живёт в DOM ровно столько,
//   сколько открыта панель. Сигнала нет намеренно (ADR-013 / контракт §4.7):
//   объявить его в core/signals.js значило бы завести счётчик нажатий, а
//   отсутствие такого счётчика — решение, а не упущение. Кандидат «пульс парка»
//   остаётся отдельным будущим gate-решением (vault ADR-052 §2) и этим пакетом не
//   принимается.
//
// НИ ОДНОЙ СТРОКИ ЭТОТ МОДУЛЬ НЕ СТРОИТ. Всё, что читает родитель, лежит готовыми
// абзацами в оболочке; здесь только снимается hidden ровно с одного из них.
// Поэтому обещание «ни одно сообщение об ошибке не несёт семейных данных» —
// свойство дерева, а не обязательство: строке, несущей данные, здесь неоткуда
// взяться. Проверяется статически (app/tests/update-contour.spec.js) вместе с
// отсутствием второго примитива запроса и второго адреса.
//
// УСТАНОВКА ПРОИСХОДИТ В БРАУЗЕРЕ, А НЕ ЗДЕСЬ. «Установить» — ссылка на страницу
// релиза с target="_blank", тот же приём, что у #installDownloadLink и
// #introPolicyLink. Приложение ничего не скачивает, ничего не готовит на диске и
// не запускает установку; REQUEST_INSTALL_PACKAGES в манифест не вводится (vault
// ADR-052 §1.3: политика Play запрещает это разрешение для самообновления, а
// манифест общий для GitHub- и Play-копий). Модель доверия остаётся прежней —
// стабильная подпись и опубликованный sha256 рядом с APK (vault ADR-047), и этот
// пакет ничего не проверяет сам.

import { CHANNEL_CONFIG } from '../channel/config.js';
import { shouldOfferUpdate } from './channel.js';

const PLUGIN_NAME = 'TheyGrowBuild';

// Единственный заголовок, который ставим мы. Постоянная протокола, а не ручка:
// значение не качественное — оно не настраивает поведение продукта, а называет
// формат ответа, — поэтому живёт здесь, а не на конфиг-поверхности. Тест состава
// запроса читает его отсюда, а не переписывает у себя.
const ACCEPT = 'application/vnd.github+json';

// Все абзацы исхода, в порядке разметки. Показывается не больше одного.
const STATUS_LINES = Object.freeze([
    'updateStatusChecking',
    'updateStatusCurrent',
    'updateStatusAvailable',
    'updateStatusOffline',
    'updateStatusTimeout',
    'updateStatusRateLimited',
    'updateStatusServerError',
    'updateStatusUnreadable',
]);

// versionCode установленной сборки, как его назвал плагин. Живёт в модуле, а не
// в DOM: это не то, что показывают, а то, с чем сравнивают.
let installedVersionCode = null;

// Одна проверка за раз. Строка на время проверки disabled, а это — пояс к
// подтяжкам: повторное нажатие не заводит второй запрос ни при каких условиях.
let inFlight = false;

function capacitor() {
    if (typeof window === 'undefined') return null;
    return window.Capacitor ?? null;
}

/**
 * True только внутри оболочки Capacitor и только когда плагин действительно есть.
 *
 * Обе половины важны по доводу store/bridge.js и export/sink.js: подставленный
 * глобал Capacitor иначе выглядел бы нативной платформой и отказал бы позже,
 * глубже и менее внятно. Здесь у второй половины есть ещё один смысл: без
 * плагина неизвестен versionCode установленной сборки, а сравнивать не с чем —
 * значит предлагать проверку нельзя.
 */
function isBuildInfoAvailable() {
    const cap = capacitor();
    if (!cap) return false;
    if (typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return false;
    return typeof cap.nativePromise === 'function';
}

/** Что за сборка установлена, или null, если спросить не у кого. */
async function readBuildInfo() {
    if (!isBuildInfoAvailable()) return null;
    try {
        const info = await capacitor().nativePromise(PLUGIN_NAME, 'info', {});
        if (!info || !Number.isInteger(info.versionCode) || info.versionCode <= 0) return null;
        return {
            versionCode: info.versionCode,
            installer: typeof info.installer === 'string' ? info.installer : null,
        };
    } catch (reason) {
        // Плагин, который не ответил, — это неизвестная установленная версия.
        // Отказ по умолчанию: строки не будет, а не будет проверки наугад.
        void reason;
        return null;
    }
}

/**
 * versionCode опубликованного релиза, вынутый из ИМЕНИ АССЕТА.
 *
 * Не из тега: docs/RUNBOOK.md § Running the release build говорит это прямо —
 * «The tag name does not set the version», тег выбирает коммит. Имя ассета
 * собирается из output-metadata.json самой сборки и несёт versionCode, который
 * native/android/app/build.gradle выводит из `git rev-list --count HEAD` именно
 * потому, что он воспроизводим по коммиту и монотонен по предкам, — «что и нужно
 * цепочке обновления».
 *
 * Возвращает null, если подходящего ассета нет. null — это «ответ не прочитан», и
 * вызывающий обязан показать именно это, а не «обновлений нет».
 */
export function latestVersionCode(assetNames) {
    if (!Array.isArray(assetNames)) return null;
    const pattern = new RegExp(CHANNEL_CONFIG.releaseAssetPattern);
    let newest = null;
    for (const name of assetNames) {
        if (typeof name !== 'string') continue;
        const found = pattern.exec(name);
        if (!found) continue;
        const code = Number.parseInt(found[1], 10);
        if (!Number.isInteger(code) || code <= 0) continue;
        if (newest === null || code > newest) newest = code;
    }
    return newest;
}

/**
 * Исход сравнения двух versionCode.
 *
 * Три значения, а не два, и третье — не отказ механики, а честный ответ: если
 * установленная или опубликованная версия неизвестна, сказать «обновлений нет»
 * значит дать ложное «всё в порядке» там, где мы не знаем. Разделение
 * «обновлений нет» и «не смогли посмотреть» — это и есть предмет.
 */
export function updateVerdict(installedCode, latestCode) {
    if (!Number.isInteger(installedCode) || installedCode <= 0) return 'unknown';
    if (!Number.isInteger(latestCode) || latestCode <= 0) return 'unknown';
    return latestCode > installedCode ? 'available' : 'current';
}

/** Показывает ровно один абзац исхода (или ни одного) и прячет ссылку. */
function showStatus(doc, id) {
    for (const lineId of STATUS_LINES) {
        const line = doc.getElementById(lineId);
        if (line) line.hidden = lineId !== id;
    }
    const link = doc.getElementById('updateInstallLink');
    if (link) link.hidden = id !== 'updateStatusAvailable';
}

/** Возврат строки в исходное состояние: ни исхода, ни заливки, ни ссылки. */
function resetStatus(doc) {
    showStatus(doc, null);
    const row = doc.getElementById('menuUpdateBtn');
    if (!row) return;
    row.classList.remove('is-checking');
    row.removeAttribute('aria-busy');
    row.disabled = false;
}

/**
 * Классифицирует ответ, который УЖЕ пришёл.
 *
 * 403 и 429 разделены от прочих не-2xx намеренно: за исчерпанным лимитом стоит
 * другое действие родителя — подождать, — и одна общая фраза «сервер ответил
 * ошибкой» это действие бы скрыла. Признак берётся и из статуса, и из заголовка
 * лимита, потому что 403 у этого API бывает и не про лимит.
 */
async function classifyResponse(response) {
    if (!response.ok) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (response.status === 429 || (response.status === 403 && remaining === '0')) {
            return 'updateStatusRateLimited';
        }
        return 'updateStatusServerError';
    }
    let body = null;
    try {
        body = await response.json();
    } catch (reason) {
        void reason;
        return 'updateStatusUnreadable';
    }
    if (!body || !Array.isArray(body.assets)) return 'updateStatusUnreadable';
    const latest = latestVersionCode(body.assets.map((asset) => asset && asset.name));
    const verdict = updateVerdict(installedVersionCode, latest);
    if (verdict === 'unknown') return 'updateStatusUnreadable';
    return verdict === 'available' ? 'updateStatusAvailable' : 'updateStatusCurrent';
}

/**
 * Одна проверка: один запрос, один исход, ни одной повторной попытки.
 *
 * Отмена здесь ровно одна — по сроку. Закрытие панели запрос не отменяет: уже
 * ушедший запрос отменой не возвращается, а «отменять на закрытии» означало бы
 * приглашение отправить второй по следующему нажатию. Вместо этого исход
 * сбрасывается при нажатии на кнопку меню, так что устаревший ответ никогда не
 * показывается заново.
 */
async function runCheck(doc) {
    if (inFlight) return;
    inFlight = true;

    const row = doc.getElementById('menuUpdateBtn');
    if (row) {
        row.disabled = true;
        row.setAttribute('aria-busy', 'true');
        // Длительность заливки — та же ручка, что и срок отказа, поставленная на
        // элемент как свойство. Второй литерал в стилях был бы заливкой, которая
        // врёт о том, когда приложение сдаётся.
        row.style.setProperty('--update-fill-duration', `${CHANNEL_CONFIG.updateCheckTimeoutMs}ms`);
        row.classList.add('is-checking');
    }
    showStatus(doc, 'updateStatusChecking');

    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, CHANNEL_CONFIG.updateCheckTimeoutMs);

    let outcome = 'updateStatusOffline';
    try {
        const response = await fetch(CHANNEL_CONFIG.updateApiUrl, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
            headers: { Accept: ACCEPT },
            signal: controller.signal,
        });
        outcome = await classifyResponse(response);
    } catch (reason) {
        void reason;
        outcome = timedOut ? 'updateStatusTimeout' : 'updateStatusOffline';
    } finally {
        clearTimeout(deadline);
    }

    if (row) {
        row.classList.remove('is-checking');
        row.removeAttribute('aria-busy');
        row.disabled = false;
    }
    showStatus(doc, outcome);
    inFlight = false;
}

/**
 * Раскрывает строку, если этот канал её действительно исполняет, и вешает
 * единственные два слушателя этого модуля.
 *
 * РЕШЕНИЕ О СОСТАВЕ ЖИВЁТ В surfaces/channel.js, а не здесь: второго канального
 * механизма пакет не заводит. Сюда попало только исполнение, потому что второй
 * факт — из какого магазина установлена копия — приходит асинхронно, а
 * wireChannel() синхронна и вызывается на загрузке.
 *
 * Первый аргумент shouldOfferUpdate — не просто «нативный канал», а «нативная
 * оболочка, в которой плагин действительно есть»: без плагина неизвестен
 * versionCode, сравнивать не с чем, и предлагать проверку было бы предложением
 * посмотреть в пустоту. Тот же двухчастный вид, что у isExportSinkAvailable().
 *
 * Адрес ссылке ставится БЕЗУСЛОВНО, по доводу surfaces/channel.js: элемент,
 * который однажды покажут, не должен быть в этот момент ссылкой в никуда.
 */
export async function wireUpdate({ doc = document } = {}) {
    const row = doc.getElementById('menuUpdateBtn');
    if (!row) return;

    const link = doc.getElementById('updateInstallLink');
    if (link) link.href = CHANNEL_CONFIG.apkReleaseUrl;

    const info = await readBuildInfo();
    const offered = shouldOfferUpdate(info !== null, info ? info.installer : null);
    row.hidden = !offered;

    // СЛУШАТЕЛЕЙ НЕТ ТАМ, ГДЕ НЕТ СТРОКИ, и это сильнее, чем скрытая строка.
    // Спрятанная кнопка с живым обработчиком — это запрос, до которого остаётся
    // одна строчка чужого кода: снятый hidden в отладке, чужой стиль, скрипт
    // расширения. Здесь на веб-канале и в Play-копии обработчика просто нет, и
    // это исполняется в app/tests/update-check.spec.js — строка раскрывается
    // силой и нажимается, и сетевой лог остаётся пустым.
    if (!offered) return;

    installedVersionCode = info.versionCode;

    row.addEventListener('click', () => {
        void runCheck(doc);
    });

    // Сброс на нажатии кнопки меню — единственный способ панель открыть, — чтобы
    // ответ прошлой проверки не встречал родителя как свежий.
    const toggle = doc.getElementById('menuBtn');
    if (toggle) toggle.addEventListener('click', () => resetStatus(doc));
}
