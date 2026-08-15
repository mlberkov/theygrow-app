// Поверхность: модальное окно онбординга (#onboardingModal).
// Ни от одной другой поверхности не зависит — самый чистый лист графа.

import { readOnboardingDismissed, writeOnboardingDismissed } from '../core/storage.js';

// Модальное окно онбординга
export function openOnboardingModal() {
    document.getElementById('onboardingModal').classList.add('show');

    // Google Analytics event
    trackEvent('onboarding_shown');
}

function closeOnboardingModal() {
    const checkbox = document.getElementById('onboardingDismissCheckbox');
    if (checkbox.checked) {
        writeOnboardingDismissed();
    }
    document.getElementById('onboardingModal').classList.remove('show');

    // Google Analytics event
    trackEvent('onboarding_dismissed', {
        action: checkbox.checked ? 'dont_show_again' : 'closed'
    });
}

export function checkAndShowOnboarding() {
    const dismissed = readOnboardingDismissed();
    if (dismissed !== 'true') {
        openOnboardingModal();
    }
}

export function wireOnboarding() {
    // Обработчики модального окна онбординга
    document.getElementById('onboardingCloseBtn').addEventListener('click', closeOnboardingModal);
    document.getElementById('onboardingModalClose').addEventListener('click', closeOnboardingModal);
    document.getElementById('onboardingModal').addEventListener('click', (e) => {
        if (e.target.id === 'onboardingModal') {
            closeOnboardingModal();
        }
    });
}
