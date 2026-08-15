"""RSN-P2 — the secret-free proof that the release signature detector can go RED.

WHY THIS SUITE EXISTS. The release workflow's positive verdict ("this APK is
signed by our key") can only ever be executed on an owner-triggered run holding
the real keystore secret. A detector nobody can watch fail is not a detector, so
its ability to FAIL is executed here instead, with no secrets and no Android SDK.

WHY SUBPROCESS AND NOT IMPORT. The contract the two workflows depend on is the
CLI one — argv in, exit code and token out. Calling `evaluate()` directly would
leave the exit-code mapping, which is the layer CI actually branches on,
unexecuted. So the tests drive exactly the entry point CI drives.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from release.harness import apksigner_output, sdk_range_output

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "verify_release_signature.py"
COMMITTED_BASELINE = REPO_ROOT / "native" / "android" / "release-signing" / "cert-sha256.txt"

# The release certificate's SHA-256, normalised. Pinned as a literal so that an
# accidental edit to the committed baseline is caught here rather than on the
# owner's release run.
EXPECTED = "e0872f0ab88e3ebc30dd3d5cf2378d89b95355ba8eea2b1e9fbd8f8cf4b2b942"

# Differs from EXPECTED in the last nibble only. A detector that compares
# anything less than the whole fingerprint passes this and must not.
ONE_NIBBLE_OFF = EXPECTED[:-1] + "3"

# Exit codes, mirrored from the script under test. Deliberately re-stated rather
# than imported: if the script renumbers them, that is a contract change for the
# two workflows, and this suite should go red rather than follow along.
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_MISMATCH = 3
EXIT_UNPARSEABLE = 4
EXIT_BASELINE_INVALID = 5
EXIT_MULTIPLE_SIGNERS = 6


def run_comparator(
    certs_output: str, baseline: Path, tmp_path: Path
) -> subprocess.CompletedProcess[str]:
    """Drive the script exactly as CI drives it, via its `--certs-output` seam."""
    certs_file = tmp_path / "certs.txt"
    certs_file.write_text(certs_output, encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--certs-output",
            str(certs_file),
            "--baseline",
            str(baseline),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def write_baseline(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "baseline.txt"
    path.write_text(content, encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# The committed baseline itself.
# --------------------------------------------------------------------------


def test_committed_baseline_is_the_expected_fingerprint() -> None:
    """The file that ships is parseable and holds the value this suite pins."""
    assert COMMITTED_BASELINE.is_file()
    body = COMMITTED_BASELINE.read_text(encoding="utf-8")
    fingerprints = [
        line.split("#", 1)[0].strip() for line in body.splitlines() if line.split("#", 1)[0].strip()
    ]
    assert len(fingerprints) == 1
    assert fingerprints[0].replace(":", "").lower() == EXPECTED


def test_committed_baseline_is_documented_as_public() -> None:
    """It is a fingerprint, not key material, and the file must keep saying so.

    A future reader who mistakes this for a secret and moves it into the Actions
    store destroys the detector: the expected value would then live in the same
    place as the key it checks.
    """
    body = COMMITTED_BASELINE.read_text(encoding="utf-8")
    assert "PUBLIC" in body
    assert "Never move it into an Actions secret" in body


# --------------------------------------------------------------------------
# The verdict.
# --------------------------------------------------------------------------


def test_accepts_the_expected_certificate(tmp_path: Path) -> None:
    result = run_comparator(apksigner_output(EXPECTED), COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_OK
    assert "THEYGROW_RELEASE_CERT_OK" in result.stdout
    assert EXPECTED in result.stdout


def test_rejects_a_wrong_certificate(tmp_path: Path) -> None:
    """THE required negative test: a wrong fingerprint turns the run red."""
    result = run_comparator(apksigner_output(ONE_NIBBLE_OFF), COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_MISMATCH
    assert "THEYGROW_RELEASE_CERT_MISMATCH" in result.stderr


def test_mismatch_reports_both_sides_labelled(tmp_path: Path) -> None:
    """A mismatch has two possible causes; one look must distinguish them.

    Either the committed baseline is wrong, or the keystore is not the key the
    fingerprint came from. Printing only one side would cost a second run — and
    on the release workflow, a second run is another run that touches the
    keystore secret.
    """
    result = run_comparator(apksigner_output(ONE_NIBBLE_OFF), COMMITTED_BASELINE, tmp_path)
    assert "apksigner reported:" in result.stderr
    assert ONE_NIBBLE_OFF in result.stderr
    assert "baseline expects:" in result.stderr
    assert EXPECTED in result.stderr


# --------------------------------------------------------------------------
# Normalisation, in both directions.
# --------------------------------------------------------------------------


def test_accepts_uppercase_apksigner_output(tmp_path: Path) -> None:
    """Case is normalised on the apksigner side.

    Colons are NOT tolerated here on purpose: apksigner prints bare hex and
    never a colon-separated digest, so accepting that shape would widen the
    parser to a format the tool cannot emit, at the cost of the unparseable
    signal. Colons occur on the baseline side, and are normalised there.
    """
    result = run_comparator(apksigner_output(EXPECTED.upper()), COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_OK


def test_rejects_a_colon_separated_digest_as_unparseable(tmp_path: Path) -> None:
    """Output apksigner cannot produce is not silently accepted."""
    colonised = ":".join(EXPECTED[i : i + 2] for i in range(0, len(EXPECTED), 2)).upper()
    result = run_comparator(apksigner_output(colonised), COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_UNPARSEABLE


def test_accepts_a_bare_lowercase_baseline(tmp_path: Path) -> None:
    """The baseline side takes either form, so neither stored format is privileged."""
    baseline = write_baseline(tmp_path, EXPECTED + "\n")
    result = run_comparator(apksigner_output(EXPECTED), baseline, tmp_path)
    assert result.returncode == EXIT_OK


def test_accepts_the_committed_colon_separated_baseline(tmp_path: Path) -> None:
    """...and the committed file is the colon-separated one, so that path is live."""
    assert ":" in COMMITTED_BASELINE.read_text(encoding="utf-8")
    result = run_comparator(apksigner_output(EXPECTED), COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_OK


def test_accepts_the_sdk_range_signer_line(tmp_path: Path) -> None:
    """`Signer (minSdkVersion=…) #1 …` from newer build-tools still parses."""
    result = run_comparator(sdk_range_output(EXPECTED), COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_OK


# --------------------------------------------------------------------------
# The parser traps.
# --------------------------------------------------------------------------


def test_does_not_read_the_public_key_digest(tmp_path: Path) -> None:
    """The decoy. apksigner prints a `public key SHA-256 digest` too.

    It is a different 64-hex value on the same signer. A parser matching
    "SHA-256 digest" alone would compare the wrong one — so output carrying the
    public-key line and NO certificate line must be unparseable, never a verdict.
    """
    output = apksigner_output(EXPECTED, include_certificate_digest=False)
    assert "public key SHA-256 digest" in output
    assert "certificate SHA-256 digest" not in output

    result = run_comparator(output, COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_UNPARSEABLE
    assert "THEYGROW_RELEASE_CERT_UNPARSEABLE" in result.stderr


def test_rejects_conflicting_signers(tmp_path: Path) -> None:
    result = run_comparator(
        apksigner_output(EXPECTED, ONE_NIBBLE_OFF), COMMITTED_BASELINE, tmp_path
    )
    assert result.returncode == EXIT_MULTIPLE_SIGNERS
    assert "THEYGROW_RELEASE_CERT_MULTIPLE_SIGNERS" in result.stderr


@pytest.mark.parametrize(
    "certs_output",
    ["", "DOES NOT VERIFY\n", "gibberish that is not apksigner output at all\n"],
    ids=["empty", "does-not-verify", "gibberish"],
)
def test_rejects_output_it_cannot_parse(certs_output: str, tmp_path: Path) -> None:
    result = run_comparator(certs_output, COMMITTED_BASELINE, tmp_path)
    assert result.returncode == EXIT_UNPARSEABLE
    assert "THEYGROW_RELEASE_CERT_UNPARSEABLE" in result.stderr


# --------------------------------------------------------------------------
# The baseline must be present and unambiguous.
# --------------------------------------------------------------------------


def test_rejects_a_missing_baseline(tmp_path: Path) -> None:
    result = run_comparator(apksigner_output(EXPECTED), tmp_path / "absent.txt", tmp_path)
    assert result.returncode == EXIT_BASELINE_INVALID
    assert "THEYGROW_RELEASE_CERT_BASELINE_INVALID" in result.stderr


@pytest.mark.parametrize(
    "content",
    [
        "# comments only, no fingerprint\n",
        "",
        f"{EXPECTED}\n{ONE_NIBBLE_OFF}\n",
        "not-a-fingerprint\n",
        f"{EXPECTED[:-2]}\n",
    ],
    ids=["comments-only", "empty", "two-fingerprints", "not-hex", "too-short"],
)
def test_rejects_an_unusable_baseline(content: str, tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path, content)
    result = run_comparator(apksigner_output(EXPECTED), baseline, tmp_path)
    assert result.returncode == EXIT_BASELINE_INVALID
    assert "THEYGROW_RELEASE_CERT_BASELINE_INVALID" in result.stderr


def test_baseline_tolerates_comments_and_blank_lines(tmp_path: Path) -> None:
    baseline = write_baseline(tmp_path, f"# a note\n\n{EXPECTED}   # trailing note\n\n")
    result = run_comparator(apksigner_output(EXPECTED), baseline, tmp_path)
    assert result.returncode == EXIT_OK


# --------------------------------------------------------------------------
# The CLI contract itself.
# --------------------------------------------------------------------------


def test_requires_exactly_one_input_mode(tmp_path: Path) -> None:
    """`--apk` and `--certs-output` are mutually exclusive, and one is required."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--baseline", str(COMMITTED_BASELINE)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == EXIT_USAGE
