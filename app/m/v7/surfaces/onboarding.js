// Поверхность: вступительное окно (#onboardingModal).
// Ни от одной другой поверхности не зависит — самый чистый лист графа.
//
// ЧТО ЗНАЧИТ ЗАКРЫТЬ ЭТО ОКНО (L3-P3, FIU-DL-001 долг 14). Любое из трёх
// закрытий — ✕, «Закрыть», клик по фону — значит «прочитал», и второй раз окно
// само не приходит. До этого пакета запоминалось только закрытие с отмеченной
// галочкой «Больше не показывать», а два других выхода не запоминали ничего: у
// одного окна было три двери, одинаковых на вид и разных по последствиям, и
// родитель, закрывший его крестиком, встречал его снова на каждом холодном
// старте. Это UX-решение, а не наведение порядка в потоке управления:
// вступление читают один раз, и галочка не чинила дефект, а перекладывала его
// на родителя.
//
// И ПОЭТОМУ ЖЕ ЗДЕСЬ ЕСТЬ ВТОРАЯ ДВЕРЬ — «?» в шапке (#aboutBtn). Окно,
// которое закрывается навсегда, обязано открываться заново: с L3-P3 внутри него
// лежит ссылка на политику конфиденциальности, и текст, достижимый ровно один
// раз, был бы обещанием, исполняемым один раз. Кнопка живёт на ОБОИХ каналах и
// ничем не объявляется: она не предлагает действия, которого канал не
// выполняет, — она открывает текст, который лежит в тех же байтах.
//
// Кнопка в шапке, а обработчик здесь — по тому же разделению, что у архива и
// дневника: surfaces/channel.js решает, ПРЕДЛАГАЕТСЯ ли действие на этом
// канале, а поверхность решает, ЧТО оно делает.

import { readOnboardingDismissed, writeOnboardingDismissed } from '../core/storage.js';

// Вступительное окно
export function openOnboardingModal() {
    document.getElementById('onboardingModal').classList.add('show');

    // Google Analytics event
    trackEvent('onboarding_shown');
}

function closeOnboardingModal() {
    // Записывается ВСЕГДА, каким бы выходом ни закрыли. Порядок такой: сначала
    // запомнить, потом убрать с экрана — если запись бросит, окно останется
    // открытым, и это честнее, чем закрыть его с потерянным фактом.
    writeOnboardingDismissed();
    document.getElementById('onboardingModal').classList.remove('show');

    // Google Analytics event. Имя события и его параметр сохранены: измерение
    // GA4 этим пакетом не расширяется и не сужается (решение владельца
    // 2026-08-16, гейт D). Словарь параметра схлопнулся до одного значения
    // вместе с галочкой, которая порождала второе.
    trackEvent('onboarding_dismissed', { action: 'closed' });
}

export function checkAndShowOnboarding() {
    const dismissed = readOnboardingDismissed();
    if (dismissed !== 'true') {
        openOnboardingModal();
    }
}

export function wireOnboarding() {
    // Обработчики вступительного окна
    document.getElementById('onboardingCloseBtn').addEventListener('click', closeOnboardingModal);
    document.getElementById('onboardingModalClose').addEventListener('click', closeOnboardingModal);
    document.getElementById('onboardingModal').addEventListener('click', (e) => {
        if (e.target.id === 'onboardingModal') {
            closeOnboardingModal();
        }
    });

    // Постоянный вход: открыть то же окно ещё раз, сколько угодно раз.
    document.getElementById('aboutBtn').addEventListener('click', openOnboardingModal);
}
