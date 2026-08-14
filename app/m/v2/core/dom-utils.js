// Stateless DOM helpers (A1-P4).
//
// Read or write a node that is handed in. No app state, no KB, no storage.

// Идемпотентно проставляет маркер готовности на строку навыка.
// data-zpd-ready — хук для фильтра (P2); класс zpd-ready — хук для оформления (P3).
export function setRowZpdReadiness(tr, ready) {
    tr.dataset.zpdReady = ready ? 'true' : 'false';
    tr.classList.toggle('zpd-ready', ready);
}

// A1-P0: ключ категории в categoryCollapsedStates. Счётчик рисуется CSS
// (content: attr(data-skills-count)) и в textContent не попадает; strip
// сохранён для совместимости с ранее сохранёнными ключами. Один источник —
// чтобы ключ записи и ключ чтения не могли разойтись.
export function categoryKey(categoryRow) {
    return categoryRow.textContent.trim().replace(/\s*\[.*?\]\s*$/, ''); // Убираем счётчик
}

// Вспомогательная функция: получить строки навыков для категории
export function getSkillRowsForCategory(categoryRow) {
    const skillRows = [];
    let nextRow = categoryRow.nextElementSibling;

    // Собрать все строки до следующей категории
    while (nextRow && !nextRow.classList.contains('category-row')) {
        // Проверяем, что это строка навыка (имеет data-skill-id)
        if (nextRow.dataset && nextRow.dataset.skillId) {
            skillRows.push(nextRow);
        }
        nextRow = nextRow.nextElementSibling;
    }

    return skillRows;
}
