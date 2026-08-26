// Поверхность: профиль ребёнка — кнопка, dropdown и модалка создания.
//
// Единственное обратное ребро графа инвертировано здесь: switchProfile()
// перестраивает таблицу, но profile.js НЕ импортирует table.js (иначе
// table -> profile -> table). Entry передаёт перестроение в initProfiles().

import {
    BACKEND,
    profiles,
    currentProfileId,
    historyBackend,
    setCurrentProfile,
    getCurrentProfile,
    createProfile,
} from '../core/state.js';
import { calculateAge, formatAge } from '../core/format.js';

// Перестроение таблицы после смены профиля. Инжектируется entry в initProfiles();
// до неё switchProfile недостижим (dropdown ещё не построен).
let onProfileSwitched = () => {};

// Инициализация профилей: обновление UI за владельцем этих элементов.
//
// L1-P4: загрузка семьи ушла в core/state.js initHistory(), которую entry
// вызывает раньше — источник данных теперь зависит от того, открылось ли
// нативное хранилище, а этой поверхности такой выбор не принадлежит.
export function initProfiles(rebuildTable) {
    onProfileSwitched = rebuildTable;
    updateProfileButton();
    updateProfileDropdown();
}

function updateProfileButton() {
    const profile = getCurrentProfile();
    const button = document.getElementById('profileName');

    if (profile) {
        let text = profile.name;
        if (profile.birthdate) {
            const age = calculateAge(profile.birthdate);
            if (age) {
                text += ' (' + formatAge(age.years, age.months) + ')';
            }
        }
        button.textContent = text;
    } else {
        button.textContent = 'Малыш (выберите дату)';
    }
}

function updateProfileDropdown() {
    const dropdown = document.getElementById('profileDropdown');
    dropdown.innerHTML = '';

    profiles.forEach(profile => {
        const item = document.createElement('div');
        item.className = 'profile-dropdown-item';
        if (profile.id === currentProfileId) {
            item.classList.add('active');
        }

        let text = profile.name;
        if (profile.birthdate) {
            const age = calculateAge(profile.birthdate);
            if (age) {
                text += ' (' + formatAge(age.years, age.months) + ')';
            }
        }
        item.textContent = text;
        item.onclick = () => switchProfile(profile.id);
        dropdown.appendChild(item);
    });

    const createItem = document.createElement('div');
    createItem.className = 'profile-dropdown-item create-new';
    createItem.textContent = '+ Создать новый профиль';
    createItem.onclick = openCreateProfileModal;
    dropdown.appendChild(createItem);
}

// Асинхронна с L1-P4: на нативном канале смена ребёнка перепроецирует отметки
// из журнала. UI обновляется после того, как проекция готова, — иначе таблица
// перестроилась бы по отметкам предыдущего ребёнка.
async function switchProfile(profileId) {
    await setCurrentProfile(profileId);
    updateProfileButton();
    updateProfileDropdown();
    closeProfileDropdown();
    onProfileSwitched();
}

function openProfileDropdown() {
    document.getElementById('profileDropdown').classList.add('show');
}

function closeProfileDropdown() {
    document.getElementById('profileDropdown').classList.remove('show');
}

function toggleProfileDropdown() {
    const dropdown = document.getElementById('profileDropdown');
    if (dropdown.classList.contains('show')) {
        closeProfileDropdown();
    } else {
        openProfileDropdown();
    }
}

/**
 * Открывает окно создания профиля.
 *
 * L3-P3: `classList.add('show')`, а не инлайновый `style.display` (FIU-DL-002,
 * долг 19). Это единственный элемент с голым классом .modal, который открывался
 * инлайном, и потому единственный, которого не видел
 * app/tests/show-rule-coverage.spec.js: сканер ищет `classList.add('show')` и
 * ничего другого. Пока окно было третьим по важности, это было безобидно; с
 * L3-P2 оно — первый экран свежей установки, и правило, которое его показывает,
 * стоит держать под тем же охраняемым правилом, что и остальные три. Инлайновый
 * стиль вдобавок оставался на элементе навсегда после первого закрытия и
 * перебивал бы .modal.show, если бы кто-то позже открыл окно классом.
 */
export function openCreateProfileModal() {
    closeProfileDropdown();
    document.getElementById('createProfileModal').classList.add('show');
}

/**
 * Спрашивает про ребёнка, если приложение установлено и профиля ещё нет (L3-P2).
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ПОНАДОБИЛОСЬ. До этого пакета первым экраном после
 * установки было предложение перенести историю из браузера — предложение,
 * которое на этом канале не могло сработать никогда (история семьи лежит в
 * localStorage production-origin, а WebView живёт на https://localhost). Оно
 * убрано целиком, решением владельца (FIU-DL-002), и после него у свежей
 * установки остаётся ровно один путь к профилю. Значит, этот путь обязан быть
 * полным и достижимым, а не спрятанным в выпадающем меню и в одной оговорке
 * внутри онбординга, который родитель может закрыть навсегда одной галочкой.
 *
 * ТРИ УСЛОВИЯ, И КАЖДОЕ ОТСЕКАЕТ СВОЙ СЛУЧАЙ.
 *
 *   journal   — только нативный канал. Веб — витрина (PDR-034), его первый
 *               визит этим пакетом не трогается; это ветка ВРЕМЕНИ ВЫПОЛНЕНИЯ,
 *               а не вторая сборка: каналы поставляют одни и те же байты.
 *   не unavailable — хранилище, которое не открылось, попадает на backend
 *               unavailable, и createProfile() там возвращает null. Предложить
 *               форму, которая заведомо откажет, — ровно то, что запрещает
 *               честная деградация (ADR-015) и чего уже не делает дневник.
 *   пусто     — есть хотя бы один ребёнок, и спрашивать не о чем.
 *
 * ОКНО ВЕРНЁТСЯ НА СЛЕДУЮЩЕМ ЗАПУСКЕ, ЕСЛИ ПРОФИЛЬ ТАК И НЕ СОЗДАН, и это
 * решение, а не недосмотр. Условие снимается самим действием и снимается
 * навсегда; работы, поверх которой можно было бы лечь, в этом состоянии ещё
 * нет — приложение без профиля не умеет ничего. Это другой класс, чем
 * онбординг: тот возвращался вечно, пока L3-P3 не решил, что значит его ✕
 * (FIU-DL-001, долг 14 — закрыт), и теперь он не возвращается вовсе, а
 * открывается по «?» в шапке.
 */
export function offerProfileIfNone() {
    if (historyBackend() !== BACKEND.journal) return;
    if (profiles.length > 0) return;
    openCreateProfileModal();
}

function closeCreateProfileModal() {
    document.getElementById('createProfileModal').classList.remove('show');
    document.getElementById('createProfileForm').reset();
}

async function createNewProfile(name, birthdate) {
    const newProfile = await createProfile(name, birthdate);
    if (!newProfile) return;
    await switchProfile(newProfile.id);
}

export function wireProfile() {
    // Обработчики профиля
    document.getElementById('profileButton').addEventListener('click', toggleProfileDropdown);

    // Закрытие dropdown при клике вне его
    document.addEventListener('click', (e) => {
        const profileButton = document.getElementById('profileButton');
        const dropdown = document.getElementById('profileDropdown');
        if (!profileButton.contains(e.target) && !dropdown.contains(e.target)) {
            closeProfileDropdown();
        }
    });

    // Обработчики модального окна создания профиля
    document.getElementById('createProfileClose').addEventListener('click', closeCreateProfileModal);
    document.getElementById('cancelProfile').addEventListener('click', closeCreateProfileModal);
    document.getElementById('createProfileModal').addEventListener('click', (e) => {
        if (e.target.id === 'createProfileModal') {
            closeCreateProfileModal();
        }
    });

    document.getElementById('createProfileForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('childName').value.trim();
        const birthdate = document.getElementById('childBirthdate').value;

        if (name && birthdate) {
            createNewProfile(name, birthdate);
            closeCreateProfileModal();
        }
    });
}
