package app.theygrow;

import static androidx.test.espresso.intent.Intents.assertNoUnverifiedIntents;
import static androidx.test.espresso.intent.Intents.intending;
import static androidx.test.espresso.intent.matcher.IntentMatchers.hasAction;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcel;
import android.util.Log;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.espresso.intent.Intents;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The export transfer on a real device, past the binder limit (XPT-P1).
 *
 * <p>WHAT FAILED, AND WHY NOTHING CAUGHT IT. Until this packet the whole archive
 * travelled as one option of the plugin call that opens the system file picker.
 * Capacitor persists that call's options into the activity's saved instance
 * state — twice — when the picker comes to the front, and on the family device
 * on 2026-08-15 a 1.73 MB archive produced a 4 630 924-byte parcel that crossed
 * the ~1 MB binder limit and killed the process before a byte was written. Every
 * existing test used a fixture of a few hundred bytes, so every existing test
 * stayed green. The size of the fixture WAS the defect's hiding place, which is
 * why this one is deliberately larger than the archive that crashed the phone.
 *
 * <p>WHAT THIS TEST EXECUTES. The whole shipped path, in the app: the store's own
 * write path seeds a journal big enough to matter, the export control is
 * PRESSED, and {@code surfaces/export.js} → {@code export/run.js} →
 * {@code export/sink.js} → the injected bridge → this app's plugin do the rest.
 * The only thing standing in for reality is the system file picker, which is
 * stubbed: driving another app's UI is the assertion this repository has
 * declined to make since L1-P3, and the owner-run smoke in {@code
 * docs/RUNBOOK.md} is where the real picker is exercised.
 *
 * <p>THE PARCEL ASSERTION CARRIES A CONTROL, and it is not decoration. "The
 * saved state is small" would stay green if the measuring instrument were
 * broken — if {@code saveInstanceState} wrote nothing, if the bundle were empty
 * for an unrelated reason, if the measurement returned zero. So the same
 * measuring function is also run against a synthetic bundle in the OLD shape,
 * carrying a payload the size of the one that crashed the device, and that
 * measurement must EXCEED the bound the real one must stay under. Both numbers
 * are logged, so a reader can see the instrument discriminating rather than take
 * it on trust.
 */
@RunWith(AndroidJUnit4.class)
public class ExportTransferTest {

    private static final String TAG = "XPT";

    private static final long POLL_MS = 500;
    /** One WebView round trip. Generous, but not the budget for the export. */
    private static final long EVALUATE_TIMEOUT_MS = 30_000;
    /** Seeding, building the artifact, chunking it across and writing it. */
    private static final long EXPORT_TIMEOUT_MS = 420_000;

    /**
     * The transaction size Android refuses past. Not a constant this repository
     * owns — it is quoted here because every bound below is stated relative to
     * it, and because the field crash is the measurement that made it matter.
     */
    private static final int BINDER_LIMIT_BYTES = 1024 * 1024;

    /**
     * What the picker-launching call's persisted state must stay under. Three
     * orders of magnitude under the limit rather than merely below it: the
     * property being asserted is that the archive is NOT in there, not that it
     * happens to fit.
     */
    private static final int LAUNCH_STATE_MAX_BYTES = 8 * 1024;

    /**
     * The archive this test refuses to be satisfied by anything smaller than.
     *
     * <p>Five times the binder limit, and about three times the archive that
     * actually crashed the family device. If the fixture below ever stops
     * reaching it the test FAILS rather than quietly proving less than it
     * claims — raise {@link #SEEDED_ENTRIES} or {@link #NOTE_CHARS}, do not
     * lower this.
     */
    private static final int MIN_ARCHIVE_BYTES = 5 * 1024 * 1024;

    /** The size of the payload the OLD shape put on the launching call. */
    private static final int FIELD_CRASH_PAYLOAD_BYTES = 2_313_920;

    // The fixture: journal-derived content, in the language a real journal is
    // written in. Cyrillic is not decoration either — it is two bytes per
    // character in the archive's text and JSON, and four hex digits per glyph in
    // the PDF, which is how a modest number of entries reaches a realistic size.
    private static final int SEEDED_ENTRIES = 200;
    private static final int NOTE_CHARS = 6144;
    private static final int SEED_BATCH = 20;

    /** A DOM fact the app's OWN modules produce — same sentinel as BridgeSmokeTest. */
    private static final String BOOTED =
            "document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0";

    @Test
    public void the_export_writes_a_complete_archive_past_the_binder_limit() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File target = new File(context.getCacheDir(), "transfer-probe.zip");
        if (target.exists() && !target.delete()) {
            fail("could not clear the probe archive from a previous run");
        }

        AtomicInteger launchStateBytes = new AtomicInteger(-1);
        AtomicReference<String> launchOptions = new AtomicReference<>(null);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity = new AtomicReference<>(null);
            scenario.onActivity(activity::set);

            // Init AFTER the launch so the activity's own start is not recorded:
            // the only intent this test has an opinion about is the picker.
            Intents.init();
            try {
                intending(hasAction(Intent.ACTION_CREATE_DOCUMENT))
                        .respondWithFunction(
                                intent -> {
                                    // MEASURED AT THE MOMENT OF LAUNCH. This is the
                                    // one instant the property is about: the call is
                                    // registered as the last activity call and the
                                    // result has not been delivered, which is exactly
                                    // the window in which the framework would call
                                    // onSaveInstanceState with the picker in front.
                                    Bundle state = new Bundle();
                                    activity.get().getBridge().saveInstanceState(state);
                                    launchStateBytes.set(parcelBytes(state));
                                    launchOptions.set(
                                            state.getString("capacitorLastPluginCallOptions"));
                                    return new Instrumentation.ActivityResult(
                                            Activity.RESULT_OK,
                                            new Intent().setData(Uri.fromFile(target)));
                                });

                pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
                seedJournal(scenario);
                String status = pressExport(scenario);
                assertEquals(
                        "the export did not report success — the surface said: " + status,
                        "saved",
                        status);
            } finally {
                Intents.release();
            }
        }

        // --- the archive itself ------------------------------------------

        long size = target.length();
        Log.i(TAG, "archive bytes=" + size);
        assertTrue(
                "the archive is "
                        + size
                        + " bytes; this test proves nothing below "
                        + MIN_ARCHIVE_BYTES
                        + " — raise SEEDED_ENTRIES/NOTE_CHARS rather than this bound",
                size >= MIN_ARCHIVE_BYTES);
        assertTrue(
                "the archive (" + size + " bytes) no longer clears the binder limit by 4x",
                size >= 4L * BINDER_LIMIT_BYTES);

        byte[] head = readAt(target, 0, 4);
        assertEquals("the archive does not start with a local file header", 0x50, head[0] & 0xff);
        assertEquals("the archive does not start with a local file header", 0x4b, head[1] & 0xff);
        assertEquals("the archive does not start with a local file header", 0x03, head[2] & 0xff);
        assertEquals("the archive does not start with a local file header", 0x04, head[3] & 0xff);

        assertTrue(
                "the archive carries no end-of-central-directory record — it is truncated",
                hasEndOfCentralDirectory(target));

        // Not "it opens": every entry is read to EOF, so the CRC in the central
        // directory is checked against the bytes actually there. A zip whose
        // index says one thing and whose bytes say another opens fine and is
        // exactly the corruption a chunked transfer could produce.
        Set<String> entries = new LinkedHashSet<>();
        try (ZipFile zip = new ZipFile(target)) {
            Enumeration<? extends ZipEntry> it = zip.entries();
            while (it.hasMoreElements()) {
                ZipEntry entry = it.nextElement();
                entries.add(entry.getName());
                try (InputStream in = zip.getInputStream(entry)) {
                    byte[] buffer = new byte[64 * 1024];
                    while (in.read(buffer) != -1) {
                        // read to EOF: java.util.zip verifies the CRC there
                    }
                }
            }
        }
        Log.i(TAG, "archive entries=" + entries);
        assertTrue("the archive holds no README.txt: " + entries, entries.contains("README.txt"));
        assertTrue("the archive holds no index.json: " + entries, entries.contains("index.json"));
        assertTrue(
                "the archive holds no MANIFEST.json: " + entries, entries.contains("MANIFEST.json"));
        assertTrue(
                "the archive holds no PDF print layer: " + entries,
                entries.contains("print/archive.pdf"));

        // --- the state that used to kill the process ----------------------

        int measured = launchStateBytes.get();
        int control = oldShapeStateBytes();
        Log.i(
                TAG,
                "saved-state bytes: staged-transfer="
                        + measured
                        + " old-shape-control="
                        + control
                        + " bound="
                        + LAUNCH_STATE_MAX_BYTES
                        + " binder-limit="
                        + BINDER_LIMIT_BYTES);

        assertTrue(
                "the picker was never launched through the stub, so nothing was measured",
                measured >= 0);

        // THE CONTROL, FIRST. If this does not exceed the bound, the instrument
        // cannot tell a payload from a reference and the assertion after it is
        // worthless whatever it says.
        assertTrue(
                "the control measurement is "
                        + control
                        + " bytes: the OLD call shape did not exceed the bound this test requires"
                        + " the new one to stay under, so the measurement discriminates nothing",
                control > LAUNCH_STATE_MAX_BYTES);
        assertTrue(
                "the control measurement is "
                        + control
                        + " bytes, which does not even reach the binder limit — it no longer"
                        + " reproduces the shape that crashed the device",
                control > BINDER_LIMIT_BYTES);

        assertTrue(
                "the saved state of the picker-launching call is "
                        + measured
                        + " bytes for a "
                        + size
                        + "-byte archive (control for the old shape: "
                        + control
                        + ") — the payload is riding that call again",
                measured <= LAUNCH_STATE_MAX_BYTES);

        String options = launchOptions.get();
        assertTrue("nothing was persisted for the launching call", options != null);
        for (String key : new String[] {"base64", "bytes", "payload", "archive"}) {
            assertTrue(
                    "the persisted options carry a \"" + key + "\" key: " + options.length()
                            + " bytes of options",
                    !options.contains("\"" + key + "\""));
        }
        assertTrue(
                "the persisted options do not name the staged transfer: " + options,
                options.contains("transferId"));
    }

    /**
     * The guard, executed against an input this test makes itself.
     *
     * <p>A guard nobody fires is a comment. This builds a payload larger than the
     * binder limit, puts it on the picker-launching call exactly as the old code
     * did, and requires the plugin to refuse it before any activity is started.
     */
    @Test
    public void the_launching_call_refuses_a_payload() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertEquals(
                    "the injected bridge is missing",
                    "function",
                    pollFor(scenario, "typeof window.Capacitor.nativePromise", EVALUATE_TIMEOUT_MS));

            Intents.init();
            try {
                String dispatched =
                        evaluate(
                                scenario,
                                "(function () {"
                                    + "window.__guardProbe = null;"
                                    + "var payload = new Array(1600001).join('A');"
                                    + "window.Capacitor.nativePromise('TheyGrowExport',"
                                    + " 'createDocument', { transferId: 'no-such-transfer',"
                                    + " filename: 'theygrow-archive-probe.zip',"
                                    + " mimeType: 'application/zip', totalBytes: 1,"
                                    + " base64: payload })"
                                    + ".then(function () { window.__guardProbe = 'resolved'; })"
                                    + ".catch(function (e) {"
                                    + " window.__guardProbe = 'err:' + (e && e.message); });"
                                    + "return 'dispatched';"
                                    + "})()");
                assertEquals("the guard probe never ran", "dispatched", dispatched);

                String probe = pollFor(scenario, "window.__guardProbe", EVALUATE_TIMEOUT_MS);
                Log.i(TAG, "guard probe: " + probe);
                assertTrue(
                        "the plugin accepted a payload on the call that opens the picker: " + probe,
                        probe.startsWith("err:") && probe.contains("refuses the option \"base64\""));

                // The refusal has to happen BEFORE the intent: a document created
                // for a transfer that then fails is the 0-byte file this packet
                // exists to end.
                assertNoUnverifiedIntents();
            } finally {
                Intents.release();
            }
        }
    }

    // --- the fixture ------------------------------------------------------

    /**
     * Seeds a journal through the SHIPPED write path.
     *
     * <p>{@code appendEntries()} out of the mount the APK actually carries — not
     * SQL written here. A fixture built by a second implementation would prove
     * the fixture; this one is the same code the app writes with, and the rows
     * it produces are the rows the export reads.
     */
    private void seedJournal(ActivityScenario<MainActivity> scenario) {
        String script =
                ("(function () {"
                                + "window.__seedDone = null; window.__seedError = null;"
                                + "var base = '__BASE__';"
                                + "var url = function (name) {"
                                + " return new URL(base + name, document.baseURI).href; };"
                                + "Promise.all([import(url('store/boot.js')),"
                                + " import(url('store/journal.js'))]).then(function (mods) {"
                                + "var boot = mods[0], journal = mods[1];"
                                + "var handle = boot.storeHandle();"
                                + "if (!handle) { throw new Error('the store is not open'); }"
                                + "var childId = 'xpt-fixture-child';"
                                + "var assertionId = 'xpt-fixture-assertion';"
                                + "var now = Date.now();"
                                + "var spine = { authorParticipantId: handle.selfParticipantId,"
                                + " subjectChildId: childId, visibilityClass: 'child_shared',"
                                + " origin: 'authored', eventDateLocal: '2026-01-01',"
                                + " eventAtUtc: null, eventUtcOffsetMin: null,"
                                + " entryAtUtc: now, entryUtcOffsetMin: 0 };"
                                + "var sentence = 'Сегодня она сама налила воду в стакан и"
                                + " ничего не пролила, а потом долго рассказывала про это. ';"
                                + "var note = '';"
                                + "while (note.length < __NOTE_CHARS__) { note += sentence; }"
                                + "note = note.slice(0, __NOTE_CHARS__);"
                                + "return journal.appendEntries([{ id: assertionId,"
                                + " kind: 'assertion', entry: spine, detail: { kind: 'note',"
                                + " effectiveFromDate: '2026-01-01',"
                                + " prerequisitePropagation: 'none' } }], { prelude: [{"
                                + " statement: 'INSERT INTO child (id, created_at_utc)"
                                + " VALUES (?, ?)', values: [childId, now] }] })"
                                + ".then(function () {"
                                + "var chain = Promise.resolve();"
                                + "for (var at = 0; at < __ENTRIES__; at += __BATCH__) {"
                                + "(function (from) { chain = chain.then(function () {"
                                + "var batch = [];"
                                + "for (var k = from; k < Math.min(from + __BATCH__, __ENTRIES__);"
                                + " k++) { batch.push({ id: 'xpt-fixture-note-' + k,"
                                + " kind: 'confirmation', entry: spine, detail: {"
                                + " targetAssertionId: assertionId, status: 'confirmed',"
                                + " note: note } }); }"
                                + "return journal.appendEntries(batch); }); })(at); }"
                                + "return chain; });"
                                + "}).then(function () { window.__seedDone = 'seeded'; })"
                                + ".catch(function (e) {"
                                + " window.__seedError = 'err:' + (e && e.message ? e.message : e);"
                                + " });"
                                + "return 'dispatched';"
                                + "})()")
                        .replace("__BASE__", MountAddress.prefix())
                        .replace("__NOTE_CHARS__", String.valueOf(NOTE_CHARS))
                        .replace("__ENTRIES__", String.valueOf(SEEDED_ENTRIES))
                        .replace("__BATCH__", String.valueOf(SEED_BATCH));

        assertEquals("the seed script never ran", "dispatched", evaluate(scenario, script));
        String outcome =
                pollFor(
                        scenario,
                        "window.__seedError ? window.__seedError : window.__seedDone",
                        EXPORT_TIMEOUT_MS);
        assertEquals("the journal fixture was not written: " + outcome, "seeded", outcome);
    }

    /** Opens the modal and presses the button, exactly as a parent does. */
    private String pressExport(ActivityScenario<MainActivity> scenario) {
        String dispatched =
                evaluate(
                        scenario,
                        "(function () {"
                            + "document.getElementById('exportBtn').click();"
                            + "var button = document.getElementById('exportRunBtn');"
                            + "if (button.hidden || button.disabled) { return 'not-offered'; }"
                            + "button.click();"
                            + "return 'pressed';"
                            + "})()");
        assertEquals(
                "the export control was not offered on the native channel", "pressed", dispatched);

        // The surface's own status line is the completion signal: it is set to
        // "Собираю архив…" before the run and replaced when the run ends, either
        // way. Polling it rather than a flag of the test's own means the thing
        // waited on is the thing a parent would be looking at.
        //
        // THE VERDICT IS REDUCED TO AN ASCII TOKEN IN JAVASCRIPT, not compared in
        // Java. evaluateJavascript hands back a JSON string, and whether a
        // Cyrillic character crosses that boundary raw or as \\uXXXX is
        // Chromium's business, not a property this test should depend on: a
        // comparison against a Russian literal here would go red on a successful
        // export for a reason that has nothing to do with the export. The
        // unmatched case still returns the text, mangled or not, because a
        // failing run needs to say what it saw.
        return pollFor(
                scenario,
                "(function () {"
                    + "var s = document.getElementById('exportStatus').textContent;"
                    + "if (!s || s.indexOf('Собираю') !== -1) { return null; }"
                    + "return s.indexOf('сохранён') !== -1 ? 'saved' : 'other:' + s;"
                    + "})()",
                EXPORT_TIMEOUT_MS);
    }

    // --- measurement ------------------------------------------------------

    /** The size of a Bundle as the framework would parcel it. */
    private static int parcelBytes(Bundle bundle) {
        Parcel parcel = Parcel.obtain();
        try {
            parcel.writeBundle(bundle);
            return parcel.dataSize();
        } finally {
            parcel.recycle();
        }
    }

    /**
     * The control: the saved state the OLD call shape produced, measured by the
     * same function as the real one.
     *
     * <p>Reproduces what {@code Bridge.saveInstanceState} wrote on the family
     * device — the options JSON directly, and again inside the plugin's own
     * bundle — around a payload the size of the one in the captured crash.
     *
     * <p>The number it returns is NOT expected to equal the 4 630 924 bytes in
     * that crash report, and nothing here asserts that it does: a {@link Parcel}
     * writes Java strings as UTF-16, so this measures larger than the
     * framework's own accounting of the same content. What is asserted is the
     * pair of inequalities that make the instrument meaningful — the old shape
     * is past the binder limit, the new one is three orders of magnitude under
     * it — and both numbers are logged so the margin can be read rather than
     * assumed.
     */
    private static int oldShapeStateBytes() {
        StringBuilder payload = new StringBuilder(FIELD_CRASH_PAYLOAD_BYTES);
        for (int i = 0; i < FIELD_CRASH_PAYLOAD_BYTES; i++) {
            payload.append('A');
        }
        String options =
                "{\"filename\":\"theygrow-archive-2026-08-15.zip\","
                        + "\"mimeType\":\"application/zip\",\"base64\":\""
                        + payload
                        + "\"}";

        Bundle pluginBundle = new Bundle();
        pluginBundle.putString("_json", options);

        Bundle state = new Bundle();
        state.putString("capacitorLastPluginId", "TheyGrowExport");
        state.putString("capacitorLastPluginCallMethodName", "createDocument");
        state.putString("capacitorLastPluginCallOptions", options);
        state.putBundle("capacitorLastPluginCallBundle", pluginBundle);
        return parcelBytes(state);
    }

    // --- file reading -----------------------------------------------------

    private static byte[] readAt(File file, long offset, int length) throws IOException {
        byte[] out = new byte[length];
        try (FileInputStream in = new FileInputStream(file)) {
            if (in.skip(offset) != offset) {
                throw new IOException("short skip in " + file);
            }
            int read = in.read(out);
            if (read != length) {
                throw new IOException("short read from " + file);
            }
        }
        return out;
    }

    /**
     * Looks for {@code PK\x05\x06} in the last 64 KiB — the whole range the
     * record can live in, since the comment field it may sit behind is bounded
     * by 0xFFFF. Its absence is what a truncated archive looks like.
     */
    private static boolean hasEndOfCentralDirectory(File file) throws IOException {
        int window = (int) Math.min(file.length(), 66_000L);
        byte[] tail = readAt(file, file.length() - window, window);
        for (int i = 0; i + 3 < tail.length; i++) {
            if ((tail[i] & 0xff) == 0x50
                    && (tail[i + 1] & 0xff) == 0x4b
                    && (tail[i + 2] & 0xff) == 0x05
                    && (tail[i + 3] & 0xff) == 0x06) {
                return true;
            }
        }
        return false;
    }

    // --- WebView plumbing, same shape as BridgeSmokeTest -------------------

    private String pollFor(ActivityScenario<MainActivity> scenario, String expression, long budget) {
        long deadline = System.currentTimeMillis() + budget;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (value != null && !"null".equals(value) && !"false".equals(value)) {
                return value;
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                fail("interrupted while waiting for " + expression);
            }
        }
        fail("timed out after " + budget + " ms waiting for " + expression);
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
        return out.replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n");
    }
}
