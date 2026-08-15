package app.theygrow;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The export sink on a real device (L1-P3).
 *
 * <p>WHAT THIS DELIBERATELY DOES NOT TEST: the system file picker. Driving
 * another app's UI from an instrumented test is the kind of assertion that goes
 * green on one Android build and flaky on the next, and it would prove that the
 * picker works rather than that the archive is written correctly. The picker is
 * covered by the owner-run smoke in {@code docs/RUNBOOK.md}.
 *
 * <p>WHAT IT DOES TEST is the half that can silently corrupt a family's only
 * off-device copy: the stream from the staged buffer to the chosen document,
 * and truncation. Plus one registration probe — a first-party plugin that failed
 * to register would leave the export button doing nothing on a real phone while
 * every desktop test stayed green.
 *
 * <p>Since XPT-P1 the base64 decode no longer happens on this path: chunks are
 * decoded as they arrive in {@code appendChunk}, and what reaches the document
 * is the staged buffer. That whole path — chunks in, archive out — is executed
 * end to end by {@link ExportTransferTest}; what stays here is the last hop,
 * driven directly so it can be asserted without the system file picker.
 */
@RunWith(AndroidJUnit4.class)
public class ExportSinkTest {

    private static final long TIMEOUT_MS = 30_000;
    private static final long POLL_MS = 250;

    @Test
    public void the_sink_writes_exactly_the_bytes_it_was_handed() throws IOException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File target = new File(context.getCacheDir(), "sink-probe.zip");

        // Deliberately not text: an archive is binary, and a byte path that
        // works on ASCII can still mangle a high byte or a zero.
        byte[] payload = new byte[256];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) i;
        }

        ExportSinkPlugin.writeDocument(context, Uri.fromFile(target), staged(payload));

        assertArrayEquals("the sink did not write the bytes it was given", payload, read(target));
    }

    @Test
    public void a_shorter_archive_does_not_leave_the_tail_of_a_longer_one() throws IOException {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File target = new File(context.getCacheDir(), "sink-truncate.zip");

        byte[] longer = new byte[1024];
        Arrays.fill(longer, (byte) 0x41);
        byte[] shorter = "короткий архив".getBytes(StandardCharsets.UTF_8);

        Uri uri = Uri.fromFile(target);
        ExportSinkPlugin.writeDocument(context, uri, staged(longer));
        ExportSinkPlugin.writeDocument(context, uri, staged(shorter));

        // Without truncation the file would still be 1024 bytes and the zip's
        // central directory would disagree with the bytes after it — a corrupt
        // archive that opens far enough to look fine.
        assertArrayEquals("the second write did not truncate the first", shorter, read(target));
    }

    @Test
    public void the_sink_plugin_is_registered_and_reachable_from_the_webview() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals(
                    "the injected bridge is missing",
                    "function",
                    pollFor(scenario, "typeof window.Capacitor.nativePromise"));

            // Called with no arguments on purpose. A REGISTERED plugin rejects
            // with its own validation message; an unregistered one rejects with
            // the bridge's "not implemented". The two are told apart below, so
            // this probe cannot pass by the plugin being absent.
            evaluate(
                    scenario,
                    "window.__sinkProbe = null;"
                        + "window.Capacitor.nativePromise('TheyGrowExport', 'createDocument', {})"
                        + ".then(function () { window.__sinkProbe = 'resolved'; })"
                        + ".catch(function (e) { window.__sinkProbe = 'err:' + (e && e.message); });"
                        + "'dispatched'");

            String probe = pollFor(scenario, "window.__sinkProbe");
            assertTrue(
                    "the export sink plugin did not answer as a registered plugin: " + probe,
                    probe != null && probe.contains("needs a filename"));
        }
    }

    /**
     * The staged buffer the plugin holds when the picker returns, built here
     * from bytes instead of from chunks. {@link ExportTransferTest} is what
     * fills one the way the app does.
     */
    private static ByteArrayOutputStream staged(byte[] payload) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(payload.length);
        out.write(payload);
        return out;
    }

    private static byte[] read(File file) throws IOException {
        byte[] out = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = in.read(out);
            if (read != out.length) {
                throw new IOException("short read from " + file);
            }
        }
        return out;
    }

    // --- WebView plumbing, same shape as BridgeSmokeTest -------------------

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
