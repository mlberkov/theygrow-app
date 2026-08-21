package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.util.Log;
import android.webkit.WebView;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * FIU-P1-INV-001 — the store closes when the app goes to the background, and the
 * next open finds a clean marker.
 *
 * <p>THE DEBT THIS DISCHARGES, AND THE CONDITION IT WAS LEFT UNDER.
 * {@code closeStore()} was defined at L1-P2 and called from nowhere, so
 * {@code openStore()}'s unconditional {@code clean_shutdown = 0} was never
 * undone and {@code integrityCheckPolicy: 'after-unclean-shutdown'} meant
 * ALWAYS: a full {@code PRAGMA integrity_check} over the family's whole history,
 * paid by the parent, at every launch. {@code DIA-DL-008} debt 8 named the
 * closing condition precisely — "evidence on whether the Android WebView
 * reliably fires {@code pagehide} before process death, and a disposition that
 * does not depend on it if it does not". This suite IS that evidence, for a
 * disposition that does not depend on {@code pagehide} at all: the app parks its
 * store on {@code visibilitychange} going hidden, and what this test does is
 * drive a real activity to STOPPED and read what the app then wrote.
 *
 * <p>WHY THE OBSERVABLE IS THE SIGNAL CHANNEL AND NOT THE DATABASE. The store is
 * SQLCipher, keyed by a passphrase the plugin minted into
 * {@code EncryptedSharedPreferences}; a test process opening that file itself
 * would need the key, and asking for it would put the key somewhere new for the
 * sake of an assertion (§4). The app already reports both facts on the
 * {@code [signal]} channel {@code DIA-P5} built — {@code store.open} carries
 * {@code previous_run_clean}, and {@code store.close} is added by this packet —
 * so what is read is what the app itself says happened, through
 * {@code SignalConsoleClient} and {@code android.util.Log}, exactly as the
 * RUNBOOK smoke reads it.
 *
 * <p>THE CONTRASTING VALUE IS NOT MANUFACTURED IN-RUN, AND SAYING SO IS THE
 * POINT. An absence-shaped claim wants a control, and the honest control here is
 * the record rather than a fixture: every dispatch through {@code DIA-P5} logged
 * {@code previous_run_clean=false} on every open, including opens whose previous
 * close was orderly — {@code DIA-DL-008} debt 8 records that as observed, and run
 * {@code 32074105863}'s own line reads {@code freshly_created=true
 * previous_run_clean=true} only because that store had never existed before. A
 * park cannot be undone inside one process to produce the false value on demand,
 * so this suite does not pretend to. What it DOES arm in-run is the mechanism:
 * the close line must appear where there was none, and the open count must rise
 * after the resume. Either half missing reds, and a park that did nothing reds
 * on the first.
 *
 * <p>WHAT IS NOT CLAIMED. That the marker survives a process kill — nothing here
 * kills the process, and the design does not depend on it: an app taken by the
 * system between {@code onStop} and the write simply leaves the marker clear,
 * which is what every run did before this packet and is the correct answer for a
 * run that really died. And nothing here is a claim about how LONG a reopen
 * costs a parent on their own phone; the number this run prints is one emulator's.
 */
@RunWith(AndroidJUnit4.class)
public class StoreLifecycleTest {

    private static final String TAG = "FIU";

    private static final long POLL_MS = 400;
    private static final long EVALUATE_TIMEOUT_MS = 30_000;
    private static final long ACT_TIMEOUT_MS = 120_000;
    private static final long SIGNAL_TIMEOUT_MS = 60_000;

    private static final String OPEN_SIGNAL = "[signal] store.open";
    private static final String CLOSE_SIGNAL = "[signal] store.close";

    @Test
    public void a_backgrounded_app_closes_its_store_and_the_next_open_finds_a_clean_marker() {
        // The window. Written BEFORE the activity launches, and never with
        // `logcat -c`, which would destroy the CI artefact every other suite in
        // this run depends on. Seven other suites open the store in this same
        // process, so a count taken over the whole log would be counting them.
        String marker = "store-lifecycle control " + Process.myPid() + "-" + System.nanoTime();
        Log.i(TAG, marker);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOT_GATE, EVALUATE_TIMEOUT_MS);

            int openedAtBoot = awaitAtLeast(marker, OPEN_SIGNAL, 1);
            assertEquals(
                    "the app did not report opening its store at boot, so nothing below is about"
                            + " a store this run opened",
                    1,
                    openedAtBoot);
            assertEquals(
                    "a store.close line exists before anything was backgrounded — the window is"
                            + " not scoped to this leg and every count below is somebody else's",
                    0,
                    occurrences(window(marker), CLOSE_SIGNAL));

            // THE ACT. STOPPED is what a home-button press and a screen lock both
            // produce, and it is the moment the page's visibility changes.
            scenario.moveToState(Lifecycle.State.CREATED);

            awaitAtLeast(marker, CLOSE_SIGNAL, 1);
            String closed = lastLine(window(marker), CLOSE_SIGNAL);
            Log.i(TAG, "the park, as the app reported it: " + closed);
            assertTrue(
                    "the app reported a close that did not complete: " + closed,
                    closed.contains("outcome=complete"));
            assertTrue(
                    "the close reported a failure class: " + closed,
                    closed.contains("failure_class=none"));

            // THE RETURN. The store is not reopened by coming back — it is
            // reopened by the first thing that needs it, which is the whole
            // reason a screen unlock that touches nothing costs nothing.
            scenario.moveToState(Lifecycle.State.RESUMED);
            pollFor(scenario, BOOT_GATE, EVALUATE_TIMEOUT_MS);

            String read = await(scenario, "__lifecycleRead", READ_THROUGH_THE_SHIPPED_DOOR);
            Log.i(TAG, "the read that reopened the store: " + read);
            assertTrue("the shipped read did not answer: " + read, read.startsWith("children:"));

            awaitAtLeast(marker, OPEN_SIGNAL, 2);
            String reopened = lastLine(window(marker), OPEN_SIGNAL);
            Log.i(TAG, "the reopen, as the app reported it: " + reopened);

            // THE CLAIM. Before this packet this line read false on every open
            // in every dispatch, including opens after an orderly close.
            assertTrue(
                    "the open after an orderly background still reports an unclean previous run,"
                            + " so PRAGMA integrity_check is still owed at every launch: "
                            + reopened,
                    reopened.contains("previous_run_clean=true"));
            assertTrue(
                    "the reopen did not report itself as an open: " + reopened,
                    reopened.contains("outcome=opened"));
        }
    }

    // --- the scripts, kept as whole literals so the parse guard can read them --

    /** The boot gate, answered with its own name so a silence is never a value. */
    private static final String BOOT_GATE =
            "(document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0)"
                    + " ? 'booted' : null";

    /**
     * One read through the shipped door, which is what trips the reopen.
     *
     * <p>{@code loadChildren()} and not a bare plugin call on purpose: what has
     * to work after a resume is the path a SURFACE takes, and every surface goes
     * through {@code store/boot.js}. A probe that reached past it would prove the
     * plugin still answers and say nothing about whether the app can.
     */
    private static final String READ_THROUGH_THE_SHIPPED_DOOR =
            "import(u('store/boot.js')).then(function (module) {"
                    + " return module.loadChildren(); })"
                    + ".then(function (rows) { return 'children:' + rows.length; })";

    // --- plumbing, copied in shape from DeviceLogTest ------------------------

    /**
     * Dispatches an async script and waits for its answer in a named slot.
     *
     * <p>Copied in shape from {@code DeviceLogTest} rather than shared, for the
     * reason {@code EMV-DL-006} records about {@code BOOTED}: a shared base class
     * would couple these suites' timeouts and their failure messages, and this
     * packet's claim is about this file.
     */
    private String await(ActivityScenario<MainActivity> scenario, String slot, String body) {
        String script =
                ("(function () {"
                                + "window.__SLOT__ = null;"
                                + "var base = '__BASE__';"
                                + "var u = function (n) { return new URL(base + n, document.baseURI).href; };"
                                + "__BODY__"
                                + ".then(function (answer) { window.__SLOT__ = String(answer); })"
                                + ".catch(function (e) {"
                                + " window.__SLOT__ = 'err:' + (e && (e.name + ':' + e.message)); });"
                                + "return 'dispatched';"
                                + "})()")
                        .replace("__SLOT__", slot)
                        .replace("__BODY__", body)
                        .replace("__BASE__", MountAddress.prefix());

        assertEquals("the script never ran", "dispatched", evaluate(scenario, script));
        String answer = pollFor(scenario, "window." + slot, ACT_TIMEOUT_MS);
        assertTrue("the script failed: " + answer, answer != null && !answer.startsWith("err:"));
        return answer;
    }

    /**
     * Waits until the log window holds at least {@code wanted} of {@code needle}.
     *
     * <p>Returns the count it settled on, so a leg can assert on it rather than
     * on the fact that waiting ended.
     */
    private int awaitAtLeast(String marker, String needle, int wanted) {
        long deadline = System.currentTimeMillis() + SIGNAL_TIMEOUT_MS;
        int seen = 0;
        while (System.currentTimeMillis() < deadline) {
            seen = occurrences(window(marker), needle);
            if (seen >= wanted) return seen;
            sleep();
        }
        fail(
                "waited "
                        + SIGNAL_TIMEOUT_MS
                        + " ms for "
                        + wanted
                        + " × \""
                        + needle
                        + "\" and saw "
                        + seen
                        + ". If the count is 0 for store.close, the page never learned it had"
                        + " gone hidden — which is the fact DIA-DL-008 debt 8 asked to be"
                        + " measured, and the answer is then to drive the park from"
                        + " MainActivity.onStop instead of from the DOM event.");
        return seen;
    }

    /** This process's log, from the control marker onward. */
    private static String window(String marker) {
        String all = dump("logcat -d -v threadtime --pid=" + Process.myPid());
        int at = all.lastIndexOf(marker);
        return at < 0 ? "" : all.substring(at);
    }

    private static String lastLine(String haystack, String needle) {
        String found = "";
        for (String line : haystack.split("\n")) {
            if (line.contains(needle)) found = line.trim();
        }
        assertTrue("no line carrying \"" + needle + "\" in the window", !found.isEmpty());
        return found;
    }

    private static int occurrences(String haystack, String needle) {
        int count = 0;
        int at = haystack.indexOf(needle);
        while (at >= 0) {
            count += 1;
            at = haystack.indexOf(needle, at + needle.length());
        }
        return count;
    }

    private static String dump(String command) {
        ParcelFileDescriptor descriptor =
                InstrumentationRegistry.getInstrumentation()
                        .getUiAutomation()
                        .executeShellCommand(command);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            byte[] buffer = new byte[8192];
            int read = in.read(buffer);
            while (read != -1) {
                out.write(buffer, 0, read);
                read = in.read(buffer);
            }
            return out.toString("UTF-8");
        } catch (IOException failure) {
            fail("the log could not be read: " + failure.getClass().getName());
            return "";
        }
    }

    private String pollFor(ActivityScenario<MainActivity> scenario, String expression, long budget) {
        long deadline = System.currentTimeMillis() + budget;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (value != null && !"null".equals(value) && !"false".equals(value)) {
                return value;
            }
            sleep();
        }
        fail("timed out waiting for " + expression);
        return null;
    }

    private String evaluate(ActivityScenario<MainActivity> scenario, String expression) {
        AtomicReference<String> result = new AtomicReference<>(null);
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(
                activity -> {
                    WebView webView = activity.getBridge().getWebView();
                    webView.evaluateJavascript(
                            expression,
                            value -> {
                                result.set(unquote(value));
                                latch.countDown();
                            });
                });
        try {
            if (!latch.await(EVALUATE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                fail("the WebView never answered " + expression);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail("interrupted evaluating " + expression);
        }
        return result.get();
    }

    private static void sleep() {
        try {
            Thread.sleep(POLL_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String unquote(String value) {
        if (value == null || "null".equals(value)) return null;
        String out = value;
        if (out.length() >= 2 && out.startsWith("\"") && out.endsWith("\"")) {
            out = out.substring(1, out.length() - 1);
        }
        return out.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
