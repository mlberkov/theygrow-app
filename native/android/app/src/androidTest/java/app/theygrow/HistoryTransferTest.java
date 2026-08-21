package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
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
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry;
import androidx.test.runner.lifecycle.Stage;

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
 * <p><b>EVERY LEG HERE WAS ONCE UNABLE TO SEE ITS OWN SUBJECT</b> — dispatch run
 * 31950709031 failed all seven for four harness defects and none for a product
 * one, and the repair is DIA-DL-002. Three rules came out of it and are enforced
 * by shape rather than by care:
 *
 * <ul>
 *   <li><b>A leg reads completion from the SHIPPED path</b> — the seam's own
 *       resolution — never from a token the test invented. {@code __diaDrain},
 *       the token that could never hold the value its assertion demanded, is
 *       gone, and {@link #no_bridge_call_carries_the_payload} reds if it comes
 *       back.
 *   <li><b>A wait tells "not yet" from "answered"</b> ({@link #answered}). The
 *       predicate that preceded it accepted the string {@code "undefined"}, which
 *       is how a correct read-back of a {@link java.util.Set} became a
 *       product-sounding failure.
 *   <li><b>A fixture belongs to ONE leg.</b> The store outlives every
 *       {@link ActivityScenario} in this process, so a child id shared between
 *       legs means the second one imports nothing and asserts against a world the
 *       first one already finished with.
 *   <li><b>An action step returns what it DID, and a leg asserts it</b> — the
 *       fourth rule, added by DIA-DL-003 after run 31954630121. A press that
 *       returns {@code 'clicked'} whether or not it pressed anything cannot
 *       report its own failure, and neither can a wait that watches the
 *       container rather than the offer. Both halves now live in
 *       {@link #offerAndPress}, and {@link #the_harness_arms_prove_themselves}
 *       fires that same helper at DOM states it builds in-run.
 * </ul>
 *
 * <p><b>AND ONE LEG WAS STILL UNABLE TO, A ROUND LATER.</b> Run 31954630121
 * brought 25 of 26 legs green and confirmed the teardown mechanism by
 * measurement — this class fell from 5 m 32.60 s to 2 m 20.77 s — with
 * {@link #the_transfer_writes_nothing_to_web_storage} the single red, again for
 * a fault of its own. {@code app.js} called {@code offerImportIfPending()} at
 * boot; nothing is staged on a fresh emulator, so {@code surfaces/import.js}
 * hid the run button and showed the modal. A wait that watched only for
 * {@code .show} was therefore answered by that BOOT-TIME invitation, before the
 * delivered profile existed, and the press that followed found a hidden button,
 * declined to click it, and said {@code 'clicked'} anyway (DIA-DL-003).
 *
 * <p><b>NEITHER LEG PRESSES ANYTHING ANY MORE (L3-P2, {@code FIU-DL-002}).</b>
 * The owner removed the in-app transfer offer outright, so that boot-time
 * invitation, that modal and that button are gone from the product. The two
 * transfer legs drive {@code pendingTransfer -> drainTransfer -> runImport} out
 * of the shipped {@code store/boot.js} instead — see {@link #drainAndImport} —
 * which keeps the retained mechanism executed on a device now that no surface
 * consumes it. The offer/press instruments stay, fired by the arm at DOM states
 * it builds itself: the rule they encode outlives the surface.
 *
 * <p>THE PARCEL LEG CARRIES ITS OWN CONTROL, for the reason {@code
 * ExportTransferTest} states: "the saved state is small" would stay green if the
 * measuring instrument were broken. So the same measuring function is run
 * against a synthetic bundle in the shape a payload-on-the-call would take, and
 * that number must EXCEED the bound the real one must stay under. Both are
 * logged. <b>What the real measurement here means is narrower than the export's,
 * and saying so is the point</b> — see {@link #no_bridge_call_carries_the_payload}.
 *
 * <p>{@link #the_harness_arms_prove_themselves} is this file's own arm-check: it
 * fires the repaired predicates at inputs it generates in-run and prints both
 * sides labelled. It executes NO product path and is a harness check, not a
 * runtime claim about the app.
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

    /** Option keys that would mean a payload is riding a bridge call. */
    private static final String[] PAYLOAD_KEYS = {"base64", "payload", "archive", "profiles"};

    /**
     * Which leg is running, and therefore whose fixture is in play.
     *
     * <p>JUnit builds a fresh instance of this class per method, so this is
     * per-leg by construction. It names the leg's child id and its document
     * token; every leg sets it as its first statement.
     */
    private String leg;

    /** The activity under test, kept so its teardown can be ASKED rather than assumed. */
    private final AtomicReference<MainActivity> activity = new AtomicReference<>(null);

    /** The Intent {@link ActivityScenario} launched with — see {@link #deliver}. */
    private final AtomicReference<Intent> launchIntent = new AtomicReference<>(null);

    // ---------------------------------------------------------------------
    // 1. The whole chain: a link arrives, the importer writes the journal.
    // ---------------------------------------------------------------------

    @Test
    public void a_deep_link_delivers_the_history() throws Exception {
        leg = "deep-link";
        withApp(scenario -> {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            Envelope envelope = buildEnvelopeInApp(scenario, 4);
            deliver(scenario, link(envelope));

            // THE MECHANISM IS DRIVEN THROUGH THE SHIPPED MODULES, NOT THROUGH A
            // SURFACE, AND THAT IS L3-P2 RATHER THAN A WEAKENING (FIU-DL-002).
            // This leg used to wait for #importModal to list the profile and
            // then press #importRunBtn. The owner removed the in-app transfer
            // offer outright, so that surface no longer exists — while the
            // plugin, the link, the envelope, the drain and the importer all
            // stay shipped as insurance. Insurance that nothing executes is a
            // claim, so the leg follows the mechanism down one layer: it calls
            // pendingTransfer -> drainTransfer -> runImport out of the SHIPPED
            // store/boot.js, in the app's own document, across the real bridge
            // to the real plugin. What is no longer covered by anyone, and is
            // said rather than left to be inferred, is the surface that used to
            // sit on top of it — because there is none.
            String status = drainAndImport(scenario, 1);
            assertEquals("the import did not report success: " + status, "imported", status);

            // THE MARKS LANDED, asked of the journal rather than of the surface.
            // A status line is what the app says; existingEntryIds() is what the
            // store holds, read through the SHIPPED module out of the mount the
            // APK carries — and read from the SAME document that imported them.
            assertImportedMarks(scenario, envelope.skillCount);
        });
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
        leg = "truncated";
        withApp(scenario -> {
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

            // WHAT THE PARENT IS TOLD IS NO LONGER ASSERTED HERE, AND IT IS NOT
            // AN OMISSION (L3-P2, FIU-DL-002). This block used to require the
            // one-line explanation and the file button ADR-048 §3 specifies —
            // `#importFallback` and `#importPickBtn`, both in the modal the
            // owner removed. There is no in-app surface for a refused handoff
            // to reach any more, because there is no in-app handoff. What is
            // left of this leg is what the PLUGIN does, which is the whole of
            // what still exists: it refuses, by code, and stages nothing.
        });
    }

    @Test
    public void the_receiver_refuses_a_foreign_query_key() throws Exception {
        leg = "foreign-key";
        withApp(scenario -> {
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
        });
    }

    @Test
    public void the_receiver_refuses_a_payload_past_the_ceiling() throws Exception {
        leg = "ceiling";
        withApp(scenario -> {
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
        });
    }

    @Test
    public void the_receiver_refuses_an_unknown_format_version() throws Exception {
        leg = "format-version";
        withApp(scenario -> {
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
        });
    }

    // ---------------------------------------------------------------------
    // 3. The payload does not ride a bridge call, measured with a control.
    // ---------------------------------------------------------------------

    /**
     * ADR-048 §2's cross-process property: the call carries a reference and small
     * metadata, never the history.
     *
     * <p><b>COMPLETION IS READ FROM THE SHIPPED SEAM, not from a token this test
     * sets.</b> {@code surfaces/import.js} calls {@code discardTransfer} only
     * after {@code drainTransfer} has resolved, on the success branch alone — the
     * refusal branch never reaches it. So a RESOLVED {@code discardTransfer} in
     * the recorded call list is the drain's own last act, and the leg waits for
     * that. The predecessor of this paragraph waited on {@code window.__diaDrain},
     * a variable the test assigned {@code 'pending'} or {@code 'none'} and never
     * {@code 'ok'} — the value its own assertion demanded — so the leg was
     * unpassable whatever the app did (DIA-DL-002).
     *
     * <p><b>AND AT LEAST ONE CHUNK MUST HAVE BEEN READ.</b> Four "this option key
     * is absent" assertions over an EMPTY call list all pass; the count is what
     * stops them meaning nothing.
     *
     * <p><b>WHAT THE SAVED-STATE MEASUREMENT HERE DOES AND DOES NOT SAY.</b>
     * {@code Bridge.saveInstanceState} writes nothing at all unless
     * {@code pluginCallForLastActivity} is set, which happens only for a call that
     * LAUNCHED an activity. {@code readChunk} launches nothing, so the honest
     * statement about this path is not "the persisted options are small" but "the
     * drain registers no call Capacitor persists in the first place" — which is
     * what is asserted, both ways round, with the reason named. The instrument is
     * shown to be able to measure a real one twice over: the control below builds
     * the old shape and must exceed the binder limit, and
     * {@code ExportTransferTest.the_export_writes_a_complete_archive_past_the_binder_limit}
     * measures a NON-empty bundle through the identical call in the same run. An
     * arm that drives this plugin's own launching call ({@code pickTransfer},
     * the only one that saves) is deferred — DIA-DL-002.
     */
    @Test
    public void no_bridge_call_carries_the_payload() throws Exception {
        leg = "no-bridge-call";
        withApp(scenario -> {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            Envelope envelope = buildEnvelopeInApp(scenario, 40);
            deliver(scenario, link(envelope));

            // The rule that made this leg unpassable, kept red rather than
            // remembered: no leg may wait on a completion token of its own.
            assertEquals(
                    "the harness set a drain placeholder again — completion must be read from"
                        + " the shipped seam, not from a variable this test assigns",
                    "undefined",
                    evaluate(scenario, "typeof window.__diaDrain"));

            // THE DRAIN IS ASKED FOR, RATHER THAN WAITED FOR (L3-P2,
            // FIU-DL-002). Until this packet the boot-time offer drained
            // whatever the plugin held, so this leg only had to wait. With the
            // offer removed nothing drains by itself, and a leg that went on
            // waiting would time out rather than measure anything. What it
            // measures is unchanged: the recorder below still watches the REAL
            // bridge calls the SHIPPED store/transfer.js makes, and the drain
            // is 40 skills' worth of history, so `chunks >= 1` still has teeth.
            String status = drainAndImport(scenario, 1);
            assertEquals("the drain did not complete: " + status, "imported", status);

            String drained =
                    pollFor(
                            scenario,
                            "(function () {"
                                + "var calls = window.__diaTransferCalls || [];"
                                + "var chunks = 0, discarded = 0;"
                                + "for (var i = 0; i < calls.length; i++) {"
                                + "if (calls[i].method === 'readChunk') { chunks += 1; }"
                                + "if (calls[i].method === 'discardTransfer' && calls[i].resolved)"
                                + " { discarded += 1; } }"
                                + "if (discarded === 0) { return null; }"
                                + "return JSON.stringify({ chunks: chunks, discarded: discarded });"
                                + "})()",
                            TRANSFER_TIMEOUT_MS);
            Log.i(TAG, "drain completion, read from the shipped seam: " + drained);
            int chunks = Integer.parseInt(jsonNumber(drained, "chunks"));
            assertTrue(
                    "the drain resolved without reading a single chunk, so the option checks"
                        + " below would inspect nothing: " + drained,
                    chunks >= 1);

            String options = evaluate(scenario, "JSON.stringify(window.__diaCalls)");
            Log.i(TAG, "drain call options=" + options);
            String carried = payloadKeyIn(options);
            assertNull("a drain call carried a \"" + carried + "\" option: " + options, carried);
            assertTrue("the drain named no transfer", options.contains("transferId"));

            // The persisted state, with its control.
            Bundle state = new Bundle();
            activity.get().getBridge().saveInstanceState(state);
            int measured = parcelBytes(state);
            String persistedOptions = state.getString("capacitorLastPluginCallOptions");
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
                            + BINDER_LIMIT_BYTES
                            + " persisted-call-options="
                            + (persistedOptions == null ? "none" : persistedOptions.length()
                                    + " chars"));

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

            assertNull(
                    "the drain registered a call Capacitor persists into saved instance state —"
                        + " the slot that carried 4 630 924 bytes on 2026-08-15 (XPT-DL-001) is"
                        + " occupied again",
                    persistedOptions);
            assertTrue(
                    "the persisted state after a "
                            + envelope.bytes
                            + "-byte transfer is "
                            + measured
                            + " bytes (control for the old shape: "
                            + control
                            + ") — a payload is riding a call again",
                    measured <= LAUNCH_STATE_MAX_BYTES);
        });
    }

    // ---------------------------------------------------------------------
    // 4. The band invariant, native side.
    // ---------------------------------------------------------------------

    /**
     * The device half of the band (ADR-048 §5), and its bound stated in the same
     * breath.
     *
     * <p>The transfer SOURCE is the browser's storage on the production origin,
     * which no emulator here holds and which the web-side leg
     * ({@code app/tests/handoff-transfer.spec.js}) is what covers. What this
     * asserts is the other side: importing a delivered history does not write to
     * the WebView's own storage either, so the milestone's "nothing in it writes
     * to Web Storage" holds on both origins rather than on one.
     *
     * <p><b>IT ESTABLISHES THAT A TRANSFER LANDED BEFORE IT ASSERTS ANYTHING
     * ABOUT WRITES.</b> In run 31950709031 this leg ran at
     * {@code history.handoff outcome=nothing_selected}: it shared a child id with
     * {@link #a_deep_link_delivers_the_history}, the store survives every
     * {@link ActivityScenario} in this process, and every mark it offered had
     * already been imported — so nothing was imported, and an empty write list
     * meant only that an untouched storage was untouched. The control below
     * measures exactly that: the same {@code []} the old assertion demanded, taken
     * from a world in which nothing has happened yet.
     *
     * <p><b>AND IT PRESSES A BUTTON THAT IS ACTUALLY THERE.</b> In run
     * 31954630121 this was the one red of twenty-six, and the product was again
     * not implicated: the logcat carries {@code history.handoff outcome=complete
     * transport=link refusal=none bytes=209 chunks=1 profiles=1} — the profile
     * WAS delivered and offered — and then carries no {@code history.import} and
     * no status line at all, because {@code runImportFromUi} is bound to a real
     * click and no click happened. The wait watched {@code .show}, which
     * {@code offerImportIfPending()} sets at BOOT for the handoff invitation
     * with the run button hidden, and the press was guarded only by
     * {@code hidden} and returned {@code 'clicked'} regardless. Both are now
     * {@link #offerAndPress}, which waits for the OFFER and reports
     * {@code 'not-offered'} rather than pressing nothing quietly (DIA-DL-003).
     * Since L3-P2 this leg presses nothing at all: the surface was removed and
     * the mechanism is driven through the shipped modules ({@link
     * #drainAndImport}). The paragraph is kept because the rule it records is
     * why the replacement reports what it DID rather than that it ran.
     */
    @Test
    public void the_transfer_writes_nothing_to_web_storage() throws Exception {
        leg = "web-storage";
        withApp(scenario -> {
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

            // THE OLD FORM'S CONTROL, taken before anything happens: the value
            // this leg's assertion demands is also the value of a world in which
            // no transfer ever ran. Logged so the contrast can be read.
            String untouched = evaluate(scenario, "JSON.stringify(window.__diaWrites)");
            Log.i(TAG, "control — web storage writes BEFORE any transfer: " + untouched);
            assertEquals(
                    "the recorder saw a write before the transfer started, so the control is not"
                        + " the untouched world it claims to be",
                    "[]",
                    untouched);

            Envelope envelope = buildEnvelopeInApp(scenario, 3);
            deliver(scenario, link(envelope));

            // THE DRAIN AND THE IMPORT, THROUGH THE SHIPPED MODULES (L3-P2,
            // FIU-DL-002 — see the deep-link leg for why the surface is gone).
            // The claim this leg makes is unchanged and is if anything sharper:
            // the recorder below is watching Storage.prototype, and what it must
            // see nothing from is the transfer path itself, which is exactly
            // what is being driven here. One profile, this leg's own count.
            String status = drainAndImport(scenario, 1);
            // Sampled HERE, before the read-back below loads any further module,
            // so what is asserted is the write set of the transfer itself.
            String writes = evaluate(scenario, "JSON.stringify(window.__diaWrites)");

            // THE TRANSFER LANDED. Asserted first, because everything after it is
            // meaningless about a transfer that did not happen.
            assertEquals("the import did not report success: " + status, "imported", status);
            assertImportedMarks(scenario, envelope.skillCount);

            Log.i(TAG, "web storage writes during a transfer that landed: " + writes);
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
        });
    }

    // ---------------------------------------------------------------------
    // 5. The arm: this file's own instruments, fired at inputs it generates.
    // ---------------------------------------------------------------------

    /**
     * The arm-check for the repairs that are predicates and steps rather than
     * paths — three from DIA-P1R (A-C), and the offer-and-press of DIA-P1R2 (D).
     *
     * <p><b>THIS IS A HARNESS CHECK AND EXECUTES NO PRODUCT PATH</b> (AGENTS.md
     * §11). It asserts nothing about the transfer; it asserts that the
     * instruments the other seven legs read through can tell the two answers
     * apart, and it prints the OLD instrument's verdict on the same inputs beside
     * the new one — because a repair with no contrast is a change.
     *
     * <p>One of the four defects has no predicate to repair. {@code 'pending'} is
     * a perfectly good answer to a question; what was wrong was that the test
     * ASKED itself. That one is fixed by shape — no leg assigns a completion
     * token — and its regression guard lives in
     * {@link #no_bridge_call_carries_the_payload}, not here. Saying so is better
     * than an assertion that pretends the predicate covers it.
     *
     * <p><b>SECTION D IS THE MUTATION DEMONSTRATION FOR DIA-P1R2, AND IT RUNS ON
     * EVERY DISPATCH RATHER THAN ONCE.</b> Removing the offer wait or the press
     * from the band's device leg and dispatching would produce one bit, at the
     * cost of a full run, and leave no standing guard. Instead D builds the DOM
     * state that broke that leg — a modal carrying {@code show} with no profile
     * listed, then one listed and the button still not pressable — and fires
     * {@link #offerAndPress} ITSELF at it, the same method the two transfer legs
     * call. It must fail, it must name the press, and no click may reach the
     * button; the OLD forms are printed green on the identical input beside it.
     * {@code 'pressed'} is then shown to mean a handler actually ran.
     *
     * <p>D touches NO product element: its subtree is its own, under
     * {@code __dia_probe_host__}, and it asserts that subtree gone from the
     * document before it finishes — a teardown that silently did not happen
     * would otherwise read as a clean run, which is the very failure this packet
     * exists to make impossible.
     */
    @Test
    public void the_harness_arms_prove_themselves() throws Exception {
        leg = "arms";

        // --- A. the wait predicate ---------------------------------------
        Log.i(
                TAG,
                "arm — wait predicate on \"undefined\": old=" + legacyAnswered("undefined")
                        + " new=" + answered("undefined")
                        + " | on \"\": old=" + legacyAnswered("")
                        + " new=" + answered("")
                        + " | on \"0\": old=" + legacyAnswered("0")
                        + " new=" + answered("0"));
        assertTrue(
                "the OLD wait predicate no longer accepts \"undefined\" — the contrast this arm"
                    + " exists to draw has evaporated and it proves nothing",
                legacyAnswered("undefined"));
        assertFalse(
                "the repaired wait predicate still treats \"undefined\" as an answer, which is"
                    + " how a correct read-back of a Set was reported as a missing journal",
                answered("undefined"));
        assertFalse("an empty string is not an answer", answered(""));
        assertFalse("a JavaScript null is not an answer", answered("null"));
        assertFalse("a Java null is not an answer", answered(null));
        assertFalse("a false is not an answer", answered("false"));
        assertTrue("a zero IS an answer", answered("0"));
        assertTrue("a plain value IS an answer", answered("size_mismatch"));

        // --- B. the payload-key scan -------------------------------------
        assertNull(
                "the OLD form's payload-key scan is no longer satisfied by an EMPTY call list —"
                    + " the vacuity this arm demonstrates has gone",
                payloadKeyIn("[]"));
        assertNull(
                "the payload-key scan sees a payload key in a reference-only call",
                payloadKeyIn("[{\"transferId\":\"probe\",\"offset\":0,\"length\":16}]"));
        assertEquals(
                "the payload-key scan cannot see a payload key it is handed directly, so its"
                    + " silence over the real calls means nothing",
                "base64",
                payloadKeyIn("[{\"transferId\":\"probe\",\"base64\":\"QUFB\"}]"));
        Log.i(
                TAG,
                "arm — payload-key scan: empty list carries no key (old form green, 0 chunks),"
                        + " a base64 option is seen. The repaired leg additionally requires"
                        + " chunks >= 1, which an empty list fails by construction.");

        // --- C. the read-back's return type, from the SHIPPED module ------
        withApp(scenario -> {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);

            assertEquals(
                    "a Set's .length is no longer undefined in this engine — defect 3's mechanism"
                        + " has changed and the repair needs re-deriving",
                    "undefined",
                    evaluate(scenario, "String(new Set(['a']).length)"));
            assertEquals(
                    "a Set's .size does not count its members",
                    "1",
                    evaluate(scenario, "String(new Set(['a']).size)"));

            String script =
                    ("(function () {"
                                    + "window.__diaKind = null;"
                                    + "var u = new URL('__BASE__store/boot.js',"
                                    + " document.baseURI).href;"
                                    + "import(u).then(function (m) {"
                                    + "return m.existingEntryIds([]); }).then(function (r) {"
                                    + "window.__diaKind = Object.prototype.toString.call(r)"
                                    + " + '|length=' + String(r.length)"
                                    + " + '|size=' + String(r.size); })"
                                    + ".catch(function (e) {"
                                    + " window.__diaKind = 'err:' + (e && e.message); });"
                                    + "return 'dispatched';"
                                    + "})()")
                            .replace("__BASE__", MountAddress.prefix());
            assertEquals("the return-type probe never ran", "dispatched", evaluate(scenario, script));
            String kind = pollFor(scenario, "window.__diaKind", EVALUATE_TIMEOUT_MS);
            Log.i(TAG, "arm — existingEntryIds() returns: " + kind);
            assertEquals(
                    "the shipped existingEntryIds() no longer returns a Set whose .length is"
                        + " undefined — the read-back's repair rests on that and must be re-derived",
                    "[object Set]|length=undefined|size=0",
                    kind);

            // --- D. the offer wait and the press, at a DOM this arm builds ----
            //
            // THIS IS THE MUTATION, RUN EVERY TIME instead of once. The state
            // that broke the band's device leg is reproduced here in a subtree
            // of the arm's own: a modal carrying `show` with no profile listed
            // and a hidden button — which is exactly what
            // offerImportIfPending() leaves behind at boot. The repaired steps
            // are required to refuse it, and the OLD forms are printed green on
            // the same input beside them.
            assertEquals(
                    "the probe subtree was not built, so section D asserts nothing",
                    "built",
                    evaluate(
                            scenario,
                            probeScript(
                                    "(function () {"
                                        + "var host = document.createElement('div');"
                                        + "host.id = '__dia_probe_host__';"
                                        + "var m = document.createElement('div');"
                                        + "m.id = '__MODAL__'; m.className = 'show';"
                                        + "var c = document.createElement('div');"
                                        + "c.id = '__CHOICES__';"
                                        + "var b = document.createElement('button');"
                                        + "b.id = '__BTN__'; b.hidden = true;"
                                        + "window.__diaProbePresses = 0;"
                                        + "b.addEventListener('click', function () {"
                                        + " window.__diaProbePresses += 1; });"
                                        + "m.appendChild(c); m.appendChild(b);"
                                        + "host.appendChild(m); document.body.appendChild(host);"
                                        + "return document.getElementById('__BTN__')"
                                        + " ? 'built' : 'not-built';"
                                        + "})()")));

            // D1 — THE WAIT. A shown modal listing no profile is not an offer.
            String legacyOffer = evaluate(scenario, legacyOfferScript(Surface.PROBE));
            String repairedOffer = evaluate(scenario, offerScript(Surface.PROBE));
            Log.i(
                    TAG,
                    "arm — wait on a shown modal listing NO profile (the boot-time handoff"
                            + " invitation): old=" + legacyOffer
                            + " new=" + repairedOffer);
            assertNull(
                    "the repaired wait accepts a modal that lists no profile — which is the"
                        + " boot-time handoff invitation, and is what answered the band's device"
                        + " leg before its transfer had arrived",
                    repairedOffer);
            assertEquals(
                    "the OLD `.show`-only wait no longer answers on a modal that lists nothing —"
                        + " the contrast this arm exists to draw has evaporated",
                    "shown",
                    legacyOffer);

            // D2 — THE PRESS, AT LEG LEVEL. One profile listed, button still not
            // pressable: the helper the two transfer legs call must fail HERE,
            // and must say so about the press.
            assertEquals(
                    "the probe was not given a profile to list",
                    "listed",
                    evaluate(
                            scenario,
                            probeScript(
                                    "(function () {"
                                        + "var c = document.getElementById('__CHOICES__');"
                                        + "var box = document.createElement('input');"
                                        + "box.type = 'checkbox'; box.checked = true;"
                                        + "c.appendChild(box);"
                                        + "var boxes = c.querySelectorAll("
                                        + "'input[type=\\\"checkbox\\\"]');"
                                        + "return boxes.length === 1 ? 'listed' : 'not-listed';"
                                        + "})()")));

            AssertionError refused = null;
            try {
                offerAndPress(scenario, Surface.PROBE, 1, PROBE_BUDGET_MS);
            } catch (AssertionError expected) {
                refused = expected;
            }
            assertNotNull(
                    "offer-and-press passed against a button that cannot be pressed, so the step"
                        + " this packet repaired still cannot report its own failure",
                    refused);
            Log.i(
                    TAG,
                    "arm — offer-and-press against an unpressable button: "
                            + refused.getMessage());
            assertTrue(
                    "the failure does not name the press, so its reader would go looking for a"
                        + " product defect the way run 31954630121's did: " + refused.getMessage(),
                    refused.getMessage().contains("the transfer button was not offered"));
            assertEquals(
                    "the repaired press reported a refusal and clicked anyway",
                    "0",
                    evaluate(scenario, PROBE_PRESSES));

            String legacyPress = evaluate(scenario, legacyPressScript(Surface.PROBE));
            String legacyPresses = evaluate(scenario, PROBE_PRESSES);
            Log.i(
                    TAG,
                    "arm — press on a hidden button: old=" + legacyPress
                            + " (clicks delivered: " + legacyPresses + ")"
                            + " new=not-offered (clicks delivered: 0). The old verdict is run"
                            + " 31954630121's one red, in one line.");
            assertEquals(
                    "the OLD press form no longer reports a press it did not make — the silent"
                        + " pass this arm reproduces has gone",
                    "clicked",
                    legacyPress);
            assertEquals(
                    "the OLD form pressed a hidden button, so the two forms are not being"
                        + " compared on the same input",
                    "0",
                    legacyPresses);

            // D3 — AND 'pressed' MEANS A HANDLER RAN. Otherwise the repaired
            // step would be a second way of saying 'clicked'.
            assertEquals(
                    "the probe button was not made pressable",
                    "offered",
                    evaluate(
                            scenario,
                            probeScript(
                                    "(function () {"
                                        + "var b = document.getElementById('__BTN__');"
                                        + "b.hidden = false;"
                                        + "return b.hidden ? 'still-hidden' : 'offered';"
                                        + "})()")));
            assertEquals(
                    "the repaired wait does not count the one profile it is shown",
                    "1",
                    evaluate(scenario, offerScript(Surface.PROBE)));
            assertEquals(
                    "the repaired press refuses a button that is present, shown and enabled",
                    "pressed",
                    evaluate(scenario, pressScript(Surface.PROBE)));
            assertEquals(
                    "the press said 'pressed' without a handler running, so 'pressed' does not"
                        + " mean the button was pressed",
                    "1",
                    evaluate(scenario, PROBE_PRESSES));

            // D4 — the other unpressable state. `runImportFromUi` disables the
            // button for the duration of an import, so this is a real one.
            assertEquals(
                    "the probe button was not disabled",
                    "disabled",
                    evaluate(
                            scenario,
                            probeScript(
                                    "(function () {"
                                        + "var b = document.getElementById('__BTN__');"
                                        + "b.disabled = true;"
                                        + "return b.disabled ? 'disabled' : 'still-enabled';"
                                        + "})()")));
            assertEquals(
                    "the repaired press presses a disabled button",
                    "not-offered",
                    evaluate(scenario, pressScript(Surface.PROBE)));
            assertEquals(
                    "a disabled button was clicked",
                    "1",
                    evaluate(scenario, PROBE_PRESSES));

            // AND THE ARM CLEANS UP AFTER ITSELF, OBSERVABLY. A teardown that
            // silently did not happen must not read as a clean run — the same
            // discipline this whole packet is about, applied to the arm's own
            // fixture. The removal step says what it DID, and the document is
            // then asked independently.
            assertEquals(
                    "the probe subtree was already gone before its teardown ran, so what the"
                        + " assertions above fired at is not what this removed",
                    "removed",
                    evaluate(
                            scenario,
                            "(function () {"
                                + "var h = document.getElementById('__dia_probe_host__');"
                                + "if (!h) { return 'absent'; }"
                                + "h.parentNode.removeChild(h);"
                                + "delete window.__diaProbePresses;"
                                + "return 'removed';"
                                + "})()"));
            assertNull(
                    "the probe subtree is still in the app's document after its own teardown"
                        + " reported it removed",
                    evaluate(
                            scenario,
                            "(function () {"
                                + "var h = document.getElementById('__dia_probe_host__');"
                                + "return h ? 'present' : null;"
                                + "})()"));
        });
    }

    /** How long the arm gives a wait it EXPECTS to be refused before it. */
    private static final long PROBE_BUDGET_MS = 2_000;

    /** How many clicks the arm's probe button has actually received. */
    private static final String PROBE_PRESSES = "String(window.__diaProbePresses)";

    /** Substitutes the probe's ids into one of the arm's own fixture scripts. */
    private static String probeScript(String script) {
        return script.replace("__MODAL__", Surface.PROBE.modal)
                .replace("__CHOICES__", Surface.PROBE.choices)
                .replace("__BTN__", Surface.PROBE.button);
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
     * This leg's child id, and no other leg's.
     *
     * <p>FORM, NOT VALUE: a compile-time constant per leg, nothing the emulator
     * regenerates. The store outlives every {@link ActivityScenario} in this
     * process — {@code freshly_created=true} appears once, on the first leg of the
     * run — so two legs sharing an id means the second imports nothing, and JUnit's
     * method order is not this file's source order. Sequencing would not have
     * fixed it; separate ids do (DIA-DL-002).
     */
    private String fixtureChild() {
        return "dia-fixture-" + leg;
    }

    /** The document this leg stamped before it delivered anything. */
    private String documentToken() {
        return "dia-doc-" + leg;
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
                        .replace("__CHILD__", fixtureChild());

        assertEquals("the fixture script never ran", "dispatched", evaluate(scenario, script));
        String raw = pollFor(scenario, "window.__diaFixture", EVALUATE_TIMEOUT_MS);
        assertTrue("the fixture was not built: " + raw, raw.startsWith("{"));

        Envelope out = new Envelope();
        out.payload = jsonString(raw, "payload");
        out.digest = jsonString(raw, "digest");
        out.bytes = Integer.parseInt(jsonNumber(raw, "bytes"));
        out.skillCount = Integer.parseInt(jsonNumber(raw, "skills"));
        Log.i(
                TAG,
                "fixture for " + fixtureChild() + ": bytes=" + out.bytes
                        + " payload=" + out.payload.length() + " chars");
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
     *
     * <p><b>THE RECORDER IS ARMED BEFORE THE INTENT IS DELIVERED.</b> It used to
     * be installed afterwards, which left a window in which a drain would have
     * gone unrecorded — never hit, and not a window worth keeping.
     *
     * <p><b>THE WAKE AND THE ASK BOTH REPORT WHAT THEY DID.</b> The wake returns
     * the visibility state it dispatched into, because {@code import.js}'s
     * listener does nothing at all on a hidden document; and the
     * {@code pendingTransfer} ask records a REJECTION into the same slot its
     * answer would have gone to, so {@link #pollForRefusal} surfaces a bridge
     * failure as a wrong refusal code rather than expiring silently on a null
     * that will never change (DIA-DL-003).
     *
     * <p><b>THE LAUNCH INTENT IS PUT BACK, AND THAT IS A HARNESS COMPENSATION
     * THAT MAKES THIS ACTIVITY DIVERGE FROM PRODUCTION.</b> In production the
     * VIEW Intent stays current after {@code MainActivity.onNewIntent} calls
     * {@code setIntent(intent)}; here it does not. The reason is that
     * {@link ActivityScenario} identifies the activity it launched by comparing
     * {@code activity.getIntent()} against the Intent it started, and discards —
     * silently, by design — every lifecycle event of an activity whose Intent no
     * longer matches. Run 31950709031 shows it three times per leg
     * ({@code "Activity lifecycle changed event received but ignored because the
     * intent does not match"}), with {@code in: DESTROYED} 0.3 s after
     * {@code close()} and {@code close()} nonetheless waiting out its full 45 s.
     * The product is right and the harness is what yields.
     *
     * <p>Both calls run in ONE main-thread block so no lifecycle event can
     * interleave while the Intent is the delivered one. <b>The assumption this
     * rests on, named because it is load-bearing:</b> nothing downstream of
     * {@code onNewIntent} re-reads {@code getIntent()}.
     * {@code MainActivity.stageHandoff} takes the Intent by argument, and so does
     * {@code Bridge.onNewIntent}, which only forwards it to every plugin's
     * {@code handleOnNewIntent}. Capacitor reads {@code getIntent()} in exactly
     * three places and all three are construction-time — the {@code Bridge}
     * constructor twice, and {@code BridgeActivity.load()} once, which is the
     * cold-start delivery. None of them runs again after a link arrives. If that
     * were nonetheless false, the restore would mask a delivery and the four
     * guard legs would stop refusing — a red, not a silent pass. Verified against
     * the vendored Capacitor source; EXECUTED only by the re-dispatch, and by
     * nothing on the development machine.
     */
    private void deliver(ActivityScenario<MainActivity> scenario, Uri uri) {
        assertEquals(
                "the transfer-call recorder did not install",
                "hooked",
                evaluate(
                        scenario,
                        ("(function () {"
                                        + "window.__diaDoc = '__DOC__';"
                                        + "window.__diaPending = { present: null };"
                                        + "window.__diaCalls = [];"
                                        + "window.__diaTransferCalls = [];"
                                        // Not named `native`, which this held until
                                        // DIA-P1R. V8 accepts it — checked, so this is
                                        // insurance and not a repair — but it is an ES3
                                        // future-reserved word, and a parse failure in a
                                        // script the WebView evaluates comes back looking
                                        // like a bridge failure rather than a typo.
                                        + "var bridgeCall = window.Capacitor.nativePromise;"
                                        + "window.Capacitor.nativePromise = function (p, m, o) {"
                                        + "var out = bridgeCall.apply(window.Capacitor, arguments);"
                                        + "if (p === 'TheyGrowTransfer') {"
                                        + "var call = { method: m, resolved: false };"
                                        + "window.__diaTransferCalls.push(call);"
                                        + "if (m === 'readChunk') { window.__diaCalls.push(o); }"
                                        + "out.then(function () { call.resolved = true; },"
                                        + " function () { call.resolved = false; }); }"
                                        + "return out; };"
                                        + "return 'hooked';"
                                        + "})()")
                                .replace("__DOC__", documentToken())));

        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.setComponent(new ComponentName(context, MainActivity.class));
        Intent launch = launchIntent.get();
        scenario.onActivity(
                target -> {
                    target.onNewIntent(intent);
                    target.setIntent(launch);
                });

        // THE WAKE SAYS WHETHER IT COULD HAVE WOKEN ANYTHING, AND THE ASK SAYS
        // WHEN IT WAS REFUSED. Both are the same defect class as the press this
        // packet repairs (DIA-DL-003). `import.js`'s listener returns before it
        // asks the plugin for anything unless the document is visible, so a
        // 'woken' that meant only "the script ran" would leave six legs timing
        // out on a poll with nothing named; and a REJECTED pendingTransfer used
        // to leave `__diaPending.present` null for ever, which is how the four
        // guard legs would have spent their whole budget saying nothing.
        assertEquals(
                "the surface was not woken: the document was not visible, so import.js's"
                    + " visibility listener returned before it asked the plugin for anything",
                "woken",
                evaluate(
                        scenario,
                        "(function () {"
                            + "window.Capacitor.nativePromise('TheyGrowTransfer',"
                            + " 'pendingTransfer', {})"
                            + ".then(function (r) { window.__diaPending = r; },"
                            + " function (e) { window.__diaPending = { present: 'error',"
                            + " refusal: 'bridge_error:' + (e && (e.message || e)) }; });"
                            + "document.dispatchEvent(new Event('visibilitychange'));"
                            + "return document.visibilityState === 'visible'"
                            + " ? 'woken' : 'not-visible:' + document.visibilityState;"
                            + "})()"));
    }

    /** Waits for the plugin's verdict about what it is holding. */
    private String pollForRefusal(ActivityScenario<MainActivity> scenario) {
        return pollFor(
                scenario,
                "(function () {"
                    + "if (window.__diaPending.present === null) { return null; }"
                    + "return window.__diaPending.refusal;"
                    + "})()",
                EVALUATE_TIMEOUT_MS,
                "the plugin to say what it is holding — pendingTransfer neither answered nor"
                        + " reported a bridge failure");
    }

    // ---------------------------------------------------------------------
    // the offer and the press, in one place, said in terms of what they DID
    // ---------------------------------------------------------------------

    /**
     * The three element ids one offer-and-press sequence is driven through.
     *
     * <p>Ids are a PARAMETER and not a constant so that
     * {@link #the_harness_arms_prove_themselves} can fire the very steps the legs
     * use at a subtree it builds itself, instead of at the product's modal. Same
     * substitution idiom this file already uses for {@code __BASE__},
     * {@code __SKILLS__} and {@code __CHILD__}.
     */
    private static final class Surface {
        final String modal;
        final String choices;
        final String button;

        Surface(String modal, String choices, String button) {
            this.modal = modal;
            this.choices = choices;
            this.button = button;
        }

        // THE PRODUCT'S IMPORT MODAL USED TO BE DECLARED HERE, and it is gone
        // with the modal (L3-P2, FIU-DL-002): the two transfer legs now drive
        // the shipped modules directly. What is left is the arm's own subtree,
        // which is what the offer/press instruments still have to be fired at —
        // the instruments themselves are kept because DIA-DL-003's rule (an
        // action step reports what it DID) is a property of this harness, not
        // of the surface that occasioned it.

        /** The arm's own subtree — built in-run, asserted gone afterwards. */
        static final Surface PROBE =
                new Surface("__dia_probe_modal__", "__dia_probe_choices__", "__dia_probe_btn__");
    }

    /**
     * Has the modal OFFERED a profile — and how many?
     *
     * <p>The offer, not the container. {@code offerImportIfPending()} adds
     * {@code show} to this same modal at boot for the handoff invitation, with no
     * profile listed and the run button hidden, so {@code .show} alone answers
     * "yes" in a world where there is nothing to press (DIA-DL-003). Returns
     * {@code null} for "not yet", per the bargain {@link #answered} names.
     */
    private static String offerScript(Surface surface) {
        return ("(function () {"
                        + "var m = document.getElementById('__MODAL__');"
                        + "if (!m || m.className.indexOf('show') === -1) { return null; }"
                        + "var boxes = document.querySelectorAll("
                        + "'#__CHOICES__ input[type=\\\"checkbox\\\"]');"
                        + "return boxes.length ? String(boxes.length) : null;"
                        + "})()")
                .replace("__MODAL__", surface.modal)
                .replace("__CHOICES__", surface.choices);
    }

    /**
     * Presses the transfer button, and says which of the two things it did.
     *
     * <p>{@code 'pressed'} is claimed only after {@code click()} has been called
     * on a button that is present, not {@code hidden} and not {@code disabled} —
     * the three states in which {@code runImportFromUi} would never run.
     */
    private static String pressScript(Surface surface) {
        return ("(function () {"
                        + "var b = document.getElementById('__BTN__');"
                        + "if (!b || b.hidden || b.disabled) { return 'not-offered'; }"
                        + "b.click(); return 'pressed';"
                        + "})()")
                .replace("__BTN__", surface.button);
    }

    /**
     * The wait as the band's device leg had it, kept ONLY as the arm's control.
     *
     * <p>Nothing waits through it. It exists so
     * {@link #the_harness_arms_prove_themselves} can show it answering
     * {@code 'shown'} on the exact DOM state that made run 31954630121's one red
     * — the boot-time handoff invitation, with no profile listed.
     */
    private static String legacyOfferScript(Surface surface) {
        return ("(function () {"
                        + "var m = document.getElementById('__MODAL__');"
                        + "return (m && m.className.indexOf('show') !== -1) ? 'shown' : null;"
                        + "})()")
                .replace("__MODAL__", surface.modal);
    }

    /**
     * The press as that leg had it, kept ONLY as the arm's control.
     *
     * <p>It returns {@code 'clicked'} whether or not it clicked anything, which
     * is the whole of DIA-P1R2: a step that cannot report its own failure, and a
     * leg that therefore spent its budget waiting for a consequence that was
     * never going to arrive.
     */
    private static String legacyPressScript(Surface surface) {
        return ("(function () { var b = document.getElementById('__BTN__');"
                        + " if (b && !b.hidden) { b.click(); } return 'clicked'; })()")
                .replace("__BTN__", surface.button);
    }

    /**
     * Drains the staged transfer and imports it, through the shipped modules.
     *
     * <p><b>WHY THIS REPLACED A BUTTON PRESS (L3-P2, {@code FIU-DL-002}).</b>
     * The in-app transfer offer was removed by owner decision, so there is no
     * modal to wait for and no button to press. Everything under it stays
     * shipped — {@code HistoryTransferPlugin}, the envelope, {@code
     * store/transfer.js}, {@code store/import-legacy.js} — and this is what
     * keeps that insurance executed on a device: the same three calls the
     * surface used to make, made from the app's own document, across the real
     * bridge, against the real plugin, out of the mount the APK carries.
     *
     * <p>It answers with the same vocabulary the status line used to, so the
     * legs above are unchanged in what they assert: {@code 'imported'} means the
     * importer reported children and marks written; anything else comes back
     * verbatim, because "nothing was staged" and "the import wrote nothing" are
     * different outcomes and a leg that accepts both cannot tell them apart.
     *
     * <p><b>And the answer must come from the document that was asked.</b> The
     * token {@link #deliver} stamps rides back with the counts, for the reason
     * {@link #assertImportedMarks} states: otherwise "the import did not happen"
     * cannot be told from "the world I asked was not the world it happened in".
     */
    private String drainAndImport(ActivityScenario<MainActivity> scenario, int expectedProfiles) {
        String script =
                ("(function () {"
                                + "window.__diaImport = null;"
                                + "var base = '__BASE__';"
                                + "var u = function (n) {"
                                + " return new URL(base + n, document.baseURI).href; };"
                                + "import(u('store/boot.js')).then(function (boot) {"
                                + "return boot.pendingTransfer().then(function (staged) {"
                                + "if (!staged.present) {"
                                + " throw new Error('nothing was staged, refusal='"
                                + " + staged.refusal); }"
                                + "return boot.drainTransfer(staged).then(function (drained) {"
                                + "var ids = drained.profiles.map(function (p) { return p.id; });"
                                + "var handle = boot.storeHandle();"
                                + "if (!handle) { throw new Error('the store is not open'); }"
                                + "return boot.runImport({ profiles: drained.profiles,"
                                + " selectedProfileIds: ids,"
                                + " authorParticipantId: handle.selfParticipantId })"
                                + ".then(function (summary) {"
                                + "return boot.discardTransfer(staged.transferId)"
                                + ".then(function () { return {"
                                + " doc: window.__diaDoc,"
                                + " profiles: String(ids.length),"
                                + " children: String(summary.children),"
                                + " assertions: String(summary.assertions) }; }); }); }); }); })"
                                + ".then(function (result) {"
                                + " window.__diaImport = JSON.stringify(result); })"
                                + ".catch(function (e) {"
                                + " window.__diaImport = 'err:' + (e && e.message); });"
                                + "return 'dispatched';"
                                + "})()")
                        .replace("__BASE__", MountAddress.prefix());

        assertEquals("the drain-and-import script never ran", "dispatched", evaluate(scenario, script));
        String raw =
                pollFor(
                        scenario,
                        "window.__diaImport",
                        TRANSFER_TIMEOUT_MS,
                        "the drain and the import to finish — neither the shipped modules nor"
                                + " their failure ever answered");
        Log.i(TAG, "drain-and-import: " + raw);
        if (!raw.startsWith("{")) {
            return "other:" + raw;
        }
        assertEquals(
                "the import was performed by a document other than the one this leg delivered"
                    + " to — every count below is about some other world: " + raw,
                documentToken(),
                jsonString(raw, "doc"));
        assertEquals(
                "the transfer carried a number of profiles other than " + expectedProfiles + ": "
                        + raw,
                String.valueOf(expectedProfiles),
                jsonString(raw, "profiles"));
        if ("0".equals(jsonString(raw, "children"))
                && "0".equals(jsonString(raw, "assertions"))) {
            return "other:the importer wrote nothing — " + raw;
        }
        return "imported";
    }

    /**
     * The same sequence, against any surface and any budget.
     *
     * <p>The wide form exists for one reason: the arm calls THIS method — the one
     * the legs call, not a re-implementation of it — against a button it has made
     * unpressable, and requires it to fail and to name the press. A repair whose
     * demonstration runs different code is not a demonstration.
     */
    private void offerAndPress(
            ActivityScenario<MainActivity> scenario,
            Surface surface,
            int expectedProfiles,
            long budget) {
        String offered =
                pollFor(
                        scenario,
                        offerScript(surface),
                        budget,
                        "the transfer to offer a profile to import — the modal listed none");
        assertEquals(
                "the transfer offered a number of profiles other than " + expectedProfiles,
                String.valueOf(expectedProfiles),
                offered);
        assertEquals(
                "the transfer button was not offered, so nothing was pressed and no import can"
                    + " have started",
                "pressed",
                evaluate(scenario, pressScript(surface)));
    }

    /**
     * Asserts the journal holds every one of this leg's marks, in the document
     * that imported them.
     *
     * <p>Through the SHIPPED {@code store/boot.js} and {@code store/store.js}:
     * the ids are derived the same way the importer derived them, and
     * {@code existingEntryIds()} is asked which of them are there. Reading the
     * store rather than the surface is the difference between "the app said it
     * worked" and "the journal has it".
     *
     * <p><b>{@code existingEntryIds()} RETURNS A Set, AND ITS SIZE IS {@code
     * .size}.</b> The predecessor of this method read {@code .length}, which is
     * {@code undefined} on a {@link java.util.Set}; {@code String(undefined)} is
     * the five-character string {@code "undefined"}, which the wait predicate of
     * the day accepted instantly. Run 31950709031 reported "the journal does not
     * hold every imported mark" while its own logcat carries the SELECT and its
     * four-row answer — four ids asked, four returned (DIA-DL-002).
     *
     * <p><b>AND THE ANSWER MUST COME FROM THE DOCUMENT THAT WAS ASKED.</b> The
     * token stamped by {@link #deliver} rides back with the count, so "the journal
     * does not hold the marks" cannot be confused with "the world I asked was not
     * the world that imported" — a distinction this leg had no way to make.
     */
    private void assertImportedMarks(ActivityScenario<MainActivity> scenario, int skills) {
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
                                + " window.__diaMarks = JSON.stringify({"
                                + " doc: window.__diaDoc,"
                                + " marks: String(present.size) }); })"
                                + ".catch(function (e) {"
                                + " window.__diaMarks = 'err:' + (e && e.message); });"
                                + "return 'dispatched';"
                                + "})()")
                        .replace("__BASE__", MountAddress.prefix())
                        .replace("__SKILLS__", String.valueOf(skills))
                        .replace("__CHILD__", fixtureChild());

        assertEquals("the read-back script never ran", "dispatched", evaluate(scenario, script));
        String raw = pollFor(scenario, "window.__diaMarks", TRANSFER_TIMEOUT_MS);
        Log.i(TAG, "read-back for " + fixtureChild() + ": " + raw);
        assertTrue("the read-back did not answer: " + raw, raw.startsWith("{"));

        assertEquals(
                "the read-back was answered by a document other than the one this leg delivered"
                    + " to — the count below is about some other world: " + raw,
                documentToken(),
                jsonString(raw, "doc"));
        assertEquals(
                "the journal does not hold every imported mark: " + raw,
                String.valueOf(skills),
                jsonString(raw, "marks"));
    }

    // --- measurement ------------------------------------------------------

    /** The first payload option key in a recorded call list, or null if clean. */
    private static String payloadKeyIn(String options) {
        for (String key : PAYLOAD_KEYS) {
            if (options.contains("\"" + key + "\"")) {
                return key;
            }
        }
        return null;
    }

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

    /** One leg's body, run against a launched app by {@link #withApp}. */
    @FunctionalInterface
    private interface Leg {
        void run(ActivityScenario<MainActivity> scenario) throws Exception;
    }

    /**
     * Launches the app, runs a leg against it, and ASKS whether it was destroyed.
     *
     * <p>Every leg goes through here so no leg can forget the last part. Not
     * closing the scenario would have made run 31950709031 green and was rejected
     * outright: 25 tests share this process, and a leaked activity silently
     * changes what the ones after it see. So the scenario is closed, and then the
     * lifecycle monitor — the same one whose {@code in: DESTROYED} line is in that
     * run's logcat — is asked what actually became of the activity.
     *
     * <p>The strong reference this holds is what makes the question answerable:
     * the monitor keys on identity through a weak reference, and an activity that
     * has been collected reports as unknown rather than as destroyed. It dies with
     * the test instance.
     */
    private void withApp(Leg leg) throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(
                    target -> {
                        activity.set(target);
                        launchIntent.set(target.getIntent());
                    });
            assertNotNull("the activity never reached the test", activity.get());
            assertNotNull(
                    "the launch Intent was not captured, so deliver() cannot put it back",
                    launchIntent.get());
            leg.run(scenario);
        }
        assertDestroyed(activity.get());
    }

    /** What the lifecycle monitor says became of the activity after close(). */
    private static void assertDestroyed(MainActivity target) {
        AtomicReference<Stage> stage = new AtomicReference<>(null);
        InstrumentationRegistry.getInstrumentation()
                .runOnMainSync(
                        () ->
                                stage.set(
                                        ActivityLifecycleMonitorRegistry.getInstance()
                                                .getLifecycleStageOf(target)));
        Log.i(TAG, "teardown: lifecycle stage after close() = " + stage.get());
        assertEquals(
                "the activity was not destroyed by close(): 25 tests share this process and a"
                    + " leaked activity changes what every one of them after this sees",
                Stage.DESTROYED,
                stage.get());
    }

    /**
     * Whether an evaluated expression has ANSWERED, as opposed to "not yet".
     *
     * <p>The predicate this replaces accepted everything but {@code null},
     * {@code "null"} and {@code "false"} — so the string {@code "undefined"}
     * satisfied it instantly, and two harness faults surfaced as product failures
     * with product-sounding messages (DIA-DL-002). {@code "undefined"} is the
     * value a WebView hands back for a JavaScript {@code undefined} coerced to a
     * string, and it is never an answer.
     *
     * <p>The rule the polled expressions keep in exchange: return {@code null}
     * for "not yet" and the answer otherwise. A leg may not poll a variable it
     * assigned a non-final placeholder to — that is not something a predicate can
     * enforce, and {@link #no_bridge_call_carries_the_payload} reds if it recurs.
     */
    private static boolean answered(String value) {
        if (value == null || value.isEmpty()) {
            return false;
        }
        return !"null".equals(value) && !"undefined".equals(value) && !"false".equals(value);
    }

    /**
     * The wait predicate as it stood before P1R, kept ONLY as the arm's control.
     *
     * <p>Nothing polls through it. It exists so
     * {@link #the_harness_arms_prove_themselves} can show it green on the exact
     * values that made two legs report a product defect that was not there.
     */
    private static boolean legacyAnswered(String value) {
        return value != null && !"null".equals(value) && !"false".equals(value);
    }

    private String pollFor(ActivityScenario<MainActivity> scenario, String expression, long budget) {
        return pollFor(scenario, expression, budget, expression);
    }

    /**
     * The same wait, saying in product terms what it was waiting for.
     *
     * <p>{@code what} is what the READER needs on a timeout, and the expression
     * is what the author needs; the first is the one a 120 s expiry has to lead
     * with. Call sites that have nothing better to say than the expression pass
     * the expression, through the three-argument form above.
     */
    private String pollFor(
            ActivityScenario<MainActivity> scenario, String expression, long budget, String what) {
        long deadline = System.currentTimeMillis() + budget;
        while (System.currentTimeMillis() < deadline) {
            String value = evaluate(scenario, expression);
            if (answered(value)) {
                return value;
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                fail("interrupted while waiting for " + what);
            }
        }
        fail("timed out after " + budget + " ms waiting for " + what);
        return null;
    }

    private String evaluate(ActivityScenario<MainActivity> scenario, String expression) {
        AtomicReference<String> result = new AtomicReference<>(null);
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(
                target -> {
                    WebView webView = target.getBridge().getWebView();
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
