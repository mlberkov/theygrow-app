"""The artifact's declared shape, checked against the artifact it actually writes.

These assertions fix a PUBLIC, long-lived commitment. Once an artifact carrying
`format_version: 1` is in a family's hands, every one of these properties has to
keep holding — so they are written here, before the builder, rather than derived
from whatever the builder happened to produce.
"""

from __future__ import annotations

import io
import json
import sqlite3
import zipfile

from .harness import SELF, load_declaration


def test_the_declaration_names_a_format_and_a_version() -> None:
    declaration = load_declaration()
    assert declaration["format"] == "theygrow-archive"
    assert declaration["format_version"] == 1
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
    assert manifest["format_version"] == 1
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
