// localStorage layer (A1-P4).
//
// The single place any shipped module touches localStorage. Key identity and
// raw get/set/remove live here; parsing, defaults and logging deliberately do
// NOT — they stay at the call sites they occupy today, because those semantics
// are unevenly (and load-bearingly) different: the profiles read throws loudly
// on corrupt JSON, the accordion and ZPD-filter reads catch and warn, and the
// legacy value is parsed only when there are no profiles. Moving parsing in
// here would flatten those differences, which is a behaviour change this
// refactor packet is not allowed to make.
//
// NO KEY IS OWNED OUTSIDE THIS FILE ANY MORE, and the exception list is empty
// for the first time since A1-P4. There were two. `iosInstallDismissed` belonged
// to the install-prompt IIFE, which A1-P5 left inline on purpose because it
// registered `beforeinstallprompt` at parse time and no level of the parity
// suite could observe that event (A1-DL-006 (f)); the IIFE went with the offer
// itself (FIU-DL-003). `ga_debug` belonged to the inline <head> gtag shim, and
// UIP-P1 removed the shim together with the whole analytics surface. Both are
// gone from DECLARED_SHELL_ACCESSES in app/tests/storage-seam.spec.js, which
// reds on a declared door that no longer exists. Either key may still sit in the
// storage of a browser that saw an older shell; nothing reads either one, and
// clearing them would be a write this packet has no reason to make.
//
// A THIRD KEY JOINS THAT LIST AT UIP-P3, and it left from INSIDE this file
// rather than from the shell. `onboarding_dismissed` recorded that the intro
// window had been read, and its only reader was the boot-time auto-open. The
// owner retired the auto-open (2026-08-25): the window now opens only from the
// header control, so nothing asks the question the key answered. The reader went
// first and the writer had to go with it — a key written on every close and read
// by nobody is a write into a parent's browser with no purpose behind it. The
// values already sitting in browsers are left exactly where they are, for the
// same reason as the two above: clearing them is also a write.

// LocalStorage ключи
const STORAGE_KEY_PROFILES = 'childDevTracker_profiles';
const STORAGE_KEY_CURRENT = 'childDevTracker_currentProfile';
const STORAGE_KEY_LEGACY = 'childDevTracker_completed'; // Для миграции
const STORAGE_KEY_ACCORDION = 'milestones_accordion_states';
const STORAGE_KEY_FILTER_ZPD = 'milestones_filter_zpd';

// Б1-P2 leftover, removed on every init (see the caller). Named here so every
// key this app writes or clears is declared in one file.
const STORAGE_KEY_FILTER_AGE_ORPHAN = 'milestones_filter_age';

export function readProfilesRaw() {
    return localStorage.getItem(STORAGE_KEY_PROFILES);
}

export function writeProfilesJson(profiles) {
    localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(profiles));
}

export function readCurrentProfileId() {
    return localStorage.getItem(STORAGE_KEY_CURRENT);
}

export function writeCurrentProfileId(profileId) {
    localStorage.setItem(STORAGE_KEY_CURRENT, profileId);
}

export function readLegacyCompletedRaw() {
    return localStorage.getItem(STORAGE_KEY_LEGACY);
}

export function readAccordionStatesRaw() {
    return localStorage.getItem(STORAGE_KEY_ACCORDION);
}

export function writeAccordionStatesJson(states) {
    localStorage.setItem(STORAGE_KEY_ACCORDION, JSON.stringify(states));
}

export function readZpdFilterRaw() {
    return localStorage.getItem(STORAGE_KEY_FILTER_ZPD);
}

export function writeZpdFilterJson(isActive) {
    localStorage.setItem(STORAGE_KEY_FILTER_ZPD, JSON.stringify(isActive));
}

export function removeOrphanedAgeFilter() {
    localStorage.removeItem(STORAGE_KEY_FILTER_AGE_ORPHAN);
}
