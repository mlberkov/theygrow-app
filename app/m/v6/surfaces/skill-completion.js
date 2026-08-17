// Поверхность: отметка навыка освоенным и счётчик категории.
//
// Отделено от table.js не по размеру, а по роли: table.js строит DOM, этот
// модуль его мутирует. Разделение заодно убирает ребро table -> profile:
// честная деградация без профиля (ADR-015) живёт здесь.

import { canRecord, getCurrentProfile, getCompletedSkills, markSkill } from '../core/state.js';
import { emitSignal } from '../core/signals.js';
import { storeFailureCode } from '../store/boot.js';
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

// Хранилище не открылось: сказать об этом прямо.
//
// Молчаливый откат галочки — это ровно та рассинхронизация DOM и данных,
// которую честная деградация здесь и убирает: родитель должен узнать, что
// отметка НЕ сохранена, а не догадаться об этом через неделю.
//
// DIA-P3: у окна теперь ДВА объяснения, и показывается ровно одно. До этого
// пакета полный диск приходил сюда с той же строкой, что и неоткрывшееся
// хранилище, — «попробуйте закрыть и открыть приложение», от чего свободного
// места не прибавляется. Причина берётся из КЛАССА ошибки (storeFailureCode),
// а не из сообщения движка, и это единственное, что здесь изменилось.
function showStoreUnavailable(failureClass = null) {
    const modal = document.getElementById('storeUnavailableModal');
    if (!modal) return;
    const diskFull = failureClass === 'disk_full';
    const diskFullNote = document.getElementById('storeDiskFullNote');
    const unavailableNote = document.getElementById('storeUnavailableNote');
    if (diskFullNote) diskFullNote.hidden = !diskFull;
    if (unavailableNote) unavailableNote.hidden = diskFull;
    modal.classList.add('show');
}

export function wireSkillCompletion() {
    const modal = document.getElementById('storeUnavailableModal');
    if (!modal) return;
    const close = () => modal.classList.remove('show');
    document.getElementById('storeUnavailableClose').addEventListener('click', close);
    document.getElementById('storeUnavailableCloseBtn').addEventListener('click', close);
    modal.addEventListener('click', (e) => {
        if (e.target.id === 'storeUnavailableModal') close();
    });
}

// Откат отметки в DOM: действие не состоялось, и галочка не должна утверждать
// обратное. Вынесено из toggleSkillCompletion, потому что причин отказа теперь
// две, а откат у них один.
function rejectMark(skillId, isCompleted) {
    const rejectedRow = document.querySelector(`tr[data-skill-id="${skillId}"]`);
    const rejectedCheckbox = rejectedRow && rejectedRow.querySelector('input[type="checkbox"]');
    if (rejectedCheckbox) rejectedCheckbox.checked = !isCompleted;
}

// Переключение состояния навыка.
//
// Асинхронна с L1-P4: на нативном канале отметка — это запись в журнал, а не
// присваивание в массиве. Порядок сохранён — сначала запись, потом DOM, — чтобы
// интерфейс никогда не показывал отметку, которая не сохранилась.
//
// Не выбрасывает наружу: вызывается из checkbox.onchange без await, и
// необработанное отклонение здесь означало бы галочку, рассинхронизированную с
// данными, — ровно то, что честная деградация тут и предотвращает.
export async function toggleSkillCompletion(skillId, isCompleted) {
    // Честная деградация (ADR-015), причина первая: без профиля отметку
    // сохранять некуда. Раньше запись молча терялась, а чекбокс оставался
    // отмеченным — DOM расходился с состоянием, и ЗБР-фильтр показывал уже
    // отмеченные навыки. Теперь отметка откатывается, а пользователю
    // предлагается создать профиль.
    // GA-событие не отправляется: действие не состоялось.
    if (canRecord() && !getCurrentProfile()) {
        rejectMark(skillId, isCompleted);
        // Причина закрытая, навык не передаётся: какие навыки родитель пытался
        // отметить — это ровно та форма семейных данных, которую диагностике
        // накапливать нельзя.
        emitSignal('write.refused', { reason: 'no_subject' });
        openCreateProfileModal();
        return;
    }

    // Причина вторая, появившаяся вместе с нативным хранилищем: приложение
    // запущено на устройстве, но хранилище не открылось. Молчаливый откат в
    // localStorage здесь был бы вторым источником правды без способа их
    // помирить (ADR-043), поэтому отметка отклоняется и об этом говорится.
    if (!canRecord()) {
        rejectMark(skillId, isCompleted);
        emitSignal('write.refused', { reason: 'store_unavailable' });
        showStoreUnavailable();
        return;
    }

    // DIA-P3: отказ КЛАССИФИЦИРУЕТСЯ, а не схлопывается в один код. Раньше здесь
    // стояло `.catch(() => false)`, и полный диск, сломанное хранилище и любая
    // другая ошибка приходили к родителю одной и той же строкой — это и есть
    // разрыв, о котором ADR-046 §1.1, на пути, которым семья пользуется чаще
    // всего. storeFailureCode — унарная функция ошибки, поэтому она встаёт
    // прямо в .catch(); ничего другого на этой поверхности не поменялось.
    const outcome = await markSkill(skillId, isCompleted).catch(storeFailureCode);
    if (outcome !== true) {
        rejectMark(skillId, isCompleted);
        // `false` значит «писать было некуда», и это не класс ошибки хранилища:
        // обе такие причины отсечены выше, так что сюда он приходит только в
        // гонке. Закрытый код всё равно должен быть закрытым.
        const failureClass = outcome === false ? 'other' : outcome;
        emitSignal('write.refused', { reason: 'write_failed', failure_class: failureClass });
        showStoreUnavailable(failureClass);
        return;
    }

    const completedSkills = getCompletedSkills();

    // Google Analytics event — после записи, а не до неё: событие сообщает о
    // состоявшемся действии, и до L1-P4 оно отправлялось раньше сохранения.
    trackEvent('skill_complete', {
        skill_id: skillId,
        action: isCompleted ? 'marked_complete' : 'marked_incomplete',
    });

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
