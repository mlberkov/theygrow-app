if ('serviceWorker' in navigator) {
    // Block-local update state — drives P1's neutral SKIP_WAITING handler.
    // updateAccepted: set only when the user taps "Обновить", so the
    //   controllerchange from P1's clients.claim() on first install does NOT reload.
    // refreshing: one-shot guard — exactly one reload, no loop.
    let updateAccepted = false;
    let refreshing = false;

    const showUpdateBanner = (worker) => {
        const banner = document.getElementById('updateBanner');
        const reloadBtn = document.getElementById('updateReloadBtn');
        const dismissBtn = document.getElementById('updateDismiss');
        if (!banner || !reloadBtn || !dismissBtn || !worker) return;
        banner.classList.add('visible');
        reloadBtn.onclick = () => {
            updateAccepted = true;
            worker.postMessage({ type: 'SKIP_WAITING' });
        };
        dismissBtn.onclick = () => {
            // Non-blocking: hide only — the update lands on the next natural visit.
            banner.classList.remove('visible');
        };
    };

    // Reload exactly once, and only for a user-accepted update.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!updateAccepted || refreshing) return;
        refreshing = true;
        window.location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then((registration) => {
                console.log('Service Worker registered:', registration.scope);

                // Path A: a new worker is already waiting at load time.
                if (registration.waiting && navigator.serviceWorker.controller) {
                    showUpdateBanner(registration.waiting);
                }

                // Path B: an update is found while the page is open.
                registration.addEventListener('updatefound', () => {
                    const installing = registration.installing;
                    if (!installing) return;
                    installing.addEventListener('statechange', () => {
                        // controller present ⇒ this is an update, not a first install.
                        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                            showUpdateBanner(installing);
                        }
                    });
                });
            })
            .catch((error) => {
                console.log('Service Worker registration failed:', error);
            });
    });
}
