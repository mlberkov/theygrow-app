// Поверхность: согласие на аналитику в браузере — спросить один раз, загрузить
// только после «да», и дать отозвать так же дёшево (PPR-P2, PDR-035 §5).
//
// ЧТО ЗДЕСЬ РЕШАЕТСЯ И ЧТО РЕШАЕТСЯ НЕ ЗДЕСЬ. Шелл описывает, КАК аналитика
// включается и выключается: он держит идентификатор измерения, адрес загрузчика,
// GA_DEBUG и trackEvent, и объявляет их одной точкой входа —
// window[CONSENT_CONFIG.shellBridge] с методами enable() и disable(). Он никогда
// не вызывает их сам. Решение, ВКЛЮЧАТЬ ЛИ, целиком здесь, и до вызова enable()
// со страницы не уходит ни одного запроса на googletagmanager.com: тега просто
// нет в документе. Это и есть «базовый режим согласия», о котором говорит
// app/privacy.html §5.
//
// ПОЧЕМУ РЕШЕНИЕ В МОНТАЖЕ, А НЕ В ГОЛОВЕ ДОКУМЕНТА. Прочитать ключ в <head>
// было бы можно, и это стоило бы второй записи в DECLARED_SHELL_ACCESSES и
// третьей копии имени ключа. Цена нынешнего вида — аналитика инициализируется
// после загрузки модулей, а не при разборе <head>. Загрузчик и без того async,
// просмотр страницы уходит тем же одним событием, и ничто в приложении не
// зависит от того, случилось это на десять миллисекунд раньше или позже.
//
// НА НАТИВНОМ КАНАЛЕ НЕ ПРОИСХОДИТ НИЧЕГО. Ни баннера, ни ссылки в подвале, ни
// аналитики: её там нет вообще с L1-P4, и спрашивать не о чем. Проверка канала —
// ветка времени выполнения, а не вторая сборка (LSC-P1-INV-002, PDR-034 §3), и
// вторая, независимая от неё, стоит в самом enable() шелла.
//
// ЗДЕСЬ НЕТ НИ ОДНОГО СОБЫТИЯ GA4 И НИ ОДНОГО СИГНАЛА, и это решение. Пакет,
// который строит согласие на измерение, не расширяет измерение: ни нового
// события, ни нового параметра. Что и сколько раз ответили — не наше дело.

import { CONSENT_CONFIG } from '../consent/config.js';
import { readAnalyticsConsent, writeAnalyticsConsent } from '../core/storage.js';

/**
 * True только внутри оболочки Capacitor.
 *
 * Своя копия проверки, как у sw-register.js, store/bridge.js и
 * surfaces/channel.js: у каждого модуля, которому нужен канал, она своя, и это
 * сложившийся вид в этом дереве, а не упущение. Общий модуль ради трёх строк
 * добавил бы узел в граф импортов, подсказку доставки и запись в OFFLINE_URLS.
 */
function inNativeShell() {
    const cap = typeof window === 'undefined' ? null : window.Capacitor;
    if (!cap) return false;
    return typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
}

/**
 * Что означает сохранённая строка. Три состояния, две из них — точные токены.
 *
 * ОТКАЗ ЗАКРЫТ В ОБЕ СТОРОНЫ. Всё, что не равно granted, ничего не грузит; всё,
 * что не равно ни granted, ни denied, — ещё и спрашивает заново. Спросить не
 * вредно, загрузить — вредно, поэтому неразобранное значение попадает в
 * «не решено», а не в «согласились».
 */
export function consentState(raw) {
    if (raw === CONSENT_CONFIG.stateGranted) return 'granted';
    if (raw === CONSENT_CONFIG.stateDenied) return 'denied';
    return 'undecided';
}

/** Грузить ли аналитику. Единственное «да» во всём модуле. */
export function shouldLoadAnalytics(state, native) {
    if (native) return false;
    return state === 'granted';
}

/** Показывать ли баннер. Только тому, кого ещё не спрашивали. */
export function shouldAskForConsent(state, native) {
    if (native) return false;
    return state === 'undecided';
}

/**
 * Связывает баннер, две кнопки и ссылку в подвале.
 *
 * Каждая локальная переменная привязана ровно к одному id — то же правило, что в
 * surfaces/channel.js (EMV-P1-INV-001): id, который никто не читает, и элемент,
 * который никто не находит, выглядят в этом файле одинаково, если позволить
 * одной переменной означать два предмета.
 */
export function wireConsent({ doc = document, win = window } = {}) {
    const native = inNativeShell();

    const banner = doc.getElementById('cookieBanner');
    const enableButton = doc.getElementById('cookieEnableBtn');
    const declineButton = doc.getElementById('cookieDeclineBtn');
    const settingsControl = doc.getElementById('cookieSettingsBtn');

    // На нативном канале не раскрывается ничего и не читается ничего: выходим
    // раньше, чем коснёмся хранилища. Баннер и ссылка приходят скрытыми из
    // разметки, поэтому «не тронуть» здесь означает «оставить скрытыми».
    if (native) return;

    const bridge = win[CONSENT_CONFIG.shellBridge];

    const showBanner = ({ moveFocus }) => {
        if (!banner) return;
        banner.classList.add('show');
        // Фокус переводится только при повторном открытии — из подвала, по
        // явному действию родителя. На первом показе страница ещё грузится, и
        // отнимать фокус в этот момент — отдельный дефект. Переводится он на сам
        // баннер, а не на одну из кнопок: сделать одну из двух равных кнопок
        // сфокусированной по умолчанию — значит перестать считать их равными.
        if (moveFocus) banner.focus();
    };

    const hideBanner = () => {
        if (banner) banner.classList.remove('show');
    };

    const answer = (state) => {
        writeAnalyticsConsent(state);
        hideBanner();
        if (!bridge) return;
        if (state === CONSENT_CONFIG.stateGranted) bridge.enable();
        else bridge.disable();
    };

    if (enableButton) {
        enableButton.addEventListener('click', () => answer(CONSENT_CONFIG.stateGranted));
    }
    if (declineButton) {
        declineButton.addEventListener('click', () => answer(CONSENT_CONFIG.stateDenied));
    }

    // Отзыв стоит ровно столько же, сколько согласие: один клик открывает тот же
    // баннер с теми же двумя кнопками. Ссылка раскрывается безусловно, а не
    // только при выданном согласии: она — вход к вопросу, а не к его ответу, и
    // родитель, отказавшийся однажды, должен иметь тот же путь обратно.
    if (settingsControl) {
        settingsControl.hidden = false;
        settingsControl.addEventListener('click', () => showBanner({ moveFocus: true }));
    }

    const state = consentState(readAnalyticsConsent());

    if (shouldLoadAnalytics(state, native)) {
        if (bridge) bridge.enable();
        return;
    }

    // Ничего не грузим — и говорим об этом самому gtag, если он всё-таки был
    // загружен раньше в этой же жизни страницы. На чистой загрузке это
    // безобидно: выключатель Google читается тегом, которого ещё нет.
    if (bridge) bridge.disable();

    if (shouldAskForConsent(state, native)) {
        showBanner({ moveFocus: false });
    }
}
