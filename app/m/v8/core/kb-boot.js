// KB boot (A1-P4): the /kb-v1.json fetch, the adapter, the derived bindings
// and the honest failure path.
//
// DATA / windowsBySkillId / MIN_MONTH / MAX_MONTH / CATEGORIES are exported as
// `let` — ES module imports are LIVE views of the exporting binding, so every
// reader sees the value initData() assigns without a single read site changing.
// Only this module ever assigns them.
//
// The fetch starts at module evaluation, which is as early as a module graph
// allows. That is later than the inline script it replaces (a <script
// type="module"> is deferred), and the cost is recorded in A1-DL-005 rather
// than worked around.

// KB-артефакт (ADR-026): единственный источник данных приложения —
// /kb-v1.json (immutable static, версия в имени файла, ADR-024).
// Fetch стартует на eval; DOMContentLoaded ждёт kbReady, initData(kb)
// наполняет module-scope биндинги, затем init() строит UI.
export const kbReady = fetch('/kb-v1.json').then((response) => {
    if (!response.ok) {
        throw new Error('kb fetch failed: HTTP ' + response.status);
    }
    return response.json();
});

// Module-scope биндинги; наполняются в initData(kb) до init().
export let DATA;
export let windowsBySkillId;
export let MIN_MONTH;
export let MAX_MONTH;
export let CATEGORIES;

// Функция-адаптер для преобразования новой структуры данных в совместимую со старым кодом
function adaptNewDataFormat(rawData) {
    // Преобразование плоского массива skills в группировку по категориям
    const milestones = {};
    rawData.metadata.categories.forEach(cat => milestones[cat] = []);

    rawData.skills.forEach(skill => {
        if (milestones[skill.category]) {
            milestones[skill.category].push(skill);
        }
    });

    // Создаем карту навыков для быстрого поиска по ID
    const skillsMap = {};
    rawData.skills.forEach(skill => {
        skillsMap[skill.id] = skill;
    });

    return {
        title: rawData.metadata.title,
        description: rawData.metadata.description,
        age_range: { min_months: 0, max_months: 72 },
        categories: rawData.metadata.categories,
        milestones: milestones,
        _skillsMap: skillsMap
    };
}

// Наполнение module-scope биндингов из kb-артефакта (VDK-P3: swap
// источника, не логики — тела адаптера и билдера индекса не менялись).
// Биологические окна приходят как kb.bio_windows (ADR-021/022/026).
export function initData(kb) {
    DATA = adaptNewDataFormat(kb.milestones);

    // Инвертированный индекс skill_id -> [окна]. Строится один раз;
    // только чтение, ничего не пишется обратно в DATA / _skillsMap.
    windowsBySkillId = {};
    kb.bio_windows.forEach(w => (w.applies_to || []).forEach(id => {
        (windowsBySkillId[id] = windowsBySkillId[id] || []).push(w);
    }));

    MIN_MONTH = DATA.age_range.min_months;
    MAX_MONTH = DATA.age_range.max_months;
    CATEGORIES = DATA.categories;
}

// Честная деградация: без kb-артефакта приложение не работает —
// минимальная честная ошибка + перезагрузка (паттерн ADR-015).
export function showKbLoadError(err) {
    console.error('KB load failed:', err);
    const box = document.createElement('div');
    box.setAttribute('style',
        'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;gap:12px;padding:20px;' +
        'background:#fff;text-align:center;font-family:inherit;');
    box.innerHTML = '<h2 style="margin:0;">Не удалось загрузить данные</h2>' +
        '<p style="margin:0;color:#555;">Проверьте подключение к интернету и попробуйте ещё раз.</p>' +
        '<button type="button" onclick="location.reload()" ' +
        'style="padding:10px 24px;font-size:16px;cursor:pointer;">Перезагрузить</button>';
    document.body.appendChild(box);
}
