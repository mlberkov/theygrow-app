// Stateless formatting helpers (A1-P4).
//
// Date/age arithmetic and activity-list rendering. Nothing here reads app
// state, the KB or the DOM — every value arrives as an argument.
//
// NOTE: formatParentActivitiesText has no caller and had none before the split.
// It is moved verbatim rather than deleted: removing it is a product change,
// which this packet is not.

// Вспомогательная функция: преобразование массива активностей в маркированный список
export function formatParentActivities(activities) {
    if (!activities || activities.length === 0) {
        return '<p>—</p>';
    }
    const items = activities.map(a => `<li>${a}</li>`).join('');
    return `<ul>${items}</ul>`;
}

// Вспомогательная функция: преобразование массива активностей в текст
export function formatParentActivitiesText(activities) {
    if (!activities || activities.length === 0) {
        return '—';
    }
    return activities.join(' ');
}

// Вычисление возраста
export function calculateAge(birthdate) {
    if (!birthdate) return null;

    const birth = new Date(birthdate);
    const today = new Date();

    let years = today.getFullYear() - birth.getFullYear();
    let months = today.getMonth() - birth.getMonth();

    if (months < 0) {
        years--;
        months += 12;
    }

    // Если ещё не наступило число месяца рождения, вычитаем 1 месяц
    if (today.getDate() < birth.getDate()) {
        months--;
        if (months < 0) {
            years--;
            months += 12;
        }
    }

    return { years, months };
}

// Вычисление текущего месяца жизни (1-72)
export function calculateCurrentLifeMonth(birthdate) {
    if (!birthdate) return null;

    const birth = new Date(birthdate);
    const today = new Date();

    let totalMonths = (today.getFullYear() - birth.getFullYear()) * 12;
    totalMonths += today.getMonth() - birth.getMonth();

    // Если ещё не наступило число месяца, вычитаем 1
    if (today.getDate() < birth.getDate()) {
        totalMonths--;
    }

    // Месяц жизни = totalMonths + 1 (т.к. первый месяц начинается с дня рождения)
    const lifeMonth = totalMonths + 1;

    return Math.max(1, Math.min(lifeMonth, 72));
}

export function formatAge(years, months) {
    let result = '';
    if (years > 0) {
        result += years + ' г.';
    }
    if (months > 0) {
        if (result) result += ' ';
        result += months + ' мес.';
    }
    return result || '0 мес.';
}
