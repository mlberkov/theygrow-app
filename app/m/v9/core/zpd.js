// ZPD (ADR-018) — предикат готовности и состояние ЗБР-фильтра.
//
// Здесь живёт то, что читают несколько поверхностей сразу: готовность навыка
// (таблица, модалка навыка, ЗБР-фильтр, активности) и флаг ЗБР-фильтра
// (фильтр и мобильный аккордеон). Оба переехали сюда в A1-P5 — не потому что
// они «утилиты», а потому что общее состояние поверхностей, живущее в одной из
// них, склеило бы граф в цикл.

import { DATA } from './kb-boot.js';
import { setRowZpdReadiness } from './dom-utils.js';

// ZPD readiness (ADR-018): навык готов к освоению, если он ещё не освоен
// И все его prerequisites уже освоены. Чистый граф зависимостей —
// без возрастного окна и без возрастного гейта (возраст здесь справочный).
export function isSkillReady(skill, completedSkills) {
    if (!skill || completedSkills.has(skill.id)) return false;
    return (skill.prerequisites || []).every(p => completedSkills.has(p));
}

// Пересчёт готовности по всем отрисованным строкам навыков на месте,
// без перестроения таблицы. Изменение освоенности одного навыка влияет
// на готовность его зависимых навыков, поэтому пересчитываем все строки.
export function refreshAllZpdReadiness(completedSkills) {
    document.querySelectorAll('tr[data-skill-id]').forEach(tr => {
        const skill = DATA._skillsMap[tr.dataset.skillId];
        if (skill) setRowZpdReadiness(tr, isSkillReady(skill, completedSkills));
    });
}

// Состояние ЗБР-фильтра. Live binding по правилу A1-DL-005 (c): читают
// zpd-filter.js и accordion.js, присваивать может ТОЛЬКО этот модуль.
export let isZpdFilterActive = false;

export function setZpdFilterActive(active) {
    isZpdFilterActive = active;
}
