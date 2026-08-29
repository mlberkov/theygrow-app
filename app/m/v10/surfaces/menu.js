// Поверхность: меню шапки (#headerMenu) — список того, что приложение умеет
// помимо таблицы (NAV-P1).
//
// РАЗДЕЛЕНИЕ, КОТОРОЕ ЗДЕСЬ СОБЛЮДЕНО. surfaces/channel.js решает, ПРЕДЛАГАЕТСЯ
// ли меню на этом канале (нативный — да, веб — нет), а этот файл решает, ЧТО оно
// делает, когда предложено. Ровно тот же разрез, что у архива, дневника и
// вступительного окна; второго канального механизма пакет не заводит.
//
// ЧТО В МЕНЮ И ЧЕГО В НЁМ НЕТ. Два пункта: «О приложении» — та же строка, что на
// вебе стоит кнопкой в шапке, и «Сохранить архив» — та же кнопка #exportBtn,
// которой NAV-P1 сменил родителя, а не разметку. Обработчики не переписаны:
// первый зовёт openOnboardingModal() из surfaces/onboarding.js, второй остаётся
// на своём слушателе в surfaces/export.js, и этот файл его даже не знает по
// имени — он только закрывает панель, когда внутри неё что-то нажали.
//
// «ОБНОВЛЕНИЕ» ПРИШЛО С NAV-P2 И ЖИВЁТ НЕ ЗДЕСЬ. Третий пункт появился вместе с
// тем, что он делает (surfaces/update.js, vault ADR-052 §1); этот файл про него
// знает ровно одно — что он НЕ закрывает панель, и знает это по атрибуту, а не по
// имени. См. ниже: делегированный слушатель пропускает кнопку с
// data-keeps-menu-open. Атрибут, а не идентификатор, потому что правило здесь
// одно на весь список: строка, которая отвечает прямо в панели, не должна
// закрывать панель под собственным ответом.
//
// ПОЧЕМУ НЕ role="menu". Роль menu обещает диктору стрелочную навигацию и одну
// остановку Tab на весь список, и исполнять это обещание пришлось бы кодом
// переноса фокуса. Здесь обычные кнопки в обычном порядке обхода: Tab идёт по
// ним, Enter и Пробел нажимают, диктор называет их кнопками. Объявлено ровно то,
// что исполняется, — aria-expanded на кнопке меню, и оно ставится ниже в том же
// месте, где меняется класс, чтобы разметка и объявление не разъезжались.
//
// ТЕЛЕМЕТРИИ НЕТ. Ни счётчика открытий, ни события выбора пункта: аналитики нет
// ни на одном канале с UIP-P1, и отсутствие сигнала здесь — решение, а не
// упущение.

import { openOnboardingModal } from './onboarding.js';

// Каждая локальная переменная связана РОВНО с одним id — то же правило, что в
// surfaces/channel.js и surfaces/diary.js: угадывать, какой элемент имеет в виду
// имя, тесты отказываются (EMV-P1-INV-001).

function openMenu() {
    const panel = document.getElementById('headerMenuPanel');
    panel.classList.add('show');
    const toggle = document.getElementById('menuBtn');
    toggle.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
    const panel = document.getElementById('headerMenuPanel');
    panel.classList.remove('show');
    const toggle = document.getElementById('menuBtn');
    toggle.setAttribute('aria-expanded', 'false');
}

function menuIsOpen() {
    const panel = document.getElementById('headerMenuPanel');
    return panel.classList.contains('show');
}

function toggleMenu() {
    if (menuIsOpen()) {
        closeMenu();
    } else {
        openMenu();
    }
}

export function wireMenu() {
    const toggle = document.getElementById('menuBtn');
    if (!toggle) return;

    toggle.addEventListener('click', toggleMenu);

    // Пункт «О приложении». Тот же обработчик, что у кнопки веб-канала; окно,
    // его текст и ссылка на политику внутри него не тронуты.
    const aboutItem = document.getElementById('menuAboutBtn');
    if (aboutItem) aboutItem.addEventListener('click', openOnboardingModal);

    // ЗАКРЫТИЕ ПО ВЫБОРУ — ОДНИМ СЛУШАТЕЛЕМ НА ПАНЕЛИ, А НЕ ПО СЛУШАТЕЛЮ НА
    // ПУНКТ. Так «Сохранить архив» закрывает меню, не будучи здесь упомянутой:
    // её собственный обработчик живёт в surfaces/export.js и этим пакетом не
    // трогается. Порядок при этом не случаен и не важен: оба обработчика висят
    // на разных узлах одного всплытия, окно открывается в любом случае.
    //
    // ИСКЛЮЧЕНИЕ ОБЪЯВЛЕНО АТРИБУТОМ (NAV-P2). Пункты, открывающие окно, панель
    // закрывают: список уходит с дороги того, что открыл. «Обновление» ничего не
    // открывает — оно отвечает прямо в панели, заливкой и строкой исхода, — и
    // закрытие панели убрало бы ответ из-под родителя в момент, когда он
    // появляется. Признак стоит НА КНОПКЕ, а не списком идентификаторов здесь:
    // этот файл намеренно не знает своих строк по именам.
    const panel = document.getElementById('headerMenuPanel');
    if (panel) {
        panel.addEventListener('click', (e) => {
            const pressed = e.target.closest('button');
            if (pressed && !pressed.hasAttribute('data-keeps-menu-open')) closeMenu();
        });
    }

    // Клик мимо — тем же приёмом, что у выпадающего списка профилей
    // (surfaces/profile.js): в шапке уже есть один такой список, и второй,
    // закрывающийся иначе, читался бы как другой предмет.
    document.addEventListener('click', (e) => {
        const menuButton = document.getElementById('menuBtn');
        const menuPanel = document.getElementById('headerMenuPanel');
        if (!menuButton.contains(e.target) && !menuPanel.contains(e.target)) {
            closeMenu();
        }
    });

    // Escape закрывает и ВОЗВРАЩАЕТ ФОКУС НА КНОПКУ. Без возврата фокус остаётся
    // на пункте, который только что перестал существовать для глаза, и следующий
    // Tab уводит родителя в середину страницы — то есть закрытие с клавиатуры
    // теряло бы место, а закрытие мышью нет.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!menuIsOpen()) return;
        closeMenu();
        const menuButton = document.getElementById('menuBtn');
        menuButton.focus();
    });
}
