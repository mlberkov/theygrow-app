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
// ONE further key exists in the shell and is NOT owned here: `ga_debug` (the
// inline <head> gtag shim, which the inline onclick still needs as a global).
// There were two until L3-P3: `iosInstallDismissed` belonged to the
// install-prompt IIFE, which A1-P5 left inline on purpose because it registered
// `beforeinstallprompt` at parse time and no level of the parity suite could
// observe that event (A1-DL-006 (f)). The IIFE is gone with the offer itself
// (FIU-DL-003), so the exception is gone with it — including from
// DECLARED_SHELL_ACCESSES in app/tests/storage-seam.spec.js, which reds on a
// declared door that no longer exists. The key may still sit in the storage of
// a browser that saw the old shell; nothing reads it, and clearing it would be
// a write this packet has no reason to make.

// LocalStorage ключи
const STORAGE_KEY_PROFILES = 'childDevTracker_profiles';
const STORAGE_KEY_CURRENT = 'childDevTracker_currentProfile';
const STORAGE_KEY_LEGACY = 'childDevTracker_completed'; // Для миграции
const STORAGE_KEY_ACCORDION = 'milestones_accordion_states';
const STORAGE_KEY_FILTER_ZPD = 'milestones_filter_zpd';
const STORAGE_KEY_ONBOARDING_DISMISSED = 'onboarding_dismissed';

// PPR-P2 — the visitor's answer to the analytics question on the web channel.
//
// KEY IDENTITY LIVES HERE AND NOWHERE ELSE, which is this file's whole job, and
// it is the one part of the consent gate's vocabulary that is NOT in
// consent/config.js. The state tokens are there, with changed_in provenance,
// because they are what the gate reasons about; the key is here, with the other
// six, because a second declaration of a key is a second thing to drift and this
// file exists to prevent exactly that. app/tests/consent-gate.spec.js pairs the
// two files so neither can move alone.
//
// FLAT NAME, on the `onboarding_dismissed` precedent rather than the
// `childDevTracker_` or `milestones_` families: it is neither profile data nor a
// filter. It is showcase state about the visitor's own choice — never family
// data, never anything the journal or its schema sees.
const STORAGE_KEY_ANALYTICS_CONSENT = 'analytics_consent';

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

export function readOnboardingDismissed() {
    return localStorage.getItem(STORAGE_KEY_ONBOARDING_DISMISSED);
}

export function writeOnboardingDismissed() {
    localStorage.setItem(STORAGE_KEY_ONBOARDING_DISMISSED, 'true');
}

/**
 * The stored consent answer, raw, or null when nothing was ever stored.
 *
 * RAW, like every other reader here: what the string MEANS is the gate's
 * business (surfaces/consent.js consentState), and it reads anything it does not
 * recognise as undecided. That is fail-closed in both directions — an
 * unrecognised value loads nothing AND asks again — and it only stays fail-closed
 * while the comparison happens in one place.
 */
export function readAnalyticsConsent() {
    return localStorage.getItem(STORAGE_KEY_ANALYTICS_CONSENT);
}

/**
 * Records the visitor's answer.
 *
 * Takes the token rather than hardcoding one, unlike writeOnboardingDismissed():
 * that key has one value and this one has two, and a pair of argument-less
 * writers would put the vocabulary in this file instead of in consent/config.js.
 */
export function writeAnalyticsConsent(state) {
    localStorage.setItem(STORAGE_KEY_ANALYTICS_CONSENT, state);
}

export function removeOrphanedAgeFilter() {
    localStorage.removeItem(STORAGE_KEY_FILTER_AGE_ORPHAN);
}
