// Поверхность: модальное окно развивающих активностей месяца.
//
// Двухтировый отбор (ADR-022 §3): окна KB переупорядочивают, но никого не
// удаляют. Сама urgency-арифметика вынесена в core/urgency.js.
//
// NAV-P4 УБИРАЕТ ОТСЮДА ЛОЖНЫЙ ОТВЕТ, И ЭТО НЕ ПРАВКА ТЕКСТА, А ПРАВКА УСЛОВИЯ.
// До этого пакета getRelevantUncompletedSkills() возвращала пустой список ДО
// того, как посмотрит хоть на один навык, если профиля нет, — а вызывающий
// рисовал пустой список одной фразой «Все навыки освоены». Два разных состояния
// схлопывались в одно предложение, и одно из них было ложью: без ребёнка не
// известно ничего, и «освоено» тут не про что сказать. Ответ на это состояние у
// приложения уже есть — окно создания профиля, которое surfaces/skill-completion.js
// открывает ровно тогда же и ровно по той же причине (ADR-015, честная
// деградация: отказ называется, и рядом лежит то, что его снимает). Оно
// ПЕРЕИСПОЛЬЗУЕТСЯ, а не повторяется: второе окно того же назначения — это второй
// текст, второй набор дверей и второй порядок закрытия, расходящиеся молча.

import { DATA, windowsBySkillId } from '../core/kb-boot.js';
import { getCurrentProfile, getCompletedSkills } from '../core/state.js';
import { calculateCurrentLifeMonth, formatParentActivities } from '../core/format.js';
import { isSkillReady } from '../core/zpd.js';
import { skillUrgency } from '../core/urgency.js';
import { openSkillModal } from './skill-modal.js';
import { openCreateProfileModal } from './profile.js';

// Модальное окно развивающих активностей месяца
export function openActivitiesModal() {
    // ПРЕДУСЛОВИЕ СТОИТ ЗДЕСЬ, В ОДНОМ МЕСТЕ, И ДО ТОГО, КАК ОКНО ВООБЩЕ
    // ТРОНУТО. Раньше оно жило внутри getRelevantUncompletedSkills() и отвечало
    // пустым списком; теперь оно отвечает тем, что снимает причину. Окно
    // активностей при этом НЕ открывается: показывать поверх окна создания
    // профиля пустую сетку не за чем, а у всех .modal один z-index (см.
    // surfaces/diary.js), так что открытое #activitiesModal легло бы поверх
    // диалога, который посетителя и просят заполнить.
    //
    // В поверхности, а не в слушателе #activitiesBtn: app.js реэкспортирует эту
    // функцию как шов паритетного прогона, и условие на слушателе оставило бы
    // шов ездить по пути, которого у родителя нет.
    //
    // Сигнала здесь нет, и это решение: сосед в skill-completion.js эмитит
    // write.refused/no_subject, потому что там отказано ЗАПИСИ; здесь не отказано
    // ничему, что пишет, а в объявленном словаре core/signals.js нет кода для
    // чтения без субъекта. Заводить его ради одного эмиттера без потребителя —
    // не то, что делает ADR-013.
    const profile = getCurrentProfile();
    if (!profile || !profile.birthdate) {
        openCreateProfileModal();
        return;
    }

    const modal = document.getElementById('activitiesModal');
    const grid = document.getElementById('activitiesGrid');

    // Получаем неосвоенные навыки, соответствующие возрасту
    const relevantSkills = getRelevantUncompletedSkills(profile);

    // Сколько из них в биологическом окне. До UIP-P1 это объявление стояло под
    // комментарием «Google Analytics event: только счётчики, без имён навыков» и
    // читалось как счётчик для события; событие снято вместе со всей аналитикой,
    // а значение — нет: оно решает, показывать ли верхнюю копию ниже.
    const tier1Count = relevantSkills.filter(s => windowsBySkillId[s.id]).length;

    // Верхняя копия (не-алармистская, популяционная) — видна только когда
    // в списке есть хотя бы один навык в окне (Tier-1 непуст); иначе скрыта.
    const topNote = document.getElementById('activitiesTopNote');
    const hasWindowed = tier1Count > 0;
    if (hasWindowed) {
        topNote.textContent = 'Для развития части навыков с биологической точки зрения время сейчас наиболее благоприятно — они в начале списка.';
        topNote.hidden = false;
    } else {
        topNote.hidden = true;
    }

    // ЭТА ФРАЗА ОСТАЁТСЯ, ПОТОМУ ЧТО С РЕБЁНКОМ ОНА ИСТИННА. Пустой список
    // достижим и у заведённого профиля — когда готовых к освоению навыков не
    // осталось, — и тогда сказанное здесь описывает ровно то состояние, в
    // котором семья находится. Ложным этот ответ делало только отсутствие
    // профиля, и оно отсечено выше.
    if (relevantSkills.length === 0) {
        grid.innerHTML = '<div class="no-activities-message">Все навыки освоены — подходящих активностей сейчас нет</div>';
    } else {
        // Создаём карточки
        grid.innerHTML = relevantSkills.map(skill => {
            const wins = windowsBySkillId[skill.id];
            const winClass = wins
                ? (wins.some(w => w.type === 'critical') ? ' activity-window-critical' : ' activity-window-sensitive')
                : '';
            return `
                    <div class="activity-card${winClass}">
                        <div class="activity-card-title" data-skill-id="${skill.id}" role="button" tabindex="0" aria-label="Открыть навык: ${skill.name}">${skill.name}</div>
                        <div class="activity-card-content">${formatParentActivities(skill.additional_info.parent_activities)}</div>
                    </div>
                `;
        }).join('');
    }

    modal.classList.add('show');
}

function closeActivitiesModal() {
    document.getElementById('activitiesModal').classList.remove('show');
}

// Профиль приходит АРГУМЕНТОМ, а не читается здесь снова (NAV-P4). Прежде
// функция сама спрашивала getCurrentProfile() и сама же отвечала пустым списком
// на его отсутствие — то есть держала предусловие, которое теперь принадлежит
// вызывающему. Оставить его здесь вторым экземпляром значило бы оставить охрану,
// до которой нельзя дойти, а недостижимая охрана — ровно та форма, о которой
// AGENTS.md §11.
function getRelevantUncompletedSkills(profile) {
    const completedSkills = getCompletedSkills();
    const relevantSkills = [];

    // Берём только готовые к освоению навыки — тот же предикат, что и фильтр
    // «Показать готовые к освоению»: не освоены И все prerequisites освоены.
    // Сужение по графу готовности (ADR-018), без возраста и без окон.
    for (const category in DATA.milestones) {
        DATA.milestones[category].forEach(skill => {
            if (isSkillReady(skill, completedSkills)) {
                relevantSkills.push(skill);
            }
        });
    }

    // Карта влияния: для каждого навыка считаем число его ПРЯМЫХ неосвоенных
    // зависимых (навыков, перечисляющих его id в prerequisites). Карта строится
    // заново при каждом открытии модалки из текущего набора данных, ничего не
    // записывая обратно в DATA / _skillsMap.
    const impactById = {};
    for (const category in DATA.milestones) {
        DATA.milestones[category].forEach(dependent => {
            if (completedSkills.has(dependent.id)) {
                return;
            }
            (dependent.prerequisites || []).forEach(prereqId => {
                impactById[prereqId] = (impactById[prereqId] || 0) + 1;
            });
        });
    }

    // Двухтировый сорт (ADR-022 §3, окна > граф). Окна НИКОГО не удаляют —
    // только переупорядочивают. Tier-1 = навыки в окне, по urgency; Tier-2 =
    // навыки без окна, по существующей graph-impact метрике (Б2, дословно).
    // Стабильная сортировка → тай-брейк внутри тира = порядок датасета.
    const lifeMonth = calculateCurrentLifeMonth(profile.birthdate);
    const tier1 = [], tier2 = [];
    relevantSkills.forEach(s => (windowsBySkillId[s.id] ? tier1 : tier2).push(s));
    tier1.sort((a, b) => skillUrgency(b.id, lifeMonth) - skillUrgency(a.id, lifeMonth));
    tier2.sort((a, b) => (impactById[b.id] || 0) - (impactById[a.id] || 0));

    return tier1.concat(tier2);
}

export function wireActivities() {
    // Обработчики модального окна развивающих активностей
    document.getElementById('activitiesBtn').addEventListener('click', openActivitiesModal);
    document.getElementById('activitiesModalClose').addEventListener('click', closeActivitiesModal);
    document.getElementById('activitiesModal').addEventListener('click', (e) => {
        if (e.target.id === 'activitiesModal') {
            closeActivitiesModal();
        }
    });

    // Deep-link: открыть модалку навыка из карточки активности.
    // Click и keydown резолвят ОДИН и тот же элемент → расхождение активации исключено.
    const activateActivitySkill = (el) => {
        if (!el) return;
        const skill = DATA._skillsMap[el.getAttribute('data-skill-id')];
        if (!skill) return;
        openSkillModal(skill, true, 'activity_card');
    };
    document.getElementById('activitiesGrid').addEventListener('click', (e) => {
        activateActivitySkill(e.target.closest('.activity-card-title[data-skill-id]'));
    });
    document.getElementById('activitiesGrid').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest('.activity-card-title[data-skill-id]');
        if (!el) return;
        e.preventDefault(); // Space не должен прокручивать страницу
        activateActivitySkill(el);
    });
}
