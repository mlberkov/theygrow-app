// Profile store (A1-P4).
//
// Owns the family's profiles and which one is current, plus the two storage
// migrations (legacy `childDevTracker_completed` -> a default profile, and
// lowercase -> uppercase skill ids). Keys, value shapes and migration
// behaviour are unchanged by the move.
//
// `profiles` and `currentProfileId` are exported as live `let` bindings and are
// assigned ONLY in this module; callers mutate profile objects and go through
// the functions below for everything else.
//
// UI is not this module's business: initProfileStore() is the storage half of
// what used to be initProfiles(), and the two UI refreshes stay with the entry
// module that owns those elements.

import {
    readProfilesRaw,
    writeProfilesJson,
    readCurrentProfileId,
    writeCurrentProfileId,
    readLegacyCompletedRaw,
} from './storage.js';

// Состояние приложения
export let profiles = [];
export let currentProfileId = null;

// Инициализация и миграция данных
export function initProfileStore() {
    const savedProfiles = readProfilesRaw();
    const savedCurrent = readCurrentProfileId();

    if (savedProfiles) {
        profiles = JSON.parse(savedProfiles);
    }

    // Миграция старых данных
    const legacyData = readLegacyCompletedRaw();
    if (legacyData && profiles.length === 0) {
        const legacyCompleted = JSON.parse(legacyData);
        const defaultProfile = {
            id: 'profile_' + Date.now(),
            name: 'Профиль по умолчанию',
            birthdate: null,
            completedSkills: legacyCompleted
        };
        profiles.push(defaultProfile);
        saveProfiles();
    }

    if (savedCurrent && profiles.find(p => p.id === savedCurrent)) {
        currentProfileId = savedCurrent;
    } else if (profiles.length > 0) {
        currentProfileId = profiles[0].id;
        writeCurrentProfileId(currentProfileId);
    }


    // МИГРАЦИЯ: преобразование ID из нижнего регистра в верхний
    let needsSave = false;
    profiles.forEach(profile => {
        if (profile.completedSkills) {
            const migrated = profile.completedSkills.map(id => {
                if (id !== id.toUpperCase()) {
                    needsSave = true;
                    return id.toUpperCase();
                }
                return id;
            });
            profile.completedSkills = migrated;
        }
    });
    if (needsSave) {
        saveProfiles();
        console.log('Migrated skill IDs to uppercase');
    }
}

export function saveProfiles() {
    writeProfilesJson(profiles);
}

export function getCurrentProfile() {
    return profiles.find(p => p.id === currentProfileId) || null;
}

export function getCompletedSkills() {
    const profile = getCurrentProfile();
    return profile ? new Set(profile.completedSkills || []) : new Set();
}

// Возвращает true, если состояние действительно записано в профиль.
// Без текущего профиля записывать некуда — вызывающая сторона обязана
// отработать отказ честно (ADR-015), а не считать запись состоявшейся.
export function saveCompletedSkills(completedSet) {
    const profile = getCurrentProfile();
    if (!profile) return false;
    profile.completedSkills = [...completedSet];
    saveProfiles();
    return true;
}

export function createProfile(name, birthdate) {
    const newProfile = {
        id: 'profile_' + Date.now(),
        name: name,
        birthdate: birthdate,
        completedSkills: []
    };
    profiles.push(newProfile);
    saveProfiles();
    return newProfile;
}

// Assigns the current profile and persists the choice. The single place
// currentProfileId is written; UI refreshes are the caller's business.
export function setCurrentProfile(profileId) {
    currentProfileId = profileId;
    writeCurrentProfileId(currentProfileId);
}
