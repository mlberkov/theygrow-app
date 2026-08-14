package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The premise the whole buildless decision rests on (LSC-DL-002, D-2).
 *
 * <p>The shipped web assets import NOTHING from the npm tree. They reach the
 * SQLite plugin through the bridge the native layer injects into the WebView —
 * {@code Capacitor.nativePromise(pluginName, methodName, options)}. If that call
 * path did not work, the packet's answer would be to vendor the plugin's ESM
 * entry rather than to introduce a bundler, and this test is what tells the
 * difference. It is deliberately the cheapest possible probe of it: an echo.
 *
 * <p>The second test then rides the same path all the way down — bridge to
 * plugin to SQLCipher to the applied schema — by asking the app's own store
 * module what happened at boot. Between them, these two cover the one claim no
 * desktop test in this packet can make.
 */
@RunWith(AndroidJUnit4.class)
public class BridgeSmokeTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    /**
     * The boot sentinel: a DOM fact the app's OWN modules produce (EMV-DL-006).
     *
     * <p>Deliberately identical to {@code WebViewStorageTest.BOOTED}, and
     * deliberately duplicated rather than extracted: pulling it into a shared
     * helper would edit a test that passes, and this packet's claim is about this
     * file. The two copies point at each other; retiring the duplication is
     * recorded as deferred in {@code EMV-DL-006}.
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

    /**
     * The gate the store probe waits on: null until the app has booted, then the
     * {@code src} the LIVE document executes — which is checked against the mount
     * {@code MountAddress} read out of the APK.
     *
     * <p>A parsed document with no module entry answers {@code 'no-module-entry'}
     * rather than null, so that state reds immediately with its own name instead
     * of consuming the whole 30 s clock as a silence.
     */
    private static final String SHELL_ENTRY =
            "(function () {"
                + "if (!(" + BOOTED + ")) { return null; }"
                + "var entry ="
                + " document.querySelector('script[type=\"module\"][src$=\"app.js\"]');"
                + "return entry ? entry.getAttribute('src') : 'no-module-entry';"
                + "})()";

    /**
     * What the boot gate was looking at, evaluated ONLY if the gate times out.
     * Distinguishes the three states the gate's silence would otherwise merge: a
     * document that never committed, a document that committed but whose shipped
     * head script never ran, and an app that booted far enough to parse but never
     * rendered a row.
     */
    private static final String BOOT_DIAGNOSTIC =
            "JSON.stringify({"
                + "readyState: document.readyState,"
                + "baseURI: document.baseURI,"
                + "isNativeShell: !!window.IS_NATIVE_SHELL,"
                + "rows: document.querySelectorAll('#tableBody tr[data-skill-id]').length,"
                + "moduleEntries: Array.prototype.map.call("
                + "document.querySelectorAll('script[type=\"module\"][src]'),"
                + " function (s) { return s.getAttribute('src'); })"
                + "})";

    /**
     * What the store probe was actually looking at, evaluated ONLY when the poll
     * times out. Every field here answers a question the bare timeout could not:
     * which URL the probe imported and which mount that came from, which mount
     * the live document actually executes, what the shell hints, whether the
     * module ever loaded, and whether its handle is null because the store failed
     * or because nothing on that copy was ever initialised.
     *
     * <p>{@code shellHint} is REPORTED STATE, not the anchor. EMV-P5 made it the
     * anchor on the strength of {@code A1-P6-INV-001}, which asserts a set
     * equality over {@code app/index.html} — a property of the FILE, and not a
     * promise that any particular element is in the DOM at the instant a probe
     * reads it. It is kept here because a hint that disagrees with
     * {@code probeUrl} still names a real defect.
     *
     * <p>A method rather than a constant because {@code MountAddress} reads the
     * APK, so the mount is not known until the instrumentation is running.
     */
    private static String storeProbeDiagnostic() {
        return "JSON.stringify({"
                + "probeUrl: window.__storeProbeUrl,"
                + "mountFromApk: '" + MountAddress.prefix() + "',"
                + "entrySrc: (document.querySelector("
                + "'script[type=\"module\"][src$=\"app.js\"]') || {}).src || null,"
                + "shellHint: (document.querySelector("
                + "'link[rel=\"modulepreload\"][href$=\"/store/boot.js\"]') || {}).href || null,"
                + "readyState: document.readyState,"
                + "baseURI: document.baseURI,"
                + "moduleLoaded: !!window.__storeModule,"
                + "storeHandleType: window.__storeModule"
                + " ? typeof window.__storeModule.storeHandle : 'no-module',"
                + "storeHandle: (window.__storeModule"
                + " && typeof window.__storeModule.storeHandle === 'function')"
                + " ? window.__storeModule.storeHandle() : null,"
                + "importError: window.__storeImportError"
                + "})";
    }

    /**
     * WHY THIS TEST TAKES NO BOOT GATE, WRITTEN DOWN RATHER THAN LEFT TO BE
     * REDISCOVERED (EMV-DL-006).
     *
     * <p>Its sibling below needs one. This one waits too — but by a side effect
     * of {@code pollFor}'s contract rather than by a stated gate, and that
     * difference was found while diagnosing the sibling's red. Left unsaid, the
     * next reader would take the asymmetry for a design.
     *
     * <p><b>The wait.</b> {@code typeof window.Capacitor.nativePromise} THROWS
     * while {@code window.Capacitor} is undefined; {@code evaluateJavascript}
     * reports a thrown expression as {@code null}, and {@code pollFor} waits on
     * null. So the first assertion polls until the bridge has been injected, and
     * that is the only precondition this test has. It deliberately does NOT wait
     * for the app: the claim is that the INJECTED BRIDGE reaches the plugin with
     * no bundled JS, which is a property of the native layer and must hold
     * whether or not a single shipped module ever evaluates. Gating it on the
     * app's boot would make a bridge-level claim depend on the very thing the
     * bridge is supposed to be independent of.
     *
     * <p><b>Why the accidental wait is nonetheless SOUND.</b> This test cannot go
     * green early, which is the property that matters and the one
     * {@code WebViewStorageTest} lost in run {@code 31680204645}. Evaluated
     * before injection it throws and polls again; evaluated after injection but
     * with the method absent it answers {@code "undefined"} — non-null, so the
     * poll returns it and the assertion reds with its own message. There is no
     * early state in which {@code "function"} is returned by a bridge that is not
     * there. Its failure modes are all false-RED, never false-green.
     *
     * <p><b>What would end that, and what to do then.</b> Any rewrite that makes
     * the polled expression TOTAL — wrapping it in {@code String(...)}, or
     * reaching through {@code window.Capacitor?.nativePromise} — removes the
     * throw and with it the wait. That is the exact shape that produced the false
     * green in {@code WebViewStorageTest}; here it would produce an immediate red
     * instead, but the wait would be gone either way. If the polled expression
     * ever stops being able to throw, this test needs an explicit gate on
     * {@code window.Capacitor} — not on {@link #BOOTED}.
     */
    @Test
    public void the_injected_bridge_reaches_the_sqlite_plugin_without_any_bundled_js() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals(
                    "the injected bridge does not expose nativePromise — the shipped modules"
                            + " could not call a plugin without a bundler",
                    "function",
                    pollFor(scenario, "typeof window.Capacitor.nativePromise"));

            evaluate(
                    scenario,
                    "window.__bridgeProbe = null;"
                        + "window.Capacitor.nativePromise('CapacitorSQLite', 'echo',"
                        + " { value: 'theygrow' })"
                        + ".then(function (r) { window.__bridgeProbe = 'ok:' + (r && r.value); })"
                        + ".catch(function (e) { window.__bridgeProbe = 'err:' + e; });"
                        + "'dispatched'");

            String probe = pollFor(scenario, "window.__bridgeProbe");
            assertEquals("the plugin did not answer through the injected bridge", "ok:theygrow", probe);
        }
    }

    @Test
    public void the_app_opens_its_encrypted_store_at_boot() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            // THE PROBE IS SYNCHRONISED TO THE APP, AND ONLY THEN ANCHORED
            // (EMV-DL-006).
            //
            // This test had never waited for anything. It probed on the line
            // after the activity launched, and the shell's <head> is long: the
            // store's delivery hints are the last block in it, behind an inline
            // script. document.querySelector mid-parse legitimately answers null,
            // and the EMV-DL-005 logcat dates the old probe at 16 ms after the
            // shell's first module request — inside the parse. Whether any given
            // element was in the DOM at that instant was a coin flip.
            //
            // EMV-P5 read that as a missing hint and re-anchored on the hint,
            // citing A1-P6-INV-001. The invariant is true and holds: boot.js is
            // imported statically by app.js, so the hint is present in the
            // shipped shell and the ship-list guard reds without it. What the
            // invariant asserts is a set equality over app/index.html — a
            // property of the FILE. It never promised that a given element is
            // reachable from a probe fired mid-parse, and that inference is what
            // failed (run 31764386329), not the invariant.
            //
            // So: gate first, anchor second.
            //
            // (1) Wait for the app to have BOOTED, not merely parsed. The gate
            //     returns the src the live document executes, which is checked
            //     against the mount read out of the APK — proof that the WebView
            //     is running that shell at that generation, and not offline.html,
            //     a cached response, or the frozen mount a copy-forward bump
            //     leaves shipped.
            String entrySrc = pollFor(scenario, SHELL_ENTRY, BOOT_DIAGNOSTIC);
            assertEquals(
                    "the running document does not execute the mount the APK's own shell names"
                            + " — a probe resolved against it would address a generation nobody"
                            + " runs, which is the EMV-DL-005 defect one layer up",
                    MountAddress.prefix() + "app.js",
                    entrySrc);

            // (2) The specifier is composed from the APK, not from the document
            //     and not written down. MountAddress derives the mount VERSION
            //     from the shipped shell; "store/boot.js" under it is stable by
            //     construction rather than by convention — app.js names it as a
            //     static relative specifier, and A1-P4-INV-001 walks that graph
            //     every push and asserts the resolved path is both shipped and
            //     precached. A bump copies the tree forward; only the version
            //     segment moves. StoreEngineTest composes its DDL path the same
            //     way and executed it on this device.
            //
            //     Resolution is still against document.baseURI, because a script
            //     handed to evaluateJavascript has no base URL of its own —
            //     Chromium reports about:blank, and a path-absolute specifier
            //     cannot be resolved from there. That is a property of this
            //     probe, not of the shipped web root. Past the gate the base is
            //     the shell's, so this yields the very URL app.js resolved to and
            //     therefore the module record the app booted with.
            String dispatched =
                    evaluate(
                            scenario,
                            "(function () {"
                                + "window.__storeModule = null; window.__storeImportError = null;"
                                + "window.__storeProbeUrl = null;"
                                + "var url = new URL('" + MountAddress.prefix() + "store/boot.js',"
                                + " document.baseURI).href;"
                                + "window.__storeProbeUrl = url;"
                                + "import(url)"
                                + ".then(function (m) { window.__storeModule = m; })"
                                + ".catch(function (e) { window.__storeImportError = 'err:' + e; });"
                                + "return 'dispatched';"
                                + "})()");

            // (3) The dispatch is CHECKED. evaluate() cannot tell a JS null from
            //     a thrown exception — evaluateJavascript reports both as null —
            //     so a probe that threw before reaching its import used to look
            //     exactly like a store that never opened, and the poll below
            //     would spend the full clock proving nothing. That silence is
            //     half of why the previous two reds were harder to read than they
            //     needed to be; it costs one assertion to remove.
            assertEquals(
                    "the probe script did not run to completion — evaluateJavascript reports a"
                            + " thrown expression as null, so this is a probe that never"
                            + " dispatched, not a store that never opened",
                    "dispatched",
                    dispatched);

            // (4) Poll for the handle. Past the gate app.js has already resolved
            //     Promise.all([kbReady, initNativeStore()]) — the store's boot
            //     call has returned — so this is no longer a race against the
            //     open; it is one microtask turn for the dynamic import of an
            //     already-loaded module record. It stays a poll rather than a
            //     single read because that turn is still asynchronous, and an
            //     import failure is reported immediately instead of waiting out
            //     the clock.
            //
            //     A timeout here now means the store genuinely did not open, and
            //     the diagnostic says which of the ways it can mean that.
            String probe =
                    pollFor(
                            scenario,
                            "window.__storeImportError ? window.__storeImportError"
                                + " : (window.__storeModule && window.__storeModule.storeHandle()"
                                + " ? JSON.stringify(window.__storeModule.storeHandle()) : null)",
                            storeProbeDiagnostic());

            assertTrue("the store never opened at boot: " + probe, probe.contains("\"journalMode\""));
            assertTrue("the store did not come up in WAL: " + probe, probe.toLowerCase().contains("wal"));
            assertTrue("the schema version was not recorded: " + probe, probe.contains("\"schemaVersion\":1"));
            assertTrue(
                    "no self participant was bootstrapped: " + probe,
                    probe.contains("selfParticipantId"));
        }
    }

    // --- WebView plumbing -------------------------------------------------

    /** Polls a JS expression until it evaluates to something other than null. */
    private String pollFor(ActivityScenario<MainActivity> scenario, String expression) {
        return pollFor(scenario, expression, null);
    }

    /**
     * Polls a JS expression until it evaluates to something other than null,
     * reporting {@code diagnostic} — evaluated once, at the deadline — if it
     * never does.
     *
     * <p>The diagnostic runs ONLY on the failing path, deliberately: evaluating
     * it every 250 ms would put its own state-reading into the window it is
     * meant to describe, and a poll that reds is already the moment where an
     * extra WebView round trip costs nothing.
     */
    private String pollFor(
            ActivityScenario<MainActivity> scenario, String expression, String diagnostic) {
        long deadline = System.currentTimeMillis() + TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (value != null && !"null".equals(value)) {
                return value;
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                fail("interrupted while waiting for " + expression);
            }
        }
        if (diagnostic == null) {
            fail("timed out waiting for " + expression);
        } else {
            fail(
                    "timed out waiting for "
                            + expression
                            + "\n  state at the deadline: "
                            + evaluate(scenario, diagnostic));
        }
        return null;
    }

    /** Runs a JS expression on the bridge WebView and returns its value, unquoted. */
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
