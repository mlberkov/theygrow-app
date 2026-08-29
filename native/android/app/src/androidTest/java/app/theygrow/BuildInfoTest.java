package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.pm.PackageManager;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * What the update check is told about the build it is running in (NAV-P2).
 *
 * <p>WHAT THIS TEST IS FOR, AND WHAT IT IS NOT. The whole of the update check's
 * network behaviour — that nothing leaves on boot or on opening the menu, that
 * one request leaves on the press, and what that request is made of — is
 * asserted by {@code app/tests/update-check.spec.js}, in a real browser with the
 * network log as the instrument. That is deliberate and is stated in both files:
 * the claim is about a request, and a request is what a browser makes.
 *
 * <p>What no browser can carry is whether {@link BuildInfoPlugin} tells the
 * truth on a device, and that is the only thing asserted here. The comparison
 * the whole feature rests on is {@code installed versionCode} against {@code
 * published versionCode}; a plugin that returned a plausible wrong number would
 * leave every desktop leg green while a parent was told there is nothing to
 * install. So: the plugin is registered and reachable from the WebView, and the
 * number it reports through the bridge is the number {@link PackageManager}
 * reports for the installed package.
 *
 * <p>THE INSTALLER LEG IS AN OBSERVATION, NOT A PLAY TEST. There is no Play copy
 * of this app — closed testing has not started (vault ADR-050) — so nothing here
 * can exercise the Play branch, and this file does not pretend to. What it can
 * establish is the branch this channel actually takes: a build installed by
 * {@code adb} is not installed by Play, so {@code shouldOfferUpdate} must offer
 * the row. The Play branch itself is executed off-device, as a truth table, in
 * {@code app/tests/channel-composition.spec.js}.
 */
@RunWith(AndroidJUnit4.class)
public class BuildInfoTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    /** The one token that means Google Play, mirroring CHANNEL_CONFIG.playInstallerPackage. */
    private static final String PLAY_INSTALLER = "com.android.vending";

    @Test
    public void the_build_info_plugin_reports_the_version_this_package_actually_carries()
            throws PackageManager.NameNotFoundException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String pkg = context.getPackageName();
        int expected = context.getPackageManager().getPackageInfo(pkg, 0).versionCode;

        // ANTI-VACUITY, BEFORE THE COMPARISON. A versionCode of 0 would make the
        // assertion below true against a plugin that returned nothing, and it
        // would also be a real defect: build.gradle falls back to 1, never 0.
        assertTrue("the installed package reports no versionCode", expected > 0);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals(
                    "the injected bridge is missing",
                    "function",
                    pollFor(scenario, "typeof window.Capacitor.nativePromise"));

            evaluate(
                    scenario,
                    "window.__buildProbe = null;"
                        + "window.Capacitor.nativePromise('TheyGrowBuild', 'info', {})"
                        + ".then(function (info) {"
                        + "  window.__buildProbe = 'ok:' + info.versionCode"
                        + "    + '|' + info.versionName"
                        + "    + '|' + (info.installer === null ? 'none' : info.installer);"
                        + "})"
                        + ".catch(function (e) { window.__buildProbe = 'err:' + (e && e.message); });"
                        + "'dispatched'");

            String probe = pollFor(scenario, "window.__buildProbe");
            assertTrue(
                    "the build-info plugin did not answer as a registered plugin: " + probe,
                    probe != null && probe.startsWith("ok:"));

            String[] parts = probe.substring("ok:".length()).split("\\|", -1);
            assertEquals("the plugin answered in an unexpected shape: " + probe, 3, parts.length);

            assertEquals(
                    "the plugin reports a different versionCode than the installed package",
                    String.valueOf(expected),
                    parts[0]);
            assertEquals(
                    "the plugin reports a different versionName than the installed package",
                    context.getPackageManager().getPackageInfo(pkg, 0).versionName,
                    parts[1]);

            // The observation, not a Play test: this build was installed by adb,
            // so the row is offered on this channel. `none` is the JS-side
            // spelling of a null installer, which is the sideload case.
            assertNotEquals(
                    "an adb-installed build reports Play as its installer",
                    PLAY_INSTALLER,
                    parts[2]);
        }
    }

    // --- WebView plumbing, same shape as ExportSinkTest --------------------

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
