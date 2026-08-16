package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcel;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The browser-to-native history transfer, on a real device (DIA-P1, ADR-048).
 *
 * <p>WHAT THIS EXISTS TO ESTABLISH. Everything about the receiving side is
 * unobservable off the device: no host test compiles the plugin, none delivers
 * an Intent, none can say whether a refusal refuses. The parity suite drives
 * both of its channels over plain HTTP with no Capacitor injected, so both take
 * the web branch. This job is the only place any of it runs.
 *
 * <p>THE FIXTURE IS BUILT WITH THE SHIPPED CODE, not with a second
 * implementation. The envelope is produced by the mount's own {@code
 * transfer/format.js} inside the app's WebView, encoded and digested by the same
 * module, and handed back to Java — so the bytes this test delivers as a link
 * are the bytes the handoff page would have produced. A fixture built in Java
 * would prove the fixture.
 *
 * <p>WHAT IS AND IS NOT STOOD IN FOR. The Intent is delivered directly to {@link
 * MainActivity} rather than through Chrome. That stands in for the browser and
 * for nothing else: what the browser contributes is a URI, and the URI is real.
 * Whether Chrome resolves {@code intent://…;package=app.theygrow;end} to this
 * package is the owner-run smoke's, exactly as the system file picker has been
 * since L1-P3 — driving another app's UI is an assertion this repository has
 * declined to make, and saying so is better than a test that pretends.
 *
 * <p>THE PARCEL LEG CARRIES ITS OWN CONTROL, for the reason {@code
 * ExportTransferTest} states: "the saved state is small" would stay green if the
 * measuring instrument were broken. So the same measuring function is run
 * against a synthetic bundle in the shape a payload-on-the-call would take, and
 * that number must EXCEED the bound the real one must stay under. Both are
 * logged.
 */
@RunWith(AndroidJUnit4.class)
public class HistoryTransferTest {

    private static final String TAG = "DIA";

    private static final long POLL_MS = 400;
    private static final long EVALUATE_TIMEOUT_MS = 30_000;
    private static final long TRANSFER_TIMEOUT_MS = 120_000;

    /** The transaction size Android refuses past — quoted, not owned. */
    private static final int BINDER_LIMIT_BYTES = 1024 * 1024;

    /** What the persisted state of any transfer call must stay under. */
    private static final int LAUNCH_STATE_MAX_BYTES = 8 * 1024;

    /** The size of the payload the 2026-08-15 crash put on a launching call. */
    private static final int FIELD_CRASH_PAYLOAD_BYTES = 2_313_920;

    /** A DOM fact the app's OWN modules produce — same sentinel as BridgeSmokeTest. */
    private static final String BOOTED =
            "document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0";

    private static final String FIXTURE_CHILD = "dia-fixture-child";

    // ---------------------------------------------------------------------
    // 1. The whole chain: a link arrives, the importer writes the journal.
    // ---------------------------------------------------------------------

    @Test
    public void a_deep_link_delivers_the_history() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            Envelope envelope = buildEnvelopeInApp(scenario, 4);
            deliver(scenario, link(envelope));

            // The surface is driven the way a parent drives it: the modal has to
            // OFFER the profile, and the button has to be pressed.
            String offered =
                    pollFor(
                            scenario,
                            "(function () {"
                                + "var m = document.getElementById('importModal');"
                                + "if (!m || m.className.indexOf('show') === -1) { return null; }"
                                + "var boxes = document.querySelectorAll("
                                + "'#importChoices input[type=\\\"checkbox\\\"]');"
                                + "return boxes.length ? String(boxes.length) : null;"
                                + "})()",
                            TRANSFER_TIMEOUT_MS);
            assertEquals("the transfer offered a number of profiles other than one", "1", offered);

            assertEquals(
                    "the transfer button was not offered",
                    "pressed",
                    evaluate(
                            scenario,
                            "(function () {"
                                + "var b = document.getElementById('importRunBtn');"
                                + "if (!b || b.hidden || b.disabled) { return 'not-offered'; }"
                                + "b.click(); return 'pressed';"
                                + "})()"));

            String status =
                    pollFor(
                            scenario,
                            "(function () {"
                                + "var s = document.getElementById('importStatus').textContent;"
                                + "if (!s || s.indexOf('Переношу') !== -1) { return null; }"
                                + "return s.indexOf('Перенесено') !== -1 ? 'imported' : 'other:' + s;"
                                + "})()",
                            TRANSFER_TIMEOUT_MS);
            assertEquals("the import did not report success: " + status, "imported", status);

            // THE MARKS LANDED, asked of the journal rather than of the surface.
            // A status line is what the app says; existingEntryIds() is what the
            // store holds, read through the SHIPPED module out of the mount the
            // APK carries.
            String present = countImportedMarks(scenario, envelope.skillCount);
            assertEquals(
                    "the journal does not hold every imported mark: " + present,
                    String.valueOf(envelope.skillCount),
                    present);
        }
    }

    // ---------------------------------------------------------------------
    // 2. The guards, fired at inputs this test builds in-run.
    // ---------------------------------------------------------------------

    /**
     * The leg {@code TRANSFER_CONFIG.linkMaxBytes} names by this exact name.
     *
     * <p>A browser that shortens a long URI is the failure the ceiling comment
     * points here for, and it is the one case the ceiling itself cannot prevent:
     * the ceiling keeps a link SHORT, and a transport is still free to deliver
     * less than it was given. So the payload is truncated after the digest and
     * the byte count were computed over the whole of it — the transport lying
     * about itself — and the receiver must refuse before it stages anything.
     */
    @Test
    public void the_receiver_refuses_a_truncated_link() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            Envelope envelope = buildEnvelopeInApp(scenario, 3);

            // Cut the payload, keep the declared byte count and digest. Nothing
            // else about the link changes.
            String truncated = envelope.payload.substring(0, envelope.payload.length() - 24);
            Uri uri =
                    Uri.parse(
                            "theygrow://transfer/?payload="
                                    + truncated
                                    + "&bytes="
                                    + envelope.bytes
                                    + "&sha256="
                                    + envelope.digest
                                    + "&v=1");
            deliver(scenario, uri);

            String refusal = pollForRefusal(scenario);
            Log.i(TAG, "truncated link refusal=" + refusal);
            assertTrue(
                    "a truncated link was not refused as a size or checksum mismatch: " + refusal,
                    "size_mismatch".equals(refusal) || "checksum_mismatch".equals(refusal));

            // NOTHING WAS STAGED. The refusal is only worth anything if it left
            // the plugin holding nothing — a partial history in an append-only
            // journal cannot be corrected afterwards.
            assertEquals(
                    "a refused transfer is still staged",
                    "false",
                    evaluate(scenario, "String(window.__diaPending.present)"));

            // The parent is told, in one line, and offered the file path. No
            // fork is presented (ADR-048 §3).
            String fallback =
                    pollFor(
                            scenario,
                            "(function () {"
                                + "var f = document.getElementById('importFallback');"
                                + "if (!f || f.hidden || !f.textContent) { return null; }"
                                + "var p = document.getElementById('importPickBtn');"
                                + "return (p && !p.hidden) ? 'offered' : 'no-button';"
                                + "})()",
                            EVALUATE_TIMEOUT_MS);
            assertEquals("the file fallback was not offered after a refusal", "offered", fallback);
        }
    }

    @Test
    public void the_receiver_refuses_a_foreign_query_key() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            Envelope envelope = buildEnvelopeInApp(scenario, 2);

            Uri uri =
                    Uri.parse(
                            "theygrow://transfer/?payload="
                                    + envelope.payload
                                    + "&bytes="
                                    + envelope.bytes
                                    + "&sha256="
                                    + envelope.digest
                                    + "&v=1&note=" + Uri.encode("что-то ещё"));
            deliver(scenario, uri);

            assertEquals(
                    "an undeclared query key was accepted",
                    "foreign_key",
                    pollForRefusal(scenario));
            assertEquals(
                    "a refused transfer is still staged",
                    "false",
                    evaluate(scenario, "String(window.__diaPending.present)"));
        }
    }

    @Test
    public void the_receiver_refuses_a_payload_past_the_ceiling() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            // Built here, deliberately larger than the ceiling the page would
            // have refused to build a link for. A guard nobody fires is a
            // comment, so the input is made rather than waited for.
            StringBuilder oversized = new StringBuilder();
            while (oversized.length() <= HistoryTransferPlugin.LINK_MAX_BYTES) {
                oversized.append("QUFBQUFBQUFBQUFBQUFBQQ");
            }
            Uri uri =
                    Uri.parse(
                            "theygrow://transfer/?payload="
                                    + oversized
                                    + "&bytes=16&sha256=00&v=1");
            deliver(scenario, uri);

            assertEquals(
                    "a payload past the ceiling was accepted",
                    "options_ceiling",
                    pollForRefusal(scenario));
        }
    }

    @Test
    public void the_receiver_refuses_an_unknown_format_version() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            Envelope envelope = buildEnvelopeInApp(scenario, 2);

            Uri uri =
                    Uri.parse(
                            "theygrow://transfer/?payload="
                                    + envelope.payload
                                    + "&bytes="
                                    + envelope.bytes
                                    + "&sha256="
                                    + envelope.digest
                                    + "&v=9");
            deliver(scenario, uri);

            assertEquals(
                    "an envelope version this build cannot read was accepted",
                    "format_version",
                    pollForRefusal(scenario));
        }
    }

    // ---------------------------------------------------------------------
    // 3. The payload does not ride a bridge call, measured with a control.
    // ---------------------------------------------------------------------

    @Test
    public void no_bridge_call_carries_the_payload() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity> activity = new AtomicReference<>(null);
            scenario.onActivity(activity::set);
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            Envelope envelope = buildEnvelopeInApp(scenario, 40);
            deliver(scenario, link(envelope));

            // Drained through the SHIPPED seam, and the calls it made are read
            // back — so what is inspected is what the app actually sent.
            String drained =
                    pollFor(
                            scenario,
                            "(function () {"
                                + "if (window.__diaDrain === undefined) { return null; }"
                                + "return window.__diaDrain;"
                                + "})()",
                            TRANSFER_TIMEOUT_MS);
            assertEquals("the drain did not complete: " + drained, "ok", drained);

            String options = evaluate(scenario, "JSON.stringify(window.__diaCalls)");
            Log.i(TAG, "drain call options=" + options);
            for (String key : new String[] {"base64", "payload", "archive", "profiles"}) {
                assertTrue(
                        "a drain call carried a \"" + key + "\" option: " + options,
                        !options.contains("\"" + key + "\""));
            }
            assertTrue("the drain named no transfer", options.contains("transferId"));

            // The persisted state at the instant a call is outstanding, with its
            // control.
            Bundle state = new Bundle();
            activity.get().getBridge().saveInstanceState(state);
            int measured = parcelBytes(state);
            int control = oldShapeStateBytes(envelope.bytes);
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
                    "the control measurement is "
                            + control
                            + " bytes and does not exceed the bound this test requires the real"
                            + " one to stay under — the instrument discriminates nothing",
                    control > LAUNCH_STATE_MAX_BYTES);
            assertTrue(
                    "the control measurement is "
                            + control
                            + " bytes, which does not reach the binder limit — it no longer"
                            + " reproduces the shape that crashed the device",
                    control > BINDER_LIMIT_BYTES);
            assertTrue(
                    "the persisted state of the transfer calls is "
                            + measured
                            + " bytes for a "
                            + envelope.bytes
                            + "-byte transfer (control: "
                            + control
                            + ") — a payload is riding a call again",
                    measured <= LAUNCH_STATE_MAX_BYTES);
        }
    }

    // ---------------------------------------------------------------------
    // 4. The band invariant, native side.
    // ---------------------------------------------------------------------

    @Test
    public void the_transfer_writes_nothing_to_web_storage() throws Exception {
        // THE HALF THIS DEVICE CAN SPEAK TO, and its bound stated in the same
        // breath. The transfer SOURCE is the browser's storage on the production
        // origin, which no emulator here holds and which the web-side leg
        // (app/tests/handoff-transfer.spec.js) is what covers. What this asserts
        // is the other side: importing a delivered history does not write to the
        // WebView's own storage either, so the milestone's "nothing in it writes
        // to Web Storage" holds on both origins rather than on one.
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            assertEquals(
                    "the recorder did not install",
                    "installed",
                    evaluate(
                            scenario,
                            "(function () {"
                                + "window.__diaWrites = [];"
                                + "var proto = window.Storage.prototype;"
                                + "['setItem','removeItem','clear'].forEach(function (m) {"
                                + "var original = proto[m];"
                                + "proto[m] = function () {"
                                + "window.__diaWrites.push(m);"
                                + "return original.apply(this, arguments); }; });"
                                + "return 'installed';"
                                + "})()"));

            Envelope envelope = buildEnvelopeInApp(scenario, 3);
            deliver(scenario, link(envelope));
            pollFor(
                    scenario,
                    "(function () {"
                        + "var m = document.getElementById('importModal');"
                        + "return (m && m.className.indexOf('show') !== -1) ? 'shown' : null;"
                        + "})()",
                    TRANSFER_TIMEOUT_MS);
            evaluate(
                    scenario,
                    "(function () { var b = document.getElementById('importRunBtn');"
                        + " if (b && !b.hidden) { b.click(); } return 'clicked'; })()");
            pollFor(
                    scenario,
                    "(function () {"
                        + "var s = document.getElementById('importStatus').textContent;"
                        + "return (s && s.indexOf('Переношу') === -1) ? 'done' : null;"
                        + "})()",
                    TRANSFER_TIMEOUT_MS);

            String writes = evaluate(scenario, "JSON.stringify(window.__diaWrites)");
            Log.i(TAG, "web storage writes during a transfer: " + writes);
            assertEquals("the transfer wrote to WebView storage: " + writes, "[]", writes);

            // SELF-PROVING: an empty list above must not be able to mean "the
            // recorder never ran".
            assertEquals(
                    "the write recorder did not record a write it was handed",
                    "[\"setItem\",\"removeItem\"]",
                    evaluate(
                            scenario,
                            "(function () {"
                                + "window.localStorage.setItem('__dia_probe__','1');"
                                + "window.localStorage.removeItem('__dia_probe__');"
                                + "return JSON.stringify(window.__diaWrites);"
                                + "})()"));
        }
    }

    // ---------------------------------------------------------------------
    // the fixture, built by the shipped modules inside the app
    // ---------------------------------------------------------------------

    private static final class Envelope {
        String payload;
        String digest;
        int bytes;
        int skillCount;
    }

    /**
     * Builds a transfer envelope with the mount's own {@code transfer/format.js}.
     *
     * <p>Inside the app's WebView, through the mount the APK actually carries —
     * so the bytes delivered below are the bytes the handoff page produces. The
     * profile id is fixed rather than random: the importer derives its journal
     * ids from it, and a stable id is what makes the read-back assertable.
     */
    private Envelope buildEnvelopeInApp(ActivityScenario<MainActivity> scenario, int skills) {
        String script =
                ("(function () {"
                                + "window.__diaFixture = null;"
                                + "var base = '__BASE__';"
                                + "var url = new URL(base + 'transfer/format.js',"
                                + " document.baseURI).href;"
                                + "import(url).then(function (m) {"
                                + "var ids = [];"
                                + "for (var k = 1; k <= __SKILLS__; k++) {"
                                + "ids.push('GM_' + String(k).padStart(3, '0')); }"
                                + "var envelope = m.buildEnvelope([{ id: '__CHILD__',"
                                + " name: 'Тестовый профиль', birthdate: '2024-09-15',"
                                + " completedSkills: ids }]);"
                                + "var bytes = m.envelopeBytes(envelope);"
                                + "return m.digestHex(bytes).then(function (d) {"
                                + "window.__diaFixture = JSON.stringify({"
                                + " payload: m.encodePayload(bytes),"
                                + " digest: d, bytes: bytes.length, skills: ids.length }); });"
                                + "}).catch(function (e) {"
                                + " window.__diaFixture = 'err:' + (e && e.message); });"
                                + "return 'dispatched';"
                                + "})()")
                        .replace("__BASE__", MountAddress.prefix())
                        .replace("__SKILLS__", String.valueOf(skills))
                        .replace("__CHILD__", FIXTURE_CHILD);

        assertEquals("the fixture script never ran", "dispatched", evaluate(scenario, script));
        String raw = pollFor(scenario, "window.__diaFixture", EVALUATE_TIMEOUT_MS);
        assertTrue("the fixture was not built: " + raw, raw.startsWith("{"));

        Envelope out = new Envelope();
        out.payload = jsonString(raw, "payload");
        out.digest = jsonString(raw, "digest");
        out.bytes = Integer.parseInt(jsonNumber(raw, "bytes"));
        out.skillCount = Integer.parseInt(jsonNumber(raw, "skills"));
        Log.i(TAG, "fixture: bytes=" + out.bytes + " payload=" + out.payload.length() + " chars");
        return out;
    }

    private Uri link(Envelope envelope) {
        return Uri.parse(
                "theygrow://transfer/?payload="
                        + envelope.payload
                        + "&bytes="
                        + envelope.bytes
                        + "&sha256="
                        + envelope.digest
                        + "&v=1");
    }

    /**
     * Delivers the link to the running activity, then wakes the surface.
     *
     * <p>{@code onNewIntent} is the path a returning parent takes — the activity
     * is {@code singleTask}, so a link arriving while the app is open does not
     * recreate it. The visibility event is what the surface listens on, and it is
     * dispatched here because the emulator never backgrounded the app.
     */
    private void deliver(ActivityScenario<MainActivity> scenario, Uri uri) {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.setComponent(new ComponentName(context, MainActivity.class));
        scenario.onActivity(activity -> activity.onNewIntent(intent));

        // Record what the plugin reports, and drive the surface exactly as the
        // visibilitychange listener does.
        evaluate(
                scenario,
                "(function () {"
                    + "window.__diaPending = { present: null };"
                    + "window.__diaDrain = undefined;"
                    + "window.__diaCalls = [];"
                    + "var native = window.Capacitor.nativePromise;"
                    + "window.Capacitor.nativePromise = function (p, m, o) {"
                    + "if (p === 'TheyGrowTransfer' && m === 'readChunk') {"
                    + "window.__diaCalls.push(o); }"
                    + "return native.apply(window.Capacitor, arguments); };"
                    + "return 'hooked';"
                    + "})()");
        evaluate(
                scenario,
                "(function () {"
                    + "window.Capacitor.nativePromise('TheyGrowTransfer', 'pendingTransfer', {})"
                    + ".then(function (r) { window.__diaPending = r;"
                    + " window.__diaDrain = r.present ? 'pending' : 'none'; });"
                    + "document.dispatchEvent(new Event('visibilitychange'));"
                    + "return 'woken';"
                    + "})()");
    }

    /** Waits for the plugin's verdict about what it is holding. */
    private String pollForRefusal(ActivityScenario<MainActivity> scenario) {
        return pollFor(
                scenario,
                "(function () {"
                    + "if (window.__diaPending.present === null) { return null; }"
                    + "return window.__diaPending.refusal;"
                    + "})()",
                EVALUATE_TIMEOUT_MS);
    }

    /**
     * How many of the fixture's marks the journal actually holds.
     *
     * <p>Through the SHIPPED {@code store/boot.js} and {@code store/store.js}:
     * the ids are derived the same way the importer derived them, and
     * {@code existingEntryIds()} is asked which of them are there. Reading the
     * store rather than the surface is the difference between "the app said it
     * worked" and "the journal has it".
     */
    private String countImportedMarks(ActivityScenario<MainActivity> scenario, int skills) {
        String script =
                ("(function () {"
                                + "window.__diaMarks = null;"
                                + "var base = '__BASE__';"
                                + "var u = function (n) {"
                                + " return new URL(base + n, document.baseURI).href; };"
                                + "Promise.all([import(u('store/boot.js')),"
                                + " import(u('store/store.js'))]).then(function (mods) {"
                                + "var boot = mods[0], store = mods[1];"
                                + "var ids = [];"
                                + "var chain = Promise.resolve();"
                                + "for (var k = 1; k <= __SKILLS__; k++) {"
                                + "(function (n) { chain = chain.then(function () {"
                                + "return store.derivedId('assertion', '__CHILD__',"
                                + " 'GM_' + String(n).padStart(3, '0'))"
                                + ".then(function (id) { ids.push(id); }); }); })(k); }"
                                + "return chain.then(function () {"
                                + "return boot.existingEntryIds(ids); }); })"
                                + ".then(function (present) {"
                                + " window.__diaMarks = String(present.length); })"
                                + ".catch(function (e) {"
                                + " window.__diaMarks = 'err:' + (e && e.message); });"
                                + "return 'dispatched';"
                                + "})()")
                        .replace("__BASE__", MountAddress.prefix())
                        .replace("__SKILLS__", String.valueOf(skills))
                        .replace("__CHILD__", FIXTURE_CHILD);

        assertEquals("the read-back script never ran", "dispatched", evaluate(scenario, script));
        return pollFor(scenario, "window.__diaMarks", TRANSFER_TIMEOUT_MS);
    }

    // --- measurement ------------------------------------------------------

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
     * The control: the saved state a payload-on-the-call would produce.
     *
     * <p>Not expected to equal the 4 630 924 bytes of the 2026-08-15 crash, and
     * nothing asserts that it does — a {@link Parcel} writes Java strings as
     * UTF-16, so this measures larger than the framework's own accounting. What
     * is asserted is the pair of inequalities that make the instrument mean
     * something.
     */
    private static int oldShapeStateBytes(int transferBytes) {
        int size = Math.max(FIELD_CRASH_PAYLOAD_BYTES, transferBytes * 2);
        StringBuilder payload = new StringBuilder(size);
        for (int i = 0; i < size; i++) {
            payload.append('A');
        }
        String options = "{\"transferId\":\"probe\",\"base64\":\"" + payload + "\"}";

        Bundle pluginBundle = new Bundle();
        pluginBundle.putString("_json", options);

        Bundle state = new Bundle();
        state.putString("capacitorLastPluginId", "TheyGrowTransfer");
        state.putString("capacitorLastPluginCallMethodName", "readChunk");
        state.putString("capacitorLastPluginCallOptions", options);
        state.putBundle("capacitorLastPluginCallBundle", pluginBundle);
        return parcelBytes(state);
    }

    // --- small helpers ----------------------------------------------------

    private static String jsonString(String json, String key) {
        String needle = "\"" + key + "\":\"";
        int at = json.indexOf(needle);
        if (at == -1) {
            fail("the fixture carries no \"" + key + "\": " + json);
        }
        int from = at + needle.length();
        return json.substring(from, json.indexOf('"', from));
    }

    private static String jsonNumber(String json, String key) {
        String needle = "\"" + key + "\":";
        int at = json.indexOf(needle);
        if (at == -1) {
            fail("the fixture carries no \"" + key + "\": " + json);
        }
        int from = at + needle.length();
        int to = from;
        while (to < json.length() && Character.isDigit(json.charAt(to))) {
            to++;
        }
        return json.substring(from, to);
    }

    static String sha256Hex(String text) throws Exception {
        byte[] digest =
                MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        for (byte b : digest) {
            out.append(Character.forDigit((b >> 4) & 0xf, 16));
            out.append(Character.forDigit(b & 0xf, 16));
        }
        return out.toString();
    }

    static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    // --- WebView plumbing, same shape as ExportTransferTest ----------------

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
