// Urgency-метрика Tier-1 (ADR-022 §3) — чистая арифметика над окнами KB.
// Ни DOM, ни состояние: единственный потребитель — сортировка в модалке
// активностей, но математика отделена от поверхности, которая её показывает.

import { windowsBySkillId } from './kb-boot.js';

// — Urgency-метрика Tier-1 (ADR-022 §3; модалка активностей ТОЛЬКО) —
// urgency = f(peak_fraction × criticality_weight(type, decline_shape)); f = identity (линейная).
// peak_fraction cap'ается; сензитивные cap'аются ниже критических; ★ (evidence_strength)
// НЕ читается; pre-peak → низкий тир. front_loaded инвертирует наклон внутри пика
// (раньше = максимум; биология привязанности: вред 0–6 мес ≫ после 2 лет).
// Значения — именованные константы для owner-tuning (ADR-022 OQ#1, envelope-деталь).
const CRITICAL_WEIGHT = 1.0, SENSITIVE_WEIGHT = 0.5;
const DECLINE_FACTORS = { sharp: 1.0, stepped: 0.8, front_loaded: 0.9, gentle: 0.6, very_gentle: 0.4 };
const CRIT_FRACTION_CAP = 1.5, SENS_FRACTION_CAP = 1.0;
const PRE_PEAK_URGENCY = 0.05;

function criticalityWeight(type, decline) {
    const typeW = type === 'critical' ? CRITICAL_WEIGHT : SENSITIVE_WEIGHT;
    return typeW * (DECLINE_FACTORS[decline] ?? DECLINE_FACTORS.gentle);
}

function windowUrgency(w, lifeMonth) {
    const span = Math.max(1, w.shape.peak_end - w.shape.peak_start);
    let frac;
    if (w.decline_shape === 'front_loaded') {
        // ранний = максимум (вред front-loaded); cap внутри [0,1]
        frac = Math.min(1, Math.max(0, 1 - (lifeMonth - w.shape.peak_start) / span));
    } else {
        if (lifeMonth < w.shape.peak_start) return PRE_PEAK_URGENCY; // pre-peak = низкий тир
        const cap = w.type === 'critical' ? CRIT_FRACTION_CAP : SENS_FRACTION_CAP;
        frac = Math.min(cap, (lifeMonth - w.shape.peak_start) / span);
    }
    return frac * criticalityWeight(w.type, w.decline_shape); // f = identity
}

// urgency навыка = максимум по покрывающим окнам (∃-семантика покрытия).
// null → навык не покрыт ни одним окном (уходит в Tier-2).
export function skillUrgency(skillId, lifeMonth) {
    const ws = windowsBySkillId[skillId];
    if (!ws || ws.length === 0) return null;
    return Math.max(...ws.map(w => windowUrgency(w, lifeMonth)));
}
