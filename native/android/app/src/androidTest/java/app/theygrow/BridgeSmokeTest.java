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
            evaluate(
                    scenario,
                    "window.__storeProbe = null;"
                        + "import('/m/v1/store/boot.js').then(function (m) {"
                        + " window.__storeProbe = JSON.stringify(m.storeHandle() || {});"
                        + "}).catch(function (e) { window.__storeProbe = 'err:' + e; });"
                        + "'dispatched'");

            String probe = pollFor(scenario, "window.__storeProbe");
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
        fail("timed out waiting for " + expression);
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
