package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.UiAutomation;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.util.Log;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * What the app writes to the device log, and what it must never write (DIA-P5).
 *
 * <p>WHY THIS SUITE EXISTS. Capacitor's bridge traces every plugin call's whole
 * argument object: {@code Bridge.java:826-837} logs {@code ", methodData: " +
 * call.getData().toString()}. Every family value this app holds crosses that
 * bridge as a bound parameter, so every one of them was written to logcat —
 * measured on {@code android-instrumented} run 32044006357, which carried
 * <b>707</b> {@code methodData:} lines — the store's SQLCipher passphrase in
 * cleartext among them. A second emitter doubles it from the JavaScript side:
 * with logging enabled the injected bridge prints every plugin RESULT through
 * {@code c.dir(JSON.stringify(result.data))}, which is whole rows of diary text,
 * and {@code BridgeWebChromeClient} forwards that console line to logcat too.
 * Across BOTH of them that run carried the child's name on 31 lines, a diary
 * body on 13 and a second body on 8; the trace's own share was 5, 8 and 1, and
 * the rest came from the echo, which is the larger emitter for anything the app
 * reads back.
 *
 * <p>THE LEAK PREDATES L2. The bridge has traced arguments since L1-P1; a
 * child's name crosses it on the launch that creates the child and on every read
 * of the child list, though not on a mark — {@code appendMark} binds the child's
 * id and never its name. What L2 added is
 * diary text, search expressions, and {@code DIA-P4-INV-002}, a written claim
 * that the search term reaches exactly two places. It reached a third.
 *
 * <p>WHY NO OFF-DEVICE TEST COULD HAVE SEEN IT. {@code DIA-P4-INV-002}'s runtime
 * enforcer watches a Playwright page console against an in-page fake bridge. The
 * emitter is Java, below that bridge, in a process no browser test starts. This
 * claim is about a device and its executor runs on one (AGENTS.md §11).
 *
 * <p>WHAT A GREEN HERE IS WORTH, AND WHY THE CONTROLS ARE THE POINT. An
 * assertion that a string is absent goes green when the string is gone, when the
 * scanner never looked, and when the needle could never have matched. This
 * milestone has spent three repair rounds on greens that meant nothing, so the
 * absence is carried by three controls that are themselves assertions:
 *
 * <ol>
 *   <li><b>The matcher arms itself.</b> The scanner is run over a synthetic line
 *       built in the exact shape run 32044006357 produced, carrying THIS suite's
 *       own needles, and every needle must be found in it. That is the guard
 *       generating its own failing input in-run.
 *   <li><b>The capture proves itself.</b> A Cyrillic control marker is written
 *       to the log before the app launches, and the scan must find it. One
 *       mechanism, three jobs: it proves the reader reaches this process's
 *       output, it proves Cyrillic survives the read — the failure mode that
 *       would silently zero every needle at once — and it marks where this
 *       leg's own traffic begins without {@code logcat -c}, which needs shell
 *       and would destroy the CI job's own artefact for every other suite. The
 *       needle scan deliberately covers the WHOLE process rather than that
 *       marker window: the claim is about the process, and a full run holds
 *       seven other suites' traffic in it — marks, imports, transfers,
 *       exports — that this leg never performs. The window scopes only the
 *       channel assertion.
 *   <li><b>The reader's scope proves itself.</b> A second, unfiltered dump must
 *       contain a line from some other process, so a reader that could only ever
 *       see what this test itself wrote is caught.
 * </ol>
 *
 * <p>AND THE CHANNEL IS ASSERTED ALIVE, in the same window, through the same
 * reader. The fix silences {@code com.getcapacitor.Logger} outright, which would
 * have taken the {@code [signal]} diagnostic channel with it — measured: all 41
 * {@code [signal]} lines in run 32044006357 carry tag {@code Capacitor/Console},
 * and there are zero {@code chromium: [INFO:CONSOLE} lines, so nothing else logs
 * console for us. {@link SignalConsoleClient} carries the channel instead, on
 * its own tag, past the Logger gate. A suite that only asserted the absence
 * would be a test that can only go green; this one reads a positive through the
 * identical JS-console path the leak used.
 *
 * <p>THE NEEDLE IS THE EXPRESSION, NOT THE WORD THE PARENT TYPED, and that
 * distinction is measured rather than assumed. The shipped prefix ceiling is 3
 * ({@code DIA-DL-008}), so «села» reaches the store as {@code ("сел"* OR
 * "сёл"*)} and a grep for «села» over run 32044006357 returns <b>zero</b> while
 * one traced expression exists per search — 5 of the 5 that run performed. A
 * needle taken from the input box would have issued a false green here.
 *
 * <p>AND THE NEEDLE CARRIES THE JSON ESCAPING, for the same class of reason.
 * {@code JSObject.toString()} escapes the quotes, so the expression appears in
 * logcat as {@code (\"под\"*)}. An unescaped needle counts zero against a log
 * that carries the leak — measured on this branch while this file was written.
 *
 * <p>AND ONE LEG DOES NOT WATCH BEHAVIOUR AT ALL, because behaviour was not the
 * whole exposure. The value that closes the trace lives in {@code
 * assets/capacitor.config.json}, which {@code cap sync} generates and git
 * ignores; the static guard in {@code app/tests/native-shell.spec.js} reads the
 * repository's copy, and this suite runs on whatever the local sync produced.
 * An APK built where that sync was skipped traces everything again and would
 * satisfy both. So {@link #the_installed_build_declares_the_knob_that_closes_the_trace}
 * reads the knob out of the APK under test — the artefact, not the description
 * of it.
 *
 * <p>WHAT THIS SUITE DOES NOT REACH. It runs on the DEBUG build, which is the
 * only build any device has ever held ({@code docs/RUNBOOK.md}: "no release
 * build has been installed on any device") and the one that document tells the
 * owner to install. A release build resolves {@code loggingBehavior} the same
 * way and is silent for a second reason ({@code FLAG_DEBUGGABLE} clear); that
 * second reason is derived from AGP's own defaults and is NOT observed here,
 * because no release artefact exists. It scans this process's log output; it
 * says nothing about the saved-instance-state parcel, about the handoff link's
 * journey through the activity manager, about {@code
 * webContentsDebuggingEnabled}, which is a different sink on the same build, or
 * about the ungated tags below Capacitor — {@code SQLiteLog}, the SQLite
 * plugin's own {@code android.util.Log} calls, and this app's own {@code
 * TheyGrowTransfer}, none of which the knob touches and none of which this suite
 * drives.
 */
@RunWith(AndroidJUnit4.class)
public class DeviceLogTest {

    private static final String TAG = "LOGSCAN";

    private static final long POLL_MS = 400;
    private static final long EVALUATE_TIMEOUT_MS = 30_000;
    private static final long ACT_TIMEOUT_MS = 120_000;

    /** A DOM fact the app's OWN modules produce — same sentinel as the siblings. */
    private static final String BOOTED =
            "document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0";

    // --- this leg's fixture, and it belongs to this leg alone (DIA-DL-002) ---

    private static final String CHILD_ID = "dia-p5-log-child";
    private static final String CHILD_NAME = "Логопроба";
    private static final String BIRTHDATE = "2011-11-11";
    private static final String AN_ENTRY = "Сам залез на подоконник";

    /**
     * Three characters, and the length is load-bearing rather than incidental.
     *
     * <p>{@code diarySearchStemChars} is 3, so a longer word would reach the
     * store truncated and this constant would name something the bridge never
     * saw. At three the typed word and the bound term are the same string, which
     * is what lets one needle stand for both halves of the claim.
     */
    private static final String TYPED = "под";

    /** The expression the shipped builder makes of {@link #TYPED}, as logcat escapes it. */
    private static final String MATCH_EXPRESSION = "(\\\"под\\\"*)";

    /**
     * What is hunted, in the order a reader should think about it.
     *
     * <p>The last two are not family text and are here on purpose. {@code
     * methodData: } is the TRACE CHANNEL itself: zero of those means the emitter
     * is silent, which no change of fixture text can fake and no future rename
     * of a fixture can weaken. {@code passphrase} is the store's key, which
     * crossed the bridge in cleartext on run 32044006357 — it is minted once per
     * device, so on a warm store no call carries it and this needle is vacuous;
     * on CI, where every run gets a fresh emulator, it is live.
     */
    private static final Map<String, String> NEEDLES = needles();

    private static Map<String, String> needles() {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("child-name", CHILD_NAME);
        map.put("birthdate", BIRTHDATE);
        map.put("diary-body", AN_ENTRY);
        map.put("search-expression", MATCH_EXPRESSION);
        map.put("trace-channel", "methodData: ");
        map.put("store-passphrase", "passphrase");
        return map;
    }

    /**
     * One line in the shape the leak produced, carrying every needle.
     *
     * <p>Modelled on run 32044006357's own lines — the record INSERT at 16:05:05,
     * the child INSERT at 16:04:59 and the search query at 16:05:00 — collapsed
     * into one so a single scan exercises every needle. It is never logged, only
     * scanned: writing it would put the needles into the very buffer the next
     * assertion reads.
     */
    private static String preChangeShape() {
        return ("08-17 16:05:05.956  5931  5931 V Capacitor: callback: 124314901, pluginId:"
                        + " CapacitorSQLite, methodName: run, methodData:"
                        + " {\"database\":\"theygrow\",\"statement\":\"INSERT INTO record (id, body)"
                        + " VALUES (?, ?)\",\"values\":[\"__NAME__\",\"__BIRTH__\",\"__BODY__\","
                        + "\"__MATCH__\"],\"passphrase\":\"2c886a56\"}")
                .replace("__NAME__", CHILD_NAME)
                .replace("__BIRTH__", BIRTHDATE)
                .replace("__BODY__", AN_ENTRY)
                .replace("__MATCH__", MATCH_EXPRESSION);
    }

    /**
     * The knob, read out of the APK rather than out of the repository.
     *
     * <p>WHY THIS IS NOT REDUNDANT WITH THE STATIC GUARD, and why the static
     * guard alone would have been a fail-open. `app/tests/native-shell.spec.js`
     * reads `native/capacitor.config.json` — the SOURCE. What the runtime reads
     * is `assets/capacitor.config.json`, which is **gitignored** and minted by
     * `npx cap sync`. An APK assembled in a tree whose sync was skipped or
     * failed after `tools/reset-sync-target.js` carries the old config, resumes
     * tracing every plugin call, and passes the source-reading guard. So this
     * leg reads the artefact under test, the way `MountAddress` reads the shell:
     * what the installed build declares, not what the repository holds.
     *
     * <p>It is a static property of an asset and carries no runtime claim by
     * itself (AGENTS.md §11) — the absence assertions below are the runtime
     * half. Together they separate "the build was configured" from "the build
     * behaves", which a single check cannot.
     */
    @Test
    public void the_installed_build_declares_the_knob_that_closes_the_trace() {
        String config = readAsset("capacitor.config.json");
        assertTrue(
                "the APK's own capacitor.config.json does not declare loggingBehavior at all —"
                        + " this build was assembled without `cap sync` picking up"
                        + " native/capacitor.config.json, and Capacitor's default traces every"
                        + " plugin call's arguments to logcat: " + squeeze(config),
                config.contains("\"loggingBehavior\""));
        assertTrue(
                "the APK's own capacitor.config.json declares loggingBehavior, but not as \"none\":"
                        + " " + squeeze(config),
                squeeze(config).contains("\"loggingBehavior\":\"none\""));
    }

    @Test
    public void the_app_writes_no_family_text_to_the_device_log() {
        // CONTROL 1, and it runs FIRST so a broken matcher cannot reach the
        // assertions it would make meaningless.
        Map<String, Integer> armed = count(preChangeShape());
        for (Map.Entry<String, String> needle : NEEDLES.entrySet()) {
            assertTrue(
                    "the scanner cannot find `"
                            + needle.getKey()
                            + "` in a line built in the shape run 32044006357 produced, so a zero"
                            + " count below would mean the matcher stopped matching rather than the"
                            + " app stopped writing: "
                            + render(armed),
                    armed.get(needle.getKey()) > 0);
        }

        // CONTROL 2. Written before the app launches, so the window covers boot
        // and therefore the store.open signal the channel assertion reads.
        String marker = "log-scan control контроль-кодировки-" + System.nanoTime();
        Log.i(TAG, marker);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            // The traffic: a child's name and birthdate, a diary entry, and a
            // search — every family value this app holds, across the real bridge
            // through the shipped modules. Not through the surface, deliberately:
            // the claim is about what the BRIDGE does with an argument, and every
            // one of these calls is the same plugin call the surface makes.
            String wrote = writeAndSearch(scenario);
            Log.i(TAG, "traffic: " + wrote);
            assertEquals(
                    "the traffic this scan is about never happened, so an empty log would prove"
                            + " nothing: " + wrote,
                    "searched:1",
                    wrote);

            String whole = dump("logcat -d -v threadtime --pid=" + Process.myPid());
            int at = whole.lastIndexOf(marker);
            assertTrue(
                    "the control marker is not in the captured log: the reader did not reach this"
                            + " process's output, or Cyrillic did not survive the read — either way"
                            + " every count below would be a zero that means nothing"
                            + " (captured " + whole.length() + " chars)",
                    at >= 0);
            String window = whole.substring(at);

            // CONTROL 3. A reader that could only see what this test wrote would
            // pass every assertion above and be worth nothing.
            assertTrue(
                    "the unfiltered dump carries no line from any other process, so the reader's"
                            + " scope cannot be trusted",
                    seesAnotherProcess());

            // THE NEEDLE SCAN IS OVER THE WHOLE PROCESS, NOT OVER THIS LEG'S
            // WINDOW, and the difference is the invariant's own sentence. The
            // claim is about what the app's PROCESS writes; the marker window
            // exists to prove the capture and to scope the channel assertion
            // below, and scanning only it would leave every other suite's
            // traffic in the same process unexamined — in a full run that is
            // seven other suites, including the ones that drive marks, imports,
            // transfers and exports, none of which this leg performs.
            Map<String, Integer> found = count(whole);
            List<String> offenders = new ArrayList<>();
            for (Map.Entry<String, Integer> hit : found.entrySet()) {
                if (hit.getValue() > 0) {
                    offenders.add(hit.getKey() + "=" + hit.getValue());
                }
            }
            // The needle itself is never printed and never will be: a red that
            // named it would write family text into the buffer the next run
            // scans, and this suite would become its own leak.
            assertEquals(
                    "the app wrote family text to the device log — counts by needle id, values"
                            + " deliberately withheld: " + render(found)
                            + " (scanned " + whole.length() + " chars of this process's log; on run"
                            + " 32044006357 the trace channel carried 707 lines, and across BOTH"
                            + " emitters the child's name appeared 31 times, the body 13, the"
                            + " expression on 5 of 5 searches and the passphrase once)",
                    "",
                    String.join(",", offenders));

            // THE OTHER HALF OF THE TRADE, through the same reader. Closing the
            // leak silences the Logger, and the [signal] channel rode on it.
            int signals = occurrences(window, "[signal] ");
            int storeOpen = occurrences(window, "[signal] store.open");
            int forwarded = occurrences(window, "TheyGrowSignal");
            Log.i(
                    TAG,
                    "the diagnostic channel after the gate closed: signals=" + signals
                            + " storeOpen=" + storeOpen + " taggedLines=" + forwarded);
            assertTrue(
                    "no [signal] line reached the log, so closing the leak took the diagnostic"
                            + " channel with it — the RUNBOOK's own §4 verification step reads"
                            + " these lines: signals=" + signals + " storeOpen=" + storeOpen,
                    storeOpen > 0);
            assertTrue(
                    "the signal lines are not carried by the app's own forwarder, so they are"
                            + " still riding the Capacitor gate this packet closed: taggedLines="
                            + forwarded,
                    forwarded >= signals && forwarded > 0);
        }
    }

    // --- the act, as a script ------------------------------------------------

    /**
     * Puts a name, a birthdate, an entry and a search expression across the
     * bridge, through the shipped modules.
     *
     * <p>The verdict is reduced to an ASCII token in JavaScript rather than
     * compared in Java: whether a Cyrillic character crosses {@code
     * evaluateJavascript} raw or escaped is Chromium's business, not this
     * assertion's.
     */
    private String writeAndSearch(ActivityScenario<MainActivity> scenario) {
        return await(
                scenario,
                "__p5Traffic",
                ("import(u('store/boot.js')).then(function (boot) {"
                                + "var handle = boot.storeHandle();"
                                + "if (!handle) { throw new Error('the store is not open'); }"
                                + "var author = handle.selfParticipantId;"
                                + "return boot.appendChild({ authorParticipantId: author,"
                                + " childId: '__CHILD__', name: '__NAME__',"
                                + " birthdate: '__BIRTH__' })"
                                + ".then(function () { return boot.createRecord({"
                                + " authorParticipantId: author, subjectChildId: '__CHILD__',"
                                + " body: '__BODY__', eventDateLocal: '2026-02-01' }); })"
                                + ".then(function () { return boot.searchRecords({"
                                + " authorParticipantId: author, subjectChildId: '__CHILD__',"
                                + " typed: '__TYPED__' }); })"
                                + ".then(function (out) {"
                                + " return 'searched:' + (out.rows.length > 0 ? 1 : 0); }); })")
                        .replace("__CHILD__", CHILD_ID)
                        .replace("__NAME__", CHILD_NAME)
                        .replace("__BIRTH__", BIRTHDATE)
                        .replace("__BODY__", AN_ENTRY)
                        .replace("__TYPED__", TYPED));
    }

    // --- the reader ----------------------------------------------------------

    /**
     * Runs a shell command as the instrumentation's shell identity and returns
     * its whole standard output.
     *
     * <p>{@code UiAutomation.executeShellCommand} is API 21 and this module's
     * minSdk is 24, so it needs no guard and no new dependency — {@code
     * InstrumentationRegistry} is already on this classpath and already used by
     * {@code MountAddress}. The instrumentation runs INSIDE the app's process,
     * which is what makes {@code Process.myPid()} the right filter: it is the
     * process whose log output the claim is about.
     *
     * <p>Nothing here clears the buffer. {@code logcat -c} would delete the
     * evidence the CI job uploads as {@code android-instrumented-logcat} for
     * every other suite in the same run; the window is bounded by a marker
     * instead.
     */
    private static String dump(String command) {
        UiAutomation automation = InstrumentationRegistry.getInstrumentation().getUiAutomation();
        ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
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

    /** True when an unfiltered dump carries a line from a process other than this one. */
    private static boolean seesAnotherProcess() {
        String mine = String.valueOf(Process.myPid());
        for (String line : dump("logcat -d -v threadtime -t 200").split("\n")) {
            String[] fields = line.trim().split("\\s+");
            if (fields.length > 2 && fields[2].matches("\\d+") && !mine.equals(fields[2])) {
                return true;
            }
        }
        return false;
    }

    /** Reads one file out of the APK's own assets, the way {@link MountAddress} reads the shell. */
    private static String readAsset(String name) {
        try (InputStream in =
                InstrumentationRegistry.getInstrumentation()
                        .getTargetContext()
                        .getAssets()
                        .open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read = in.read(buffer);
            while (read != -1) {
                out.write(buffer, 0, read);
                read = in.read(buffer);
            }
            return out.toString("UTF-8");
        } catch (IOException failure) {
            fail("the APK carries no asset at " + name + ": " + failure.getClass().getName());
            return "";
        }
    }

    /** Whitespace removed, so a formatting change in a generated file cannot decide a match. */
    private static String squeeze(String text) {
        return text.replaceAll("\\s+", "");
    }

    private static Map<String, Integer> count(String haystack) {
        Map<String, Integer> found = new LinkedHashMap<>();
        for (Map.Entry<String, String> needle : NEEDLES.entrySet()) {
            found.put(needle.getKey(), occurrences(haystack, needle.getValue()));
        }
        return found;
    }

    /**
     * Non-overlapping occurrences of a literal.
     *
     * <p>A literal scan and never a regular expression: this repository has
     * already paid for a guard whose regex failed open (AGENTS.md §11, case 3),
     * and every needle here is a fixed string.
     */
    private static int occurrences(String haystack, String needle) {
        int total = 0;
        int at = haystack.indexOf(needle);
        while (at >= 0) {
            total++;
            at = haystack.indexOf(needle, at + needle.length());
        }
        return total;
    }

    private static String render(Map<String, Integer> counts) {
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, Integer> hit : counts.entrySet()) {
            if (out.length() > 0) {
                out.append(';');
            }
            out.append(hit.getKey()).append('=').append(hit.getValue());
        }
        return out.toString();
    }

    // --- WebView plumbing, the shape the siblings use ------------------------

    private String await(ActivityScenario<MainActivity> scenario, String slot, String body) {
        String script =
                ("(function () {"
                                + "window.__SLOT__ = null;"
                                + "var base = '__BASE__';"
                                + "var u = function (n) {"
                                + " return new URL(base + n, document.baseURI).href; };"
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

    private String pollFor(ActivityScenario<MainActivity> scenario, String expression, long budget) {
        long deadline = System.currentTimeMillis() + budget;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (value != null && !"null".equals(value) && !"false".equals(value)) {
                return value;
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                fail("interrupted while waiting for " + expression);
            }
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
                    webView.evaluateJavascript(expression, value -> {
                        result.set(unquote(value));
                        latch.countDown();
                    });
                });
        try {
            if (!latch.await(EVALUATE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                fail("the WebView never answered " + expression);
            }
        } catch (InterruptedException interrupted) {
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
