// Поверхность: отметка навыка освоенным и счётчик категории.
//
// Отделено от table.js не по размеру, а по роли: table.js строит DOM, этот
// модуль его мутирует. Разделение заодно убирает ребро table -> profile:
// честная деградация без профиля (ADR-015) живёт здесь.

import { getCurrentProfile, getCompletedSkills, saveCompletedSkills } from '../core/state.js';
import { getSkillRowsForCategory } from '../core/dom-utils.js';
import { refreshAllZpdReadiness } from '../core/zpd.js';
import { openCreateProfileModal } from './profile.js';
import { applyFilter } from './zpd-filter.js';

// Обновление счётчика навыков категории
function updateCategoryCounter(skillRow) {
    // Найти родительскую категорию
    let categoryRow = skillRow.previousElementSibling;
    while (categoryRow && !categoryRow.classList.contains('category-row')) {
        categoryRow = categoryRow.previousElementSibling;
    }

    if (!categoryRow) return;

    // Получить все навыки этой категории
    const skillRows = getSkillRowsForCategory(categoryRow);

    // Посчитать освоенные/всего
    const totalSkills = skillRows.length;
    const completedSkills = skillRows.filter(row => {
        const checkbox = row.querySelector('input[type="checkbox"]');
        return checkbox && checkbox.checked;
    }).length;

    // Обновить счётчик в атрибуте первой ячейки
    const firstCell = categoryRow.querySelector('td');
    if (firstCell) {
        firstCell.setAttribute('data-skills-count', `[${completedSkills}/${totalSkills}]`);
    }
}

// Переключение состояния навыка
export function toggleSkillCompletion(skillId, isCompleted) {
    // Честная деградация (ADR-015): без профиля отметку сохранять некуда.
    // Раньше запись молча терялась, а чекбокс оставался отмеченным — DOM
    // расходился с состоянием, и ЗБР-фильтр показывал уже отмеченные навыки.
    // Теперь отметка откатывается, а пользователю предлагается создать профиль.
    // GA-событие не отправляется: действие не состоялось.
    if (!getCurrentProfile()) {
        const rejectedRow = document.querySelector(`tr[data-skill-id="${skillId}"]`);
        const rejectedCheckbox = rejectedRow && rejectedRow.querySelector('input[type="checkbox"]');
        if (rejectedCheckbox) rejectedCheckbox.checked = !isCompleted;
        openCreateProfileModal();
        return;
    }

    const completedSkills = getCompletedSkills();

    if (isCompleted) {
        completedSkills.add(skillId);

        // Google Analytics event - skill completed
        trackEvent('skill_complete', { skill_id: skillId, action: 'marked_complete' });
    } else {
        completedSkills.delete(skillId);

        // Google Analytics event - skill uncompleted
        trackEvent('skill_complete', { skill_id: skillId, action: 'marked_incomplete' });
    }

    saveCompletedSkills(completedSkills);

    // Найти строку навыка и обновить её напрямую (без перестроения таблицы)
    const skillRow = document.querySelector(`tr[data-skill-id="${skillId}"]`);
    if (skillRow) {
        // Обновить класс строки
        if (isCompleted) {
            skillRow.classList.add('skill-completed');
        } else {
            skillRow.classList.remove('skill-completed');
        }

        // Обновить классы ячеек месяцев
        const startMonth = parseInt(skillRow.dataset.startMonth);
        const endMonth = parseInt(skillRow.dataset.endMonth);

        skillRow.querySelectorAll('td.col-month').forEach(td => {
            const month = parseInt(td.dataset.month);
            if (month >= startMonth && month <= endMonth) {
                if (isCompleted) {
                    td.classList.remove('cell-active');
                    td.classList.add('cell-completed');
                } else {
                    td.classList.remove('cell-completed');
                    td.classList.add('cell-active');
                }
            }
        });

        // Обновить счётчик категории
        updateCategoryCounter(skillRow);

        // ZPD: пересчитать готовность по всем строкам на месте — переключение
        // влияет на готовность зависимых навыков, а не только текущего
        refreshAllZpdReadiness(completedSkills);

        // Применить фильтры, если они активны (обновит видимость без перестроения DOM)
        applyFilter();
    }
}
