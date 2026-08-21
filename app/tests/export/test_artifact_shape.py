"""The artifact's declared shape, checked against the artifact it actually writes.

These assertions fix a PUBLIC, long-lived commitment. Once an artifact carrying
a given `format_version` is in a family's hands, every one of these properties
has to keep holding — so they are written here, before the builder, rather than
derived from whatever the builder happened to produce.

The version is **2** since FIU-P4, and the bump is the reason the number exists:
v1 scoped diary records through their AREA, so another participant's entry in a
child-shared area was inside the promise; v2 scopes them by their AUTHOR, so it
never is. A reader decades from now can tell which rule an archive was written
under only from this number.
"""

from __future__ import annotations

import io
import json
import re
import sqlite3
import zipfile

from .harness import EXPORT_DIR, SELF, load_declaration
from .pdf_text import pdf_lines


def test_the_declaration_names_a_format_and_a_version() -> None:
    declaration = load_declaration()
    assert declaration["format"] == "theygrow-archive"
    assert declaration["format_version"] == 2
    assert declaration["schema_contract"] == "lsc-journal-v1"
    assert declaration["datasets"], "a declaration with no datasets describes nothing"
    assert declaration["files"], "a declaration with no files describes nothing"


def test_every_dataset_declares_its_own_parameters() -> None:
    """A query whose placeholders and declared parameters disagree binds wrongly.

    The failure mode this catches is not cosmetic: a scope-filtered query bound
    with one parameter too few raises, but one bound against the WRONG name would
    silently widen the export past the requesting participant.
    """
    for dataset in load_declaration()["datasets"]:
        placeholders = dataset["query"].count("?")
        assert placeholders == len(dataset["params"]), (
            f'dataset "{dataset["name"]}" has {placeholders} placeholders '
            f"and {len(dataset['params'])} declared parameters"
        )
        for name in dataset["params"]:
            assert name == "self_participant_id", (
                f'dataset "{dataset["name"]}" declares an unknown parameter "{name}"'
            )


def test_every_dataset_query_returns_exactly_its_declared_columns(
    store: sqlite3.Connection,
) -> None:
    """The declaration is the artifact's contract; the query is what fills it.

    If the two drift, the artifact carries a column no reader was told about, or
    promises one that never arrives. Either way a reader in 2044 is stuck, so the
    agreement is asserted against the real frozen schema rather than assumed.
    """
    for dataset in load_declaration()["datasets"]:
        cursor = store.execute(dataset["query"], [SELF] * len(dataset["params"]))
        actual = [column[0] for column in cursor.description]
        declared = [column["name"] for column in dataset["columns"]]
        assert actual == declared, (
            f'dataset "{dataset["name"]}" returns {actual}, declares {declared}'
        )


def test_every_declared_column_carries_a_human_explanation() -> None:
    """Self-describing means a person can read it, not just a parser."""
    for dataset in load_declaration()["datasets"]:
        assert dataset["description_ru"].strip(), f'dataset "{dataset["name"]}" has no description'
        for column in dataset["columns"]:
            explanation = column["description_ru"].strip()
            assert len(explanation) > 10, (
                f"column {dataset['name']}.{column['name']} has no usable explanation"
            )


def test_the_declaration_states_the_scope_and_the_media_exclusion() -> None:
    """Two promises the artifact has to make in its own words.

    Scope is a promise about OTHER people's private records, and it is stated in
    the published format rather than only in the code, so it cannot quietly widen
    when a second participant exists (L7).
    """
    declaration = load_declaration()
    assert declaration["scope"]["kind"] == "requesting_participant"
    assert declaration["scope"]["parameter"] == "self_participant_id"
    assert declaration["media"]["included"] is False
    assert declaration["media"]["statement_ru"].strip()


def test_the_artifact_holds_exactly_the_declared_files(artifact: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        present = [info.filename for info in archive.infolist()]
    declared = [entry["path"] for entry in load_declaration()["files"]]
    assert present == declared, "the artifact and its own file list disagree"


def test_every_entry_is_stored_uncompressed_and_time_pinned(artifact: bytes) -> None:
    """Determinism, asserted at the container level.

    A compressor is a second thing that has to still exist and still behave
    identically decades from now, and its output is not guaranteed stable across
    WebView versions — which would break byte-identity between two devices
    holding the same journal.
    """
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        for info in archive.infolist():
            assert info.compress_type == zipfile.ZIP_STORED, f"{info.filename} is compressed"
            assert info.date_time == (1980, 1, 1, 0, 0, 0), (
                f"{info.filename} carries a wall-clock timestamp"
            )


def test_the_manifest_carries_the_versions_that_produced_the_record(artifact: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        manifest = json.loads(archive.read("MANIFEST.json").decode("utf-8"))

    assert manifest["format"] == "theygrow-archive"
    assert manifest["format_version"] == 2
    # Which canon the skill identifiers were written against. Without it a
    # skill id is an opaque string.
    assert manifest["canon_version"] == 1
    assert manifest["app_version"] == "1.0.0"
    # Read from the device's own schema_meta, not from a build constant.
    assert manifest["schema_contract"] == "lsc-journal-v1"
    assert manifest["schema_version"] == 1
    assert manifest["scope"]["kind"] == "requesting_participant"
    assert manifest["scope"]["participant_id"] == SELF
    assert manifest["media_included"] is False
    assert manifest["encrypted"] is False
    assert manifest["exported_at_utc"] == 1_770_000_000_000
    assert manifest["counts"]["journal_entry"] > 0


def test_the_index_embeds_the_declaration_verbatim(artifact: bytes) -> None:
    """The property that makes the artifact readable without this repository.

    A copy of the declaration is what lets a reader interpret the data using only
    what the artifact says about itself. A paraphrase would drift; a verbatim copy
    cannot.
    """
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        index = json.loads(archive.read("index.json").decode("utf-8"))
    assert index["declaration"] == load_declaration()


def test_the_readme_states_the_two_things_a_parent_must_not_get_wrong(artifact: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        readme = archive.read("README.txt").decode("utf-8")

    # Media, and the absence of a cloud backup. Both are stated plainly in the
    # artifact itself, not only in the interface that produced it — a parent
    # opening this file in 2044 has no interface left to read.
    assert "Фотографии, видео и звукозаписи в архив не входят." in readme
    assert "Резервной копии этих данных в облаке нет." in readme
    # What opens it, since that is the whole point of a durable artifact.
    assert ".zip" in readme
    assert "index.json" in readme


def test_the_attachments_directory_says_why_it_is_empty(artifact: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        note = archive.read("attachments/README.txt").decode("utf-8")
    assert "не входят" in note


def test_no_file_in_the_artifact_is_empty(artifact: bytes) -> None:
    """An empty file reads as data loss to someone who cannot ask.

    text/diary.txt is the live case: the diary arrives on a later rung, so the
    file exists and says so in words rather than being zero bytes.
    """
    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        for info in archive.infolist():
            assert info.file_size > 0, f"{info.filename} is empty"


# --- the scope boundary and the page width (FIU-P4) ----------------------

# Every dataset that can carry text a PARTICIPANT wrote, and the predicate that
# is allowed to be the thing scoping it. The list is exhaustive on purpose: a
# dataset added later with a free-text column and no entry here fails, which
# forces the question "whose text is this, and what binds it" to be answered in
# the declaration rather than in a review comment.
TEXT_BEARING = {
    # FIU-P4: the diary. Bound to the AUTHOR of the entry, not to the area it
    # sits in — see scope.diary.
    "record": "r.author_participant_id = ?",
    # The fragment copied out of a record at confirmation time; private by
    # construction since L1-P2.
    "assertion_quote": "private_to_participant_id = ?",
}

# Free-text columns, by the name a participant's own words arrive under. `note`
# is deliberately absent from TEXT_BEARING above and present here: a note on a
# SHARED assertion is an act in the shared journal — the archive is supposed to
# carry the co-parent's «Видел то же самое.» — so its dataset is scoped by
# visibility, and this list existing is what makes that a decision rather than
# an oversight.
FREE_TEXT_COLUMNS = {"body", "quote_text", "note"}


def test_the_declaration_binds_diary_text_to_its_author() -> None:
    """The scope rule, as a property of the published declaration.

    STATIC, and it says so: this reads the declaration's text and executes
    nothing. The runtime arm — a second participant's entry seeded into the
    shared area and absent from every layer of a built archive — is
    `test_artifact_selfdescribing.py::test_another_participants_diary_entry_never_travels`.
    What this one adds is that the boundary is IN THE QUERY, where it cannot be
    undone by a renderer, and stated in the artifact's own words.
    """
    declaration = load_declaration()

    diary = declaration["scope"]["diary"]
    assert diary["predicate"] == "record.author_participant_id = self_participant_id"
    assert "author_participant_id" in diary["statement_ru"]
    assert diary["statement_en"].strip()

    by_name = {dataset["name"]: dataset for dataset in declaration["datasets"]}
    record = by_name["record"]
    assert "r.author_participant_id = ?" in record["query"]
    # The area-scoped predicates are GONE, not merely joined by a second one: a
    # filter that still mentions them reads as though they were load-bearing.
    assert "visibility_class" not in record["query"]
    assert "owner_participant_id" not in record["query"]
    assert record["params"] == ["self_participant_id"]

    for dataset in declaration["datasets"]:
        columns = {column["name"] for column in dataset["columns"]}
        if not columns & FREE_TEXT_COLUMNS:
            continue
        expected = TEXT_BEARING.get(dataset["name"])
        if expected is None:
            assert "visibility_class" in dataset["query"], (
                f'dataset "{dataset["name"]}" carries free text, is not bound to the requesting'
                " participant, and is not scoped by visibility either"
            )
            continue
        assert expected in dataset["query"], (
            f'dataset "{dataset["name"]}" carries free text and does not bind {expected}'
        )
        assert "self_participant_id" in dataset["params"]


def _declared_line_width() -> int:
    """The shipped knob, read out of the module that owns it.

    Not a second copy of 78: `EXPORT_CONFIG.textLineWidth` is the one place the
    width is decided, and a test carrying its own literal would keep passing
    after someone changed it.
    """
    source = (EXPORT_DIR / "config.js").read_text(encoding="utf-8")
    match = re.search(r"textLineWidth: (\d+)", source)
    assert match, "export/config.js no longer declares textLineWidth"
    return int(match.group(1))


def test_no_line_in_a_text_file_is_wider_than_the_page(artifact: bytes) -> None:
    """A line nobody can read is a line that is not there (FIU-P4).

    Measured before this packet: one diary entry containing a 300-character
    unbroken token produced a 300-character line in `text/diary.txt` and a single
    300-glyph line in the print layer, which runs off an A4 page and is simply
    gone. The text layer is where the fix lives, and this is the assertion that
    holds it: `pdf.js` lays out what these files contain and never joins two
    input lines, so bounding the line here bounds the printed page — which the
    second half of this test checks rather than assumes.
    """
    width = _declared_line_width()

    with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
        names = [info.filename for info in archive.infolist() if info.filename.endswith(".txt")]
        for name in names:
            for number, line in enumerate(archive.read(name).decode("utf-8").split("\n"), 1):
                assert len(line) <= width, f"{name}:{number} is {len(line)} characters wide"
        printed = pdf_lines(archive.read("print/archive.pdf"))

    assert names, "no text files in the artifact — this test would pass vacuously"
    assert printed, "no printed lines — this test would pass vacuously"
    for line in printed:
        assert len(line) <= width, f"a printed line is {len(line)} characters wide: {line[:40]}…"
