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
import { initHistory, wireStoreLifecycle } from './core/state.js';
import { loadCategoryStates } from './surfaces/accordion.js';
import { initProfiles, offerProfileIfNone, wireProfile } from './surfaces/profile.js';
import { restoreZpdFilter, wireZpdFilter } from './surfaces/zpd-filter.js';
import { buildTableHeader, buildTableBody, setFixedSkillColumnWidth } from './surfaces/table.js';
import { checkAndShowOnboarding, wireOnboarding } from './surfaces/onboarding.js';
import { wireSkillCompletion } from './surfaces/skill-completion.js';
import { wireSkillModal } from './surfaces/skill-modal.js';
import { wireActivities } from './surfaces/activities.js';
import { wireChannel } from './surfaces/channel.js';
import { wireConsent } from './surfaces/consent.js';
import { wireDiary } from './surfaces/diary.js';
import { wireExport } from './surfaces/export.js';
import { initNativeStore } from './store/boot.js';

// Инициализация приложения.
//
// L1-P4: асинхронна, потому что семья теперь может лежать в нативном хранилище.
// Порядок операторов сохранён — регистрация слушателей относительно
// buildTableBody() это поведение, — а загрузка данных встала перед ними: до неё
// у поверхностей нет модели, из которой строить DOM.
async function init(storeOutcome) {
    await initHistory(storeOutcome);

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
    wireDiary();
    wireExport();
    wireSkillCompletion();

    // FIU-P1: хранилище закрывается, когда страница уходит в фон, и открывается
    // снова по первому обращению. Здесь, а не в initHistory: initHistory
    // выполняется и на web-канале, и в тестах, которые вызывают его напрямую, а
    // это — подписка на событие документа, то есть то же самое, что делают
    // wire*-функции выше, и её место среди них.
    wireStoreLifecycle();

    // СПРОСИТЬ ПРО РЕБЁНКА — последним, в том же месте и по той же причине, по
    // которой здесь стояло предложение переноса (FIU-DL-002): окно ложится
    // поверх собранной таблицы, а не поверх пустого экрана. Предложение
    // переноса отсюда убрано целиком — оно было первым, что видела семья после
    // установки, и на этом канале оно было мёртвым с самого начала: истории
    // семьи в localStorage у https://localhost никогда не было. Теперь на
    // первом запуске приложение спрашивает единственное, без чего оно не
    // работает, — о ком вести записи. Не ожидается: создание профиля — решение
    // родителя, а не часть загрузки.
    offerProfileIfNone();
}

// Запуск при загрузке страницы: ждём kb-артефакт, затем строим UI
document.addEventListener('DOMContentLoaded', () => {
    // СОСТАВ ДЕЙСТВИЙ В ШАПКЕ РЕШАЕТСЯ ДО И БЕЗ ДАННЫХ (DIA-P2). Ему не нужны ни
    // kb-артефакт, ни хранилище — только то, в каком канале мы выполняемся, — а
    // отложить его внутрь init() значило бы, что при неудачной загрузке kb канал
    // остаётся несобранным: обе кнопки приходят скрытыми, и на нативном канале
    // родитель не увидел бы архива вообще. Отказ по умолчанию должен сниматься
    // раньше всего, что может не сбыться.
    wireChannel();

    // СОГЛАСИЕ РЕШАЕТСЯ ПЕРВЫМ ЖЕ ДЕЛОМ, И ПО ДВУМ ПРИЧИНАМ (PPR-P2). Посетителю,
    // который уже согласился, аналитика должна начаться без лишнего ожидания —
    // это единственное место, где эта задержка вообще существует, потому что тег
    // больше не создаётся при разборе <head>. А тому, кого ещё не спрашивали,
    // вопрос должен быть виден сразу, а не после того, как загрузится kb: баннер
    // ни от каких данных не зависит, и ставить его в очередь за ними значило бы,
    // что при неудачной загрузке kb вопрос не задан вовсе. Тот же довод, по
    // которому выше стоит wireChannel().
    wireConsent();

    // L1-P2 opened the native store here without awaiting it. L1-P4 AWAITS it,
    // because the answer decides where the family is read from and written to:
    // a store that is still opening would be indistinguishable from one that
    // failed, and the app would boot onto the wrong side of the seam.
    //
    // It still cannot throw — on the web it returns 'not-native' before touching
    // anything, and on the device a store that fails to open returns its reason
    // rather than taking the tracker down. The two waits run together because
    // neither needs the other.
    Promise.all([kbReady, initNativeStore()])
        .then(([kb, storeOutcome]) => {
            initData(kb);
            return init(storeOutcome);
        })
        .catch(showKbLoadError);
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
