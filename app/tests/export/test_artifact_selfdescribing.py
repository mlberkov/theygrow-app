"""Read the artifact using only what the artifact declares about itself.

The requirement this closes is PDR-026 §4's fifth accompanying rule — the export
stays human-readable and self-describing for years, without the app. A test that
imported the app's own modules to read the artifact would prove nothing about
that, so the reader (`blind_reader.py`) imports only the standard library and
takes every structural fact out of the archive's embedded declaration.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

from .blind_reader import Artifact
from .harness import OTHER, SELF
from .pdf_text import REPLACEMENT, pdf_text

READER_SOURCE = Path(__file__).resolve().parent / "blind_reader.py"


def test_the_reader_imports_nothing_but_the_standard_library() -> None:
    """Anti-vacuity: the whole proof rests on the reader being genuinely blind.

    Asserted structurally rather than trusted, because an import added later
    would quietly turn every assertion below into a statement about this
    repository instead of about the artifact.
    """
    tree = ast.parse(READER_SOURCE.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "the blind reader may not import from this package"
            assert node.module is not None
            imported.add(node.module.split(".")[0])

    stdlib = set(sys.stdlib_module_names)
    outside = sorted(name for name in imported if name not in stdlib)
    assert not outside, f"the blind reader reaches outside the standard library: {outside}"


def test_a_blind_reader_finds_every_declared_dataset(artifact: bytes) -> None:
    archive = Artifact(artifact)
    for name in archive.dataset_names():
        rows = archive.rows(name)
        declared = archive.columns_of(name)
        for row in rows:
            assert list(row.keys()) == declared, (
                f"row of {name} does not match the columns the artifact declares"
            )


def test_a_blind_reader_finds_every_declared_file(artifact: bytes) -> None:
    archive = Artifact(artifact)
    for path in archive.declared_file_paths():
        assert archive.raw(path), f"the artifact declares {path} but it is unreadable"
        # Everything except the print layer is UTF-8 text a person can open in
        # any editor; the declaration says which one is not.
        if path != archive.declaration["print_layer"]["path"]:
            assert archive.text_file(path), f"{path} is not readable as UTF-8 text"


def test_a_blind_reader_can_rebuild_the_journal(artifact: bytes) -> None:
    """The one join the format asks a reader to make, made from the declaration."""
    archive = Artifact(artifact)
    journal = archive.journal()

    assert journal, "the artifact carries no journal"
    for entry in journal:
        assert entry["detail"] is not None, f"entry {entry['id']} has no detail row"

    # The seeded history, read back out: a name set once and changed later, with
    # BOTH events surviving — which is what "append-only" has to look like from
    # the outside.
    names = [
        entry["detail"]["value"]
        for entry in journal
        if entry["detail_dataset"] == "child_attribute" and entry["detail"]["attribute"] == "name"
    ]
    assert names == ["Мия", "Мия Александровна"], names

    # A skill observed and later revoked: both assertions are still there.
    skill_1 = [
        entry["detail"]["kind"]
        for entry in journal
        if entry["detail_dataset"] == "assertion" and entry["detail"]["skill_id"] == "skill-1"
    ]
    assert skill_1 == ["skill_observed", "skill_revoked"], skill_1


def test_the_journal_is_ordered_the_way_the_artifact_says_it_is(artifact: bytes) -> None:
    """Order is `(entry_at_utc, id)`, never the device's local arrival order.

    Local arrival order is assigned differently by two devices holding identical
    histories, so an artifact ordered by it would differ between them. The pair
    below is what every replica computes identically.
    """
    archive = Artifact(artifact)
    keys = [(entry["entry_at_utc"], entry["id"]) for entry in archive.rows("journal_entry")]
    assert keys == sorted(keys)
    # And the device-local sequence number is not in the artifact at all.
    assert "seq" not in archive.columns_of("journal_entry")


def test_the_derived_state_agrees_with_the_journal_it_came_from(artifact: bytes) -> None:
    archive = Artifact(artifact)
    state = {row["skill_id"]: row["state"] for row in archive.rows("child_skill_state")}

    # The later assertion wins; the earlier one is still in the journal.
    assert state["skill-1"] == "skill_revoked"
    assert state["skill-2"] == "skill_observed"

    current = {row["attribute"]: row["value"] for row in archive.rows("child_attribute_current")}
    assert current["name"] == "Мия Александровна"
    assert current["birthdate"] == "2025-06-01"
    # A declarative marker stays readable and stays flagged.
    marker = [
        row
        for row in archive.rows("child_attribute_current")
        if row["attribute"] == "marker_bilingual"
    ]
    assert marker and marker[0]["sensitive"] == 1


def test_the_archive_holds_the_requesters_own_private_records(artifact: bytes) -> None:
    """Scope-by-requester, the half that must be present.

    The parent's own private records belong in the parent's own archive; an
    export that withheld them would be a backup with a hole in it.
    """
    archive = Artifact(artifact)
    skills = {row["skill_id"] for row in archive.rows("child_skill_state")}
    assert "skill-3" in skills, "the requester's own private assertion is missing"

    quotes = archive.rows("assertion_quote")
    assert [row["private_to_participant_id"] for row in quotes] == [SELF]
    assert "сама залезла на диван" in quotes[0]["quote_text"]

    areas = {row["id"] for row in archive.rows("area")}
    assert "a-self" in areas
    bodies = {row["id"] for row in archive.rows("record")}
    assert "r-self" in bodies


def test_the_archive_holds_no_other_participants_private_records(artifact: bytes) -> None:
    """Scope-by-requester, the half that must be absent.

    On this rung there is one participant, so this assertion costs nothing today.
    It exists because the published format is a long-lived promise: when a second
    participant arrives (L7), a format that had promised "all private areas"
    would already have committed us to putting a co-parent's private records into
    someone else's archive.
    """
    archive = Artifact(artifact)

    skills = {row["skill_id"] for row in archive.rows("child_skill_state")}
    assert "skill-4" not in skills, "another participant's private assertion leaked"
    assert "skill-5" in skills, "another participant's SHARED assertion should be present"

    journal_ids = {entry["id"] for entry in archive.rows("journal_entry")}
    assert "j-a-other-private" not in journal_ids
    assert "j-a-other-shared" in journal_ids

    assert {row["id"] for row in archive.rows("area")}.isdisjoint({"a-other"})
    assert {row["id"] for row in archive.rows("record")}.isdisjoint({"r-other"})
    assert all(row["private_to_participant_id"] != OTHER for row in archive.rows("assertion_quote"))

    # And nowhere in the bytes, not merely absent from the parsed datasets: a
    # leak into a rendered text file would pass every assertion above.
    assert "цитата второго родителя" not in artifact.decode("utf-8", errors="ignore")
    assert "Личная заметка второго родителя" not in artifact.decode("utf-8", errors="ignore")


def test_the_text_files_are_readable_on_their_own(artifact: bytes) -> None:
    """The text half of "self-describing": no parser, no app, just reading."""
    archive = Artifact(artifact)

    children = archive.text_file("text/children.txt")
    assert "Мия Александровна" in children

    journal = archive.text_file("text/journal.txt")
    assert "skill-1" in journal
    # Every text file names the dataset it renders, so a reader can find the
    # field explanations for what they are looking at.
    assert "child_attribute" in journal

    skills = archive.text_file("text/skills.txt")
    assert "skill-2" in skills

    diary = archive.text_file("text/diary.txt")
    assert "Сегодня сама залезла на диван." in diary

    # The empty case is worded as a fact about the source, not as an apology.
    participants = archive.text_file("text/participants.txt")
    assert SELF in participants


# --- the diary (FIU-P4) --------------------------------------------------
#
# THE PACKET'S ONE RULE THAT CANNOT BE GOT WRONG, and the two halves of it. What
# these tests are worth rests entirely on the fixture: `seed_family` seeds the
# other participant's entry in the CHILD-SHARED area, which is the row the
# pre-packet, area-scoped filter handed over. Against that query the first test
# below fails in four places at once — the parsed dataset, the rendered text
# file, the print layer and the manifest's own count.


def test_another_participants_diary_entry_never_travels(artifact: bytes) -> None:
    """The scope rule, armed against the case that used to pass by accident.

    `r-other` sits in the other participant's PRIVATE area, so withholding it
    proves nothing about a filter: an area-scoped one withholds it too.
    `r-other-shared` is the same participant's entry in the area BOTH parents
    share, and that is the row a rule about areas gets wrong and a rule about
    authors cannot. Every layer is checked separately, because a filter can be
    right about the data and a renderer wrong about the page.
    """
    archive = Artifact(artifact)
    theirs = "Личный текст второго родителя в общей области."

    assert {row["id"] for row in archive.rows("record")}.isdisjoint({"r-other", "r-other-shared"})
    assert all(row["author_participant_id"] == SELF for row in archive.rows("record"))

    # The rendered half. A leak into text/diary.txt would satisfy every
    # assertion above and still be a leak.
    assert theirs not in archive.text_file("text/diary.txt")
    assert theirs not in artifact.decode("utf-8", errors="ignore")

    # The printed half, decoded through the file's own /ToUnicode map — a
    # substring search over PDF bytes would pass whether the text is there or
    # not, because the page carries glyph ids rather than characters.
    assert theirs not in pdf_text(archive.raw("print/archive.pdf"))

    # And the count, which is a leak of its own: a total that includes entries
    # the archive does not carry says how many the other participant wrote.
    assert archive.manifest["counts"]["record"] == len(archive.rows("record"))


def test_the_requesters_own_diary_reaches_every_layer(artifact: bytes) -> None:
    """The other half — the one a filter that exports nothing would also pass.

    The archive exists to keep what the parent wrote; a scope rule bought by
    withholding their own text would be the same failure wearing a safer face.
    """
    archive = Artifact(artifact)
    ours = "Личная заметка родителя."

    assert {row["id"] for row in archive.rows("record")} == {"r-self", "r-shared", "r-edge"}
    assert ours in archive.text_file("text/diary.txt")
    assert ours in pdf_text(archive.raw("print/archive.pdf"))
    # Own text out of the SHARED area travels too: the rule binds the author, not
    # the container, and withholding this row would lose a parent their own words.
    assert "Сегодня сама залезла на диван." in archive.text_file("text/diary.txt")


def test_the_diary_file_reads_as_a_diary(artifact: bytes) -> None:
    """What the packet is for: "what did I write about my child", answered.

    The entry comes first, under the day it is about, wrapped as prose — not as
    the fifth field of a thirteen-field record. And the ordering is what makes a
    line INSIDE an entry unmistakable: a parent who writes `  id: ...` on a line
    of their own is quoting themselves, and the file must not render that as a
    field of the record.
    """
    archive = Artifact(artifact)
    diary = archive.text_file("text/diary.txt")

    assert "--- запись 1 из 3 — 2026-01-01 ---" in diary
    assert "поля записи (её текст приведён выше):" in diary
    # The body is no longer rendered as a `body:` field at all.
    assert "  body:" not in diary

    entry = diary.split("--- запись 3 из 3 — 2026-01-04 ---")[1]
    text, fields = entry.split("поля записи (её текст приведён выше):")
    assert "Первая строка про подоконник." in text
    assert "id: это не поле, это текст" in text
    # The forged line is in the TEXT half and the field half still reports the
    # record's real id, so nothing a parent types can rename their own entry.
    assert "id: r-edge" in fields
    assert "это не поле" not in fields


def test_a_codepoint_the_font_does_not_cover_degrades_only_in_the_print_layer(
    artifact: bytes,
) -> None:
    """ADR-015 in the artifact's own words, executed on a real uncovered glyph.

    `declaration.print_layer.authority_ru` promises exactly this: the text files
    and index.json carry the character a parent typed, the PDF carries U+FFFD in
    its place, and the declaration says which of the two is authoritative. PT
    Sans covers no emoji, so the fixture's 🙂 is the case.
    """
    archive = Artifact(artifact)
    body = next(row["body"] for row in archive.rows("record") if row["id"] == "r-edge")

    assert "🙂" in body
    assert "🙂" in archive.text_file("text/diary.txt")

    printed = pdf_text(archive.raw("print/archive.pdf"))
    assert "🙂" not in printed
    assert REPLACEMENT in printed
    assert "и хвост" in printed, "the surrounding sentence still prints"
