// Поверхность: мобильный accordion категорий.
//
// Читает состояние ЗБР-фильтра из core/zpd.js (а не из zpd-filter.js) — иначе
// фильтр и аккордеон импортировали бы друг друга: applyFilter() синхронизирует
// аккордеон последним, и обратное ребро замкнуло бы цикл.
//
// Слушатель resize регистрируется при вычислении этого модуля, а не в конце
// entry, как раньше. Граф модулей вычисляется одним синхронным проходом, так
// что между этими двумя точками ни одно событие доставлено быть не может.

import { readAccordionStatesRaw, writeAccordionStatesJson } from '../core/storage.js';
import { categoryKey, getSkillRowsForCategory } from '../core/dom-utils.js';
import { isZpdFilterActive } from '../core/zpd.js';

// ═════════════════════════════════════════════════════════════════════════════
// MOBILE: Accordion для категорий
// ═════════════════════════════════════════════════════════════════════════════

// Глобальная переменная для хранения состояний категорий
let categoryCollapsedStates = {};

// A1-P0: последнее значение isZpdFilterActive, применённое к аккордеону.
// null — аккордеон ещё не синхронизирован ни с одним состоянием фильтра.
let accordionSyncedForFilter = null;

// A1-P0: намерение пользователя — должна ли категория быть свёрнута.
// Отделено от presentation-слоя (см. applyAccordionVisibility).
function isCategoryCollapsedByIntent(categoryName, index) {
    // Если есть сохранённое состояние, использовать его
    if (categoryCollapsedStates.hasOwnProperty(categoryName)) {
        return categoryCollapsedStates[categoryName];
    }
    // По умолчанию: первая категория открыта, остальные закрыты
    return index > 0;
}

// Сохранить состояние одной категории (свёрнута/развёрнута).
// A1-P0: раньше функция обходила DOM и выводила намерение из класса
// .collapsed. Теперь presentation может законно расходиться с намерением
// (активный фильтр разворачивает категории), и такой обход стал бы
// разрушительным: один ручной toggle при активном фильтре записал бы
// «развёрнута» для всех категорий, стерев настройки семьи.
function saveCategoryState(categoryRow, isCollapsed) {
    if (window.innerWidth > 767) return; // Только для мобильной версии

    categoryCollapsedStates[categoryKey(categoryRow)] = isCollapsed;

    // Сохранить в localStorage
    writeAccordionStatesJson(categoryCollapsedStates);

    console.log('[Mobile] Состояния категорий сохранены:', categoryCollapsedStates);
}

// Загрузить состояния категорий из localStorage
export function loadCategoryStates() {
    const savedStates = readAccordionStatesRaw();
    if (savedStates) {
        try {
            categoryCollapsedStates = JSON.parse(savedStates);
            console.log('[Mobile] Состояния категорий загружены:', categoryCollapsedStates);
        } catch (e) {
            console.warn('[Mobile] Ошибка при загрузке состояний категорий:', e);
            categoryCollapsedStates = {};
        }
    }
}

// A1-P0: единственный владелец presentation-слоя свёрнутости.
// Активный ЗБР-фильтр приостанавливает аккордеон: фильтр — только что
// выраженное намерение увидеть короткий список, и прятать его результаты
// за свёрнутыми заголовками бессмысленно (именно это давало визуально
// пустую таблицу без честного empty-state; провенанс A0-DL-001).
// Честный empty-state при этом остаётся честным: он считает .hidden, а не
// свёрнутость — иначе сообщение «нет готовых навыков» лгало бы, пока
// готовые навыки лежат в одном тапе по шеврону (ADR-018).
// Сохранённое намерение не мутируется: при выключении фильтра оно возвращается.
export function applyAccordionVisibility(options) {
    if (window.innerWidth > 767) return; // Только для мобильной версии

    const table = document.getElementById('mainTable');
    if (!table) return;

    // Без force прогон пропускается, если состояние фильтра не менялось:
    // иначе любой applyFilter() (например, отметка навыка) молча отменил бы
    // ручное свёртывание, сделанное пользователем при активном фильтре.
    const force = !!(options && options.force);
    if (!force && accordionSyncedForFilter === isZpdFilterActive) return;
    accordionSyncedForFilter = isZpdFilterActive;

    table.querySelectorAll('tr.category-row').forEach((categoryRow, index) => {
        const collapsed = isZpdFilterActive
            ? false
            : isCategoryCollapsedByIntent(categoryKey(categoryRow), index);

        categoryRow.classList.toggle('collapsed', !!collapsed);

        // display:'' безопасен для отфильтрованных строк: .hidden объявлен
        // с !important и перебивает инлайновый стиль.
        getSkillRowsForCategory(categoryRow).forEach(skillRow => {
            skillRow.style.display = collapsed ? 'none' : '';
        });
    });
}

export function initMobileAccordion() {
    // Проверка viewport
    if (window.innerWidth > 767) return;

    console.log('[Mobile] Инициализация accordion для категорий');

    const table = document.getElementById('mainTable');
    if (!table) {
        console.warn('[Mobile] Таблица не найдена');
        return;
    }

    // Найти все строки категорий
    const categoryRows = table.querySelectorAll('tr.category-row');

    if (categoryRows.length === 0) {
        console.warn('[Mobile] Категории не найдены');
        return;
    }

    categoryRows.forEach((categoryRow) => {
        // Получить навыки этой категории
        const categoryName = categoryRow.textContent.trim();
        const skillRows = getSkillRowsForCategory(categoryRow);

        // Посчитать освоенные/всего
        const totalSkills = skillRows.length;
        const completedSkills = skillRows.filter(row => {
            const checkbox = row.querySelector('input[type="checkbox"]');
            return checkbox && checkbox.checked;
        }).length;

        // Добавить счётчик в атрибут первой ячейки
        const firstCell = categoryRow.querySelector('td');
        if (firstCell) {
            firstCell.setAttribute('data-skills-count', `[${completedSkills}/${totalSkills}]`);
        }

        // Добавить обработчик клика
        categoryRow.style.cursor = 'pointer';
        categoryRow.addEventListener('click', function(e) {
            // Игнорировать клики по чекбоксам и их родителям
            if (e.target.type === 'checkbox' || e.target.closest('.checkbox-cell')) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            // Toggle collapsed класс
            const isCollapsed = this.classList.toggle('collapsed');

            // Показать/скрыть навыки
            skillRows.forEach(skillRow => {
                skillRow.style.display = isCollapsed ? 'none' : '';
            });

            console.log(`[Mobile] Категория "${categoryName}" ${isCollapsed ? 'свёрнута' : 'развёрнута'}`);

            // Сохранить состояние аккордеона
            saveCategoryState(categoryRow, isCollapsed);
        });
    });

    // A1-P0: начальное состояние категорий выставляет единственный владелец
    // presentation-слоя. force — строки только что построены/перевешаны.
    applyAccordionVisibility({ force: true });

    console.log(`[Mobile] Accordion инициализирован для ${categoryRows.length} категорий`);
}

// Переинициализация при изменении размера окна
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        // Убрать accordion на desktop
        if (window.innerWidth > 767) {
            const table = document.getElementById('mainTable');
            if (table) {
                const allRows = table.querySelectorAll('tr');
                allRows.forEach(row => {
                    row.classList.remove('collapsed');
                    row.style.display = '';
                    row.style.cursor = '';
                });
            }
        } else {
            // Переинициализировать на mobile
            initMobileAccordion();
        }
    }, 250);
});
