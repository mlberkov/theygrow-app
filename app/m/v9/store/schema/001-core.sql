-- theygrow local store, schema version 1 (L1-P2, LSC-DL-002).
--
-- THIS FILE IS THE FREEZE POINT. After the first live record, changing anything
-- here means migrating a family history that exists nowhere else. Read
-- docs/decision-log.md LSC-DL-002 before touching it.
--
-- ONE ARTIFACT, THREE READERS. The mount's own store/store.js fetches this file
-- inside the WebView — at an address that mount DERIVES from itself since
-- DIA-DL-001, which is why no generation is named here any more —
-- app/tests/schema/ applies it against desktop SQLite, and
-- native/android/app/src/androidTest/ reads it out of assets/public/ and applies
-- it to the real SQLCipher engine. There is no second copy to drift from.
--
-- TWO FORMATTING RULES ARE LOAD-BEARING, not style:
--   1. Every CREATE TRIGGER opens and closes on ONE line. The Android wrapper
--      splits this file on ";\n" and re-joins a trigger body only when a
--      fragment trims to exactly "END", so a trigger whose body holds more than
--      one statement across lines is cut in half and applied as garbage.
--   2. No SQL string literal contains "--" or a lowercase "end;". The same
--      splitter strips "--" to end of line inside quotes as well as outside,
--      and uppercases "end;" blindly.
-- app/tests/schema/test_store_ddl_apply.py enforces both.
--
-- Slot numbers below refer to PDR-026 §4 (body + amendment 2026-08-04 + overlay
-- 2026-08-11). app/tests/schema/test_store_slots.py maps every slot to the
-- object that carries it and the test that exercises it.

-- === identity ===========================================================

-- A family-contour participant. No name column, deliberately: attribution needs
-- an id, not an identity, and named participants arrive with L7 grants.
CREATE TABLE participant (
    id TEXT PRIMARY KEY NOT NULL,
    is_self INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
    created_at_utc INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX participant_one_self ON participant (is_self) WHERE is_self = 1;

-- A child is identity only (slot 4 multi-child). Every attribute of a child --
-- including the name -- is a journal event, so the profile has history.
CREATE TABLE child (
    id TEXT PRIMARY KEY NOT NULL,
    created_at_utc INTEGER NOT NULL
) STRICT;

-- Slot 3: the area flag. A private area belongs to exactly one participant; a
-- child-shared area belongs to none. The CHECK binds the two facts together so
-- an area cannot be private and ownerless, or shared and owned.
CREATE TABLE area (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    visibility_class TEXT NOT NULL CHECK (visibility_class IN ('child_shared', 'participant_private')),
    owner_participant_id TEXT REFERENCES participant (id),
    created_at_utc INTEGER NOT NULL,
    CHECK ((visibility_class = 'participant_private') = (owner_participant_id IS NOT NULL))
) STRICT;

-- Slot 4: one area can cover several children (PDR-021 OQ#6).
CREATE TABLE area_child (
    area_id TEXT NOT NULL REFERENCES area (id),
    child_id TEXT NOT NULL REFERENCES child (id),
    PRIMARY KEY (area_id, child_id)
) STRICT;

-- === records ============================================================

-- The diary record. Slot 5 (text/media flag), slot 11 (event vs entry time),
-- slot 12 (sensitivity). Rule 1: records are edited by OVERWRITE -- append-only
-- binds the mark journal and derived state, not diary text.
--
-- sensitivity carries NO DEFAULT on purpose. NULL means "never declared", which
-- is a different fact from "declared not sensitive": a default would make an
-- accumulated corpus indistinguishable from a reviewed one, which is exactly
-- the retro-labelling problem the slot exists to prevent. What a proactive
-- surface does with an undeclared record is projection-time policy (L5).
CREATE TABLE record (
    id TEXT PRIMARY KEY NOT NULL,
    area_id TEXT NOT NULL REFERENCES area (id),
    author_participant_id TEXT NOT NULL REFERENCES participant (id),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'media')),
    body TEXT,
    media_ref TEXT,
    sensitivity TEXT CHECK (sensitivity IN ('sensitive', 'not_sensitive')),
    event_date_local TEXT NOT NULL CHECK (event_date_local IS date(event_date_local)),
    event_at_utc INTEGER,
    event_utc_offset_min INTEGER,
    entry_at_utc INTEGER NOT NULL,
    entry_utc_offset_min INTEGER NOT NULL,
    updated_at_utc INTEGER NOT NULL,
    CHECK ((kind = 'text') = (body IS NOT NULL)),
    CHECK ((kind = 'media') = (media_ref IS NOT NULL)),
    CHECK ((event_at_utc IS NULL) = (event_utc_offset_min IS NULL))
) STRICT;

CREATE INDEX record_by_area ON record (area_id, event_date_local);

-- Rule 4: the retrieval index is DERIVED and rebuildable. It holds no
-- normalization decision, so L2 can change Russian word-form handling by
-- rebuilding this index rather than by migrating the journal. The tokenizer is
-- pinned explicitly; unicode61 folds Cyrillic case but does not fold yo to ye,
-- which is the measured L2 gap recorded in LSC-DL-002.
CREATE VIRTUAL TABLE record_fts USING fts5(body, content='record', tokenize='unicode61 remove_diacritics 2');

CREATE TRIGGER record_fts_after_insert AFTER INSERT ON record BEGIN INSERT INTO record_fts (rowid, body) VALUES (new.rowid, new.body); END;
CREATE TRIGGER record_fts_after_delete AFTER DELETE ON record BEGIN INSERT INTO record_fts (record_fts, rowid, body) VALUES ('delete', old.rowid, old.body); END;
CREATE TRIGGER record_fts_after_update AFTER UPDATE ON record BEGIN INSERT INTO record_fts (record_fts, rowid, body) VALUES ('delete', old.rowid, old.body); INSERT INTO record_fts (rowid, body) VALUES (new.rowid, new.body); END;

-- === the journal ========================================================

-- Slot 10: the append-only spine. One monotonic seq for the whole journal, which
-- is what makes the filing cursor resumable (slot for filing continuity,
-- ADR-046 §1) and what a CRDT models as a single list.
--
-- seq is LOCAL ARRIVAL order, never event order. An entry about January written
-- in March gets a higher seq than the March entries that preceded it, and so
-- will an entry merged in from another device at L7. A cursor ordered by event
-- time would skip both.
--
-- Slot 1: author_participant_id is NOT NULL -- a mark is an ATTRIBUTED
-- assertion, never an impersonal fact. Slot 2: subject plus visibility class.
-- Slot 11: event time and entry time are held separately, each with its own UTC
-- offset, because the offset at observation and the offset at entry differ.
-- Slot 16: id is minted at creation and unique forever.
CREATE TABLE journal_entry (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('assertion', 'confirmation', 'child_attribute')),
    author_participant_id TEXT NOT NULL REFERENCES participant (id),
    subject_child_id TEXT NOT NULL REFERENCES child (id),
    visibility_class TEXT NOT NULL CHECK (visibility_class IN ('child_shared', 'participant_private')),
    origin TEXT NOT NULL CHECK (origin IN ('authored', 'migrated_legacy', 'imported')),
    event_date_local TEXT NOT NULL CHECK (event_date_local IS date(event_date_local)),
    event_at_utc INTEGER,
    event_utc_offset_min INTEGER,
    entry_at_utc INTEGER NOT NULL,
    entry_utc_offset_min INTEGER NOT NULL,
    CHECK ((event_at_utc IS NULL) = (event_utc_offset_min IS NULL))
) STRICT;

CREATE INDEX journal_entry_by_subject ON journal_entry (subject_child_id, seq);

-- Slot 7: prerequisite_propagation records the AUTHOR INTENT at assertion time.
-- The implication itself is computed by the projection, never written back as a
-- journal row: materialising implied prerequisites would fabricate assertions
-- the parent never made, which slot 1 forbids.
--
-- source_record_id deliberately carries NO foreign key and no ON DELETE action.
-- An FK action would MUTATE this row when its record is deleted, and this table
-- is append-only; provenance degradation is derived instead (v_assertion_provenance).
CREATE TABLE assertion (
    journal_id TEXT PRIMARY KEY NOT NULL REFERENCES journal_entry (id),
    kind TEXT NOT NULL CHECK (kind IN ('skill_observed', 'skill_revoked', 'note')),
    skill_id TEXT,
    effective_from_date TEXT NOT NULL CHECK (effective_from_date IS date(effective_from_date)),
    prerequisite_propagation TEXT NOT NULL CHECK (prerequisite_propagation IN ('none', 'implies_prerequisites')),
    source_record_id TEXT,
    supersedes_assertion_id TEXT REFERENCES assertion (journal_id),
    CHECK ((kind IN ('skill_observed', 'skill_revoked')) = (skill_id IS NOT NULL))
) STRICT;

-- Slot 9 and slot 13. A confirmation is itself an append-only journal entry, so
-- a dispute never erases the assertion it disputes -- it lands on top of it.
-- Legacy marks migrate (P4) as origin='migrated_legacy' plus one confirmation by
-- their author, which is exactly "author's assertion, confirmed by one".
CREATE TABLE confirmation (
    journal_id TEXT PRIMARY KEY NOT NULL REFERENCES journal_entry (id),
    target_assertion_id TEXT NOT NULL REFERENCES assertion (journal_id),
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'disputed', 'needs_refresh')),
    note TEXT
) STRICT;

-- Slot 6 (composition fixed by PDR-033) and slot 8. The child this row is about
-- is the spine's subject_child_id -- not repeated here, so the two cannot drift.
--
-- ONE computing field: gestational age at birth as weeks plus days, from which
-- corrected-age policy is derived (v_child_age). THREE declarative markers,
-- which change what the product may ASSERT and never a number
-- (LSC-P2-INV-002). All three carry the sensitivity flag by construction.
-- stopped_time is the slot-8 state: per child, reversible, identical for every
-- participant -- there is no per-user column here and no view exposes one.
CREATE TABLE child_attribute (
    journal_id TEXT PRIMARY KEY NOT NULL REFERENCES journal_entry (id),
    attribute TEXT NOT NULL CHECK (attribute IN ('name', 'birthdate', 'gestational_age_weeks', 'gestational_age_days', 'stopped_time', 'marker_bilingual', 'marker_atypical_development', 'marker_unknown_early_history')),
    value TEXT,
    sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)),
    CHECK (sensitive = 1 OR attribute NOT IN ('marker_bilingual', 'marker_atypical_development', 'marker_unknown_early_history'))
) STRICT;

-- Slot 15: the fragment-basis. A SEPARATE table because the shared journal must
-- be shippable without it -- the quote stays in the author's private area, and
-- the second parent sees a pointer to the author's records, never the quote.
-- The quote is copied at confirmation time, so editing the record does not
-- touch it; final deletion of the record erases it while the assertion survives
-- with degraded provenance (ADR-015).
CREATE TABLE assertion_quote (
    journal_id TEXT PRIMARY KEY NOT NULL REFERENCES assertion (journal_id),
    private_to_participant_id TEXT NOT NULL REFERENCES participant (id),
    source_record_id TEXT NOT NULL,
    quote_text TEXT NOT NULL,
    copied_at_utc INTEGER NOT NULL
) STRICT;

CREATE INDEX assertion_quote_by_record ON assertion_quote (source_record_id);

-- === append-only enforcement (LSC-P2-INV-001) ===========================
--
-- Eight triggers, one per verb per journal table. The quote table and the
-- record table are deliberately absent: erasure and overwrite are their
-- specified behaviour.

CREATE TRIGGER journal_entry_no_update BEFORE UPDATE ON journal_entry BEGIN SELECT RAISE(ABORT, 'journal_entry is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER journal_entry_no_delete BEFORE DELETE ON journal_entry BEGIN SELECT RAISE(ABORT, 'journal_entry is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER assertion_no_update BEFORE UPDATE ON assertion BEGIN SELECT RAISE(ABORT, 'assertion is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER assertion_no_delete BEFORE DELETE ON assertion BEGIN SELECT RAISE(ABORT, 'assertion is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER confirmation_no_update BEFORE UPDATE ON confirmation BEGIN SELECT RAISE(ABORT, 'confirmation is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER confirmation_no_delete BEFORE DELETE ON confirmation BEGIN SELECT RAISE(ABORT, 'confirmation is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER child_attribute_no_update BEFORE UPDATE ON child_attribute BEGIN SELECT RAISE(ABORT, 'child_attribute is append-only (LSC-P2-INV-001)'); END;
CREATE TRIGGER child_attribute_no_delete BEFORE DELETE ON child_attribute BEGIN SELECT RAISE(ABORT, 'child_attribute is append-only (LSC-P2-INV-001)'); END;

-- Slot 15 erasure: deleting a record erases the quotes copied out of it. The
-- assertions themselves are untouched and report degraded provenance.
CREATE TRIGGER record_delete_erases_quotes AFTER DELETE ON record BEGIN DELETE FROM assertion_quote WHERE source_record_id = old.id; END;

-- === housekeeping =======================================================

-- Slot 14: the version and the path it was reached by, both on the device. The
-- migration MECHANISM (pre-migration encrypted dump, transactionality,
-- interrupt recovery) is designed with P4; this is the ledger it writes to.
CREATE TABLE schema_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE schema_migration (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at_utc INTEGER NOT NULL
) STRICT;

-- Filing-cursor continuity. Deliberately MUTABLE: a cursor is a position, not
-- history. Background filing is L5; the shape it needs is here.
CREATE TABLE journal_cursor (
    name TEXT PRIMARY KEY NOT NULL,
    last_seq INTEGER NOT NULL,
    updated_at_utc INTEGER NOT NULL
) STRICT;

-- Corruption detection. clean_shutdown is cleared on open and set on graceful
-- close; finding it clear at open means the last run died, which is when
-- PRAGMA integrity_check earns its cost.
CREATE TABLE store_lifecycle (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    opened_at_utc INTEGER NOT NULL,
    clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1))
) STRICT;

-- Rule 3: a state snapshot for a date is a derived projection, not a stored
-- file. SQLite views take no parameters, so the as-of date is bound here and
-- read by v_child_skill_state. The default reads as "all history applied".
CREATE TABLE projection_context (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    as_of_date TEXT NOT NULL CHECK (as_of_date IS date(as_of_date))
) STRICT;

INSERT INTO projection_context (id, as_of_date) VALUES (1, '9999-12-31');
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
INSERT INTO schema_meta (key, value) VALUES ('kb_journal_contract', 'lsc-journal-v1');

-- === projections ========================================================

-- The latest event per (child, attribute). Everything below reads this rather
-- than the raw table, so "current value" has exactly one definition.
--
-- WHY THE WINNER IS NOT max(seq). seq is LOCAL ARRIVAL order, and two devices
-- holding the same merged journal assign it differently — a projection keyed on
-- seq would make the two devices disagree about the current value of an
-- attribute while holding identical histories. The merge-semantics run
-- (app/tests/merge-semantics.spec.js) demonstrates exactly that divergence.
-- (entry_at_utc, id) is a total order that every replica computes identically,
-- so seq stays what it is good for: the filing cursor.
CREATE VIEW v_child_attribute_current AS
SELECT
    je.subject_child_id AS child_id,
    ca.attribute AS attribute,
    ca.value AS value,
    ca.sensitive AS sensitive,
    je.entry_at_utc AS entry_at_utc
FROM child_attribute ca
JOIN journal_entry je ON je.id = ca.journal_id
WHERE NOT EXISTS (
    SELECT 1
    FROM child_attribute ca2
    JOIN journal_entry je2 ON je2.id = ca2.journal_id
    WHERE je2.subject_child_id = je.subject_child_id
      AND ca2.attribute = ca.attribute
      AND (je2.entry_at_utc, je2.id) > (je.entry_at_utc, je.id)
);

-- The computing profile. Names exactly the four non-marker attributes: this is
-- the ONLY path from attribute events into a computation, and it cannot reach a
-- declarative marker (LSC-P2-INV-002).
CREATE VIEW v_child_profile AS
SELECT
    c.id AS child_id,
    (SELECT v.value FROM v_child_attribute_current v WHERE v.child_id = c.id AND v.attribute = 'name') AS name,
    (SELECT v.value FROM v_child_attribute_current v WHERE v.child_id = c.id AND v.attribute = 'birthdate') AS birthdate,
    (SELECT CAST(v.value AS INTEGER) FROM v_child_attribute_current v WHERE v.child_id = c.id AND v.attribute = 'gestational_age_weeks') AS gestational_age_weeks,
    (SELECT CAST(v.value AS INTEGER) FROM v_child_attribute_current v WHERE v.child_id = c.id AND v.attribute = 'gestational_age_days') AS gestational_age_days
FROM child c;

-- The declarative markers, kept where they belong: readable, sensitive, and out
-- of every computing path.
CREATE VIEW v_child_marker AS
SELECT
    v.child_id AS child_id,
    v.attribute AS attribute,
    v.value AS value,
    v.sensitive AS sensitive
FROM v_child_attribute_current v
WHERE substr(v.attribute, 1, 7) = 'marker_';

-- Slot 8. Keyed on the child alone -- no participant column, because the mode is
-- identical for every family-contour participant and carries no per-user state.
CREATE VIEW v_child_stopped_time AS
SELECT
    c.id AS child_id,
    COALESCE((SELECT v.value FROM v_child_attribute_current v WHERE v.child_id = c.id AND v.attribute = 'stopped_time'), 'off') AS stopped_time
FROM child c;

-- The one computing view. It yields DATE-INDEPENDENT facts only: age at a date
-- is that date minus corrected_age_baseline_date, computed by the caller. No
-- clock inside SQL means the projection is deterministic and testable.
CREATE VIEW v_child_age AS
SELECT
    p.child_id AS child_id,
    p.birthdate AS birthdate,
    (p.gestational_age_weeks * 7 + COALESCE(p.gestational_age_days, 0)) AS gestational_age_days_total,
    CASE WHEN p.gestational_age_weeks IS NULL THEN 0 ELSE max(0, 280 - (p.gestational_age_weeks * 7 + COALESCE(p.gestational_age_days, 0))) END AS prematurity_correction_days,
    CASE WHEN p.gestational_age_weeks IS NULL THEN p.birthdate ELSE date(p.birthdate, '+' || max(0, 280 - (p.gestational_age_weeks * 7 + COALESCE(p.gestational_age_days, 0))) || ' days') END AS corrected_age_baseline_date
FROM v_child_profile p;

-- Slot 2: derived state carries its subject and its visibility class. The
-- winning assertion per (child, skill) as of projection_context.as_of_date.
CREATE VIEW v_child_skill_state AS
SELECT
    je.subject_child_id AS child_id,
    a.skill_id AS skill_id,
    a.kind AS state,
    je.visibility_class AS visibility_class,
    je.author_participant_id AS asserted_by,
    a.effective_from_date AS effective_from_date,
    a.prerequisite_propagation AS prerequisite_propagation,
    a.journal_id AS assertion_id
FROM assertion a
JOIN journal_entry je ON je.id = a.journal_id
WHERE a.skill_id IS NOT NULL
  AND a.effective_from_date <= (SELECT pc.as_of_date FROM projection_context pc WHERE pc.id = 1)
  AND NOT EXISTS (
    SELECT 1
    FROM assertion a2
    JOIN journal_entry je2 ON je2.id = a2.journal_id
    WHERE je2.subject_child_id = je.subject_child_id
      AND a2.skill_id = a.skill_id
      AND a2.effective_from_date <= (SELECT pc2.as_of_date FROM projection_context pc2 WHERE pc2.id = 1)
      AND (je2.entry_at_utc, je2.id) > (je.entry_at_utc, je.id)
);

-- Slot 13: the latest status per (assertion, participant).
CREATE VIEW v_assertion_status AS
SELECT
    cf.target_assertion_id AS assertion_id,
    je.author_participant_id AS participant_id,
    cf.status AS status,
    je.entry_at_utc AS entry_at_utc
FROM confirmation cf
JOIN journal_entry je ON je.id = cf.journal_id
WHERE NOT EXISTS (
    SELECT 1
    FROM confirmation cf2
    JOIN journal_entry je2 ON je2.id = cf2.journal_id
    WHERE cf2.target_assertion_id = cf.target_assertion_id
      AND je2.author_participant_id = je.author_participant_id
      AND (je2.entry_at_utc, je2.id) > (je.entry_at_utc, je.id)
);

-- Slot 9: consensus state, which degenerates to one under a single owner.
CREATE VIEW v_assertion_consensus AS
SELECT
    a.journal_id AS assertion_id,
    (SELECT count(*) FROM v_assertion_status s WHERE s.assertion_id = a.journal_id AND s.status = 'confirmed') AS confirmed_by,
    (SELECT count(*) FROM v_assertion_status s WHERE s.assertion_id = a.journal_id AND s.status = 'disputed') AS disputed_by,
    (SELECT count(*) FROM v_assertion_status s WHERE s.assertion_id = a.journal_id AND s.status = 'needs_refresh') AS needs_refresh_by
FROM assertion a;

-- Slot 15 plus ADR-015: what an assertion can still show for its basis.
-- 'quoted' -- the copied fragment is present; 'record_pointer' -- no quote, but
-- the record is still there; 'degraded' -- the record is gone and the quote with
-- it, and the assertion says so instead of pretending; 'none' -- never had one.
CREATE VIEW v_assertion_provenance AS
SELECT
    a.journal_id AS assertion_id,
    CASE
        WHEN q.journal_id IS NOT NULL THEN 'quoted'
        WHEN a.source_record_id IS NULL THEN 'none'
        WHEN r.id IS NOT NULL THEN 'record_pointer'
        ELSE 'degraded'
    END AS basis
FROM assertion a
LEFT JOIN assertion_quote q ON q.journal_id = a.journal_id
LEFT JOIN record r ON r.id = a.source_record_id;

-- The set L7 sync may ever ship: child-shared entries, no quote column at all.
-- Declaring it here rather than at the call site is what makes it testable now,
-- years before there is a relay to ship it to.
CREATE VIEW v_shared_journal AS
SELECT
    je.seq AS seq,
    je.id AS id,
    je.kind AS kind,
    je.author_participant_id AS author_participant_id,
    je.subject_child_id AS subject_child_id,
    je.origin AS origin,
    je.event_date_local AS event_date_local,
    je.event_at_utc AS event_at_utc,
    je.entry_at_utc AS entry_at_utc
FROM journal_entry je
WHERE je.visibility_class = 'child_shared';
