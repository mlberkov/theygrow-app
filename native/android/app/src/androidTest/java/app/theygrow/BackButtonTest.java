package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.fail;

import android.view.KeyEvent;
import android.webkit.WebView;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The hardware back button, as a phone performs it (NAV-P3-INV-001, device
 * half).
 *
 * <p>WHY THIS IS THE ONLY OBSERVER OF ITS CLAIM. {@code
 * app/tests/back-button.spec.js} drives the shipped JavaScript by dispatching
 * the same window event {@link BackButtonPlugin} dispatches, and it settles the
 * page's whole share of the decision: which window closes, which surface is on
 * screen, and which single answer goes back to the plugin. Two things are
 * outside any browser and are the reason this file exists:
 *
 * <ul>
 *   <li>that a REAL {@code KEYCODE_BACK} — the key the platform delivers, not an
 *       event we synthesised — reaches that page at all, through an
 *       {@code OnBackPressedCallback} registered on the activity; and
 *   <li>THE THIRD CASE. «Otherwise let the system default happen» cannot be
 *       observed where there is no task to leave. Here it can: after the press,
 *       the activity is no longer in the foreground.
 * </ul>
 *
 * <p>THE ARMING PROVES ITSELF, IN THIS RUN, AND THAT IS WHY THE THREE CASES ARE
 * ONE METHOD IN ONE ORDER. Case three would pass against an app that never armed
 * the interceptor at all — a disarmed plugin also lets the platform default
 * happen, which is exactly its fail-closed resting state. So cases one and two
 * run first in the same scenario: each of them is a press the interceptor
 * SWALLOWED, with the app still in the foreground afterwards. Only after that is
 * a press that leaves evidence of anything.
 *
 * <p>WHAT IS DELIBERATELY NOT CLAIMED. Not WHICH default the platform picks.
 * A root {@code singleTask} activity may be finished or its task moved to the
 * back, the rule has changed across releases, and {@link BackButtonPlugin}
 * re-dispatches the press precisely so that the platform keeps deciding rather
 * than us. What is asserted is that the press reached the platform: the app left
 * the foreground. Restating the platform's own rule here would be the second
 * copy of it that the plugin refuses to keep.
 *
 * <p>And, as everywhere in this directory: the emulator is not the family's
 * phone. This is one image, and {@code android-instrumented} is not a per-push
 * gate, so a regression here can arrive several commits after its cause.
 */
@RunWith(AndroidJUnit4.class)
public class BackButtonTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    /** True while the greeting window is on screen. */
    private static final String GREETING_OPEN =
            "document.getElementById('onboardingModal').classList.contains('show')";

    /** True while the diary surface is the current one. */
    private static final String DIARY_CURRENT =
            "document.getElementById('diaryModal').classList.contains('show')";

    @Test
    public void the_back_button_closes_a_window_then_steps_the_pager_then_leaves() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals(
                    "the injected bridge is missing, so nothing could have armed the interceptor",
                    "function",
                    pollForNonNull(scenario, "typeof window.Capacitor.nativePromise"));

            // The app booted far enough to have a pager at all: the switcher is
            // rendered, which only happens on the native branch.
            assertEquals(
                    "the surface switcher never rendered, so this is not the app under test",
                    "true",
                    pollFor(
                            scenario,
                            "document.getElementById('surfaceNav').offsetParent !== null",
                            "true"));

            // ---- CASE ONE: a window is open -------------------------------
            evaluate(
                    scenario,
                    "(function () {"
                        + "document.getElementById('menuBtn').click();"
                        + "document.getElementById('menuAboutBtn').click();"
                        + "return 'opened';"
                        + "})()");
            assertEquals("the greeting never opened", "true", pollFor(scenario, GREETING_OPEN, "true"));
            assertEquals(
                    "the diary was already open before the first press",
                    "false",
                    evaluate(scenario, DIARY_CURRENT));

            pressBack();

            assertEquals(
                    "back did not close the open window",
                    "false",
                    pollFor(scenario, GREETING_OPEN, "false"));
            // A press that closed a window is not also a press that navigated.
            assertEquals(
                    "back closed the window AND moved the pager",
                    "false",
                    evaluate(scenario, DIARY_CURRENT));
            assertEquals(
                    "the app left the foreground on a press it should have swallowed",
                    Lifecycle.State.RESUMED,
                    scenario.getState());

            // ---- CASE TWO: off the start surface --------------------------
            evaluate(scenario, "document.getElementById('surfaceDiaryBtn').click(); 'pressed'");
            assertEquals(
                    "the diary surface never came up",
                    "true",
                    pollFor(scenario, DIARY_CURRENT, "true"));

            pressBack();

            assertEquals(
                    "back did not step the pager off the diary",
                    "false",
                    pollFor(scenario, DIARY_CURRENT, "false"));
            assertEquals(
                    "the app left the foreground on a press it should have swallowed",
                    Lifecycle.State.RESUMED,
                    scenario.getState());

            // ---- CASE THREE: the start surface, nothing open --------------
            //
            // Everything above is the arming for this: two presses were
            // intercepted and consumed, in this run, so the interceptor is
            // demonstrably armed and what follows is not the resting state of a
            // plugin that never woke up.
            assertEquals("a window is open before the last press", "false", evaluate(scenario, GREETING_OPEN));
            assertEquals("the pager is not on the start surface", "false", evaluate(scenario, DIARY_CURRENT));

            pressBack();

            waitForForegroundToEnd(scenario);
            assertNotEquals(
                    "the app stayed in the foreground: the press never reached the platform",
                    Lifecycle.State.RESUMED,
                    scenario.getState());
        }
    }

    // --- the platform press -------------------------------------------------

    /**
     * A real key event, delivered by the platform to the focused window.
     *
     * <p>Deliberately NOT {@code onBackPressedDispatcher.onBackPressed()} on the
     * activity: that would call our own callback directly and prove only that
     * the callback works, skipping the whole question of whether the platform
     * routes a back press to it under this manifest, this {@code targetSdk} and
     * this launch mode. The point of a device leg is the part a unit call
     * removes.
     */
    private void pressBack() {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    private void waitForForegroundToEnd(ActivityScenario<MainActivity> scenario) {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (scenario.getState() != Lifecycle.State.RESUMED) {
                return;
            }
            sleep();
        }
        fail("timed out waiting for the app to leave the foreground after the last back press");
    }

    // --- WebView plumbing, same shape as BuildInfoTest ----------------------

    /** Polls until the expression evaluates to exactly {@code expected}. */
    private String pollFor(
            ActivityScenario<MainActivity> scenario, String expression, String expected) {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        String last = null;
        while (System.currentTimeMillis() < deadline) {
            last = evaluate(scenario, expression);
            if (expected.equals(last)) {
                return last;
            }
            sleep();
        }
        fail("timed out waiting for " + expression + " to be " + expected + "; last was " + last);
        return null;
    }

    private String pollForNonNull(ActivityScenario<MainActivity> scenario, String expression) {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (value != null && !"null".equals(value)) {
                return value;
            }
            sleep();
        }
        fail("timed out waiting for " + expression);
        return null;
    }

    private void sleep() {
        try {
            Thread.sleep(POLL_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail("interrupted while polling");
        }
    }

    private String evaluate(ActivityScenario<MainActivity> scenario, String expression) {
        AtomicReference<String> result = new AtomicReference<>(null);
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(
                activity -> {
                    WebView webView = activity.getBridge().getWebView();
                    webView.evaluateJavascript(expression, value -> {
                        result.set(unquote(value));
                        latch.countDown();
                    });
                });
        try {
            if (!latch.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                fail("the WebView never answered " + expression);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail("interrupted evaluating " + expression);
        }
        return result.get();
    }

    private static String unquote(String value) {
        if (value == null || "null".equals(value)) {
            return null;
        }
        String out = value;
        if (out.length() >= 2 && out.startsWith("\"") && out.endsWith("\"")) {
            out = out.substring(1, out.length() - 1);
        }
        return out.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}
