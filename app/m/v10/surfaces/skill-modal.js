// Поверхность: модальное окно деталей навыка (#skillModal) и рендеры его секций.
//
// ВНИМАНИЕ: шаблонный литерал в openSkillModal НЕ выровнен по месту — его
// содержимое попадает в DOM дословно, и деддент менял разметку (A1-DL-005 (h)).
// В A1-P5 он переехал сюда без единого изменения отступа.

import { DATA } from '../core/kb-boot.js';
import { getCompletedSkills } from '../core/state.js';
import { formatParentActivities } from '../core/format.js';
import { isSkillReady } from '../core/zpd.js';

// Вспомогательная функция: преобразование prerequisites в HTML
function getPrerequisitesHtml(prerequisites, completedSkills) {
    if (!prerequisites || prerequisites.length === 0) {
        return '';
    }
    const skillSpans = prerequisites.map(id => {
        const skill = DATA._skillsMap[id];
        const done = completedSkills.has(id);
        const marker = `<span class="prereq-marker ${done ? 'prereq-marker-done' : 'prereq-marker-todo'}">${done ? '✓' : '○'}</span>`;
        if (skill) {
            return `${marker} <span class="prerequisite-skill" data-skill-id="${id}" data-relation="prerequisite">${skill.name}</span>`;
        }
        return `${marker} ${id}`;
    });
    return `<h3>Требуемые навыки</h3><p>${skillSpans.join(', ')}</p>`;
}

// Pure read: обратные пререквизиты. Возвращает навыки, перечисляющие skillId
// в своём prerequisites (прямые зависимые, порядок датасета — стабильно).
// Источник рёбер — поля prerequisites (тот же, что impactById/isSkillReady);
// top-level edges в kb.milestones отсутствует (адаптер его в DATA и не переносил).
// Ничего не пишет обратно в DATA / _skillsMap.
function getDownstreamSkills(skillId) {
    const downstream = [];
    for (const category in DATA.milestones) {
        DATA.milestones[category].forEach(skill => {
            if ((skill.prerequisites || []).includes(skillId)) {
                downstream.push(skill);
            }
        });
    }
    return downstream;
}

// Рендер секции «Открывает дальше», зеркало getPrerequisitesHtml. Навыки
// берутся из DATA.milestones — id всегда валиден (fallback не нужен).
// Лист графа (нет зависимых) → '' (честная пустота через отсутствие).
function getDownstreamHtml(skillId) {
    const downstream = getDownstreamSkills(skillId);
    if (downstream.length === 0) {
        return '';
    }
    const skillSpans = downstream.map(skill => {
        return `<span class="prerequisite-skill" data-skill-id="${skill.id}" data-relation="downstream">${skill.name}</span>`;
    });
    return `<h3>Открывает дальше</h3><p>${skillSpans.join(', ')}</p>`;
}

// Рендер блока «Почему сейчас» — статус готовности (band-first, ADR-018).
// isSkillReady — единственный авторитет готовности: чистый граф prerequisites,
// без возраста и биологических окон. Язык популяционный и ненормативный:
// приглашение, не дедлайн; никакого сравнения с нормой.
function getReadinessHtml(skill, completedSkills) {
    // освоен
    if (completedSkills.has(skill.id)) {
        return `<h3>Почему сейчас</h3><p class="readiness readiness-done">✓ Этот навык отмечен как освоенный.</p>`;
    }
    // готов к освоению (предикат ADR-018)
    if (isSkillReady(skill, completedSkills)) {
        const body = (skill.prerequisites && skill.prerequisites.length)
            ? 'Готов к освоению — все предпосылки выполнены.'
            : 'Готов к освоению.';
        return `<h3>Почему сейчас</h3><p class="readiness readiness-ready">${body}</p>`;
    }
    // откроется, когда — только НЕосвоенные прямые предпосылки, кликабельны
    const missing = (skill.prerequisites || []).filter(p => !completedSkills.has(p));
    const spans = missing.map(id => {
        const s = DATA._skillsMap[id];
        return s ? `<span class="prerequisite-skill" data-skill-id="${id}" data-relation="readiness">${s.name}</span>` : id;
    });
    return `<h3>Почему сейчас</h3><p class="readiness readiness-blocked">Откроется, когда будут освоены: ${spans.join(', ')}.</p>`;
}

// ИСТОРИЯ ПОСЕЩЁННЫХ КАРТОЧЕК, а не «цепочка предпосылок» (профиль и текущий
// профиль живут в core/state.js).
//
// ЧТО ЗДЕСЬ НАКАПЛИВАЕТСЯ, ИЗМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО (NAV-P3). Сюда кладётся
// КАЖДЫЙ переход с карточки на карточку, по любой из ТРЁХ разновидностей
// ссылок, которые рисуются одним и тем же классом .prerequisite-skill:
// «Требуемые навыки» (data-relation=prerequisite), «Открывает дальше»
// (downstream) и «Откроется, когда» (readiness). То есть след — это посещённые
// КАРТОЧКИ, и он может вести вниз по графу так же, как вверх. Называть его
// «шагом по цепочке предпосылок» неверно: владелец наблюдал переход по
// «Открывает дальше», и чтение обработчика ниже это подтверждает.
let skillModalHistory = [];

// ОДИН КОНТРОЛ С ДВУМЯ СОСТОЯНИЯМИ (NAV-P3, решение владельца 2026-08-29).
//
// Пакет убирал «стрелки назад внутри окон» — они существовали потому, что
// аппаратная кнопка «назад» не работала, а теперь работает. Здесь решение
// владельца иное и принято после того, как механика была измерена: у этого окна
// стрелка была ЕДИНСТВЕННЫМ контролом и делала ДВА разных дела. Заменить её
// простым закрытием значило бы отнять у веб-канала шаг назад по посещённым
// карточкам вовсе — на вебе аппаратной кнопки нет. Поэтому контрол остаётся
// один и на том же месте, но честно называет то, что сделает СЕЙЧАС: знак и
// доступное имя переключаются вместе.
const STEP_BACK_GLYPH = '↩';
const CLOSE_GLYPH = '×';
const STEP_BACK_NAME = 'К предыдущей карточке';
const CLOSE_NAME = 'Закрыть';

/**
 * Приводит контрол окна в состояние, соответствующее следу посещённых карточек.
 *
 * Знак и имя ставятся ОДНОЙ функцией и всегда парой: знак, обещающий возврат,
 * над обработчиком, который закроет окно, — это ровно тот разрыв между видимым
 * и исполняемым, который стрелка здесь и создавала.
 */
function refreshSkillModalControl() {
    const control = document.getElementById('skillModalClose');
    if (!control) return;
    const stepsBack = skillModalHistory.length > 0;
    control.textContent = stepsBack ? STEP_BACK_GLYPH : CLOSE_GLYPH;
    control.setAttribute('aria-label', stepsBack ? STEP_BACK_NAME : CLOSE_NAME);
    control.setAttribute('title', stepsBack ? STEP_BACK_NAME : CLOSE_NAME);
}

// Модальное окно деталей навыка
export function openSkillModal(skill, addToHistory = true, source = 'unknown') {
    // `source` не читается с UIP-P1 — см. комментарий у closeSkillModal ниже.
    void source;
    const modal = document.getElementById('skillModal');
    const modalBody = document.getElementById('skillModalBody');
    const completedSkills = getCompletedSkills();

    // Если модальное окно уже открыто и нужно сохранить в историю
    if (addToHistory && modal.style.display === 'block') {
        const currentSkillId = modalBody.querySelector('h2')?.getAttribute('data-skill-id');
        if (currentSkillId) {
            const currentSkill = DATA._skillsMap[currentSkillId];
            if (currentSkill) {
                skillModalHistory.push(currentSkill);
            }
        }
    }

    modalBody.innerHTML = `
                <h2 data-skill-id="${skill.id}">${skill.name}</h2>
                <p class="period">Период: ${skill.age_start_months}–${skill.age_end_months} месяцев</p>

                <h3>Диагностические признаки</h3>
                <p>${skill.assessment_criteria}</p>

                ${getReadinessHtml(skill, completedSkills)}

                ${getPrerequisitesHtml(skill.prerequisites, completedSkills)}

                ${getDownstreamHtml(skill.id)}

                <h3>Естественное освоение</h3>
                <p>${skill.additional_info.natural_acquisition}</p>

                <h3 class="potential-issues">Потенциальные проблемы</h3>
                <p class="potential-issues">${skill.additional_info.potential_issues}</p>

                <h3>Активности для родителей</h3>
                ${formatParentActivities(skill.additional_info.parent_activities)}

                <h3>Медицинская консультация</h3>
                <p>${skill.additional_info.medical_consultation}</p>
            `;

    modal.style.display = 'block';
    refreshSkillModalControl();
}

/**
 * `action` НИЧЕГО НЕ ЧИТАЕТ С UIP-P1, И ПАРАМЕТР ОСТАВЛЕН НАМЕРЕННО. Он
 * существовал ради одного поля события skill_modal_close ('close_button' |
 * 'backdrop'); события больше нет. Сигнатура сохранена, потому что и эта
 * функция, и openSkillModal ниже реэкспортируются шва ради (app.js) — арность
 * экспортированной функции наблюдаема снаружи, и менять её в пакете про
 * аналитику значило бы менять не тот предмет. То же относится к третьему
 * аргументу openSkillModal.
 */
export function closeSkillModal(action = 'backdrop') {
    void action;
    const modal = document.getElementById('skillModal');
    modal.style.display = 'none';
    skillModalHistory = []; // Очистить историю при закрытии
    // Следующее открытие начинается с пустого следа, значит с «Закрыть». Знак
    // ставится здесь, а не только при открытии: окно закрывают и щелчком по
    // фону, и аппаратной кнопкой, и после них контрол не должен остаться
    // стрелкой до следующего открытия.
    refreshSkillModalControl();
}

/**
 * ЕДИНСТВЕННОЕ ДЕЙСТВИЕ КОНТРОЛА ОКНА, и то же самое, что аппаратная кнопка
 * «назад» делает с этим окном.
 *
 * Семантика не изменилась с DIA-времён: есть посещённые карточки — вернуться на
 * предыдущую; нет — закрыть окно. Изменилось то, что контрол теперь ГОВОРИТ,
 * какая из двух веток сейчас исполнится (refreshSkillModalControl выше).
 *
 * Экспортируется не ради второго вызывающего в продукте, а потому, что
 * app/tests/behavior.spec.js проверяет обе ветки как поведение; сама
 * аппаратная кнопка приходит сюда иначе — она НАЖИМАЕТ этот контрол
 * (nav/overlays.js), поэтому у окна нет второго пути закрытия.
 */
export function navigateBackOrCloseSkillModal() {
    if (skillModalHistory.length > 0) {
        // Есть след — вернуться к предыдущей ПОСЕЩЁННОЙ карточке; openSkillModal
        // сама переставит знак, когда след укоротится.
        const previousSkill = skillModalHistory.pop();
        openSkillModal(previousSkill, false, 'back_navigation');
    } else {
        // След пуст — закрыть окно
        closeSkillModal('close_button');
    }
}

export function wireSkillModal() {
    // Обработчики модального окна деталей навыка
    const windowControl = document.getElementById('skillModalClose');
    windowControl.addEventListener('click', navigateBackOrCloseSkillModal);
    // КЛАВИАТУРА. Контрол — <span>, а не <button>, и таким он приехал из самой
    // ранней разметки этого продукта. Пока он был безымянным знаком, это было
    // просто упущение; с NAV-P3 у него есть ДОСТУПНОЕ ИМЯ, которое меняется, —
    // а имя, которого нельзя достичь и нажать, не имя. role + tabindex + эти
    // две клавиши — минимум, который делает объявленное исполнимым. Ни один
    // другой крестик этим пакетом не тронут.
    windowControl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        navigateBackOrCloseSkillModal();
    });
    refreshSkillModalControl();
    document.getElementById('skillModal').addEventListener('click', (e) => {
        if (e.target.id === 'skillModal') {
            closeSkillModal();
        }
    });

    // Обработчик кликов на пререквизитные навыки в модальном окне
    document.getElementById('skillModal').addEventListener('click', (e) => {
        if (e.target.classList.contains('prerequisite-skill')) {
            const skillId = e.target.getAttribute('data-skill-id');
            const skill = DATA._skillsMap[skillId];
            if (skill) {
                // ЧТО ЗДЕСЬ ПЕРЕЖИЛО UIP-P1 И ПОЧЕМУ, ТОЧНО. Рядом стояли
                // fromId/fromSkill: они читали h2 источника ДО openSkillModal
                // (иначе заголовок затирался) и существовали только ради
                // параметров события graph_navigate, которого больше нет —
                // сняты. `relation` остался, но не потому, что его кто-то
                // читает: он собирает третий аргумент вызова ниже, а этот
                // аргумент — параметр `source`, помеченный в openSkillModal как
                // непрочитанный (`void source`). Снять `relation` в этом пакете
                // значило бы менять форму экспортированного вызова, что не его
                // предмет; при удалении вызов падал с ReferenceError, и это
                // поймали исполняющие тесты, а не чтение.
                const relation = e.target.getAttribute('data-relation') || 'unknown';
                openSkillModal(skill, true, `${relation}_chip`);
            }
        }
    });
}
