// THE SERVICE-WORKER DISPOSITION INSIDE THE WEBVIEW (L1-P4).
//
// The question this settles was raised in L1-P1 (LSC-DL-001 (i)), left open by
// L1-P2, carried past L1-P3, and is the last thing this milestone owes: inside
// the Capacitor WebView a registered service worker turns Cache Storage into a
// SECOND copy of the shell held in WebView storage — the exact persistence
// surface this milestone spent four packets inverting. L1-P1 declined to touch
// it because that packet made zero product changes; L1-P2 declined because it
// was outside its approved scope. P4 changes native-channel behaviour anyway,
// and there is no later packet in this milestone, so it is taken here.
//
// THE DECISION: the native channel registers no worker, and purges one a
// previously installed APK left behind together with its caches.
//
// Implemented as a RUNTIME BRANCH in this same shipped file, so the two channels
// still ship byte-identical bytes (LSC-P1-INV-002) — the pattern the export
// surface and the store already use. A second file, or stripping the script in
// the native build, would fork the channels and cost more than it bought.
//
// WHAT IS DELETED, precisely: caches whose names start with this app's own
// prefix, holding shipped shell assets — HTML, CSS, JS, icons, the KB artifact.
// That is the losable cache ADR-043 explicitly permits, reconstructible from the
// APK on the next launch. NO FAMILY DATA IS IN CACHE STORAGE, and none is
// deleted here. On the web channel this branch does not run at all: the PWA
// needs its worker, and its offline boot is asserted by behavior.spec.js.
//
// The APK never had an update channel to lose — assets are read from local
// storage inside the package, /sw.js is never re-fetched from a network origin,
// so no bumped CACHE_VERSION was ever discovered and the banner could never
// appear (LSC-DL-001 (h)). Unregistering removes a stale second copy and costs
// nothing that was working.
const IN_NATIVE_SHELL = !!(
    window.Capacitor
    && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform()
);

// Kept in step with CACHE_NAME in app/sw.js by hand, and deliberately narrow:
// deleting every cache would reach past this app into anything else sharing the
// origin, which is not this file's business even when it is empty.
const SHELL_CACHE_PREFIX = 'theygrow-';

if (IN_NATIVE_SHELL) {
    // Best-effort and unconditional-failure-tolerant: a shell that cannot purge
    // an old cache must still boot. Nothing downstream depends on this finishing.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker
            .getRegistrations()
            .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
            .catch(() => {});
    }
    if (typeof caches !== 'undefined') {
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name.startsWith(SHELL_CACHE_PREFIX))
                        .map((name) => caches.delete(name))
                )
            )
            .catch(() => {});
    }
} else if ('serviceWorker' in navigator) {
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
