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
            String verdict = fillAndSave(scenario, "2026-02-01", "Впервые сам встал у дивана");
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
            // says so, while the instant of WRITING is real.
            assertEquals("the event instant was invented: " + read, "null", field(read, "eventAt"));
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

    // --- the refusal a full disk produces ------------------------------------

    @Test
    public void a_full_disk_refuses_the_entry_and_keeps_the_text() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            String leg = "diskdiary";
            seedChild(scenario, leg);

            String armed = fillToCeiling(scenario);
            Log.i(TAG, "arming: " + armed);
            assertEquals(
                    "the store never reached its ceiling, so nothing below is about a full disk: "
                            + armed,
                    "full",
                    field(armed, "state"));

            assertEquals("the diary was not offered", "pressed", openCompose(scenario));
            String verdict = fillAndSave(scenario, "2026-02-01", "Впервые сам встал у дивана");

            Log.i(TAG, "refusal verdict: " + verdict);
            assertEquals("the parent was not told the disk is full: " + verdict, "refused-disk-full", verdict);

            String state = surfaceState(scenario);
            Log.i(TAG, "surface after refusal: " + state);
            assertEquals("the text the parent typed was lost: " + state, "kept", field(state, "text"));
            assertEquals("the day they chose was lost: " + state, "kept", field(state, "date"));
            assertEquals("the window closed under a refusal: " + state, "open", field(state, "modal"));
            assertEquals("the form was taken away: " + state, "visible", field(state, "form"));
            assertEquals("the parent cannot try again: " + state, "enabled", field(state, "save"));

            assertEquals("a refused entry was written anyway", "0", field(readBack(scenario, leg), "count"));

            // THE CONTROL. Release the ceiling and press the same button again:
            // it must save. Without this, a surface that refused everything
            // would pass the assertions above.
            releaseCeiling(scenario);
            assertEquals(
                    "the same press failed with the ceiling released, so the refusal above was"
                            + " not about a full disk",
                    "listed",
                    pressSave(scenario));
            assertEquals("1", field(readBack(scenario, leg), "count"));
        }
    }

    @Test
    public void a_full_disk_withdraws_the_tick_and_says_why() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            pollFor(scenario, BOOTED, EVALUATE_TIMEOUT_MS);
            seedChild(scenario, "diskmark");

            String armed = fillToCeiling(scenario);
            Log.i(TAG, "arming: " + armed);
            assertEquals("the store never reached its ceiling: " + armed, "full", field(armed, "state"));

            String verdict = tickFirstSkill(scenario);
            Log.i(TAG, "tick verdict: " + verdict);

            // THE TICK IS WITHDRAWN, AND THE REASON IS THE RIGHT ONE. A checkbox
            // that stayed checked would assert a mark the store never took; a
            // message about the store not opening would send the parent to
            // restart the app, which does not free space.
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

        // The tick is asynchronous: the write happens, and only then is the DOM
        // rolled back or left alone. Polled until the app has finished deciding,
        // which is either of the two outcomes and never a timeout on both.
        return pollFor(
                scenario,
                "(function () {"
                    + "var box = window.__diaBox;"
                    + "var modal = document.getElementById('storeUnavailableModal');"
                    + "var shown = modal.classList.contains('show');"
                    + "if (!shown && !box.checked) { return null; }"
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

    /** This leg's entries, read through the SHIPPED module out of the APK's mount. */
    private String readBack(ActivityScenario<MainActivity> scenario, String leg) {
        return await(
                scenario,
                "__diaRead",
                ("import(u('store/boot.js')).then(function (boot) {"
                        + "return boot.loadRecords({ authorParticipantId: window.__diaAuthor,"
                        + " subjectChildId: '__CHILD__' }); })"
                        + ".then(function (rows) {"
                        + "if (!rows.length) { return 'count=0'; }"
                        + "var row = rows[0];"
                        + "return ['count=' + rows.length,"
                        + " 'id=' + row.id,"
                        + " 'body=' + (row.body === window.__diaWritten ? 'match' : 'differs'),"
                        + " 'eventDate=' + row.event_date_local,"
                        + " 'eventAt=' + (row.event_at_utc === null ? 'null' : 'set'),"
                        + " 'entryAt=' + (row.entry_at_utc > 0 ? 'set' : 'missing'),"
                        + " 'entryAtValue=' + row.entry_at_utc,"
                        + " 'updatedAtValue=' + row.updated_at_utc,"
                        + " 'sensitivity=' + (row.sensitivity === null ? 'null' : row.sensitivity)"
                        + "].join(';'); })")
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
     * Lowers the page ceiling to the current size and then REACHES it.
     *
     * <p>The clamp alone is not a full disk: SQLite refuses to set a maximum
     * below the current page count, and a small row may still fit in a
     * partially-filled page. So filler rows are written until one is refused —
     * first in large pieces, then in small ones, so that what remains free is
     * smaller than any row the acts under test write. The refusal of the last
     * filler is the evidence that the store is full, and it is returned rather
     * than assumed.
     */
    private String fillToCeiling(ActivityScenario<MainActivity> scenario) {
        return await(
                scenario,
                "__diaArm",
                "import(u('store/bridge.js')).then(function (bridge) {"
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
                    + "var write = function (size) {"
                    + " var body = new Array(size).join('я');"
                    + " return bridge.run('INSERT INTO record (id, area_id,"
                    + " author_participant_id, kind, body, event_date_local, entry_at_utc,"
                    + " entry_utc_offset_min, updated_at_utc)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',"
                    + " ['dia-p3-filler-' + made + '-' + Date.now(), 'dia-p3-filler-area',"
                    + " window.__diaAuthor, 'text', body, '2026-01-01', Date.now(), 0,"
                    + " Date.now()]); };"
                    + "var loop = function (size, left) {"
                    + " if (left <= 0) { return Promise.resolve('budget'); }"
                    + " return write(size).then(function () { made += 1;"
                    + "  return loop(size, left - 1); },"
                    + "  function (error) { return 'full:' + (error && error.name); }); };"
                    + "return loop(8000, 400).then(function (big) {"
                    + " if (big === 'budget') { return 'state=budget;rows=' + made; }"
                    + " return loop(200, 400).then(function (small) {"
                    + "  if (small === 'budget') { return 'state=budget;rows=' + made; }"
                    + "  return ['state=full', 'rows=' + made, 'ceiling=' + ceiling,"
                    + "   'refusal=' + small].join(';'); }); }); }); }); })");
    }

    /**
     * Releases the ceiling and removes the filler rows.
     *
     * <p>The rows are deleted rather than left: they are this test's, not a
     * family's, and `record` is the one table whose erasure is specified
     * behaviour. The pragma is per-connection, so releasing it restores the
     * store for whatever runs next in this process.
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
