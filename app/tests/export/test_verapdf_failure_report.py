"""FIU-P5 — the CI failure evidence, executed off a recorded report.

WHY THIS SUITE EXISTS. `scripts/verapdf_failures.py` runs in exactly one place:
the failing branch of a job that runs on `pull_request` and `workflow_dispatch`
only. If its correctness were left to that branch, the first time anyone found
out whether it prints anything useful would be the next red conformance run —
which is the same shape of gap this packet exists to close, one level up. So it
is executed here, against the report a real veraPDF really wrote on the real
failure (`fixtures/verapdf-mrr-32530473473.xml`), on every push.

WHY SUBPROCESS AND NOT IMPORT, the `app/tests/release/test_verify_release_signature.py`
reason: the contract the workflow depends on is the CLI one — argv in, stdout
and an exit code out. Calling `report()` directly would leave the layer CI
actually invokes unexecuted, including the promise that this thing never fails a
step it was only asked to explain.

WHAT IT PROVES AND DOES NOT. It proves the extractor reads the SHAPE veraPDF
1.30.2 emitted once, on one day, for one rule. It does not prove veraPDF still
emits it — that claim belongs to the `android-instrumented` job and to nothing
here — and it proves nothing whatever about the PDF being conformant.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "verapdf_failures.py"
RECORDED = Path(__file__).resolve().parent / "fixtures" / "verapdf-mrr-32530473473.xml"

# The clause the recorded report failed on. Pinned because it is a property of
# THIS FIXTURE's bytes, which do not change. Nothing environment-generated is
# pinned anywhere in this file — see the fixture's own header for the list.
RECORDED_CLAUSE = "6.2.11.8"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    """Drive the script exactly as .github/workflows/ci.yml drives it."""
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _clean_report(tmp_path: Path) -> Path:
    """A compliant report, synthesised — the passing shape, in the fewest bytes."""
    path = tmp_path / "clean.xml"
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<report><jobs><job>"
        '<validationReport isCompliant="true">'
        '<details passedRules="144" failedRules="0" passedChecks="2892" failedChecks="0">'
        "</details></validationReport>"
        "</job></jobs></report>",
        encoding="utf-8",
    )
    return path


def test_the_recorded_failure_is_named_by_clause_test_number_and_description() -> None:
    """The four things the red run of 32530473473 did not print.

    Run 32530473473 printed `failedRules=1 failedChecks=1` and stopped. Which
    rule, on what object, and why, came out of the `pdfa-validation` artifact by
    hand afterwards. These are those four things, out of that same report.
    """
    result = run(str(RECORDED))
    assert result.returncode == 0, result.stderr
    out = result.stdout

    assert "ISO 19005-2:2011" in out
    assert f"clause {RECORDED_CLAUSE}" in out
    assert "test 1" in out
    assert ".notdef" in out, "the rule's description is not in the output"
    assert "text showing operators" in out, "the description is truncated away"


def test_the_first_failing_context_is_printed() -> None:
    """The object path — without it a reader knows the rule and not the place."""
    out = run(str(RECORDED)).stdout
    context = next((line for line in out.splitlines() if line.strip().startswith("context:")), None)
    assert context, f"no context line in the output:\n{out}"
    # The FORM, not the values: a veraPDF context is a path from the document
    # root. Pinning the page index or the object number would pin this fixture's
    # accident rather than the extractor's behaviour.
    assert "root/document" in context
    assert "contentStream" in context


def test_it_prints_nothing_at_all_for_a_compliant_report(tmp_path: Path) -> None:
    """The reason it is safe to invoke unconditionally.

    The workflow calls it on every run, before the verdict block. If it spoke on
    a green run it would be noise in every passing log; if it exited non-zero it
    would be a second gate nobody declared.
    """
    result = run(str(_clean_report(tmp_path)))
    assert result.stdout == "", result.stdout
    assert result.returncode == 0


def test_an_unreadable_report_is_explained_and_never_fails_the_step(tmp_path: Path) -> None:
    """Evidence, not a verdict: the verdict step already fails on this by itself.

    Both directions are executed — a file that is not there, and a file that is
    there and is not XML — because a crash in either would turn a readable
    conformance failure into an unreadable traceback above it.
    """
    missing = run(str(tmp_path / "absent.xml"))
    assert missing.returncode == 0, missing.stderr
    assert "could not be read" in missing.stdout

    truncated = tmp_path / "truncated.xml"
    truncated.write_text("<report><jobs><job>", encoding="utf-8")
    broken = run(str(truncated))
    assert broken.returncode == 0, broken.stderr
    assert "could not be read" in broken.stdout


def test_a_failing_rule_with_no_failed_check_is_stated_rather_than_dropped(
    tmp_path: Path,
) -> None:
    """The recorded report's own bytes, with the evidence half removed.

    A rule element carrying no `<check>` is a shape this repository has not seen
    from veraPDF. The extractor must still name the rule and say the context is
    absent, because printing the rule alone would read as "the report declined to
    say where", and printing nothing would lose the failure entirely.
    """
    stripped = tmp_path / "no-checks.xml"
    text = RECORDED.read_text(encoding="utf-8")
    start, end = text.index("<check"), text.index("</check>") + len("</check>")
    stripped.write_text(text[:start] + text[end:], encoding="utf-8")

    out = run(str(stripped)).stdout
    assert f"clause {RECORDED_CLAUSE}" in out
    assert "lists no failed check" in out


def test_the_output_is_bounded_and_says_what_it_withheld(tmp_path: Path) -> None:
    """No silent cap. A bound that does not announce itself reads as completeness."""
    rule = (
        '<rule specification="ISO 19005-2:2011" clause="6.{0}.1" testNumber="1"'
        ' status="failed" failedChecks="2"><description>synthetic {0}</description>'
        '<check status="failed"><context>root/document[0]/pages[{0}]</context></check>'
        '<check status="failed"><context>root/document[0]/pages[{0}]/second</context></check>'
        "</rule>"
    )
    many = tmp_path / "many.xml"
    many.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<report><jobs><job>'
        '<validationReport isCompliant="false"><details failedRules="20">'
        + "".join(rule.format(n) for n in range(20))
        + "</details></validationReport></job></jobs></report>",
        encoding="utf-8",
    )

    out = run(str(many), "--max-rules", "3").stdout
    assert out.count("::error::PDF/A rule") == 3, out
    assert "20 failing rule(s)" in out
    assert "17 further failing rule(s) not shown" in out
    # The per-rule context bound announces itself too.
    assert "1 further failed check(s)" in out
