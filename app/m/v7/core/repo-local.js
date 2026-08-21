// The localStorage side of the history seam (L1-P4).
//
// This is the web channel's whole world, and it is TODAY'S BEHAVIOUR MOVED, not
// rewritten: the parsing, the two migrations and their differing error postures
// came out of core/state.js unchanged, because the parity suite is the gate for
// this half and a behaviour change here would show up as a moved baseline rather
// than as a caught bug.
//
// Both migrations belong to localStorage and stay here rather than in the seam:
// the legacy `childDevTracker_completed` key and the lowercase→uppercase skill
// ids are facts about how this app used to write to a browser, and the native
// store has never held either.
//
// EVERY WRITE HERE IS SYNCHRONOUS, and returns an already-resolved promise. That
// is deliberate and load-bearing. The seam is async because the native store is,
// but `app/tests/behavior.spec.js` reads localStorage straight after a click and
// `app/tests/visual.spec.js` drives the persist path through the parity seam —
// so on this channel the value must be in storage before the handler yields, and
// the promise exists only to give the two repos one shape.

import {
    readCurrentProfileId,
    readLegacyCompletedRaw,
    readProfilesRaw,
    writeCurrentProfileId,
    writeProfilesJson,
} from './storage.js';

/**
 * Reads the family out of localStorage, applying both legacy migrations.
 *
 * Lifted verbatim from `initProfileStore()`: the profiles read still throws
 * loudly on corrupt JSON rather than silently starting an empty family, which is
 * the honest posture — a parse that swallows the error hands the parent a blank
 * app and no reason.
 */
export function loadHistory() {
    let profiles = [];
    const savedProfiles = readProfilesRaw();
    const savedCurrent = readCurrentProfileId();

    if (savedProfiles) {
        profiles = JSON.parse(savedProfiles);
    }

    // Миграция старых данных
    const legacyData = readLegacyCompletedRaw();
    if (legacyData && profiles.length === 0) {
        const legacyCompleted = JSON.parse(legacyData);
        profiles.push({
            id: 'profile_' + Date.now(),
            name: 'Профиль по умолчанию',
            birthdate: null,
            completedSkills: legacyCompleted,
        });
        writeProfilesJson(profiles);
    }

    let currentProfileId = null;
    if (savedCurrent && profiles.find((p) => p.id === savedCurrent)) {
        currentProfileId = savedCurrent;
    } else if (profiles.length > 0) {
        currentProfileId = profiles[0].id;
        writeCurrentProfileId(currentProfileId);
    }

    // МИГРАЦИЯ: преобразование ID из нижнего регистра в верхний
    let needsSave = false;
    profiles.forEach((profile) => {
        if (profile.completedSkills) {
            profile.completedSkills = profile.completedSkills.map((id) => {
                if (id !== id.toUpperCase()) {
                    needsSave = true;
                    return id.toUpperCase();
                }
                return id;
            });
        }
    });
    if (needsSave) {
        writeProfilesJson(profiles);
        // eslint-disable-next-line no-console
        console.log('Migrated skill IDs to uppercase');
    }

    return { profiles, currentProfileId };
}

/**
 * Which child the parent was last looking at.
 *
 * Read on BOTH backends: the selection is a pointer, not history — the same
 * class of thing as the accordion state — so it lives behind the one declared
 * Web Storage door (LSC-P1-INV-001) rather than taking a slot in a frozen
 * schema. On the journal backend the value is a child id.
 */
export function loadSelection() {
    return readCurrentProfileId();
}

/** Persists the whole profile array, as this channel always has. */
export function saveHistory(profiles) {
    writeProfilesJson(profiles);
    return Promise.resolve();
}

export function saveCurrent(profileId) {
    writeCurrentProfileId(profileId);
    return Promise.resolve();
}

/**
 * Records a mark by rewriting the profile's completed list.
 *
 * On this channel a mark is still a string in an array — there is no journal in
 * a browser, so there is no author, no event date and no confirmation to record.
 * That difference is the divergence L1-P4 documents rather than hides.
 */
export function markSkill(profiles, profile, skillId, observed) {
    const completed = new Set(profile.completedSkills || []);
    if (observed) {
        completed.add(skillId);
    } else {
        completed.delete(skillId);
    }
    profile.completedSkills = [...completed];
    writeProfilesJson(profiles);
    return Promise.resolve(completed);
}

export function createChild(profiles, name, birthdate) {
    const child = {
        id: 'profile_' + Date.now(),
        name,
        birthdate,
        completedSkills: [],
    };
    profiles.push(child);
    writeProfilesJson(profiles);
    return Promise.resolve(child);
}
