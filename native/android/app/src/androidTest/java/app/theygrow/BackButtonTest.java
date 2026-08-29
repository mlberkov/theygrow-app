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
 * <p>WHAT THE FIRST OBSERVATION OF THIS LEG MEASURED, AND WHY THE GATE MOVED
 * (NAV-P5). Run 33251376412, on PR #36, is the only time this file has ever run
 * on CI, and it observed NONE of the three cases: it failed in SETUP, before the
 * first {@link #pressBack()}. The gate was {@code #surfaceNav}, which {@code
 * wireChannel()} un-hides in the {@code DOMContentLoaded} handler — PHASE ONE,
 * before any data. What the leg then drives is {@code #menuAboutBtn}, whose
 * listener {@code wireMenu()} attaches inside {@code init()} — PHASE TWO, behind
 * {@code await Promise.all([kbReady, initNativeStore()])}. A cold SQLite open put
 * 2405 ms between the two, so the clicks landed about 1.7 s before {@code init()}
 * began, on a menu nothing had been wired to; {@code pollFor} then polled the
 * assertion for thirty seconds without ever repeating the act. The gate did not
 * gate what the leg drives.
 *
 * <p>SO THE GATE IS THE BOOT SENTINEL, AND THAT IS AN ARGUMENT RATHER THAN A
 * PREFERENCE. {@code buildTableBody()} runs at {@code app.js:75}, {@code
 * wireMenu()} at {@code :96} and {@code wirePager()} at {@code :107}, and there
 * is NO {@code await} between them — the whole wiring block is one synchronous
 * continuation, and an {@code evaluateJavascript} probe cannot observe the
 * document in the middle of it. If the poller can see a row, everything this leg
 * presses has already been wired. NOTHING IS RELAXED BY THE MOVE: the timeout is
 * not raised, no act is retried, and no failure is caught. A retry loop would
 * have made this leg tolerate a menu that is never wired at all, which is the one
 * thing this repair must not be.
 *
 * <p>And, as everywhere in this directory: the emulator is not the family's
 * phone. This is one image, and {@code android-instrumented} is not a per-push
 * gate, so a regression here can arrive several commits after its cause.
 */
@RunWith(AndroidJUnit4.class)
public class BackButtonTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    /**
     * The boot sentinel: a DOM fact the app's OWN modules produce (EMV-DL-006).
     *
     * <p>Deliberately identical to the spelling in {@code BridgeSmokeTest},
     * {@code DiaryEntryTest}, {@code ExportTransferTest}, {@code
     * StoreLifecycleTest} and {@code WebViewStorageTest}, and deliberately
     * duplicated rather than extracted: pulling it into a shared helper would
     * edit five tests that pass in order to repair one that does not. The copies
     * point at each other, and retiring the duplication stays where {@code
     * EMV-DL-006} left it.
     *
     * <p>Rows carry {@code data-skill-id} from {@code surfaces/table.js}, and
     * {@code app.js} renders them only after {@code Promise.all([kbReady,
     * initNativeStore()])} resolves — so a row proves the module graph EVALUATED
     * and the store's own boot call already returned. {@code document.readyState}
     * would not do: it says the parser finished, and the parser finishing is not
     * the app having run.
     */
    private static final String BOOTED =
            "document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0";

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

            // THE READINESS GATE, AND IT IS A PHASE-TWO FACT (NAV-P5; see the
            // class comment). Not `#surfaceNav`, which is true of a document
            // whose modules have not run yet.
            assertEquals(
                    "the app never finished booting: no skill row was ever rendered",
                    "true",
                    pollFor(scenario, BOOTED, "true"));

            // The pager exists at all — READ ONCE, as a check on the channel
            // rather than as a wait. The sentinel above already establishes the
            // time; what this still carries and the sentinel does not is that
            // `surfaces/channel.js` revealed the switcher, which it does only on
            // the native branch. A browser-shaped build reds here by name.
            assertEquals(
                    "the surface switcher never rendered, so this is not the app under test",
                    "true",
                    evaluate(
                            scenario,
                            "document.getElementById('surfaceNav').offsetParent !== null"));

            // THE DOCUMENT IS CLEARED OF WHAT THE APP OPENED BY ITSELF, AND
            // THE STATE IS ASSERTED RATHER THAN ASSUMED (NAV-P5). A fresh
            // install has no child, so `offerProfileIfNone()` opens
            // #createProfileModal at the end of init() — measured on the
            // emulator, not deduced. That window is DECLARED (nav/overlays.js
            // row 5) and the greeting is row 1, and `topmostOpenOverlay()` scans
            // the table backwards: with both open, the first press closes the
            // create-profile window and the greeting stays put. The leg would
            // then red at «back did not close the open window» — accusing a
            // product that had done exactly what NAV-P3-INV-001 says. Case one
            // says «a window is open»; it has to be THIS window and no other.
            assertEquals(
                    "something the app opened by itself is still on screen, so the first press"
                            + " would be answered by the wrong window",
                    "clear",
                    clearWhatTheAppOpenedByItself(scenario));

            // ---- CASE ONE: a window is open -------------------------------
            //
            // THE ACT REPORTS WHETHER IT WAS PERFORMED, on the shape
            // DiaryEntryTest.openCompose() already uses. Without it an unwired
            // menu reds as «the greeting never opened» — an accusation aimed at
            // openOnboardingModal(), which is the wrong file, and is exactly what
            // run 33251376412 printed about a menu that had not been wired yet.
            assertEquals(
                    "the menu never led to the greeting",
                    "pressed",
                    openGreetingFromTheMenu(scenario));
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
            assertEquals(
                    "the surface switcher offered no way to the diary",
                    "pressed",
                    openTheDiarySurface(scenario));
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

    // --- the acts a parent performs -----------------------------------------

    /**
     * Opens the header menu and presses «О приложении», saying which step failed
     * when one does.
     *
     * <p>FOUR ANSWERS, NOT TWO, and the middle one is the reason. The panel is
     * {@code display: none} until it carries {@code .show}, so before the toggle
     * fires {@code #menuAboutBtn.offsetParent} is null whatever the cause — a row
     * missing from the shell and a toggle whose listener never attached are
     * indistinguishable at that instant. Checking the toggle's EFFECT in between
     * separates them: {@code menu-shut} is a handler defect and {@code no-about}
     * is a composition defect, and they are repaired in different files.
     *
     * <p>It is performed ONCE. Pressing again until the greeting appears would
     * turn this leg into one that passes against an app whose menu is wired
     * eventually, or never.
     */
    private String openGreetingFromTheMenu(ActivityScenario<MainActivity> scenario) {
        return evaluate(
                scenario,
                "(function () {"
                    + "var toggle = document.getElementById('menuBtn');"
                    + "if (!toggle || toggle.offsetParent === null) { return 'no-menu'; }"
                    + "toggle.click();"
                    + "var panel = document.getElementById('headerMenuPanel');"
                    + "if (!panel || panel.offsetParent === null) { return 'menu-shut'; }"
                    + "var about = document.getElementById('menuAboutBtn');"
                    + "if (!about || about.offsetParent === null) { return 'no-about'; }"
                    + "about.click();"
                    + "return 'pressed';"
                    + "})()");
    }

    /**
     * Presses the close control of the window a FRESH INSTALL opens by itself,
     * and reports what is still open afterwards.
     *
     * <p>Dismissed through the shell's OWN control — {@code #cancelProfile}, the
     * closer {@code nav/overlays.js} declares for that window — rather than by
     * stripping a class off an element: a fixture that reached into the DOM
     * would leave the module's own state saying the window is open, and the next
     * press would be answered by it anyway.
     *
     * <p>NOT by seeding a child to stop the window appearing. That would put a
     * store write in a leg that has nothing to do with the store, and it would
     * make the premise depend on a fixture rather than on an observation.
     *
     * <p>The answer names every element still carrying the reveal class, so a
     * red says WHICH window stood in the way instead of leaving the next reader
     * to take a logcat apart for it. The selector is {@code .show} rather than
     * {@code .modal.show} because the greeting is an {@code .onboarding-modal}
     * and would be missed by the narrower one.
     */
    private String clearWhatTheAppOpenedByItself(ActivityScenario<MainActivity> scenario) {
        return evaluate(
                scenario,
                "(function () {"
                    + "var offered = document.getElementById('createProfileModal');"
                    + "var cancel = document.getElementById('cancelProfile');"
                    + "if (offered && offered.classList.contains('show') && cancel) {"
                    + " cancel.click(); }"
                    + "var open = Array.prototype.map.call(document.querySelectorAll('.show'),"
                    + " function (element) { return element.id || element.className; });"
                    + "return open.length ? 'open:' + open.join(',') : 'clear';"
                    + "})()");
    }

    /**
     * Presses the diary entry in the surface switcher.
     *
     * <p>Self-reporting for the same reason as the act above, and it is the same
     * defect one case further down: the old form pressed the element
     * unconditionally, so an absent control threw inside the WebView and the leg
     * red two assertions later at «the diary surface never came up» — a surface
     * accused of not opening by a press that never happened. The probe asks
     * whether the control is RENDERED rather than whether it carries {@code
     * hidden}, because its container carries the attribute and it does not
     * (DiaryEntryTest.openCompose()).
     */
    private String openTheDiarySurface(ActivityScenario<MainActivity> scenario) {
        return evaluate(
                scenario,
                "(function () {"
                    + "var open = document.getElementById('surfaceDiaryBtn');"
                    + "if (!open || open.offsetParent === null) { return 'not-offered'; }"
                    + "open.click();"
                    + "return 'pressed';"
                    + "})()");
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
