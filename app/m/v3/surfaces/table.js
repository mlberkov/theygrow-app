// Поверхность: сетка навыков — заголовок, тело, строка навыка и измерение
// ширины sticky-колонки.
//
// setFixedSkillColumnWidth измеряет реальный текст, поэтому визуальные baseline
// парити-сьюта валидны только внутри закреплённого контейнера — эта функция
// и есть причина platform pin (docs/RUNBOOK.md).

import { DATA, MIN_MONTH, MAX_MONTH, CATEGORIES } from '../core/kb-boot.js';
import { getCurrentProfile, getCompletedSkills } from '../core/state.js';
import { calculateCurrentLifeMonth } from '../core/format.js';
import { setRowZpdReadiness } from '../core/dom-utils.js';
import { isSkillReady } from '../core/zpd.js';
import { applyFilter } from './zpd-filter.js';
import { initMobileAccordion } from './accordion.js';
import { openSkillModal } from './skill-modal.js';
import { toggleSkillCompletion } from './skill-completion.js';

// Построение заголовка таблицы
export function buildTableHeader() {
    const thead = document.getElementById('tableHead');
    const tr = document.createElement('tr');

    const thSkill = document.createElement('th');
    thSkill.className = 'col-skill';
    thSkill.textContent = 'Навык';
    tr.appendChild(thSkill);

    const thDone = document.createElement('th');
    thDone.className = 'col-done';
    thDone.textContent = '✓';
    tr.appendChild(thDone);

    for (let m = MIN_MONTH; m <= MAX_MONTH; m++) {
        const th = document.createElement('th');
        th.className = 'col-month';
        th.textContent = m;
        th.dataset.month = m;
        tr.appendChild(th);
    }

    thead.appendChild(tr);
}

// Построение тела таблицы с подсветкой текущего месяца
export function buildTableBody() {
    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = '';

    const fragment = document.createDocumentFragment();
    const completedSkills = getCompletedSkills();

    // Определяем текущий месяц жизни
    const profile = getCurrentProfile();
    const currentLifeMonth = profile && profile.birthdate ?
        calculateCurrentLifeMonth(profile.birthdate) : null;

    CATEGORIES.forEach(category => {
        const categoryRow = document.createElement('tr');
        categoryRow.className = 'category-row';

        // Sticky ячейка с названием категории
        const categorySkillCell = document.createElement('td');
        categorySkillCell.className = 'col-skill';
        categorySkillCell.textContent = category;
        categoryRow.appendChild(categorySkillCell);

        // Sticky пустая ячейка для колонки "✓"
        const categoryDoneCell = document.createElement('td');
        categoryDoneCell.className = 'col-done';
        categoryRow.appendChild(categoryDoneCell);

        // Пустые ячейки для всех месяцев
        for (let m = MIN_MONTH; m <= MAX_MONTH; m++) {
            const td = document.createElement('td');
            td.className = 'col-month';
            td.dataset.month = m;
            categoryRow.appendChild(td);
        }

        fragment.appendChild(categoryRow);

        const skills = DATA.milestones[category] || [];
        skills.forEach(skill => {
            const row = createSkillRow(skill, completedSkills, currentLifeMonth);
            fragment.appendChild(row);
        });
    });

    tbody.appendChild(fragment);
    applyFilter();

    // Инициализация мобильного accordion после построения таблицы
    if (window.innerWidth <= 767) {
        initMobileAccordion();
    }
}

// Создание строки навыка
function createSkillRow(skill, completedSkills, currentLifeMonth) {
    const tr = document.createElement('tr');
    tr.dataset.skillId = skill.id;
    tr.dataset.startMonth = skill.age_start_months;
    tr.dataset.endMonth = skill.age_end_months;

    const tdSkill = document.createElement('td');
    tdSkill.className = 'col-skill';
    tdSkill.textContent = skill.name;
    tdSkill.onclick = () => openSkillModal(skill, true, 'table_row');
    tr.appendChild(tdSkill);

    const isCompleted = completedSkills.has(skill.id);
    if (isCompleted) {
        tr.classList.add('skill-completed');
    }

    // ZPD: маркер готовности навыка (ADR-018), невидимый до P2/P3
    setRowZpdReadiness(tr, isSkillReady(skill, completedSkills));

    const tdDone = document.createElement('td');
    tdDone.className = 'col-done checkbox-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isCompleted;
    checkbox.onchange = (e) => {
        e.stopPropagation(); // Предотвратить всплытие события к category-row
        toggleSkillCompletion(skill.id, checkbox.checked);
    };
    checkbox.onclick = (e) => {
        e.stopPropagation(); // Предотвратить всплытие клика к category-row
    };
    tdDone.appendChild(checkbox);
    tr.appendChild(tdDone);

    for (let m = MIN_MONTH; m <= MAX_MONTH; m++) {
        const td = document.createElement('td');
        td.className = 'col-month';
        td.dataset.month = m;

        if (m >= skill.age_start_months && m <= skill.age_end_months) {
            if (isCompleted) {
                td.classList.add('cell-completed');
            } else {
                td.classList.add('cell-active');
            }
        }

        // Подсветка текущего месяца жизни
        if (currentLifeMonth && m === currentLifeMonth) {
            td.classList.add('current-month-col');
        }

        tr.appendChild(td);
    }

    return tr;
}

// Функция для расчета и установки фиксированной ширины колонки навыков
export function setFixedSkillColumnWidth() {
    // Создаем временный элемент для измерения текста
    const tempDiv = document.createElement('div');
    tempDiv.style.position = 'absolute';
    tempDiv.style.visibility = 'hidden';
    tempDiv.style.whiteSpace = 'nowrap';
    tempDiv.style.fontSize = window.getComputedStyle(document.body).fontSize;
    tempDiv.style.fontFamily = window.getComputedStyle(document.body).fontFamily;
    tempDiv.style.paddingLeft = '10px';
    tempDiv.style.paddingRight = '8px';
    document.body.appendChild(tempDiv);

    let maxWidth = 0;

    // Проходим по всем категориям и навыкам
    CATEGORIES.forEach(category => {
        tempDiv.textContent = category;
        maxWidth = Math.max(maxWidth, tempDiv.offsetWidth);

        const skills = DATA.milestones[category] || [];
        skills.forEach(skill => {
            tempDiv.textContent = skill.name;
            maxWidth = Math.max(maxWidth, tempDiv.offsetWidth);
        });
    });

    document.body.removeChild(tempDiv);

    // Добавляем небольшой запас
    const skillColWidth = Math.ceil(maxWidth) + 2;

    // Устанавливаем CSS переменные
    document.documentElement.style.setProperty('--skill-col-width', skillColWidth + 'px');
    document.documentElement.style.setProperty('--done-col-left', skillColWidth + 'px');
}
