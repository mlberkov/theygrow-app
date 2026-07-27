// Поверхность: профиль ребёнка — кнопка, dropdown и модалка создания.
//
// Единственное обратное ребро графа инвертировано здесь: switchProfile()
// перестраивает таблицу, но profile.js НЕ импортирует table.js (иначе
// table -> profile -> table). Entry передаёт перестроение в initProfiles().

import {
    profiles,
    currentProfileId,
    initProfileStore,
    setCurrentProfile,
    getCurrentProfile,
    createProfile,
} from '../core/state.js';
import { calculateAge, formatAge } from '../core/format.js';

// Перестроение таблицы после смены профиля. Инжектируется entry в initProfiles();
// до неё switchProfile недостижим (dropdown ещё не построен).
let onProfileSwitched = () => {};

// Инициализация профилей: хранилище и миграции — в core/state.js, обновление
// UI остаётся здесь, за владельцем этих элементов.
export function initProfiles(rebuildTable) {
    onProfileSwitched = rebuildTable;
    initProfileStore();
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

function switchProfile(profileId) {
    setCurrentProfile(profileId);
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

        // Google Analytics event
        trackEvent('profile_click');
    }
}

export function openCreateProfileModal() {
    closeProfileDropdown();
    document.getElementById('createProfileModal').style.display = 'block';
}

function closeCreateProfileModal() {
    document.getElementById('createProfileModal').style.display = 'none';
    document.getElementById('createProfileForm').reset();
}

function createNewProfile(name, birthdate) {
    const newProfile = createProfile(name, birthdate);
    switchProfile(newProfile.id);
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

            // Google Analytics event — без параметров: имя ребёнка — PII,
            // в телеметрию не передаётся (AGENTS.md §4)
            trackEvent('profile_create');
        }
    });
}
