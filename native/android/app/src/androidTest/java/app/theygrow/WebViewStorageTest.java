package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * What the WebView actually does with the two surfaces this milestone inverted
 * (L1-P4).
 *
 * <p><b>Why this test exists rather than a paragraph.</b> Two claims about the
 * Capacitor WebView have been asserted, deferred and re-deferred across three
 * packets without anyone measuring them. {@code docs/RUNBOOK.md} called the
 * service-worker question "the one open question the repository cannot settle".
 * It can be settled; it just needed a device. So does the analytics claim: the
 * parity suite runs {@code native/www} over plain HTTP with no Capacitor
 * injected, so both of its channels take the WEB branch, and no parity project
 * can show what the native branch does. Only this test can.
 *
 * <p><b>The probe facts are printed, not only asserted.</b> An assertion tells a
 * later reader that something passed. What they will actually want to know is
 * what the WebView DOES — whether {@code serviceWorker} is in {@code navigator}
 * at all in this Android WebView, what {@code caches.keys()} returns, whether
 * {@code isNativePlatform()} is true. Those go to stdout so they land in the
 * instrumented report and in logcat, where the next person to ask the question
 * finds an observation instead of an opinion.
 */
@RunWith(AndroidJUnit4.class)
public class WebViewStorageTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    /** The prefix app/sw.js uses for its shell caches, and the only one we delete. */
    private static final String SHELL_CACHE_PREFIX = "theygrow-";

    @Test
    public void the_native_shell_registers_no_service_worker_and_leaves_no_shell_cache() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            // Recorded first, because the answer is interesting either way: if the
            // API is absent the guard is a no-op and the disposition still holds;
            // if it is present, the guard is what makes it hold.
            String hasApi = pollFor(scenario, "String('serviceWorker' in navigator)");
            String isNative =
                    pollFor(
                            scenario,
                            "String(!!(window.Capacitor && window.Capacitor.isNativePlatform"
                                + " && window.Capacitor.isNativePlatform()))");
            System.out.println("[probe] serviceWorker in navigator = " + hasApi);
            System.out.println("[probe] Capacitor.isNativePlatform() = " + isNative);

            assertEquals(
                    "the shell does not believe it is running natively, so every native-only"
                            + " branch in the shipped bytes is inert and this whole test is vacuous",
                    "true",
                    isNative);

            evaluate(
                    scenario,
                    "window.__swProbe = null;"
                        + "(('serviceWorker' in navigator)"
                        + "  ? navigator.serviceWorker.getRegistrations()"
                        + "  : Promise.resolve([]))"
                        + ".then(function (rs) { window.__swProbe = 'count:' + rs.length; })"
                        + ".catch(function (e) { window.__swProbe = 'err:' + e; });"
                        + "'dispatched'");
            String registrations = pollFor(scenario, "window.__swProbe");
            System.out.println("[probe] service worker registrations = " + registrations);
            assertEquals(
                    "a service worker is registered inside the WebView, which is exactly the"
                            + " second copy of the shell this milestone removed",
                    "count:0",
                    registrations);

            evaluate(
                    scenario,
                    "window.__cacheProbe = null;"
                        + "((typeof caches !== 'undefined')"
                        + "  ? caches.keys() : Promise.resolve([]))"
                        + ".then(function (k) { window.__cacheProbe = 'keys:' + JSON.stringify(k); })"
                        + ".catch(function (e) { window.__cacheProbe = 'err:' + e; });"
                        + "'dispatched'");
            String cacheKeys = pollFor(scenario, "window.__cacheProbe");
            System.out.println("[probe] caches.keys() = " + cacheKeys);
            assertTrue(
                    "a shell cache survives inside WebView storage: " + cacheKeys,
                    !cacheKeys.contains(SHELL_CACHE_PREFIX));
        }
    }

    /**
     * The analytics half of the same decision (LSC-DL-004).
     *
     * <p>C4 stripped GA4 from the native channel as a runtime branch. The parity
     * suite cannot see that branch, and its two analytics assertions — one event
     * on a successful tick, none on a refused one — are statements about the WEB
     * branch and remain so. This is where the native claim is settled.
     */
    @Test
    public void the_native_shell_sends_nothing_to_analytics() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            String flag = pollFor(scenario, "String(!!window.IS_NATIVE_SHELL)");
            System.out.println("[probe] IS_NATIVE_SHELL = " + flag);
            assertEquals(
                    "the shell did not take the native analytics branch, so the assertions"
                            + " below would pass while proving nothing",
                    "true",
                    flag);

            // No loader tag was injected, so nothing was ever requested from the
            // analytics origin. Asserted on the DOM rather than on the network,
            // because a request that is never made leaves no trace to assert on.
            String loaders =
                    pollFor(
                            scenario,
                            "String(document.querySelectorAll("
                                + "'script[src*=\"googletagmanager.com\"]').length)");
            System.out.println("[probe] googletagmanager script tags = " + loaders);
            assertEquals("the analytics loader was injected on the native channel", "0", loaders);

            String layer = pollFor(scenario, "String((window.dataLayer || []).length)");
            System.out.println("[probe] dataLayer entries = " + layer);
            assertEquals(
                    "the native shell queued analytics events: " + layer + " entr(y|ies)",
                    "0",
                    layer);

            // Anti-vacuity: trackEvent must still EXIST — the branch is meant to
            // make it a no-op, not to remove the function every surface calls.
            String helper = pollFor(scenario, "typeof window.trackEvent");
            System.out.println("[probe] typeof trackEvent = " + helper);
            assertEquals("trackEvent is gone, so the surfaces would throw", "function", helper);

            evaluate(scenario, "trackEvent('probe_event', { probe: 1 }); 'dispatched'");
            String afterCall = pollFor(scenario, "String((window.dataLayer || []).length + 1000)");
            System.out.println("[probe] dataLayer entries after a trackEvent call = " + afterCall);
            assertEquals(
                    "calling trackEvent on the native channel still queued an event",
                    "1000",
                    afterCall);
        }
    }

    // --- WebView plumbing -------------------------------------------------
    //
    // Copied in shape from BridgeSmokeTest rather than shared: the two tests
    // poll different things and a shared base class would couple their timeouts.

    /** Polls a JS expression until it evaluates to something other than null. */
    private String pollFor(ActivityScenario<MainActivity> scenario, String expression) {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (value != null && !"null".equals(value)) {
                return value;
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                fail("interrupted while polling for: " + expression);
            }
        }
        fail("timed out waiting for: " + expression);
        return null;
    }

    /** Evaluates one expression in the activity's WebView and returns its JSON form. */
    private String evaluate(ActivityScenario<MainActivity> scenario, String expression) {
        AtomicReference<String> result = new AtomicReference<>(null);
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(
                activity ->
                        activity.getBridge()
                                .getWebView()
                                .evaluateJavascript(
                                        expression,
                                        value -> {
                                            result.set(unquote(value));
                                            latch.countDown();
                                        }));
        try {
            if (!latch.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                fail("the WebView never answered: " + expression);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            fail("interrupted while evaluating: " + expression);
        }
        return result.get();
    }

    /** evaluateJavascript returns JSON, so a string result arrives quoted. */
    private static String unquote(String value) {
        if (value == null) {
            return null;
        }
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }
}
