// Поверхность: ЗБР-фильтр — видимость строк, пустые категории и колонки месяцев,
// честный empty-state и кнопка переключения.
//
// Сам флаг живёт в core/zpd.js: его читает ещё и аккордеон, а applyFilter()
// синхронизирует аккордеон последним — держать флаг здесь означало бы цикл.

import { MIN_MONTH, MAX_MONTH } from '../core/kb-boot.js';
import { getCompletedSkills } from '../core/state.js';
import { readZpdFilterRaw, writeZpdFilterJson } from '../core/storage.js';
import { isZpdFilterActive, setZpdFilterActive, refreshAllZpdReadiness } from '../core/zpd.js';
import { applyAccordionVisibility } from './accordion.js';

// Восстановление сохранённого состояния фильтра на старте. Парсинг и catch
// остаются на том же месте, что и раньше (A1-DL-005 (b)).
export function restoreZpdFilter() {
    // Загрузить состояния фильтров
    const savedFilterZpd = readZpdFilterRaw();
    if (savedFilterZpd !== null) {
        try {
            setZpdFilterActive(JSON.parse(savedFilterZpd));
        } catch (e) {
            console.warn('[Mobile] Ошибка при загрузке состояния ЗБР-фильтра:', e);
        }
    }
}

// Применение фильтра
export function applyFilter() {
    const tbody = document.getElementById('tableBody');
    const zpdFilterBtn = document.getElementById('zpdFilterToggleBtn');

    // Готовность пересчитывается от сохранённого состояния перед каждым
    // применением фильтра: фильтр не может опереться на устаревший маркер
    // строки, кем бы он ни был проставлен. Идемпотентно для вызовов,
    // которые уже пересчитали (buildTableBody / toggleSkillCompletion).
    refreshAllZpdReadiness(getCompletedSkills());

    tbody.querySelectorAll('tr:not(.category-row)').forEach(row => {
        let shouldHide = false;

        // Фильтр ЗБР: показывать только готовые к освоению (data-zpd-ready === "true")
        if (isZpdFilterActive && row.dataset.zpdReady !== 'true') {
            shouldHide = true;
        }

        if (shouldHide) {
            row.classList.add('hidden');
        } else {
            row.classList.remove('hidden');
        }
    });

    // Честная деградация (ADR-018 / контракт §2): если ЗБР-фильтр включён и
    // ни один навык не готов к освоению, показываем сообщение вместо пустой таблицы.
    // Считаем видимые строки навыков по тому же механизму скрытия (класс .hidden).
    const visibleSkillCount = tbody.querySelectorAll('tr:not(.category-row):not(.hidden)').length;
    const zpdEmptyState = document.getElementById('zpdEmptyState');
    const showZpdEmptyState = isZpdFilterActive && visibleSkillCount === 0;
    // GA: только на переходе скрыто→показано (applyFilter вызывается многократно)
    if (showZpdEmptyState && zpdEmptyState.hidden) {
        trackEvent('zpd_empty_state_shown');
    }
    zpdEmptyState.hidden = !showZpdEmptyState;

    // Обновляем кнопку фильтра ЗБР
    if (isZpdFilterActive) {
        zpdFilterBtn.classList.add('active');
        zpdFilterBtn.textContent = 'Показать все навыки';
    } else {
        zpdFilterBtn.classList.remove('active');
        zpdFilterBtn.textContent = 'Показать навыки, готовые к освоению';
    }

    hideEmptyCategories();
    hideEmptyMonthColumns();

    // A1-P0: аккордеон синхронизируется последним — учёт видимости выше
    // строится на классе .hidden и от свёрнутости не зависит.
    applyAccordionVisibility();
}

// Скрытие пустых колонок месяцев
function hideEmptyMonthColumns() {
    const thead = document.getElementById('tableHead');
    const tbody = document.getElementById('tableBody');

    // Если фильтр не активен, показываем все колонки
    if (!isZpdFilterActive) {
        // Показываем все колонки месяцев в заголовке
        thead.querySelectorAll('th.col-month').forEach(th => {
            th.classList.remove('hidden-column');
        });

        // Показываем все колонки месяцев в теле таблицы
        tbody.querySelectorAll('td.col-month').forEach(td => {
            td.classList.remove('hidden-column');
        });
        return;
    }

    // Проверяем каждый месяц
    for (let m = MIN_MONTH; m <= MAX_MONTH; m++) {
        let hasVisibleActiveSkill = false;

        // Проверяем все ячейки этого месяца в видимых строках навыков
        const rows = tbody.querySelectorAll('tr:not(.category-row):not(.hidden)');
        rows.forEach(row => {
            const cell = row.querySelector(`td.col-month[data-month="${m}"]`);
            // Проверяем, есть ли активный (не освоенный) навык в этой ячейке
            if (cell && cell.classList.contains('cell-active')) {
                hasVisibleActiveSkill = true;
            }
        });

        // Если в колонке нет видимых активных навыков, скрываем её
        const shouldHideColumn = !hasVisibleActiveSkill;

        // Скрываем/показываем заголовок колонки
        const thMonth = thead.querySelector(`th.col-month[data-month="${m}"]`);
        if (thMonth) {
            if (shouldHideColumn) {
                thMonth.classList.add('hidden-column');
            } else {
                thMonth.classList.remove('hidden-column');
            }
        }

        // Скрываем/показываем все ячейки этой колонки
        const allCellsInMonth = tbody.querySelectorAll(`td.col-month[data-month="${m}"]`);
        allCellsInMonth.forEach(cell => {
            if (shouldHideColumn) {
                cell.classList.add('hidden-column');
            } else {
                cell.classList.remove('hidden-column');
            }
        });
    }
}

function toggleZpdFilter() {
    setZpdFilterActive(!isZpdFilterActive);

    // Сохранить состояние фильтра в localStorage
    writeZpdFilterJson(isZpdFilterActive);

    applyFilter();

    // Google Analytics event
    trackEvent('filter_zpd_toggle', { filter_state: isZpdFilterActive ? 'enabled' : 'disabled' });
}

// Скрытие пустых категорий
function hideEmptyCategories() {
    const tbody = document.getElementById('tableBody');
    const categoryRows = tbody.querySelectorAll('.category-row');

    categoryRows.forEach(catRow => {
        let nextRow = catRow.nextElementSibling;
        let hasVisibleSkills = false;

        while (nextRow && !nextRow.classList.contains('category-row')) {
            if (!nextRow.classList.contains('hidden')) {
                hasVisibleSkills = true;
                break;
            }
            nextRow = nextRow.nextElementSibling;
        }

        if (hasVisibleSkills) {
            catRow.classList.remove('hidden');
        } else {
            catRow.classList.add('hidden');
        }
    });
}

export function wireZpdFilter() {
    // Обработчик кнопки ЗБР-фильтра
    document.getElementById('zpdFilterToggleBtn').addEventListener('click', toggleZpdFilter);
}
