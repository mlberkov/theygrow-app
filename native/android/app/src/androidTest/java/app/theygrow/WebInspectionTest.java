package app.theygrow;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.CapConfig;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * FIU-P1-INV-002 — the installed build does not answer {@code chrome://inspect}.
 *
 * <p>THE DOOR THIS CLOSES, AND WHY IT IS NOT THE ONE {@code DeviceLogTest}
 * CLOSED. {@code DIA-P5} shut the logcat gate with {@code
 * android.loggingBehavior: "none"}. That value does nothing to this knob:
 * {@code CapConfig.java:286} resolves {@code
 * android.webContentsDebuggingEnabled} from {@code FLAG_DEBUGGABLE} on its own,
 * and {@code Bridge.java:618} hands the result to {@code
 * WebView.setWebContentsDebuggingEnabled}. Same default, same build, same
 * phone, a different sink: an authorised adb connection reaches the DOM, the JS
 * heap and WebView storage — the store's rows included, in the clear, because
 * the WebView sits on the inside of the encryption boundary. Recorded as {@code
 * DIA-DL-010} debt 12 and closed by owner choice; {@code FIU-DL-001}.
 *
 * <p>WHAT THESE TWO LEGS DO AND DO NOT ESTABLISH, stated here rather than left
 * to be read off the assertions (AGENTS.md §11). {@code
 * android.webkit.WebView} declares a STATIC SETTER and no getter, so the flag's
 * effect is not readable by any test this repository can write, on a device or
 * anywhere else. Neither leg executes "chrome://inspect finds nothing". What is
 * checkable is the VALUE THAT REACHES THE SETTER, and that is what is checked:
 * {@link #the_running_bridge_was_handed_a_false} reads it off the live {@code
 * CapConfig} the bridge parsed while booting this app, one call before {@code
 * Bridge.loadWebView()} passes it on; {@link
 * #the_installed_build_declares_the_knob_that_closes_the_inspector} reads the
 * asset that value came from. The static half — the repository's own source key
 * — is {@code app/tests/native-shell.spec.js}, on every push.
 *
 * <p>AND THE FIRST LEG CARRIES ITS OWN ARM. A {@code CapConfig} that had been
 * default-constructed rather than parsed would report {@code false} here too,
 * for the wrong reason — {@code Builder} resolves an unset key to {@code
 * isDebug} only when it can see the application info, and a test that merely
 * asserted {@code false} could not tell the two apart. So the same object is
 * asked for {@code isLoggingEnabled()}, whose non-default value {@code false}
 * can ONLY have come from this repository's {@code loggingBehavior: "none"}:
 * Capacitor's own default for it is {@code debug}, which resolves to TRUE in
 * the debuggable build this suite runs on. One assertion proves the subject,
 * the other proves the object was read from our config at all.
 */
@RunWith(AndroidJUnit4.class)
public class WebInspectionTest {

    /**
     * The knob as the RUNNING bridge holds it.
     *
     * <p>This boots the app: the activity starts, {@code BridgeActivity.onCreate}
     * builds the bridge, and the bridge parses {@code
     * assets/capacitor.config.json} on its way. The value read here is the one
     * {@code Bridge.java:618} hands to the WebView in that same constructor.
     */
    @Test
    public void the_running_bridge_was_handed_a_false() {
        AtomicReference<CapConfig> parsed = new AtomicReference<>(null);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> parsed.set(activity.getBridge().getConfig()));
        }
        CapConfig config = parsed.get();
        assertNotNull("the activity never handed its bridge configuration to the test", config);

        // The arm, and it runs first for the reason the class comment gives: a
        // configuration that was never read from our asset would answer the
        // subject correctly and mean nothing.
        assertFalse(
                "the bridge's configuration reports logging ENABLED, so it is not the one this"
                        + " repository ships — Capacitor's loggingBehavior default is \"debug\","
                        + " which is true in a debuggable build, and native/capacitor.config.json"
                        + " sets \"none\". Read this as \"the object under test is wrong\" before"
                        + " reading anything below it.",
                config.isLoggingEnabled());

        assertFalse(
                "the running bridge was handed webContentsDebuggingEnabled=true, so this build"
                        + " answers chrome://inspect with the DOM, the JS heap and WebView storage"
                        + " over any authorised adb connection (FIU-P1-INV-002)",
                config.isWebContentsDebuggingEnabled());
    }

    /**
     * The knob, read out of the APK rather than out of the repository.
     *
     * <p>The same fail-open {@code DeviceLogTest}'s declaration leg exists for:
     * {@code app/tests/native-shell.spec.js} reads the SOURCE, {@code
     * assets/capacitor.config.json} is gitignored and minted by {@code cap
     * sync}, and an APK assembled in a tree whose sync was skipped carries the
     * old config, restores the default, and passes the source-reading guard.
     *
     * <p>{@code false} EXPLICITLY, never "absent and therefore off": absent is
     * precisely the state that produced the exposure, because the resolver's
     * default argument is {@code isDebug}.
     */
    @Test
    public void the_installed_build_declares_the_knob_that_closes_the_inspector() {
        String config = squeeze(readAsset("capacitor.config.json"));
        assertTrue(
                "the APK's own capacitor.config.json does not declare"
                        + " webContentsDebuggingEnabled at all — this build was assembled without"
                        + " `cap sync` picking up native/capacitor.config.json, and Capacitor"
                        + " defaults the key to the debuggable flag: " + config,
                config.contains("\"webContentsDebuggingEnabled\""));
        assertTrue(
                "the APK's own capacitor.config.json declares webContentsDebuggingEnabled, but not"
                        + " as false: " + config,
                config.contains("\"webContentsDebuggingEnabled\":false"));
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
}
