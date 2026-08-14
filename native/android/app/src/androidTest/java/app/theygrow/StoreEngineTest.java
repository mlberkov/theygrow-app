package app.theygrow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.database.Cursor;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
        String asset = schemaAsset();
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
