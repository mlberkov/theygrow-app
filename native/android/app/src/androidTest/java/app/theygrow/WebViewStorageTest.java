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
 *
 * <p><b>Everything below the boot gate, and why the gate exists.</b> The first
 * execution of this class (run {@code 31680204645}) measured a document that had
 * not booted. {@code pollFor} waits only while a value is {@code null}, and every
 * probe here is wrapped in {@code String(...)}, which is never null — so each one
 * answered on the FIRST evaluation, milliseconds after the activity resumed and
 * long before the shipped modules ran. The analytics test went red honestly
 * ({@code IS_NATIVE_SHELL = false}, because the head script had not executed
 * yet). The service-worker test went GREEN, which was worse: zero registrations
 * and no shell cache are trivially true of a page that has not run
 * {@code sw-register.js}, so it proved nothing while looking like proof.
 *
 * <p>Both now wait for a sentinel the APP produces — populated table rows — and
 * take every measurement after it. The pre-gate reading is still recorded, on
 * purpose: it is what makes the gate's effect visible in the report rather than
 * merely claimed.
 */
@RunWith(AndroidJUnit4.class)
public class WebViewStorageTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    /** The prefix app/sw.js uses for its shell caches, and the only one we delete. */
    private static final String SHELL_CACHE_PREFIX = "theygrow-";

    /**
     * The boot sentinel: a DOM fact the app's own modules produce, and the same
     * one the parity suite waits on ({@code app/tests/support/seed.js} — "init()
     * has run and buildTableBody() has populated rows").
     *
     * <p>Deliberately NOT a marker minted for this test. A flag added to shipped
     * code so a test can pass is the test changing the product, which is the
     * opposite of what these invariants are for. Rows carry {@code data-skill-id}
     * from {@code surfaces/table.js}, and they exist only after
     * {@code Promise.all([kbReady, initNativeStore()])} resolved and {@code init()}
     * ran — so a row is proof that the module graph EVALUATED, not merely that the
     * document parsed. {@code document.readyState === 'complete'} would not do:
     * it says the parser finished, which is exactly the state the failed run was
     * already in when it read a flag that did not exist yet.
     *
     * <p>Ordering, which is what makes this sound for the service-worker half:
     * {@code app.js} (index.html:384) and {@code sw-register.js} (index.html:515)
     * are both {@code type="module"} and therefore evaluate in document order,
     * while the rows appear only after {@code app.js}'s async boot resolves —
     * strictly later. Rows therefore imply {@code sw-register.js} has evaluated
     * and its native branch has been entered.
     */
    private static final String BOOTED =
            "document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0";

    @Test
    public void the_native_shell_registers_no_service_worker_and_leaves_no_shell_cache() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            recordPreBoot(scenario);
            awaitBoot(scenario);

            // Recorded first, because the answer is interesting either way: if the
            // API is absent the guard is a no-op and the disposition still holds;
            // if it is present, the guard is what makes it hold.
            String hasApi = probe(scenario, "String('serviceWorker' in navigator)");
            String isNative =
                    probe(
                            scenario,
                            "String(!!(window.Capacitor && window.Capacitor.isNativePlatform"
                                + " && window.Capacitor.isNativePlatform()))");
            String shellFlag = probe(scenario, "String(!!window.IS_NATIVE_SHELL)");
            System.out.println("[probe] serviceWorker in navigator = " + hasApi);
            System.out.println("[probe] Capacitor.isNativePlatform() = " + isNative);
            System.out.println("[probe] IS_NATIVE_SHELL = " + shellFlag);

            assertEquals(
                    "the shell does not believe it is running natively, so every native-only"
                            + " branch in the shipped bytes is inert and this whole test is vacuous",
                    "true",
                    isNative);

            // Re-anchored against the APP rather than the bridge. isNativePlatform()
            // is true as soon as Capacitor injects, which is before a single shipped
            // byte runs — it is what let the original form of this test pass against
            // a blank document. IS_NATIVE_SHELL is computed by index.html's own head
            // script, so it cannot be true unless the shipped bytes executed.
            assertEquals(
                    "the shipped head script never ran, so sw-register.js did not run either"
                            + " and the two assertions below would hold of any blank page",
                    "true",
                    shellFlag);

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
     * The analytics half of the same decision (LSC-DL-004), re-armed at UIP-P1.
     *
     * <p>C4 stripped GA4 from the native channel as a runtime BRANCH: the loader
     * was not injected here and {@code trackEvent} returned early, while the web
     * channel kept both. UIP-P1 removed analytics from the web showcase as well
     * (vault ADR-043 annotation 2026-08-25, class: reversal), so there is no
     * branch left to take — the shell carries no loader, no {@code gtag}, no
     * {@code dataLayer} and no {@code trackEvent} on either channel.
     *
     * <p>THE ASSERTIONS BELOW GOT STRICTER RATHER THAN WEAKER, and one of them
     * had to be inverted to stay honest. The old anti-vacuity probe required
     * {@code typeof window.trackEvent === "function"} — correct while the branch
     * was meant to make the helper a no-op rather than delete it, and false the
     * moment the helper was deleted. It now requires the opposite, and the
     * anti-vacuity work it used to do is carried by the {@code IS_NATIVE_SHELL}
     * probe above it, which is what proves this test reached a real booted shell
     * rather than an empty page.
     *
     * <p>The parity suite serves the same bytes over plain HTTP with no
     * Capacitor injected, so both of its channels take what used to be the web
     * path; the static half of the same property is
     * {@code app/tests/analytics-absence.spec.js} and its executing half on the
     * web is {@code app/tests/analytics-egress.spec.js}. This is where the claim
     * is settled for a real WebView inside the APK.
     */
    @Test
    public void the_native_shell_sends_nothing_to_analytics() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            recordPreBoot(scenario);
            awaitBoot(scenario);

            String flag = probe(scenario, "String(!!window.IS_NATIVE_SHELL)");
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
                    probe(
                            scenario,
                            "String(document.querySelectorAll("
                                + "'script[src*=\"googletagmanager.com\"]').length)");
            System.out.println("[probe] googletagmanager script tags = " + loaders);
            assertEquals("the analytics loader was injected on the native channel", "0", loaders);

            String layer = probe(scenario, "String((window.dataLayer || []).length)");
            System.out.println("[probe] dataLayer entries = " + layer);
            assertEquals(
                    "the native shell queued analytics events: " + layer + " entr(y|ies)",
                    "0",
                    layer);

            // The helper is GONE, not quiet (UIP-P1). Until this packet the
            // assertion here was the opposite — trackEvent had to still EXIST,
            // because the native branch made it a no-op and every surface
            // called it. Both halves of that are now false: the shell defines
            // no such function on any channel, and no surface under the mount
            // calls one.
            String helper = probe(scenario, "typeof window.trackEvent");
            System.out.println("[probe] typeof trackEvent = " + helper);
            assertEquals(
                    "the shell still defines trackEvent — analytics left every channel at UIP-P1,"
                            + " and a helper with no caller is how the surface comes back",
                    "undefined",
                    helper);

            // And the gtag shim it pushed through is gone with it. dataLayer was
            // created unconditionally in the old head block, which is why the
            // probe above reads a length rather than a type; here the array
            // itself must never have been created.
            String layerType = probe(scenario, "typeof window.dataLayer");
            System.out.println("[probe] typeof dataLayer = " + layerType);
            assertEquals(
                    "the shell still creates window.dataLayer — the gtag shim is back",
                    "undefined",
                    layerType);
        }
    }

    // --- The boot gate ----------------------------------------------------

    /**
     * Records what the ungated probes would have read, before waiting for
     * anything. Kept deliberately: without it, the gate's effect is a claim in a
     * comment. With it, every run prints the pre-boot reading beside the
     * post-boot one, and a reader can see the difference rather than trust it.
     *
     * <p>If these two ever print the same values, the gate has stopped doing
     * anything and should be re-examined rather than left in place for comfort.
     */
    private void recordPreBoot(ActivityScenario<MainActivity> scenario) {
        System.out.println(
                "[probe pre-boot] IS_NATIVE_SHELL = "
                        + evaluate(scenario, "String(!!window.IS_NATIVE_SHELL)"));
        System.out.println(
                "[probe pre-boot] table rows = "
                        + evaluate(
                                scenario,
                                "String(document.querySelectorAll("
                                    + "'#tableBody tr[data-skill-id]').length)"));
        System.out.println(
                "[probe pre-boot] document.readyState = " + evaluate(scenario, "document.readyState"));
    }

    /**
     * Blocks until the app has demonstrably booted, and fails the test rather
     * than measuring early if it never does.
     */
    private void awaitBoot(ActivityScenario<MainActivity> scenario) {
        pollFor(scenario, "(" + BOOTED + ") ? 'booted' : null");
    }

    /**
     * A probe that honours the contract {@code pollFor} was written against.
     *
     * <p>The bug this replaces: {@code String(...)} is never null, so the raw
     * poll returned on its first evaluation and the 30-second timeout was
     * unreachable — the loop was dead code for every probe except the two that
     * initialise themselves to {@code null}. Wrapping each probe so it yields
     * {@code null} until the sentinel holds makes the polling real. The
     * assertions on the returned values are unchanged.
     */
    private String probe(ActivityScenario<MainActivity> scenario, String expression) {
        return pollFor(scenario, "(" + BOOTED + ") ? (" + expression + ") : null");
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
