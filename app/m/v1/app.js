// App entry (A1-P4; split per surface in A1-P5) — the module the shell loads.
//
// This file is wiring and bootstrap only. The feature code lives in
// surfaces/*.js (one file per UI surface) over a shared core/*.js layer; init()
// below keeps the exact statement order the single-file version had, because
// listener registration order relative to buildTableBody() is behaviour.
//
// GRAPH SHAPE. entry -> surfaces/* -> core/*, and it is a DAG: the only
// backward call — switchProfile() rebuilding the table — is inverted by passing
// the rebuild into initProfiles(), so surfaces/profile.js never imports
// surfaces/table.js. Shared mutable state that two surfaces read (the ZPD
// filter flag) lives in core/, not in whichever surface happens to own the
// button. A cycle would in fact evaluate correctly here, but it is not a
// property a later packet should have to re-derive.
//
// BOOT ORDER. <script type="module"> is deferred, so this file executes after
// the document is parsed and before DOMContentLoaded fires — the listener at
// the foot of this file is therefore still registered in time. core/* sits one
// level deeper in the fetch waterfall than in A1-P4 (entry -> surfaces ->
// core); A1-P6 paid that cost by giving the shell a modulepreload hint for
// every non-entry module, which collapsed cold-boot discovery from four waves
// to one. A hint fetches and compiles but never evaluates, so this file is
// still the only evaluation root and boot order is unchanged.
// See A1-DL-006, A1-DL-007.

import { kbReady, initData, showKbLoadError } from './core/kb-boot.js';
import { removeOrphanedAgeFilter } from './core/storage.js';
import { loadCategoryStates } from './surfaces/accordion.js';
import { initProfiles, wireProfile } from './surfaces/profile.js';
import { restoreZpdFilter, wireZpdFilter } from './surfaces/zpd-filter.js';
import { buildTableHeader, buildTableBody, setFixedSkillColumnWidth } from './surfaces/table.js';
import { checkAndShowOnboarding, wireOnboarding } from './surfaces/onboarding.js';
import { wireSkillModal } from './surfaces/skill-modal.js';
import { wireActivities } from './surfaces/activities.js';
import { wireExport } from './surfaces/export.js';
import { initNativeStore } from './store/boot.js';

// Инициализация приложения
function init() {
    initProfiles(buildTableBody);

    // Загрузить сохранённые состояния UI
    loadCategoryStates();

    restoreZpdFilter();

    // Б1-P2: возрастной фильтр заменён ЗБР-фильтром — убрать осиротевшее состояние
    // (идемпотентно; без семантической миграции age-on → zpd-on)
    removeOrphanedAgeFilter();

    buildTableHeader();
    buildTableBody();
    setFixedSkillColumnWidth();

    // Показать онбординг при первом запуске
    checkAndShowOnboarding();

    wireProfile();
    wireZpdFilter();
    wireSkillModal();
    wireActivities();
    wireOnboarding();
    wireExport();
}

// Запуск при загрузке страницы: ждём kb-артефакт, затем строим UI
document.addEventListener('DOMContentLoaded', () => {
    // L1-P2: open the native store when running inside the Capacitor shell.
    // Deliberately not awaited and deliberately unable to throw — on the web it
    // returns 'not-native' before touching anything, and on the device a store
    // that fails to open must not take the tracker down with it. P2 opens the
    // store and writes no family data; the write path is P4.
    initNativeStore();

    kbReady.then((kb) => {
        initData(kb);
        init();
    }).catch(showKbLoadError);
});

// ─────────────────────────────────────────────────────────────────────────────
// Parity-gate seam (A1-P4; re-wired to the surface modules in A1-P5).
// NOT a public API.
//
// Module scope removed the global lexical bindings the parity suite reached
// through (DATA._skillsMap, openSkillModal, ...), and A1-P1-INV-001 needs them
// back. These exports are that seam, and nothing more: no shipped code imports
// this module, so the surface is reachable only by same-origin code that
// deliberately imports this URL — no window.* global is created.
//
// A test-only variant gated on a flag was rejected on purpose: it would make
// the tested build differ from the shipped build, which is the one property the
// parity gate exists to provide. Keep this list minimal; it is not a contract,
// and it may change in any packet.
//
// The split moved four of the seven names out of this file; re-exporting them
// from their new owners keeps the seam identical from the tests' side — same
// URL, same seven names — so A1-P5 touches no file under app/tests/.
// ─────────────────────────────────────────────────────────────────────────────
export { DATA } from './core/kb-boot.js';
export { saveCompletedSkills } from './core/state.js';
export { openSkillModal, closeSkillModal } from './surfaces/skill-modal.js';
export { openCreateProfileModal } from './surfaces/profile.js';
export { openActivitiesModal } from './surfaces/activities.js';
export { openOnboardingModal } from './surfaces/onboarding.js';
