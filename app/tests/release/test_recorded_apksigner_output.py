"""RSN-P4 — the comparator against bytes a real apksigner actually printed.

WHY THIS SUITE EXISTS. Every other comparand in `app/tests/release` is output
this repository wrote, and that is precisely why the detector could stay green
here for two packets while returning 4 on every real run: the suite tested the
shapes the repository believed in, and the shape build-tools 37.0.0 prints was
not one of them. `fixtures/apksigner-buildtools-37.0.0.txt` is the run's own
stdout, transcribed from the log of CI run 31896998977.

WHAT IT PROVES. That the parser reads the recorded shape, and — the half that
matters more — that it refuses the five near-misses standing beside the answer in
that same output. One of those five is a 64-hex public-key digest: same length,
same shape, different key. A comparator that read it would satisfy the letter of
ADR-047 detector (a) and defeat its purpose, and it would do so by returning
GREEN, which is the worst available outcome for this check.

WHAT IT DOES NOT PROVE. That apksigner still prints this. These bytes are one
tool, one version, one image, one day. "The comparator returns exactly 3 against
a foreign certificate, on a real APK, with the real tool" is executed by the
`android` job in `.github/workflows/ci.yml` and by nothing here.

THE DIGESTS BELOW ARE A DEBUG KEY'S, MINTED PER RUN. They are pinned as literals
so that this suite says out loud which line it expects each value to come from —
not because the values mean anything. Nothing here may ever be compared against
the release baseline.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from release.harness import recorded_output

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "verify_release_signature.py"

FIXTURE = "apksigner-buildtools-37.0.0.txt"

# Mirrored from the script under test, as the sibling suites mirror them: a
# renumbering is a contract change for two workflows and should red here.
EXIT_OK = 0
EXIT_MISMATCH = 3
EXIT_UNPARSEABLE = 4

# What the run reported about its own stdout. Asserted, so a transcription that
# lost or gained a line reds instead of silently becoming a fixture of something
# no tool ever printed.
RECORDED_BYTES = 1026
RECORDED_LINES = 18

# The answer: the `certificate SHA-256 digest` line.
CERT_SHA256 = "b31b2c7312fcd55a8f3b21046332a38fabb5b76345367fb958294ac1c15faccf"

# THE CATASTROPHIC NEAR-MISS. Same 64 hex characters of shape, three lines below
# the answer in the same block, and the digest of a different thing.
PUBLIC_KEY_SHA256 = "56879f9be4c700c6958403ee42d3c8634df191116eb2f741460398c5eddf50ed"

FOREIGN = "9" * 64


def run_comparator(
    certs_output: str, baseline: str, tmp_path: Path
) -> subprocess.CompletedProcess[str]:
    """Drive the CLI seam, which is the contract the two workflows branch on."""
    certs_file = tmp_path / "certs.txt"
    certs_file.write_text(certs_output, encoding="utf-8")
    baseline_file = tmp_path / "baseline.txt"
    baseline_file.write_text(f"{baseline}\n", encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--certs-output",
            str(certs_file),
            "--baseline",
            str(baseline_file),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


# --------------------------------------------------------------------------
# The fixture is the recorded bytes, and is still the shape that broke us.
# --------------------------------------------------------------------------


def test_the_fixture_matches_the_byte_and_line_count_the_run_reported() -> None:
    """Transcription integrity, against figures the tool itself produced."""
    body = recorded_output(FIXTURE)
    assert len(body.encode("utf-8")) == RECORDED_BYTES
    assert len(body.splitlines()) == RECORDED_LINES


def test_the_fixture_carries_the_scheme_qualified_unnumbered_shape() -> None:
    """Guards the fixture against being tidied into the shape that already worked.

    If someone "corrects" these lines to `Signer #1 certificate SHA-256 digest:`,
    every other test in this file still passes and the file stops pinning the only
    thing it exists to pin. That is the vacuous-fixture defect class this
    repository has already paid for four times (`AGENTS.md` §11).
    """
    body = recorded_output(FIXTURE)
    assert f"V2 Signer: certificate SHA-256 digest: {CERT_SHA256}" in body
    assert "Signer #" not in body


def test_the_header_is_stripped_and_never_reaches_the_parser() -> None:
    body = recorded_output(FIXTURE)
    assert not body.startswith("#")
    assert "PROVENANCE" not in body
    assert body.startswith("Verifies\n")


# --------------------------------------------------------------------------
# The verdict, on the real shape.
# --------------------------------------------------------------------------


def test_the_recorded_output_yields_the_certificate_digest(tmp_path: Path) -> None:
    """The repair, stated as the thing that was broken: exit 4 before, 0 now."""
    result = run_comparator(recorded_output(FIXTURE), CERT_SHA256, tmp_path)
    assert result.returncode == EXIT_OK
    assert "THEYGROW_RELEASE_CERT_OK" in result.stdout
    assert CERT_SHA256 in result.stdout


def test_the_recorded_output_is_a_mismatch_against_a_foreign_baseline(tmp_path: Path) -> None:
    result = run_comparator(recorded_output(FIXTURE), FOREIGN, tmp_path)
    assert result.returncode == EXIT_MISMATCH
    assert "THEYGROW_RELEASE_CERT_MISMATCH" in result.stderr
    assert CERT_SHA256 in result.stderr


def test_the_public_key_digest_is_never_the_answer(tmp_path: Path) -> None:
    """THE test this packet exists to make possible, stated positively.

    Baseline set to the public-key SHA-256 that sits three lines below the answer
    in the very same block. A comparator reading that line would return 0 here —
    a green verdict on a key that never signed anything. It must return 3, and it
    must report the CERTIFICATE digest as what it saw.
    """
    result = run_comparator(recorded_output(FIXTURE), PUBLIC_KEY_SHA256, tmp_path)
    assert result.returncode == EXIT_MISMATCH
    assert f"apksigner reported: {CERT_SHA256}" in result.stderr
    assert f"baseline expects:   {PUBLIC_KEY_SHA256}" in result.stderr


# --------------------------------------------------------------------------
# The five near-misses, each refused on its own.
# --------------------------------------------------------------------------

HEADER = "Verifies\nNumber of signers: 1\n"

NEAR_MISSES = {
    "certificate-sha1": (
        "V2 Signer: certificate SHA-1 digest: c76b496a62cc6080d3ba33ab3de870f40a519632"
    ),
    "certificate-md5": "V2 Signer: certificate MD5 digest: 6d3422eca24ac0602b74f313abd24ef4",
    "public-key-sha256": f"V2 Signer: public key SHA-256 digest: {PUBLIC_KEY_SHA256}",
    "public-key-sha1": (
        "V2 Signer: public key SHA-1 digest: bfba9e4b60477280da2843b4cfa9269687e2b1b2"
    ),
    "public-key-md5": "V2 Signer: public key MD5 digest: 603592de54da9d88a7236b03efda8573",
}


@pytest.mark.parametrize("line", list(NEAR_MISSES.values()), ids=list(NEAR_MISSES))
def test_a_near_miss_line_alone_is_never_read_as_the_certificate(line: str, tmp_path: Path) -> None:
    """Every line in the recorded block that is a digest but not THE digest.

    Lifted verbatim from the fixture. Each one, alone with the header, must be
    unparseable — never a match, and never a comparison against whatever hex it
    happens to carry.
    """
    result = run_comparator(f"{HEADER}{line}\n", CERT_SHA256, tmp_path)
    assert result.returncode == EXIT_UNPARSEABLE
    assert "THEYGROW_RELEASE_CERT_UNPARSEABLE" in result.stderr


def test_the_recorded_output_without_its_certificate_line_is_unparseable(tmp_path: Path) -> None:
    """The five together, in situ: remove the answer and nothing else may stand in.

    The per-line cases above prove each near-miss is refused in isolation. This
    proves the parser does not fall back to one of them when they are all present
    and the line it wants is gone — which is the arrangement a real APK produces.
    """
    body = recorded_output(FIXTURE)
    without = "\n".join(
        line for line in body.splitlines() if "certificate SHA-256 digest:" not in line
    )
    assert PUBLIC_KEY_SHA256 in without  # the decoys are still all there
    result = run_comparator(f"{without}\n", CERT_SHA256, tmp_path)
    assert result.returncode == EXIT_UNPARSEABLE


def test_a_signer_line_never_reaches_a_digest_line_below_it(tmp_path: Path) -> None:
    """The class in the pattern must not span lines.

    `[^:]` matches newlines, so under re.MULTILINE — where the anchors are
    per-line but the class is not — a `Signer` line could be stitched to a
    `certificate SHA-256 digest:` line further down whenever no colon fell in
    between, reading a digest that is not on the signer line at all. Real output
    always intervenes a colon, which makes this latent rather than live, and
    latent is what surfaces on the next tool version.
    """
    stitched = f"{HEADER}V2 Signer\ncertificate SHA-256 digest: {CERT_SHA256}\n"
    result = run_comparator(stitched, CERT_SHA256, tmp_path)
    assert result.returncode == EXIT_UNPARSEABLE
