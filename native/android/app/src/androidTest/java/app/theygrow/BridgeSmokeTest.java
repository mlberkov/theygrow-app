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
     * What the store probe was actually looking at, evaluated ONLY when the poll
     * times out. Every field here answers a question the bare timeout could not:
     * which URL the probe imported, which URL the shell hints (the two differing
     * IS the wrong-generation bug), whether the module ever loaded, and whether
     * its handle is null because the store failed or because nothing on that
     * copy was ever initialised.
     */
    private static final String STORE_PROBE_DIAGNOSTIC =
            "JSON.stringify({"
                + "probeUrl: window.__storeProbeUrl,"
                + "shellHint: (document.querySelector("
                + "'link[rel=\"modulepreload\"][href$=\"/store/boot.js\"]') || {}).href || null,"
                + "baseURI: document.baseURI,"
                + "moduleLoaded: !!window.__storeModule,"
                + "storeHandleType: window.__storeModule"
                + " ? typeof window.__storeModule.storeHandle : 'no-module',"
                + "storeHandle: (window.__storeModule"
                + " && typeof window.__storeModule.storeHandle === 'function')"
                + " ? window.__storeModule.storeHandle() : null,"
                + "importError: window.__storeImportError"
                + "})";

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
            // THE SPECIFIER IS WHAT DECIDES THIS, NOT THE BASE URL (EMV-DL-005).
            //
            // A script handed to evaluateJavascript has no base URL of its own —
            // Chromium reports it as about:blank — so a path-absolute specifier
            // cannot be resolved from here, while the identical specifier
            // resolves normally inside app.js, which is a page module. Resolving
            // against document.baseURI fixes that much, and this probe still
            // does it. What it does NOT do, and what the earlier version of this
            // comment wrongly claimed it did, is guarantee the module instance
            // the app booted with: an absolute URL naming the FROZEN mount
            // resolves perfectly well against the same base, because a bump is
            // copy-forward and leaves the previous generation shipped. It then
            // returns a second, never-initialised copy of boot.js whose
            // module-scoped handle is null forever — which is exactly what this
            // test did after EMV-P1 moved the shell forward while this line
            // still named the previous generation, and exactly why it polled out
            // in silence (run 31750267059) while the app under test had opened
            // its store in 884 ms.
            //
            // So the URL is taken from the document instead of written here. The
            // modulepreload hint is the anchor because A1-P6-INV-001 asserts the
            // hint set equals the shell's import graph EXACTLY, in both
            // directions — so the hint cannot go stale while boot.js is in the
            // graph, and it is already the very URL app.js resolved to. A
            // missing hint is reported as an error rather than thrown into a
            // dropped promise.
            evaluate(
                    scenario,
                    "(function () {"
                        + "window.__storeModule = null; window.__storeImportError = null;"
                        + "window.__storeProbeUrl = null;"
                        + "var hint = document.querySelector("
                        + "'link[rel=\"modulepreload\"][href$=\"/store/boot.js\"]');"
                        + "if (!hint) {"
                        + "window.__storeImportError = 'err: the shell hints no store/boot.js"
                        + " modulepreload — the mount cannot be derived from the document';"
                        + "return 'dispatched';"
                        + "}"
                        + "window.__storeProbeUrl = hint.href;"
                        + "import(hint.href)"
                        + ".then(function (m) { window.__storeModule = m; })"
                        + ".catch(function (e) { window.__storeImportError = 'err:' + e; });"
                        + "return 'dispatched';"
                        + "})()");

            // The app opens the store from DOMContentLoaded and does not await
            // it, so the handle appears some time after the module does. Poll
            // for the handle itself; reading it once races the open and would
            // report an empty handle as a store that never opened. An import
            // failure is reported immediately instead of waiting out the clock.
            //
            // A timeout now reports WHY rather than restating the expression it
            // waited on: a module that loaded from a URL the shell does not hint
            // is a wrong-generation import, and that is the one state the old
            // failure text could not tell apart from a store that never opened.
            String probe =
                    pollFor(
                            scenario,
                            "window.__storeImportError ? window.__storeImportError"
                                + " : (window.__storeModule && window.__storeModule.storeHandle()"
                                + " ? JSON.stringify(window.__storeModule.storeHandle()) : null)",
                            STORE_PROBE_DIAGNOSTIC);

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
