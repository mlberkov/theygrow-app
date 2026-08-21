"""Helpers for the export-contour suite (L1-P3).

WHY THE ARTIFACT IS BUILT BY NODE AND READ BY PYTHON.

The artifact's format is a public commitment, so what has to be proven is the
artifact the SHIPPED code writes — not a Python re-implementation of it that
could agree with the tests and disagree with the app. So the read-out runs here,
against a real SQLite database carrying the real frozen DDL, and the bytes are
built by `node` running the shipped mount's `export/build.js` unchanged. The
same discipline as `app/tests/schema/harness.py`, which applies the DDL through a
port of the wrapper's own splitter rather than through a convenient shortcut.

The read-out is not hand-written either: every query comes out of
the mount's `export/declaration.json`, the same file the builder reads and the same
file a verbatim copy of which lands inside every artifact. One artifact, three
readers — the `001-core.sql` arrangement applied to the export.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

from schema.harness import apply_schema, connect, current_mount

REPO_ROOT = Path(__file__).resolve().parents[3]
# Derived from the shell, never pinned — see schema.harness.current_mount
# (EMV-DL-001): the frozen generation is still on disk after a copy-forward
# bump, and building the artifact with its builder would prove the wrong bytes.
EXPORT_DIR = REPO_ROOT / "app" / "m" / current_mount(REPO_ROOT) / "export"
DECLARATION_PATH = EXPORT_DIR / "declaration.json"
BUILD_DRIVER = Path(__file__).resolve().parent / "build-artifact.mjs"

# The fixture's own vocabulary. Ids are readable rather than UUIDs, for the
# reason app/tests/schema/harness.py gives: the schema constrains uniqueness, not
# form, and a readable id makes a failing assertion legible.
SELF = "p-self"
OTHER = "p-other"
CHILD = "c-1"

__all__ = [
    "BUILD_DRIVER",
    "CHILD",
    "DECLARATION_PATH",
    "EXPORT_DIR",
    "OTHER",
    "REPO_ROOT",
    "SELF",
    "build_artifact",
    "load_declaration",
    "manifest_inputs",
    "read_out",
    "seed_family",
]


def load_declaration() -> dict[str, Any]:
    """The artifact's self-description, as the builder and the app both read it."""
    with DECLARATION_PATH.open(encoding="utf-8") as handle:
        result: dict[str, Any] = json.load(handle)
    return result


def _bind(params: list[str], self_participant_id: str) -> list[str]:
    """Resolve a dataset's declared parameter names to values.

    Only one parameter name exists today. An unknown one raises rather than
    binding None: a silently NULL-bound scope filter would widen the export past
    the requesting participant, which is exactly the failure this suite exists to
    make impossible.
    """
    values = {"self_participant_id": self_participant_id}
    return [values[name] for name in params]


def read_out(conn: sqlite3.Connection, self_participant_id: str = SELF) -> dict[str, Any]:
    """Run every declared dataset query. The shape the builder consumes."""
    declaration = load_declaration()
    datasets: dict[str, Any] = {}
    for dataset in declaration["datasets"]:
        rows = conn.execute(
            dataset["query"], _bind(dataset["params"], self_participant_id)
        ).fetchall()
        datasets[dataset["name"]] = [dict(row) for row in rows]
    return datasets


def manifest_inputs(
    conn: sqlite3.Connection,
    exported_at_utc: int = 1_770_000_000_000,
    self_participant_id: str = SELF,
) -> dict[str, Any]:
    """The manifest facts, read from the DEVICE rather than from a build constant.

    The schema identifier and version come out of ``schema_meta`` — what the
    database actually holds — so an artifact cannot claim a schema its own data
    was not written under.
    """
    meta = {
        str(row["key"]): str(row["value"])
        for row in conn.execute("SELECT key, value FROM schema_meta").fetchall()
    }
    return {
        "exportedAtUtc": exported_at_utc,
        "appVersion": "1.0.0",
        "canonVersion": 1,
        "schemaContract": meta["kb_journal_contract"],
        "schemaVersion": int(meta["schema_version"]),
        "selfParticipantId": self_participant_id,
    }


def build_artifact(
    conn: sqlite3.Connection,
    tmp_path: Path,
    *,
    exported_at_utc: int = 1_770_000_000_000,
    self_participant_id: str = SELF,
    name: str = "artifact.zip",
) -> bytes:
    """Build the artifact with the SHIPPED builder, and return its bytes."""
    node = shutil.which("node")
    # Loud rather than skipped: a skip here would turn the whole suite vacuous on
    # exactly the machine where someone believes it ran.
    assert node is not None, "node is required to build the artifact with the shipped builder"

    payload = tmp_path / "readout.json"
    out = tmp_path / name
    payload.write_text(
        json.dumps(
            {
                "readout": read_out(conn, self_participant_id),
                "manifest": manifest_inputs(
                    conn,
                    exported_at_utc=exported_at_utc,
                    self_participant_id=self_participant_id,
                ),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    subprocess.run(
        [node, str(BUILD_DRIVER), str(payload), str(out)],
        check=True,
        capture_output=True,
    )
    return out.read_bytes()


def seed_family(conn: sqlite3.Connection) -> None:
    """A family with everything the scope rule has to separate.

    Deliberately NOT a minimal fixture. It holds a second participant with
    private entries of their own, a superseded assertion, an attribute with a
    history, and a quote belonging to each participant — because a scope filter
    that is only ever shown shared data passes while doing nothing.

    FIU-P4 adds the two rows that were missing from exactly that argument. The
    first is the other participant's diary entry in the CHILD-SHARED area: the
    area-scoped filter this fixture was written against withheld their private
    area and handed over that one, so the "second participant" it held was never
    able to fail. The second is one entry carrying what a parent really types —
    a line break, a line shaped like this format's own field syntax, an
    unbreakable 300-character token and a codepoint the embedded font does not
    cover — because the print layer's failures are all failures on real input.
    """
    conn.execute(
        "INSERT INTO participant (id, is_self, created_at_utc) VALUES (?, 1, 1000)", (SELF,)
    )
    conn.execute(
        "INSERT INTO participant (id, is_self, created_at_utc) VALUES (?, 0, 1100)", (OTHER,)
    )
    conn.execute("INSERT INTO child (id, created_at_utc) VALUES (?, 1000)", (CHILD,))

    # One shared area, one private area per participant.
    for area_id, visibility, owner in (
        ("a-shared", "child_shared", None),
        ("a-self", "participant_private", SELF),
        ("a-other", "participant_private", OTHER),
    ):
        conn.execute(
            "INSERT INTO area (id, title, visibility_class, owner_participant_id, created_at_utc)"
            " VALUES (?, ?, ?, ?, 1000)",
            (area_id, area_id, visibility, owner),
        )
        conn.execute("INSERT INTO area_child (area_id, child_id) VALUES (?, ?)", (area_id, CHILD))

    for record_id, area_id, author, body, day, at in (
        ("r-shared", "a-shared", SELF, "Сегодня сама залезла на диван.", "2026-01-01", 1000),
        ("r-self", "a-self", SELF, "Личная заметка родителя.", "2026-01-01", 1000),
        ("r-other", "a-other", OTHER, "Личная заметка второго родителя.", "2026-01-01", 1000),
        # THE SCOPE ARM, AND THE ONLY ROW IN THIS FIXTURE THAT MUST NOT TRAVEL
        # OUT OF A SHARED CONTAINER. `r-other` above sits in the other
        # participant's PRIVATE area, so an area-scoped filter withholds it while
        # doing nothing; this row is theirs and sits in the CHILD-SHARED area,
        # which is where an area-scoped filter hands their diary text to someone
        # else. Measured before FIU-P4: it reached text/diary.txt, index.json,
        # MANIFEST.json counts.record and the print layer.
        (
            "r-other-shared",
            "a-shared",
            OTHER,
            "Личный текст второго родителя в общей области.",
            "2026-01-03",
            6000,
        ),
        # WHAT A PARENT ACTUALLY TYPES, in one row: a line break, a line that
        # imitates this format's own field syntax, a token longer than the page
        # is wide, a codepoint the embedded font does not cover, and Cyrillic
        # prose around all of it. Every one of those was a measured defect in the
        # text and print layers before this packet.
        (
            "r-edge",
            "a-self",
            SELF,
            "Первая строка про подоконник.\n"
            "  id: это не поле, это текст\n"
            "Ссылка, которую никто не переносил: " + "A" * 300 + " и хвост 🙂 после неё.",
            "2026-01-04",
            7000,
        ),
    ):
        conn.execute(
            "INSERT INTO record (id, area_id, author_participant_id, kind, body,"
            " event_date_local, entry_at_utc, entry_utc_offset_min, updated_at_utc)"
            " VALUES (?, ?, ?, 'text', ?, ?, ?, 180, ?)",
            (record_id, area_id, author, body, day, at, at),
        )

    # The child's name changes once, so the artifact has to show a history and
    # still name a current value.
    _attribute(conn, "j-name-1", SELF, "name", "Мия", entry_at_utc=1000)
    _attribute(conn, "j-name-2", SELF, "name", "Мия Александровна", entry_at_utc=3000)
    _attribute(conn, "j-birth", SELF, "birthdate", "2025-06-01", entry_at_utc=1000)
    _attribute(conn, "j-marker", SELF, "marker_bilingual", "true", entry_at_utc=1000)

    # A skill observed, then superseded by a revocation: both stay in the journal
    # and only the later one wins the derived state.
    _assertion(conn, "j-a1", SELF, skill_id="skill-1", kind="skill_observed", entry_at_utc=1000)
    _assertion(
        conn,
        "j-a2",
        SELF,
        skill_id="skill-1",
        kind="skill_revoked",
        entry_at_utc=4000,
        supersedes="j-a1",
    )
    _assertion(conn, "j-a3", SELF, skill_id="skill-2", kind="skill_observed", entry_at_utc=2000)

    # The requester's own private assertion — belongs in their archive.
    _assertion(
        conn,
        "j-a-self-private",
        SELF,
        skill_id="skill-3",
        kind="skill_observed",
        visibility="participant_private",
        entry_at_utc=2100,
    )
    # The other participant's private assertion — must never appear.
    _assertion(
        conn,
        "j-a-other-private",
        OTHER,
        skill_id="skill-4",
        kind="skill_observed",
        visibility="participant_private",
        entry_at_utc=2200,
    )
    # The other participant's SHARED assertion — must appear.
    _assertion(
        conn,
        "j-a-other-shared",
        OTHER,
        skill_id="skill-5",
        kind="skill_observed",
        entry_at_utc=2300,
    )

    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
        " VALUES ('j-c1', 'confirmation', ?, ?, 'child_shared', 'authored',"
        " '2026-01-02', 5000, 180)",
        (OTHER, CHILD),
    )
    conn.execute(
        "INSERT INTO confirmation (journal_id, target_assertion_id, status, note)"
        " VALUES ('j-c1', 'j-a3', 'confirmed', 'Видел то же самое.')"
    )

    # One quote per participant. Only the requester's own may travel.
    conn.execute(
        "INSERT INTO assertion_quote (journal_id, private_to_participant_id, source_record_id,"
        " quote_text, copied_at_utc) VALUES ('j-a1', ?, 'r-shared', ?, 2000)",
        (SELF, "сама залезла на диван"),
    )
    conn.execute(
        "INSERT INTO assertion_quote (journal_id, private_to_participant_id, source_record_id,"
        " quote_text, copied_at_utc) VALUES ('j-a-other-shared', ?, 'r-other', ?, 2400)",
        (OTHER, "цитата второго родителя"),
    )
    conn.commit()


def _attribute(
    conn: sqlite3.Connection,
    entry_id: str,
    author: str,
    attribute: str,
    value: str,
    *,
    entry_at_utc: int,
) -> None:
    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
        " VALUES (?, 'child_attribute', ?, ?, 'child_shared', 'authored', '2026-01-01', ?, 180)",
        (entry_id, author, CHILD, entry_at_utc),
    )
    conn.execute(
        "INSERT INTO child_attribute (journal_id, attribute, value, sensitive) VALUES (?, ?, ?, ?)",
        (entry_id, attribute, value, 1 if attribute.startswith("marker_") else 0),
    )


def _assertion(
    conn: sqlite3.Connection,
    entry_id: str,
    author: str,
    *,
    skill_id: str,
    kind: str,
    entry_at_utc: int,
    visibility: str = "child_shared",
    supersedes: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO journal_entry (id, kind, author_participant_id, subject_child_id,"
        " visibility_class, origin, event_date_local, entry_at_utc, entry_utc_offset_min)"
        " VALUES (?, 'assertion', ?, ?, ?, 'authored', '2026-01-01', ?, 180)",
        (entry_id, author, CHILD, visibility, entry_at_utc),
    )
    conn.execute(
        "INSERT INTO assertion (journal_id, kind, skill_id, effective_from_date,"
        " prerequisite_propagation, source_record_id, supersedes_assertion_id)"
        " VALUES (?, ?, ?, '2026-01-01', 'none', NULL, ?)",
        (entry_id, kind, skill_id, supersedes),
    )


def seeded_store() -> sqlite3.Connection:
    """A store with the frozen schema applied and the fixture family seeded."""
    conn = connect()
    apply_schema(conn)
    seed_family(conn)
    return conn
