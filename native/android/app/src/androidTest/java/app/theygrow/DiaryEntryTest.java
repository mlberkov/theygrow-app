package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.util.Log;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The diary write path on a real device, and the refusal a full disk produces
 * (DIA-P3).
 *
 * <p>WHY THIS IS THE ONLY OBSERVER OF ITS CLAIMS. Everything else about this
 * packet can be checked on a laptop: {@code app/tests/schema/
 * test_diary_write_path.py} runs the shipped statements against the real frozen
 * DDL, {@code app/tests/diary-write.spec.js} drives the shipped modules against
 * a recorder, and {@code app/tests/diary-surface.spec.js} loads the page and
 * reads what a parent sees. None of them can say that a parent's entry LANDS —
 * that needs the plugin, SQLCipher and the app together — and none of them can
 * reach the disk-full refusal at all, because reaching it needs a store that
 * opens.
 *
 * <p>HOW A FULL DISK IS PRODUCED WITHOUT FILLING THE EMULATOR. {@code PRAGMA
 * max_page_count} is lowered to the database's CURRENT size, after which SQLite
 * raises SQLITE_FULL for any write needing a new page — a genuine engine-level
 * refusal, the same one and the same message a full partition produces, from the
 * real SQLCipher build the app ships. It is per-connection and not persisted, so
 * releasing it restores the store.
 *
 * <p>THE ARMING PROVES ITSELF, TWICE OVER. Clamping the page count alone is not
 * enough to guarantee the next small write fails: a partially filled leaf page
 * may still have room, and a leg that passed only because the row happened not
 * to fit would be luck reported as evidence. So the ceiling is REACHED first —
 * filler rows are written until one is refused — and the refusal of that filler
 * is what says the store is genuinely full before the act under test is
 * performed. Then, after each disk-full leg, the ceiling is released and THE
 * SAME ACT IS REPEATED AND MUST SUCCEED. Without that control, a leg would go
 * green against a surface that refused everything for any reason at all.
 *
 * <p>AND IT MUST PROVE ITSELF FOR EACH SHAPE SEPARATELY, which run 31971968427
 * is why this now says so. "Full" is not a property of the database, it is a
 * property of the next write: the filler exhausts what {@code record}'s pages
 * will take, and the tick writes four small rows into {@code journal_entry} /
 * {@code assertion} / {@code confirmation}, which fitted in THOSE tables' own
 * partially-filled leaves and landed —
 * {@code {"changes":{"changes":4,"lastId":1,"values":[]}}} at 21:00:24.770, on a
 * store the arming had just called full. The mark leg was therefore never about
 * a full disk at all. So the arming now reaches the ceiling with BOTH shapes,
 * record and journal, and returns both refusals rather than assuming the second
 * from the first. It also refuses to call anything but a {@code
 * StoreDiskFullError} "full": a constraint violation reported as fullness would
 * arm nothing and say it had.
 *
 * <p>A SECOND FAULT IN THAT SAME LEG, of a different kind: the tick's wait
 * returned 200 ms BEFORE the bridge answered, because it polled {@code
 * box.checked}, which {@code box.click()} sets synchronously. It read the
 * pre-decision document and reported it as the app's verdict, down to {@code
 * unavailable=visible} — which is only the resting state of a paragraph that
 * ships without {@code hidden} ({@code app/index.html}). A wait must key on
 * something the app SETS when it has decided; see {@code tickFirstSkill}.
 *
 * <p>AND THE RELEASE MUST NOT DEPEND ON THE ASSERTIONS PASSING. In that run the
 * mark leg failed before reaching its release, and the diary leg that followed
 * armed against a store that was still clamped: {@code arming:
 * state=full;rows=0}. Zero filler rows written, because the first one was
 * already refused — an arming that "succeeded" without arming anything. Both
 * disk-full legs now release in a {@code finally}.
 *
 * <p>DIA-P4 ADDS ONE LEG, and it is here rather than in a file of its own because
 * it is the same subject: what the store does with a parent's own text, observed
 * through the surface they touch. It searches, it destroys the derived index
 * underneath them and searches again, and it TIMES both — a repair that happens
 * inside a search is time a parent waits, and "the index is rebuildable" is not
 * a claim worth making without the number attached.
 *
 * <p>WHAT THIS TEST DOES NOT REACH, so no green here is read as more than it is.
 * The emulator is not the family's phone: it is a fresh API-34 image, and a
 * device whose storage is actually exhausted also fails in ways SQLite never
 * sees — the WebView failing to load, the OS killing the process. Nothing here
 * exercises that. What it does establish is that when the ENGINE says the disk
 * is full, the app tells the parent so and keeps what they wrote.
 */
@RunWith(AndroidJUnit4.class)
public class DiaryEntryTest {

    private static final String TAG = "DIA";

    private static final long POLL_MS = 400;
    private static final long EVALUATE_TIMEOUT_MS = 30_000;
    private static final long ACT_TIMEOUT_MS = 120_000;

    /** A DOM fact the app's OWN modules produce — same sentinel as the siblings. */
    private static final String BOOTED =
            "document.querySelectorAll('#tableBody tr[data-skill-id]').length > 0";

    /**
     * The entry the acts write, and therefore the SIZE the arming has to reach.
     *
     * <p>One constant because it was typed in two legs and a third has to arm
     * for it. The text is incidental; the LENGTH is load-bearing (DIA-DL-009).
     * Twenty-six characters fit in slack that a two-hundred-character filler
     * could not use, so a fixture that stopped at the longer row called the
     * store full and then watched this one land on it.
     */
    private static final String AN_ENTRY = "Впервые сам встал у дивана";

    /**
     * A fixture belongs to ONE leg (DIA-DL-002). The store outlives every
     * ActivityScenario in this process, so a child id shared between legs would
     * let one leg read another leg's entries and call them its own.
     */
    private static String child(String leg) {
        return "dia-p3-" + leg + "-child";
    }

    // --- the acts a parent performs -----------------------------------------

    @Test
    public void an_entry_a_parent_writes_lands_in_the_store() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            String leg = "write";
            seedChild(scenario, leg);

            assertEquals(
                    "the diary was not offered on the native channel",
                    "pressed",
                    openCompose(scenario));

            // A parent writing in the evening about the morning: the day is
            // chosen, the moment of writing is the app's business.
            String verdict = fillAndSave(scenario, "2026-02-01", AN_ENTRY);
            assertEquals("the surface did not report a saved entry: " + verdict, "listed", verdict);

            // THE ENTRY LANDED, asked of the STORE rather than of the surface —
            // through the shipped module, out of the mount the APK carries, and
            // from the same document that wrote it.
            String read = readBack(scenario, leg);
            Log.i(TAG, "read-back after write: " + read);
            assertEquals("the store does not hold exactly one entry: " + read, "1", field(read, "count"));
            assertEquals("the entry was stored with different text: " + read, "match", field(read, "body"));
            assertEquals("the day the entry is about was not kept: " + read, "2026-02-01", field(read, "eventDate"));
            // Slot 11, on the device: the instant of the EVENT is unknown and
            // says so, while the instant of WRITING is real. BOTH HALVES of the
            // pair are asked for, because the schema's CHECK is what makes
            // "unknown" expressible only when the two agree — an offset left
            // behind by a NULL instant would be a half-declared moment, and
            // RECORD_INSERT_SQL writes them together precisely so it cannot be.
            assertEquals("the event instant was invented: " + read, "null", field(read, "eventAt"));
            assertEquals(
                    "the event instant is NULL but its offset is not, which the paired CHECK"
                            + " exists to prevent: " + read,
                    "null",
                    field(read, "eventOffset"));
            assertEquals("the entry time was not recorded: " + read, "set", field(read, "entryAt"));
            // Slot 12: nobody was asked about sensitivity, so nothing is declared.
            assertEquals("a sensitivity nobody declared was written: " + read, "null", field(read, "sensitivity"));
        }
    }

    @Test
    public void an_edit_overwrites_the_entry_and_appends_nothing() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            String leg = "edit";
            seedChild(scenario, leg);

            assertEquals("the diary was not offered", "pressed", openCompose(scenario));
            assertEquals("listed", fillAndSave(scenario, "2026-02-01", "Встал у дивана"));

            String before = readBack(scenario, leg);
            String journalBefore = journalCount(scenario);

            assertEquals(
                    "the entry offered no way to correct it", "pressed", pressEdit(scenario));
            String verdict = fillAndSave(scenario, "2026-01-31", "Не у дивана, а у стула");
            assertEquals("the edit did not return to the list: " + verdict, "listed", verdict);

            String after = readBack(scenario, leg);
            Log.i(TAG, "read-back after edit: " + after);

            // PDR-026 §4 rule 1, on the real engine: the row is replaced in
            // place. One record before and one after, with the SAME id — a
            // second row would mean the edit had appended a new entry, which is
            // what the mark journal does and what a diary must not.
            assertEquals("the edit created a second entry: " + after, "1", field(after, "count"));
            assertEquals(
                    "the edit wrote a different row rather than overwriting this one",
                    field(before, "id"),
                    field(after, "id"));
            assertEquals("the corrected text was not stored: " + after, "match", field(after, "body"));
            assertEquals("the corrected day was not stored: " + after, "2026-01-31", field(after, "eventDate"));
            // The entry time is when the text was FIRST written; only
            // updated_at_utc moves.
            assertEquals(
                    "the edit rewrote the entry time",
                    field(before, "entryAtValue"),
                    field(after, "entryAtValue"));
            assertNotEquals(
                    "the edit did not record when it happened",
                    field(after, "entryAtValue"),
                    field(after, "updatedAtValue"));

            // AND THE APPEND-ONLY JOURNAL IS UNTOUCHED BY IT. Editing a diary
            // entry is not an assertion about a child and appends nothing.
            assertEquals(
                    "editing a diary entry wrote to the mark journal",
                    journalBefore,
                    journalCount(scenario));
        }
    }

    // --- search, and the index repairing itself under the parent (DIA-P4) ----

    /**
     * A parent searches their own diary, and a destroyed index costs them nothing.
     *
     * <p>THREE CLAIMS, IN THE ORDER THEY HAVE TO BE MADE.
     *
     * <p>1. A FORM THEY DID NOT WRITE STILL FINDS THE ENTRY. `села` reaches «сел
     * сам» — the whole point of a query-side word-form strategy, and the thing
     * that decides whether search is usable in Russian at all.
     *
     * <p>2. THE SELF-HEAL IS OBSERVED AS REACHING THE PARENT. The index is
     * emptied through the shipped seam, and then the parent presses the same
     * search control and IS SHOWN THEIR ENTRY. What is asserted is what appears
     * on their screen — not that a rebuild statement was issued, which would be
     * asserting our own mechanism back to ourselves. And it is timed, because
     * whatever the repair costs is time they spend looking at a screen that has
     * not answered yet.
     *
     * <p>3. A FORM NO PREFIX CAN REACH IS SAID HONESTLY, and said as the RIGHT
     * ONE of two sentences. `сесть` cannot reach `сел` — the stem moved — so the
     * parent gets the word-forms explanation. If they got the store-refusal line
     * instead, the app would be blaming itself for a working search; if they got
     * the word-forms line on a real refusal, it would be telling them they never
     * wrote something they did write. Both elements are asserted, each way round.
     *
     * <p>ORDER IS LOAD-BEARING HERE. The repair fires at most once per app
     * session, so the miss is searched LAST: an empty result earlier would spend
     * the one repair this document gets, and claim 2 would then be observing a
     * rebuild that had already happened.
     */
    @Test
    public void a_parent_searches_the_diary_and_a_lost_index_is_repaired_under_them() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            String leg = "search";
            seedChild(scenario, leg);

            assertEquals("the diary was not offered", "pressed", openCompose(scenario));
            assertEquals("listed", fillAndSave(scenario, "2026-02-01", "Сегодня сел сам и держался"));
            assertEquals(
                    "a second entry could not be composed", "pressed", openCompose(scenario));
            assertEquals("listed", fillAndSave(scenario, "2026-02-02", "Ёлка растёт быстро"));

            // 1. The form the parent did not write, and it narrows rather than
            //    returning the diary: one entry of the two.
            String hit = searchFromTheSurface(scenario, "села");
            Log.i(TAG, "search hit: " + hit);
            assertEquals("`села` did not reach «сел сам»: " + hit, "1", field(hit, "found"));
            assertEquals("the search reported nothing found: " + hit, "false", field(hit, "empty"));
            assertEquals("the search did not run: " + hit, "false", field(hit, "failed"));

            // 2. The index is destroyed underneath them — FTS5's own delete-all,
            //    through the shipped seam, so the loss is real rather than
            //    simulated — and the next search must still answer.
            destroyIndex(scenario);
            String healed = searchFromTheSurface(scenario, "села");
            Log.i(TAG, "search after the index was destroyed: " + healed);
            assertEquals(
                    "a destroyed index cost the parent their entry — the repair did not reach"
                            + " them: " + healed,
                    "1",
                    field(healed, "found"));
            assertEquals("the parent was told nothing matched: " + healed, "false", field(healed, "empty"));
            assertEquals("false", field(healed, "failed"));

            // The control, and the reason it is here: without a second search on
            // a whole index, the number above is a repair time with no baseline
            // to read it against.
            String again = searchFromTheSurface(scenario, "села");
            Log.i(TAG, "search on a whole index: " + again);
            assertEquals("1", field(again, "found"));
            Log.i(
                    TAG,
                    "search wait as the parent experiences it: repairing=" + field(healed, "ms")
                            + " ms, ordinary=" + field(again, "ms")
                            + " ms (two short entries on an emulator — a real diary is a"
                            + " different measurement and this does not predict it)");

            // 3. The form no prefix can reach, and the RIGHT sentence for it.
            String miss = searchFromTheSurface(scenario, "сесть");
            Log.i(TAG, "search miss: " + miss);
            assertEquals("`сесть` reached `сел`, which no prefix can do: " + miss, "0", field(miss, "found"));
            assertEquals("nothing matched, and the surface did not say so: " + miss, "true", field(miss, "empty"));
            assertEquals(
                    "a working search was reported to the parent as a broken store: " + miss,
                    "false",
                    field(miss, "failed"));
            assertEquals(
                    "the parent was told nothing matched without being told why, or what to try"
                            + " instead (ADR-015): " + miss,
                    "wordforms",
                    field(miss, "said"));
        }
    }

    // --- the refusal a full disk produces ------------------------------------

    @Test
    public void a_full_disk_refuses_the_entry_and_keeps_the_text() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            String leg = "diskdiary";
            seedChild(scenario, leg);

            String armed = fillToCeiling(scenario, AN_ENTRY);
            Log.i(TAG, "arming: " + armed);
            try {
                assertEquals(
                        "the store never reached its ceiling, so nothing below is about a full"
                                + " disk: " + armed,
                        "full",
                        field(armed, "state"));
                // THIS leg's act is a record write OF A PARTICULAR SIZE, so the
                // refusal that arms it is the refusal of a record that size.
                //
                // `refusal` — the 200-character filler's — is still in the
                // arming line and is deliberately NOT asserted here. It licensed
                // this leg until DIA-DL-009, and it licensed nothing: on run
                // 32012897363 it was reported at 09:03:45.287, and at
                // 09:03:45.345 the app logged `diary.write outcome=complete
                // ... chars=26` on that same store. Keeping it in the line is
                // what let that run be compared with 31982061125, whose arming
                // string was byte-identical and whose leg went green.
                // The journal-shaped refusal is asserted by the mark leg, whose
                // act writes journal rows.
                assertEquals(
                        "the store still accepts a record the size of the entry below, so that"
                                + " entry is not being written to a full disk: " + armed,
                        "full:StoreDiskFullError",
                        field(armed, "actRefusal"));

                assertEquals("the diary was not offered", "pressed", openCompose(scenario));
                String verdict = fillAndSave(scenario, "2026-02-01", AN_ENTRY);

                Log.i(TAG, "refusal verdict: " + verdict);
                assertEquals(
                        "the parent was not told the disk is full: " + verdict,
                        "refused-disk-full",
                        verdict);

                String state = surfaceState(scenario);
                Log.i(TAG, "surface after refusal: " + state);
                assertEquals("the text the parent typed was lost: " + state, "kept", field(state, "text"));
                assertEquals("the day they chose was lost: " + state, "kept", field(state, "date"));
                assertEquals("the window closed under a refusal: " + state, "open", field(state, "modal"));
                assertEquals("the form was taken away: " + state, "visible", field(state, "form"));
                assertEquals("the parent cannot try again: " + state, "enabled", field(state, "save"));

                assertEquals(
                        "a refused entry was written anyway",
                        "0",
                        field(readBack(scenario, leg), "count"));

                // THE CONTROL. Release the ceiling and press the same button
                // again: it must save. Without this, a surface that refused
                // everything would pass the assertions above.
                releaseCeiling(scenario);
                assertEquals(
                        "the same press failed with the ceiling released, so the refusal above was"
                                + " not about a full disk",
                        "listed",
                        pressSave(scenario));
                assertEquals("1", field(readBack(scenario, leg), "count"));
            } finally {
                releaseQuietly(scenario);
            }
        }
    }

    @Test
    public void a_full_disk_withdraws_the_tick_and_says_why() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            seedChild(scenario, "diskmark");

            // This leg's act is journal-shaped, so what arms it is
            // `journalRefusal` and the act-sized record stage is not its
            // precondition. It is passed the same entry anyway, so that ONE
            // arming serves both legs and the record stages mean the same thing
            // in each — a fixture that filled to a different depth depending on
            // its caller would make the two legs' arming lines incomparable,
            // and comparing arming lines is what found DIA-DL-009.
            String armed = fillToCeiling(scenario, AN_ENTRY);
            Log.i(TAG, "arming: " + armed);
            try {
                assertEquals(
                        "the store never reached its ceiling: " + armed, "full", field(armed, "state"));
                // THE ASSERTION THIS LEG WAS MISSING, and its absence is why it
                // red on an artefact rather than on a defect. The act below
                // writes JOURNAL rows; a ceiling that only refuses `record`
                // writes leaves that act free to succeed, which is exactly what
                // run 31971968427 recorded. So the refusal that arms this leg is
                // the journal-shaped one.
                assertEquals(
                        "the store still accepts journal writes, so the tick below is not being"
                                + " performed on a full disk: " + armed,
                        "full:StoreDiskFullError",
                        field(armed, "journalRefusal"));

                String verdict = tickFirstSkill(scenario);
                Log.i(TAG, "tick verdict: " + verdict);

                // THE TICK IS WITHDRAWN, AND THE REASON IS THE RIGHT ONE. A
                // checkbox that stayed checked would assert a mark the store
                // never took; a message about the store not opening would send
                // the parent to restart the app, which does not free space.
                assertEquals("the tick was not withdrawn: " + verdict, "unchecked", field(verdict, "checkbox"));
                assertEquals("the parent was not told: " + verdict, "show", field(verdict, "modal"));
                assertEquals("the full disk was reported as a broken store: " + verdict, "visible", field(verdict, "diskFull"));
                assertEquals("both explanations were shown at once: " + verdict, "hidden", field(verdict, "unavailable"));

                // The control, as above: with the ceiling released the same tick
                // sticks.
                releaseCeiling(scenario);
                String again = tickFirstSkill(scenario);
                Log.i(TAG, "tick after release: " + again);
                assertEquals(
                        "the tick failed with the ceiling released, so the refusal above was not"
                                + " about a full disk: " + again,
                        "checked",
                        field(again, "checkbox"));
            } finally {
                releaseQuietly(scenario);
            }
        }
    }

    // --- the acts, as scripts ------------------------------------------------

    /**
     * Creates this leg's child through the SHIPPED path and selects it.
     *
     * <p>Not an INSERT of its own: {@code appendChild} is what the app uses, and
     * a fixture that wrote the row itself would be testing a child the product
     * never creates.
     */
    private void seedChild(ActivityScenario<MainActivity> scenario, String leg) {
        String done =
                await(
                        scenario,
                        "__diaSeed",
                        ("Promise.all([import(u('store/boot.js')), import(u('core/state.js'))])"
                                + ".then(function (mods) {"
                                + "var boot = mods[0], state = mods[1];"
                                + "var handle = boot.storeHandle();"
                                + "if (!handle) { throw new Error('the store is not open'); }"
                                + "window.__diaAuthor = handle.selfParticipantId;"
                                + "window.__diaChild = '__CHILD__';"
                                + "return boot.appendChild({"
                                + " authorParticipantId: handle.selfParticipantId,"
                                + " childId: '__CHILD__', name: 'Проба', birthdate: '2025-01-01' })"
                                + ".then(function () { return state.reloadHistory(); })"
                                + ".then(function () { return state.setCurrentProfile('__CHILD__'); })"
                                + ".then(function () { return 'seeded'; }); })")
                                .replace("__CHILD__", child(leg)));
        assertEquals("the fixture child was not created: " + done, "seeded", done);
    }

    /**
     * Opens the diary and switches to the compose form, as a parent does.
     *
     * <p>Two steps with a wait between them, and the wait is load-bearing:
     * openDiaryModal() renders the list ASYNCHRONOUSLY, and that render is what
     * decides whether the compose control is offered at all. Pressing it in the
     * same turn as the open would sometimes press a button the app had not yet
     * finished deciding about — green by timing rather than by behaviour.
     */
    private String openCompose(ActivityScenario<MainActivity> scenario) {
        String opened =
                evaluate(
                        scenario,
                        "(function () {"
                            + "var open = document.getElementById('diaryBtn');"
                            + "if (!open || open.hidden) { return 'not-offered'; }"
                            + "open.click();"
                            + "return 'pressed';"
                            + "})()");
        if (!"pressed".equals(opened)) {
            return opened;
        }
        pollFor(
                scenario,
                "(function () {"
                    + "var modal = document.getElementById('diaryModal');"
                    + "var add = document.getElementById('diaryNewBtn');"
                    + "return modal.classList.contains('show') && !add.hidden;"
                    + "})()",
                ACT_TIMEOUT_MS);
        return evaluate(
                scenario,
                "(function () {"
                    + "document.getElementById('diaryNewBtn').click();"
                    + "return document.getElementById('diaryForm').hidden ? 'form-hidden' : 'pressed';"
                    + "})()");
    }

    /** Presses the edit control on the first entry in the list. */
    private String pressEdit(ActivityScenario<MainActivity> scenario) {
        return evaluate(
                scenario,
                "(function () {"
                    + "var edit = document.querySelector('#diaryList .diary-entry-edit');"
                    + "if (!edit) { return 'no-entry'; }"
                    + "edit.click();"
                    + "return document.getElementById('diaryForm').hidden ? 'form-hidden' : 'pressed';"
                    + "})()");
    }

    /**
     * Types an entry and presses save.
     *
     * <p>THE VERDICT IS REDUCED TO AN ASCII TOKEN IN JAVASCRIPT, not compared in
     * Java: {@code evaluateJavascript} hands back a JSON string, and whether a
     * Cyrillic character crosses that boundary raw or escaped is Chromium's
     * business, not this assertion's (the rule ExportTransferTest records).
     */
    private String fillAndSave(
            ActivityScenario<MainActivity> scenario, String eventDate, String body) {
        String typed =
                evaluate(
                        scenario,
                        ("(function () {"
                                + "var day = document.getElementById('diaryEventDate');"
                                + "var text = document.getElementById('diaryBody');"
                                + "if (!day || !text || document.getElementById('diaryForm').hidden) {"
                                + " return 'no-form'; }"
                                + "day.value = '__DATE__';"
                                + "text.value = '__BODY__';"
                                + "window.__diaWritten = text.value;"
                                + "window.__diaDay = day.value;"
                                + "return 'typed';"
                                + "})()")
                                .replace("__DATE__", eventDate)
                                .replace("__BODY__", body));
        assertEquals("the compose form was not there to type into", "typed", typed);
        return pressSave(scenario);
    }

    /** Presses save and reads what the surface says, as a parent would. */
    private String pressSave(ActivityScenario<MainActivity> scenario) {
        String dispatched =
                evaluate(
                        scenario,
                        "(function () {"
                            + "var save = document.getElementById('diarySaveBtn');"
                            + "if (!save || save.disabled) { return 'not-offered'; }"
                            + "save.click();"
                            + "return 'pressed';"
                            + "})()");
        assertEquals("the save control was not offered", "pressed", dispatched);

        // Polled through the surface the parent is looking at: the list is the
        // confirmation, and #diaryStatus is where a refusal is said.
        return pollFor(
                scenario,
                "(function () {"
                    + "var form = document.getElementById('diaryForm');"
                    + "var status = document.getElementById('diaryStatus');"
                    + "if (form.hidden) {"
                    + " return document.querySelectorAll('#diaryList .diary-entry').length > 0"
                    + " ? 'listed' : 'listed-empty'; }"
                    + "var said = status.hidden ? '' : status.textContent;"
                    + "if (!said || said.indexOf('Сохраняю') !== -1) { return null; }"
                    + "if (said.indexOf('закончилось место') !== -1) { return 'refused-disk-full'; }"
                    + "return 'refused-other';"
                    + "})()",
                ACT_TIMEOUT_MS);
    }

    /**
     * Types a query, presses the search control, and reports what the parent got.
     *
     * <p>THE WAIT IS MEASURED IN THE PAGE, not by the Java poller. {@code pollFor}
     * ticks every 400 ms, which would quantise a repair that takes twenty into
     * "four hundred" — and the number this returns is meant to be read as what a
     * parent sat through, so it has to be finer than the instrument.
     *
     * <p>It settles on whichever of the three outcomes the surface produces —
     * entries listed, «ничего не нашлось», or a refusal — so a leg can assert
     * that the RIGHT one happened rather than waiting for the one it expects and
     * timing out on the others. {@code said} reduces the empty sentence to a
     * token in JavaScript rather than comparing Cyrillic across the
     * {@code evaluateJavascript} boundary, which is the rule ExportTransferTest
     * records.
     */
    private String searchFromTheSurface(ActivityScenario<MainActivity> scenario, String typed) {
        return await(
                scenario,
                "__diaSearch",
                ("(new Promise(function (resolve) {"
                                + "var box = document.getElementById('diarySearchInput');"
                                + "var go = document.getElementById('diarySearchBtn');"
                                + "if (!box || !go || document.getElementById('diarySearchForm').hidden) {"
                                + " resolve('found=-1;empty=false;failed=false;said=no-form;ms=0');"
                                + " return; }"
                                + "var started = Date.now();"
                                + "box.value = '__TERM__';"
                                + "go.click();"
                                // THE WAIT KEYS ON SOMETHING THE APP SETS WHEN IT
                                // HAS DECIDED, which is the rule the mark leg's
                                // wait was repaired to obey (DIA-DL-006). A
                                // predicate over the LIST would settle before
                                // the search ran at all: the list already holds
                                // the entries the parent wrote, so `an entry is
                                // present` is true of the document before the
                                // press. The search control disables itself
                                // synchronously on submit and re-enables in a
                                // `finally`, so its being enabled again is the
                                // surface saying it is finished.
                                + "var tick = function () {"
                                + " if (go.disabled) { setTimeout(tick, 20); return; }"
                                + " var found = document.querySelectorAll('#diaryList .diary-entry').length;"
                                + " var none = document.getElementById('diarySearchEmpty');"
                                + " var failed = document.getElementById('diarySearchStatus');"
                                + " var said = 'listed';"
                                + " if (!none.hidden) {"
                                + "  said = none.textContent.indexOf('словоформ') !== -1"
                                + "   ? 'wordforms' : 'other'; }"
                                + " if (!failed.hidden) { said = 'refused'; }"
                                + " resolve(['found=' + found, 'empty=' + !none.hidden,"
                                + "  'failed=' + !failed.hidden, 'said=' + said,"
                                + "  'ms=' + (Date.now() - started)].join(';'));"
                                + "};"
                                + "setTimeout(tick, 20);"
                                + "}))")
                        .replace("__TERM__", typed));
    }

    /**
     * Empties the derived index, through the seam the app itself writes with.
     *
     * <p>{@code delete-all} is FTS5's own command for an external-content index,
     * so what follows is a genuinely lost index rather than a simulated one — the
     * same distinction {@code fillToCeiling} draws about a full disk. Nothing the
     * family wrote is touched: {@code record} is the source, and the index is
     * derived from it (PDR-026 §4 rule 3).
     */
    private void destroyIndex(ActivityScenario<MainActivity> scenario) {
        String done =
                await(
                        scenario,
                        "__diaWipe",
                        "import(u('store/bridge.js')).then(function (bridge) {"
                            + "return bridge.run('INSERT INTO record_fts (record_fts) VALUES (?)',"
                            + " ['delete-all'], { transaction: false })"
                            + ".then(function () { return 'wiped'; }); })");
        assertEquals("the derived index was not emptied", "wiped", done);
    }

    /** What the parent is left holding after a refusal. */
    private String surfaceState(ActivityScenario<MainActivity> scenario) {
        return evaluate(
                scenario,
                "(function () {"
                    + "var text = document.getElementById('diaryBody');"
                    + "var day = document.getElementById('diaryEventDate');"
                    + "var modal = document.getElementById('diaryModal');"
                    + "var form = document.getElementById('diaryForm');"
                    + "var save = document.getElementById('diarySaveBtn');"
                    + "return ['text=' + (text.value === window.__diaWritten ? 'kept' : 'lost'),"
                    + " 'date=' + (day.value === window.__diaDay ? 'kept' : 'lost'),"
                    + " 'modal=' + (modal.classList.contains('show') ? 'open' : 'closed'),"
                    + " 'form=' + (form.hidden ? 'hidden' : 'visible'),"
                    + " 'save=' + (save.disabled ? 'disabled' : 'enabled')].join(';');"
                    + "})()");
    }

    /**
     * Ticks a skill that is not ticked, and reports what the app did about it.
     *
     * <p>An UNCHECKED box is selected rather than the first one, and any open
     * refusal window is dismissed first: both are what let this be called twice
     * in one leg — once armed, once released — without the second call reading
     * the first call's leftovers and reporting them as its own result.
     */
    private String tickFirstSkill(ActivityScenario<MainActivity> scenario) {
        String dispatched =
                evaluate(
                        scenario,
                        "(function () {"
                            + "var diary = document.getElementById('diaryModalClose');"
                            + "if (diary) { diary.click(); }"
                            + "var dismiss = document.getElementById('storeUnavailableCloseBtn');"
                            + "if (dismiss) { dismiss.click(); }"
                            + "var box = document.querySelector("
                            + " '#tableBody tr[data-skill-id] input[type=\"checkbox\"]:not(:checked)');"
                            + "if (!box) { return 'no-unticked-skill'; }"
                            + "window.__diaBox = box;"
                            + "box.click();"
                            + "return 'clicked';"
                            + "})()");
        assertEquals("no unticked skill row was there to tick", "clicked", dispatched);

        // WAITING FOR SOMETHING THE APP SETS, NOT FOR SOMETHING THE CLICK SET.
        //
        // The old predicate returned as soon as `box.checked` was true — which
        // `box.click()` makes true synchronously, before the write is even
        // dispatched. It therefore never waited at all: run 31971968427 logged
        // the verdict at 21:00:24.570, four milliseconds after the executeSet
        // left for native and two hundred before it came back. What it reported
        // was the document mid-act, including `unavailable=visible`, which is
        // just the resting state of a paragraph that ships without `hidden`.
        //
        // Both of the app's outcomes are written by the app AFTER the write
        // resolved (surfaces/skill-completion.js): a refusal un-ticks the box and
        // shows the window, a success adds `skill-completed` to the row. Either
        // one means it has decided; neither is true before it has.
        return pollFor(
                scenario,
                "(function () {"
                    + "var box = window.__diaBox;"
                    + "var row = box.closest('tr[data-skill-id]');"
                    + "var modal = document.getElementById('storeUnavailableModal');"
                    + "var shown = modal.classList.contains('show');"
                    + "var kept = !!row && row.classList.contains('skill-completed');"
                    + "if (!shown && !kept) { return null; }"
                    + "var diskFull = document.getElementById('storeDiskFullNote');"
                    + "var unavailable = document.getElementById('storeUnavailableNote');"
                    + "return ['checkbox=' + (box.checked ? 'checked' : 'unchecked'),"
                    + " 'modal=' + (shown ? 'show' : 'hidden'),"
                    + " 'diskFull=' + (diskFull.hidden ? 'hidden' : 'visible'),"
                    + " 'unavailable=' + (unavailable.hidden ? 'hidden' : 'visible')].join(';');"
                    + "})()",
                ACT_TIMEOUT_MS);
    }

    // --- reading the store, and arming it ------------------------------------

    /**
     * This leg's entries, read through the SHIPPED module out of the APK's mount.
     *
     * <p>AND A SECOND STATEMENT, FOR THE COLUMNS THE LIST QUERY DOES NOT RETURN.
     * {@code RECORDS_SQL} selects seven columns and the event pair is not among
     * them — the diary surface has no use for it — so until DIA-P3R2 this method
     * read {@code row.event_at_utc} off a row that never carried it, got
     * {@code undefined}, and reported {@code eventAt=set}. Run 31979084821 red
     * on that as {@code expected:<null> but was:<set>}: an assertion about slot
     * 11 that had never once observed slot 11, accusing a product that was
     * right. The event pair is therefore asked for by name here, through the
     * same bridge {@code journalCount} uses, rather than by widening a product
     * query to serve a test.
     *
     * <p>AND A COLUMN THAT WAS NEVER SELECTED NOW SAYS SO. {@code absent} is a
     * third answer, distinct from {@code null} and from {@code set}, so the next
     * assertion written against a column no query returned reds naming this
     * fixture instead of accusing the write path. That is the class the run
     * caught, not just the instance.
     */
    private String readBack(ActivityScenario<MainActivity> scenario, String leg) {
        return await(
                scenario,
                "__diaRead",
                ("Promise.all([import(u('store/boot.js')), import(u('store/bridge.js'))])"
                        + ".then(function (mods) {"
                        + "var boot = mods[0], bridge = mods[1];"
                        + "return boot.loadRecords({ authorParticipantId: window.__diaAuthor,"
                        + " subjectChildId: '__CHILD__' })"
                        + ".then(function (rows) {"
                        + "if (!rows.length) { return 'count=0'; }"
                        + "var row = rows[0];"
                        + "return bridge.query('SELECT event_at_utc, event_utc_offset_min"
                        + " FROM record WHERE id = ?', [row.id])"
                        + ".then(function (probe) {"
                        + "var pair = probe[0] || {};"
                        + "var slot = function (name) {"
                        + " if (!(name in pair)) { return 'absent'; }"
                        + " return pair[name] === null ? 'null' : 'set'; };"
                        + "return ['count=' + rows.length,"
                        + " 'id=' + row.id,"
                        + " 'body=' + (row.body === window.__diaWritten ? 'match' : 'differs'),"
                        + " 'eventDate=' + row.event_date_local,"
                        + " 'eventAt=' + slot('event_at_utc'),"
                        + " 'eventOffset=' + slot('event_utc_offset_min'),"
                        + " 'entryAt=' + (row.entry_at_utc > 0 ? 'set' : 'missing'),"
                        + " 'entryAtValue=' + row.entry_at_utc,"
                        + " 'updatedAtValue=' + row.updated_at_utc,"
                        + " 'sensitivity=' + (row.sensitivity === null ? 'null' : row.sensitivity)"
                        + "].join(';'); }); }); })")
                        .replace("__CHILD__", child(leg)));
    }

    /** How many rows the append-only journal holds right now. */
    private String journalCount(ActivityScenario<MainActivity> scenario) {
        return await(
                scenario,
                "__diaJournal",
                "import(u('store/bridge.js')).then(function (bridge) {"
                    + "return bridge.query('SELECT count(*) AS n FROM journal_entry', []); })"
                    + ".then(function (rows) { return String(rows[0].n); })");
    }

    /**
     * Lowers the page ceiling to the current size and then REACHES it, in both
     * of the shapes the acts under test write AND at the size they write.
     *
     * <p>The clamp alone is not a full disk: SQLite refuses to set a maximum
     * below the current page count, and a small row may still fit in a
     * partially-filled page. So filler rows are written until one is refused —
     * first in large pieces, then in small ones, and last in rows the size of
     * the act itself, because what a refusal establishes is bounded by the row
     * that was refused and reaches nothing narrower. The refusal of the last
     * filler is the evidence that the store is full, and it is returned rather
     * than assumed.
     *
     * <p>AND THE LAST FILLER MUST BE THE SIZE OF THE ACT, which run 32012897363
     * is why this now says so. A REFUSAL PROVES THE STORE FULL FOR THE WRITE
     * THAT WAS PERFORMED AND FOR NOTHING ELSE. {@code max_page_count} bounds the
     * pages of the FILE, not its occupancy, and a statement that is refused
     * leaves the file no larger than it found it — so the slack in
     * partially-filled leaves is still there afterwards for a shorter row. The
     * small stage's filler is 199 characters against the act's 26 — the stages
     * are named by the argument to {@code new Array(n)}, which joins to n-1
     * characters, and the one-off does not move the argument — so its refusal
     * said nothing whatever about the act: the
     * arming reported itself full at 09:03:45.287, and fifty-eight milliseconds
     * later the app's own signal recorded the entry landing on that same store
     * — {@code [signal] diary.write outcome=complete failure_class=none
     * chars=26 write_ms=44}, at 09:03:45.345. (This fixture's own {@code
     * refusal verdict: listed} follows at .716; that line is the harness
     * speaking, not the store.)
     *
     * <p>{@code app/tests/schema/test_store_corruption.py} measures the same
     * thing off the device and in seconds: the 8000-character stage is refused
     * immediately, the 200-character stage writes eight rows and is refused,
     * and then FOUR MORE ROWS OF THE ACT'S SIZE LAND before that size is refused
     * in turn — after which it stays refused for ten more attempts, which is the
     * only reason arming down to it terminates.
     *
     * <p>SO THE THREE STAGES ARE NOT THREE WAYS OF SAYING ONE THING and the loop
     * cannot be simplified back into one. They are three sizes, the last of them
     * is the act's, and its refusal — returned as {@code actRefusal} — is what
     * licenses the diary leg. {@code refusal}, the small stage's, stays in the
     * answer because it is what makes one run's arming comparable with another's,
     * and it is no longer asserted by anybody.
     *
     * <p>THEN THE SAME THING AGAIN FOR THE JOURNAL, because "full" is a property
     * of the next write and not of the file. The filler above exhausts what
     * {@code record}'s pages will take; a mark writes small rows into
     * {@code journal_entry} and {@code assertion}, whose own leaves had room —
     * so in run 31971968427 the mark landed on a store this method had just
     * called full. The probe is the mark path's own shape (one transaction, an
     * entry plus its detail) with {@code kind='note'} and no skill, so the rows
     * it does manage to write move nothing in the projected skill state. Its
     * refusal is returned as {@code journalRefusal}.
     *
     * <p>ONLY A DISK-FULL REFUSAL COUNTS AS FULL. Anything else — a constraint
     * violation, a foreign key, a typo in a column list — is rethrown and
     * surfaces as a failed script. Reporting it as fullness would arm nothing
     * and say it had, which is the whole failure mode this method exists to
     * prevent.
     */
    private String fillToCeiling(ActivityScenario<MainActivity> scenario, String act) {
        return await(
                scenario,
                "__diaArm",
                ("import(u('store/bridge.js')).then(function (bridge) {"
                    // The filler needs a container, and it gets its OWN — created
                    // before the clamp, and deliberately NOT linked to any child.
                    // loadRecords() reaches records through area_child, so an
                    // unlinked area is invisible to every read this test makes:
                    // the "no entry was written" assertion after a refusal cannot
                    // be confused by the filler that produced the refusal.
                    + "return bridge.run('INSERT INTO area (id, title, visibility_class,"
                    + " owner_participant_id, created_at_utc) VALUES (?, ?, ?, ?, ?)"
                    + " ON CONFLICT (id) DO NOTHING',"
                    + " ['dia-p3-filler-area', 'filler', 'participant_private',"
                    + " window.__diaAuthor, Date.now()])"
                    + ".then(function () { return bridge.pragma('PRAGMA page_count'); })"
                    + ".then(function (pages) {"
                    + "return bridge.pragma('PRAGMA max_page_count = ' + pages)"
                    + ".then(function (ceiling) {"
                    + "var made = 0;"
                    + "var write = function (body) {"
                    + " return bridge.run('INSERT INTO record (id, area_id,"
                    + " author_participant_id, kind, body, event_date_local, entry_at_utc,"
                    + " entry_utc_offset_min, updated_at_utc)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',"
                    + " ['dia-p3-filler-' + made + '-' + Date.now(), 'dia-p3-filler-area',"
                    + " window.__diaAuthor, 'text', body, '2026-01-01', Date.now(), 0,"
                    + " Date.now()]); };"
                    // A refusal is only evidence of a FULL disk when it is the
                    // full-disk class. Anything else is rethrown: see the
                    // method comment.
                    + "var refused = function (error) {"
                    + " if (!error || error.name !== 'StoreDiskFullError') { throw error; }"
                    + " return 'full:' + error.name; };"
                    + "var loop = function (body, left) {"
                    + " if (left <= 0) { return Promise.resolve('budget'); }"
                    + " return write(body).then(function () { made += 1;"
                    + "  return loop(body, left - 1); }, refused); };"
                    // The mark path's own shape: one transaction carrying a
                    // journal entry and its detail. kind='note' with a NULL
                    // skill is what the schema's paired CHECK makes expressible,
                    // and it keeps every probe that DOES land out of
                    // v_child_skill_state — the projection the acts read.
                    + "var journalled = 0;"
                    + "var probe = function () {"
                    + " var jid = 'dia-p3-arm-' + journalled + '-' + Date.now();"
                    + " var at = Date.now();"
                    + " return bridge.executeSet(["
                    + "  { statement: 'INSERT INTO journal_entry (id, kind,"
                    + " author_participant_id, subject_child_id, visibility_class, origin,"
                    + " event_date_local, event_at_utc, event_utc_offset_min, entry_at_utc,"
                    + " entry_utc_offset_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',"
                    + "    values: [jid, 'assertion', window.__diaAuthor, window.__diaChild,"
                    + "     'child_shared', 'authored', '2026-01-01', at, 0, at, 0] },"
                    + "  { statement: 'INSERT INTO assertion (journal_id, kind, skill_id,"
                    + " effective_from_date, prerequisite_propagation, source_record_id,"
                    + " supersedes_assertion_id) VALUES (?, ?, ?, ?, ?, ?, ?)',"
                    + "    values: [jid, 'note', null, '2026-01-01', 'none', null, null] }"
                    + " ], { transaction: true }); };"
                    + "var journalLoop = function (left) {"
                    + " if (left <= 0) { return Promise.resolve('budget'); }"
                    + " return probe().then(function () { journalled += 1;"
                    + "  return journalLoop(left - 1); }, refused); };"
                    + "return loop(new Array(8000).join('я'), 400).then(function (big) {"
                    + " if (big === 'budget') { return 'state=budget;rows=' + made; }"
                    + " return loop(new Array(200).join('я'), 400).then(function (small) {"
                    + "  if (small === 'budget') { return 'state=budget;rows=' + made; }"
                    // Everything written from here on is the act's own size, so
                    // the two counts are kept apart: `rows` stays what it always
                    // meant, and `actRows` is the cost of the stage that was
                    // missing.
                    + "  var sized = made;"
                    + "  return loop('__ACT__', 400).then(function (act) {"
                    + "   if (act === 'budget') {"
                    + "    return 'state=act-budget;rows=' + sized"
                    + "     + ';actRows=' + (made - sized); }"
                    + "   return journalLoop(200).then(function (journal) {"
                    + "    if (journal === 'budget') {"
                    + "     return 'state=journal-budget;rows=' + sized"
                    + "      + ';actRows=' + (made - sized)"
                    + "      + ';journalRows=' + journalled; }"
                    + "    return ['state=full', 'rows=' + sized, 'ceiling=' + ceiling,"
                    + "     'refusal=' + small, 'actRows=' + (made - sized),"
                    + "     'actRefusal=' + act, 'journalRows=' + journalled,"
                    + "     'journalRefusal=' + journal].join(';'); });"
                    + "   }); }); }); }); }); })")
                        .replace("__ACT__", act));
    }

    /**
     * Releases the ceiling and removes the filler rows.
     *
     * <p>The rows are deleted rather than left: they are this test's, not a
     * family's, and `record` is the one table whose erasure is specified
     * behaviour. The pragma is per-connection, so releasing it restores the
     * store for whatever runs next in this process.
     *
     * <p>THE JOURNAL PROBES THAT LANDED ARE NOT DELETED, and cannot be: the
     * append-only triggers refuse DELETE on `journal_entry` outright, which is
     * the property the whole schema is built on. That is the price of arming
     * the journal path at all, it is bounded by the record filler running first,
     * and the count is returned so it is a measured cost rather than a silent
     * one. The probes carry this leg's own child id and a NULL skill, so nothing
     * any other leg reads can see them.
     */
    private void releaseCeiling(ActivityScenario<MainActivity> scenario) {
        String released =
                await(
                        scenario,
                        "__diaRelease",
                        "import(u('store/bridge.js')).then(function (bridge) {"
                            + "return bridge.pragma('PRAGMA max_page_count = 1073741823')"
                            + ".then(function () {"
                            + " return bridge.run('DELETE FROM record WHERE id LIKE ?',"
                            + " ['dia-p3-filler-%']); })"
                            + ".then(function () {"
                            + " return bridge.run('DELETE FROM area WHERE id = ?',"
                            + " ['dia-p3-filler-area']); })"
                            + ".then(function () { return 'released'; }); })");
        assertEquals("the store was left armed for the next test", "released", released);
    }

    /**
     * The same release, in a {@code finally}, reporting instead of asserting.
     *
     * <p>WHY IT EXISTS. In run 31971968427 the mark leg failed at its first
     * assertion and never reached its release, so the diary leg after it armed
     * against a store that was still clamped and logged {@code arming:
     * state=full;rows=0} — an arming that wrote nothing because everything was
     * already refused, reported as success. The store outlives every
     * ActivityScenario in this process, so one leg's leftovers are the next
     * leg's premise; the release therefore belongs where it runs whatever the
     * assertions did.
     *
     * <p>WHY IT SWALLOWS. An exception thrown from a {@code finally} REPLACES
     * the failure the leg was reporting. A cleanup that hides the red it was
     * cleaning up after is worse than no cleanup, so this one logs.
     */
    private void releaseQuietly(ActivityScenario<MainActivity> scenario) {
        try {
            releaseCeiling(scenario);
        } catch (Throwable failed) {
            Log.w(TAG, "the ceiling could not be released after this leg", failed);
        }
    }

    // --- WebView plumbing, same shape as the sibling suites ------------------

    /** One value out of a {@code key=value;key=value} answer. */
    private static String field(String answer, String key) {
        for (String part : answer.split(";")) {
            int at = part.indexOf('=');
            if (at > 0 && part.substring(0, at).equals(key)) {
                return part.substring(at + 1);
            }
        }
        fail("the answer carries no " + key + ": " + answer);
        return null;
    }

    /**
     * Dispatches an async script and waits for its answer.
     *
     * <p>The mount address is DERIVED (MountAddress), never written down: a
     * copy-forward bump leaves the frozen generation shipped, so a literal would
     * keep reading bytes nothing runs — the defect DIA-DL-002 records.
     */
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
