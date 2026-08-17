package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.database.Cursor;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Real-engine assertions for the L1-P2 store (LSC-P2-INV-006).
 *
 * <p>WHY THIS EXISTS. Everything else about this packet can be checked on a
 * laptop: the desktop suite applies the DDL to the standard library's SQLite,
 * and the merge run models the schema in both CRDT candidates. What NO desktop
 * test can establish is what the ANDROID engine compiled in — the system SQLite
 * historically guarantees neither FTS5 nor a modern version, which is exactly
 * why this packet bundles one. `assembleDebug` proves the shell compiles; it
 * proves nothing about the engine, and an irreversible schema deserves better.
 *
 * <p>The database opened here is the same artifact the app uses: the same
 * SQLCipher build (declared at the version the plugin itself resolves) and the
 * same DDL, read out of assets/public/ where `cap sync` stages the web root.
 * Nothing is duplicated for the test's convenience.
 */
@RunWith(AndroidJUnit4.class)
public class StoreEngineTest {

    private static final String TAG = "LSC";

    private static final int[] SQLITE_VERSION_FLOOR = {3, 37, 0};

    /**
     * The DDL the SHELL's mount carries, never a written-down mount version
     * (EMV-DL-005). Until this packet this named the PREVIOUS generation's asset
     * path literally, and it went on passing after EMV-P1 moved the shell
     * forward — because a copy-forward bump leaves the frozen generation
     * shipped, and the two generations' DDL differed only in a comment naming
     * its own path. A green test reading the generation nobody runs is the same
     * defect as the red one beside it, found by the same scan; it is only
     * luckier.
     */
    private static String schemaAsset() {
        return MountAddress.assetPrefix() + "store/schema/001-core.sql";
    }

    private File databaseFile;
    private SQLiteDatabase database;

    @Before
    public void openEncryptedDatabase() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        System.loadLibrary("sqlcipher");
        databaseFile = new File(context.getCacheDir(), "engine-probe.db");
        if (databaseFile.exists() && !databaseFile.delete()) {
            fail("could not clear the probe database from a previous run");
        }
        database = SQLiteDatabase.openOrCreateDatabase(databaseFile, "probe-passphrase", null, null);
    }

    @After
    public void close() {
        if (database != null) {
            database.close();
        }
        if (databaseFile != null) {
            databaseFile.delete();
        }
    }

    // --- capability floor -------------------------------------------------

    @Test
    public void the_bundled_engine_compiles_fts5_in() {
        List<String> options = queryColumn("PRAGMA compile_options");
        assertFalse("PRAGMA compile_options returned nothing", options.isEmpty());

        boolean fts5 = false;
        boolean icu = false;
        for (String option : options) {
            if (option.contains("ENABLE_FTS5")) {
                fts5 = true;
            }
            if (option.contains("ENABLE_ICU")) {
                icu = true;
            }
        }
        assertTrue(
                "the bundled engine has no FTS5 — the lexical retrieval path this schema "
                        + "secures would not exist",
                fts5);

        // Recorded, not required. The upstream requirement named ICU as
        // mandatory; the primary sources say the SQLCipher Android build does
        // not compile it in, and ICU would not fold yo/ye or lemmatise Russian
        // anyway. The substance secured instead is a fully rebuildable index.
        // See LSC-DL-002. If this ever flips to true, that decision can be
        // revisited — it is not a failure either way.
        assertFalse(
                "ENABLE_ICU appeared in the bundled engine — re-read LSC-DL-002 before "
                        + "relying on it",
                icu);
    }

    @Test
    public void the_engine_is_new_enough_for_the_schema() {
        String version = queryScalar("SELECT sqlite_version()");
        String[] parts = version.split("\\.");
        for (int i = 0; i < SQLITE_VERSION_FLOOR.length; i++) {
            int actual = Integer.parseInt(parts[i]);
            if (actual > SQLITE_VERSION_FLOOR[i]) {
                return;
            }
            assertTrue(
                    "SQLite " + version + " is below the floor STRICT tables need",
                    actual == SQLITE_VERSION_FLOOR[i]);
        }
    }

    @Test
    public void the_database_is_actually_encrypted() {
        String cipher = queryScalar("PRAGMA cipher_version");
        assertFalse("PRAGMA cipher_version is empty — this is not SQLCipher", cipher.isEmpty());
    }

    // --- the schema itself ------------------------------------------------

    @Test
    public void the_shipped_ddl_applies_to_the_real_engine() {
        applySchema();

        List<String> names = queryColumn(
                "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
        assertTrue("the DDL created suspiciously little", names.size() > 30);
        assertTrue(names.contains("journal_entry"));
        assertTrue(names.contains("record_fts"));
        assertTrue(names.contains("v_child_skill_state"));

        assertEquals("1", queryScalar("SELECT value FROM schema_meta WHERE key = 'schema_version'"));
        assertEquals("ok", queryScalar("PRAGMA integrity_check"));
    }

    @Test
    public void wal_is_available_on_the_device() {
        assertEquals("wal", queryScalar("PRAGMA journal_mode = WAL").toLowerCase());
    }

    @Test
    public void the_append_only_triggers_fire_on_the_real_engine() {
        applySchema();
        database.execSQL(
                "INSERT INTO participant (id, is_self, created_at_utc) VALUES ('p-1', 1, 1)");
        database.execSQL("INSERT INTO child (id, created_at_utc) VALUES ('c-1', 1)");
        database.execSQL(
                "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
                        + " visibility_class, origin, event_date_local, entry_at_utc,"
                        + " entry_utc_offset_min) VALUES ('j-1', 'assertion', 'p-1', 'c-1',"
                        + " 'child_shared', 'authored', '2026-01-01', 1, 0)");
        try {
            database.execSQL("UPDATE journal_entry SET entry_at_utc = 2 WHERE id = 'j-1'");
            fail("the journal accepted an UPDATE — it is supposed to be append-only");
        } catch (Exception expected) {
            assertTrue(
                    "the refusal did not name the invariant: " + expected.getMessage(),
                    expected.getMessage().contains("append-only"));
        }
    }

    /**
     * The measured behaviour of the tokenizer this schema pins, on the engine
     * that will actually index a family's diary. The negative assertions are the
     * point: they hand L2 a fact rather than an assumption about Russian word
     * forms.
     */
    @Test
    public void russian_tokenization_behaves_as_measured_off_device() {
        applySchema();
        database.execSQL(
                "INSERT INTO participant (id, is_self, created_at_utc) VALUES ('p-1', 1, 1)");
        database.execSQL(
                "INSERT INTO area (id, title, visibility_class, owner_participant_id,"
                        + " created_at_utc) VALUES ('a-1', 'x', 'child_shared', NULL, 1)");
        database.execSQL(
                "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
                        + " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
                        + " VALUES ('r-1', 'a-1', 'p-1', 'text', 'ЁЛКА растёт БЫСТРО',"
                        + " '2026-01-01', 1, 0, 1)");

        assertTrue("Cyrillic case folding is broken", matches("ёлка"));
        assertTrue(matches("быстро"));
        assertFalse("yo folded to ye — the L2 gap recorded in LSC-DL-002 has closed", matches("елка"));
        assertFalse(matches("растет"));
    }

    @Test
    public void the_index_rebuilds_from_the_records() {
        applySchema();
        database.execSQL(
                "INSERT INTO participant (id, is_self, created_at_utc) VALUES ('p-1', 1, 1)");
        database.execSQL(
                "INSERT INTO area (id, title, visibility_class, owner_participant_id,"
                        + " created_at_utc) VALUES ('a-1', 'x', 'child_shared', NULL, 1)");
        database.execSQL(
                "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
                        + " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
                        + " VALUES ('r-1', 'a-1', 'p-1', 'text', 'сел сам', '2026-01-01', 1, 0, 1)");
        assertTrue(matches("сел"));

        database.execSQL("INSERT INTO record_fts (record_fts) VALUES ('rebuild')");
        assertTrue("a full rebuild lost the index", matches("сел"));
    }

    // --- search over the diary, on the device engine (DIA-P4) --------------
    //
    // WHERE THE BOUNDARY IS, AND WHY THE NEXT READER MUST NOT "UNIFY" THESE WITH
    // THE BUILDER. The two legs below make claims about the ENGINE: that
    // SQLCipher's FTS5 build, with the tokenizer the frozen schema pins, resolves
    // a quoted prefix, an OR of two spellings, and the `rebuild` command the way
    // the desktop engine does. That is why their match terms are LITERAL. They
    // are expressions of the SHAPE `buildDiaryMatch` produces, chosen to exercise
    // prefix, alternation and quoting — they are NOT read from
    // `diarySearchStemChars`, and they must not be.
    //
    // The moment they were derived from the knob, a green here would mean "the
    // app agrees with itself" instead of "the engine does what we measured", and
    // the one claim no laptop can make would be gone. What the SHIPPED builder
    // produces from what a parent types is asserted where the builder runs:
    // app/tests/schema/test_diary_search.py executes it under node against the
    // real frozen DDL, and DiaryEntryTest drives it through the surface.
    //
    // So if these two ever disagree with that suite, the answer is not to make
    // one read the other. It is that this engine differs from the desktop one,
    // which is exactly the fact these legs exist to surface.

    /** Five ordinary diary sentences, the same corpus the desktop suite uses. */
    private void seedSearchCorpus() {
        applySchema();
        database.execSQL(
                "INSERT INTO participant (id, is_self, created_at_utc) VALUES ('p-1', 1, 1)");
        database.execSQL(
                "INSERT INTO area (id, title, visibility_class, owner_participant_id,"
                        + " created_at_utc) VALUES ('a-1', 'diary', 'child_shared', NULL, 1)");
        String[][] corpus = {
            {"r-sel", "Сегодня сел сам и держался"},
            {"r-elka", "Ёлка растёт быстро"},
            {"r-posla", "Пошла первый раз без рук"},
            {"r-reb", "Ребёнок сказал новое слово"},
            {"r-spal", "Спал днём два часа"},
        };
        for (String[] row : corpus) {
            database.execSQL(
                    "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
                            + " event_date_local, entry_at_utc, entry_utc_offset_min,"
                            + " updated_at_utc) VALUES (?, 'a-1', 'p-1', 'text', ?,"
                            + " '2026-01-01', 1, 0, 1)",
                    new String[] {row[0], row[1]});
        }
    }

    /**
     * What a query of the shipped SHAPE finds on the engine that will run it.
     *
     * <p>The negative assertions carry as much as the positive ones. A search
     * without lemmatisation has systematic misses, the product tells the parent
     * so in its own words, and this is where "systematic" stops being an
     * assumption about the device: `сесть` does not reach `сел` and `спит` does
     * not reach `спал`, because the stem itself moved and a prefix bridges only
     * an ending.
     */
    @Test
    public void a_query_of_the_shipped_shape_behaves_as_measured_on_the_device() {
        seedSearchCorpus();

        // A prefix reaches a longer written form.
        assertTrue("a quoted prefix found nothing", matches("(\"сел\"* OR \"сёл\"*)"));
        assertTrue("`растут` does not reach `растёт`", matches("(\"раст\"*)"));
        assertTrue("`пошёл` does not reach `Пошла`", matches("(\"пош\"*)"));
        assertTrue("`спать` does not reach `Спал`", matches("(\"спа\"*)"));

        // BOTH ё/е spellings are searched, because the index folds NEITHER into
        // the other — the measured gap of LSC-DL-002, which the query closes and
        // the index still does not.
        assertTrue("the е spelling did not reach an indexed ё", matches("(\"елк\"* OR \"ёлк\"*)"));
        assertFalse(
                "yo folded to ye on this engine — re-read LSC-DL-002 and DIA-DL-008,"
                        + " the query-side alternation may no longer be needed",
                matches("\"елк\"*"));

        // The documented misses. If either of these ever passes, this engine
        // acquired stemming and the whole word-form decision can be revisited.
        assertFalse("`сесть` reached `сел`, which no prefix scheme can do", matches("(\"сес\"*)"));
        assertFalse("`спит` reached `Спал`", matches("(\"спи\"*)"));

        // THE OVER-MATCH IS DELIBERATELY NOT ASSERTED HERE. `сельский` finding
        // `сел сам` is a fact about TRUNCATION — the builder cutting both words
        // to the same prefix — not about this engine, which sees only the
        // expression it is handed. It is executed where the builder runs
        // (app/tests/schema/test_diary_search.py, `сельский` -> ["r-sel"]).
        // Asserting it here would make this file quietly about the knob.
    }

    /**
     * A destroyed index is rebuilt from the records, and the rebuild is TIMED.
     *
     * <p>WHY THE NUMBER IS THE POINT. The product repairs the index inside a
     * search that came back empty over a diary that has entries, so whatever a
     * rebuild costs is time a PARENT waits, holding a screen that has not
     * answered yet. Recording "it can be rebuilt" without recording what that
     * takes would leave the one fact the design rests on unmeasured.
     *
     * <p>WHAT THE NUMBER DOES NOT SAY, and it must be read with this attached: it
     * is five short sentences on an emulator. A parent with three years of
     * entries is a different measurement, and nothing in this repository reaches
     * it. The cost of a rebuild grows with the corpus, because a rebuild
     * re-tokenises every record.
     *
     * <p>{@code delete-all} is FTS5's own way of emptying an external-content
     * index, so the loss is real rather than simulated.
     */
    @Test
    public void the_index_repairs_itself_after_delete_all() {
        seedSearchCorpus();
        assertTrue("the corpus was not indexed to begin with", matches("(\"сел\"* OR \"сёл\"*)"));

        database.execSQL("INSERT INTO record_fts (record_fts) VALUES ('delete-all')");
        assertFalse(
                "delete-all left the index standing, so nothing below is about a repair",
                matches("(\"сел\"* OR \"сёл\"*)"));

        // RECORDED, NOT REQUIRED — the same posture as the ICU line above, and
        // the product depends on none of it. On desktop SQLite 3.45.1 the
        // argument-less integrity-check PASSES over an emptied index and only
        // the `rank`-argument form detects the divergence; whether that form
        // exists on this engine has never been measured. The product rebuilds
        // unconditionally rather than probing, so this reports instead of
        // asserting: it turns an unknown in DIA-DL-008 into a fact for whoever
        // later wants a staleness probe.
        String argumentless = "did not raise";
        try {
            database.execSQL("INSERT INTO record_fts (record_fts) VALUES ('integrity-check')");
        } catch (RuntimeException raised) {
            argumentless = "raised: " + raised.getMessage();
        }
        String withRank = "did not raise";
        try {
            database.execSQL(
                    "INSERT INTO record_fts (record_fts, rank) VALUES ('integrity-check', 1)");
        } catch (RuntimeException raised) {
            withRank = "raised: " + raised.getMessage();
        }
        Log.i(TAG, "fts integrity-check over an emptied index: bare=" + argumentless
                + " | rank=1=" + withRank);

        long startedAt = System.nanoTime();
        database.execSQL("INSERT INTO record_fts (record_fts) VALUES ('rebuild')");
        long rebuildMs = (System.nanoTime() - startedAt) / 1_000_000L;

        assertTrue("the rebuild did not restore the index", matches("(\"сел\"* OR \"сёл\"*)"));
        assertTrue("the rebuild restored only the term it was asked about", matches("(\"пош\"*)"));

        // The records are the SOURCE of the index, so a rebuild reads them and
        // writes nothing back. Losing the index must never cost a family a row.
        assertEquals("5", queryScalar("SELECT count(*) FROM record"));

        Log.i(
                TAG,
                "fts rebuild: records=5 ms=" + rebuildMs
                        + " (emulator, five short sentences — a real diary is a different"
                        + " measurement and this number does not predict it)");
    }

    // --- what the engine SAYS when it is full (DIA-P3) ---------------------

    /**
     * A full database says so in words the shipped classifier recognises.
     *
     * <p>WHY THIS IS NOT A DETAIL. ADR-046 §1.1 asks for explicit disk-full
     * handling on the write path, and the app's half of that is
     * {@code classifyStoreFailure} in {@code store/errors.js}, which matches
     * SUBSTRINGS of the message the wrapper rejects with. Substring matching is
     * only as good as the string, and nothing on a laptop can say what THIS
     * engine emits: the marker list and the SQLCipher build have never met. If
     * the bundled engine ever worded it differently, every disk-full path in the
     * product would silently degrade to a generic failure — the parent would be
     * told to restart the app instead of to free space — and no other test in
     * this repository would notice.
     *
     * <p>The markers are READ OUT OF THE SHIPPED MODULE in the APK's own assets,
     * never retyped here: a copy in this file would agree with itself after the
     * list changed, which is the drift the whole one-artifact rule exists to
     * prevent.
     *
     * <p>SQLITE_FULL is produced by lowering {@code max_page_count} to the
     * database's current size and then writing past it. That is a real engine
     * refusal rather than a simulated one; what it is NOT is a device whose
     * storage is actually exhausted, which fails in ways SQLite never sees.
     */
    @Test
    public void a_full_database_says_so_in_words_the_app_classifies() {
        applySchema();
        database.execSQL(
                "INSERT INTO participant (id, is_self, created_at_utc) VALUES ('p-1', 1, 1)");
        database.execSQL(
                "INSERT INTO area (id, title, visibility_class, owner_participant_id,"
                        + " created_at_utc) VALUES ('a-1', 'x', 'child_shared', NULL, 1)");

        List<String> markers = diskFullMarkers();
        assertFalse("store/errors.js declares no disk-full markers", markers.isEmpty());

        long pages = Long.parseLong(queryScalar("PRAGMA page_count"));
        clampPageCount(pages);

        try {
            StringBuilder body = new StringBuilder();
            while (body.length() < 64_000) {
                body.append("текст, который не поместится ");
            }

            String message = null;
            // Written until one is refused. A single attempt could fit in a
            // partially-filled page and pass this test by not being full at all.
            for (int attempt = 0; attempt < 200 && message == null; attempt++) {
                try {
                    database.execSQL(
                            "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
                                    + " event_date_local, entry_at_utc, entry_utc_offset_min,"
                                    + " updated_at_utc) VALUES (?, 'a-1', 'p-1', 'text', ?,"
                                    + " '2026-01-01', 1, 0, 1)",
                            new Object[] {"r-full-" + attempt, body.toString()});
                } catch (Exception refused) {
                    message = String.valueOf(refused.getMessage());
                }
            }
            assertTrue(
                    "the engine never refused a write, so this test says nothing about a full"
                            + " database",
                    message != null);
            Log.i(TAG, "engine said, on a full database: " + message);

            String said = message.toLowerCase(Locale.ROOT);
            boolean recognised = false;
            for (String marker : markers) {
                if (said.contains(marker)) {
                    recognised = true;
                }
            }
            assertTrue(
                    "the bundled engine words a full database as \""
                            + message
                            + "\", which store/errors.js does not recognise: "
                            + markers
                            + " — every disk-full refusal in the product would degrade to a"
                            + " generic failure",
                    recognised);
        } finally {
            // RELEASED WHERE IT RUNS WHATEVER THE ASSERTIONS DID. Until this
            // packet the release was the last statement of the body, so a red
            // leg never reached it. Here the ceiling sits on a per-test probe
            // database that @After deletes, so the leak was bounded — the move
            // is for one rule across both instrumented files, and because the
            // sibling DiaryEntryTest, whose store OUTLIVES the test, is where
            // the same omission actually poisoned the next leg (run
            // 31971968427: "arming: state=full;rows=0").
            releaseQuietly();
        }
    }

    /**
     * Sets the page ceiling, through the path the binding supports.
     *
     * <p>NOT {@code execSQL}. {@code PRAGMA max_page_count = N} RETURNS the new
     * ceiling as a row, and {@code execSQL} routes to
     * {@code executeForChangedRowCount}, which refuses any statement that yields
     * one — run 31971968427 red this line with "Queries can be performed using
     * SQLiteDatabase query or rawQuery methods only". The app's own seam draws
     * the same distinction for the same reason, and says so where it draws it
     * ({@code app/m/v6/store/bridge.js}, {@code pragma()}).
     */
    private void clampPageCount(long pages) {
        queryScalar("PRAGMA max_page_count = " + pages);
    }

    /** Lifts the ceiling, reporting rather than asserting: see the finally above. */
    private void releaseQuietly() {
        try {
            Log.i(TAG, "ceiling released, now: " + queryScalar("PRAGMA max_page_count = 1073741823"));
        } catch (RuntimeException failed) {
            // Never rethrown from a finally: an exception here would REPLACE the
            // failure the leg was reporting, which is the one thing a cleanup
            // must not do.
            Log.w(TAG, "the ceiling could not be released", failed);
        }
    }

    /** DISK_FULL_MARKERS, read out of the shipped module in the APK. */
    private List<String> diskFullMarkers() {
        String source = readAssetText(MountAddress.assetPrefix() + "store/errors.js");
        Matcher declaration =
                Pattern.compile("const DISK_FULL_MARKERS = \\[([^\\]]*)\\]").matcher(source);
        assertTrue(
                "store/errors.js no longer declares DISK_FULL_MARKERS in a form this test can"
                        + " read — it must not be guessed at",
                declaration.find());
        List<String> markers = new ArrayList<>();
        Matcher literal = Pattern.compile("'([^']+)'").matcher(declaration.group(1));
        while (literal.find()) {
            markers.add(literal.group(1));
        }
        return markers;
    }

    // --- helpers ----------------------------------------------------------

    private boolean matches(String term) {
        Cursor cursor = database.rawQuery(
                "SELECT count(*) FROM record_fts WHERE record_fts MATCH ?", new String[] {term});
        try {
            cursor.moveToFirst();
            return cursor.getInt(0) > 0;
        } finally {
            cursor.close();
        }
    }

    private void applySchema() {
        for (String statement : splitLikeTheWrapper(readAsset())) {
            if (statement.trim().isEmpty()) {
                continue;
            }
            database.execSQL(statement);
        }
    }

    private String readAsset() {
        return readAssetText(schemaAsset());
    }

    private String readAssetText(String asset) {
        try (InputStream in =
                InstrumentationRegistry.getInstrumentation()
                        .getTargetContext()
                        .getAssets()
                        .open(asset)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            throw new IllegalStateException(
                    "the DDL is not in the APK at " + asset + " — cap sync stages the web"
                            + " root into assets/public/",
                    e);
        }
    }

    /**
     * Mirrors UtilsSQLite.getStatementsArray in the wrapper, and the port in
     * app/tests/schema/harness.py. Three copies of one heuristic is two too
     * many, but the alternative is a device test that applies the DDL in a way
     * the app never will — which would pass while the app fails.
     */
    private static List<String> splitLikeTheWrapper(String sql) {
        String normalised = sql.replace("end;", "END;");
        List<String> out = new ArrayList<>();
        for (String fragment : normalised.split(";\n")) {
            StringBuilder builder = new StringBuilder();
            for (String rawLine : fragment.split("\n")) {
                String line = rawLine.trim();
                int comment = line.indexOf("--");
                if (comment > -1) {
                    line = line.substring(0, comment).trim();
                }
                if (line.isEmpty()) {
                    continue;
                }
                if (builder.length() > 0) {
                    builder.append(" ");
                }
                builder.append(line);
            }
            String statement = builder.toString();
            if ("END".equals(statement) && !out.isEmpty()) {
                out.set(out.size() - 1, out.get(out.size() - 1) + "; END");
                continue;
            }
            if (!statement.isEmpty()) {
                out.add(statement);
            }
        }
        return out;
    }

    private String queryScalar(String sql) {
        Cursor cursor = database.rawQuery(sql, null);
        try {
            return cursor.moveToFirst() ? String.valueOf(cursor.getString(0)) : "";
        } finally {
            cursor.close();
        }
    }

    private List<String> queryColumn(String sql) {
        Cursor cursor = database.rawQuery(sql, null);
        List<String> values = new ArrayList<>();
        try {
            while (cursor.moveToNext()) {
                values.add(cursor.getString(0));
            }
        } finally {
            cursor.close();
        }
        return values;
    }
}
