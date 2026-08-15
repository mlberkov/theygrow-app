"""RSN-P3 — the comparator's `--apk` path and its diagnostic block.

WHY THIS SUITE EXISTS. The detector's first real run (CI run 31894850072, job
`android`) returned exit 4 — `THEYGROW_RELEASE_CERT_UNPARSEABLE` — and the log
said nothing about WHY. Two explanations survived it and they need opposite
repairs: a certificate block on the parsed stream in a shape the pattern misses,
or nothing on the parsed stream at all. The diagnostic block added by this packet
is what tells them apart, and a diagnostic asserted only by reading it is the
failure that produced this packet. So it is executed here.

WHAT THIS PROVES AND WHAT IT DOES NOT. The apksigner here is a shell stub this
repository wrote. That makes every claim below a claim about the comparator's
PLUMBING — which binary it resolves out of several, which stream it parses, what
it prints when it cannot parse, and that none of it moves a verdict. It proves
NOTHING about what a real apksigner prints, which is exactly the gap that opened
this packet, and which only the `android` job can close.

The suite is POSIX-only: the stub is a `#!/bin/sh` script. Both CI runners and
the development machine are Linux.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from release.harness import apksigner_output, fake_apksigner

pytestmark = pytest.mark.skipif(os.name != "posix", reason="the apksigner stub is a POSIX script")

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "verify_release_signature.py"

# Mirrored from the script under test on purpose, exactly as the sibling suite
# mirrors them: a renumbering is a contract change for two workflows and should
# red here rather than be followed.
EXIT_OK = 0
EXIT_MISMATCH = 3
EXIT_UNPARSEABLE = 4
EXIT_APKSIGNER_ABSENT = 7
EXIT_APK_UNVERIFIED = 8

# Any 64-hex value works: this suite is about plumbing, not about the release
# certificate, and it writes its own baseline rather than reading the committed
# one so that nothing here can be confused for a claim about the real key.
BASELINE = "0" * 32 + "1" * 32
FOREIGN = "2" * 32 + "3" * 32


def run_against_stub(
    tmp_path: Path,
    *,
    stdout: str = "",
    stderr: str = "",
    returncode: int = 0,
    version: str = "36.0.0",
    also_install: tuple[str, ...] = (),
    plant_apksigner: bool = True,
    sdk_root_too: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Drive the `--apk` entry point exactly as CI drives it, against the stub."""
    sdk_root = tmp_path / "sdk"
    sdk_root.mkdir(exist_ok=True)

    for other in also_install:
        # A loser: it answers, but with output that could never be parsed, so a
        # green can only mean the newest was the one that ran.
        fake_apksigner(sdk_root, stdout="wrong build-tools answered\n", version=other)
    if plant_apksigner:
        fake_apksigner(
            sdk_root, stdout=stdout, stderr=stderr, returncode=returncode, version=version
        )

    apk = tmp_path / "app-debug.apk"
    apk.write_bytes(b"not an APK; the stub never opens it")
    baseline = tmp_path / "baseline.txt"
    baseline.write_text(f"{BASELINE}\n", encoding="utf-8")

    empty_bin = tmp_path / "empty-bin"
    empty_bin.mkdir(exist_ok=True)

    env = dict(os.environ)
    env["ANDROID_HOME"] = str(sdk_root)
    if sdk_root_too:
        env["ANDROID_SDK_ROOT"] = str(sdk_root)
    else:
        env.pop("ANDROID_SDK_ROOT", None)
    # PATH is scrubbed so a real apksigner on the development machine or the
    # runner can never satisfy the fallback and make this suite pass for a reason
    # it is not testing.
    env["PATH"] = str(empty_bin)

    return subprocess.run(
        [sys.executable, str(SCRIPT), "--apk", str(apk), "--baseline", str(baseline)],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


# --------------------------------------------------------------------------
# The verdicts are unmoved. These run first because everything else in this
# packet is only allowed to ADD output.
# --------------------------------------------------------------------------


def test_a_matching_certificate_still_passes_through_the_apk_path(tmp_path: Path) -> None:
    result = run_against_stub(tmp_path, stdout=apksigner_output(BASELINE))
    assert result.returncode == EXIT_OK
    assert "THEYGROW_RELEASE_CERT_OK" in result.stdout


def test_a_foreign_certificate_still_returns_three_and_carries_no_excerpt(tmp_path: Path) -> None:
    """The exact verdict `.github/workflows/ci.yml` asserts against the debug APK.

    A mismatch already prints both fingerprints; it is not blind, so it gets no
    diagnostic block. That is asserted here rather than assumed, because an
    excerpt on this path would print the release certificate's output on every
    owner release run for nothing.
    """
    result = run_against_stub(tmp_path, stdout=apksigner_output(FOREIGN))
    assert result.returncode == EXIT_MISMATCH
    assert "THEYGROW_RELEASE_CERT_MISMATCH" in result.stderr
    assert "how apksigner was resolved" not in result.stderr
    assert "--- apksigner stdout" not in result.stderr


# --------------------------------------------------------------------------
# Resolution: which binary ran, and can the log tell.
# --------------------------------------------------------------------------


def test_picks_the_newest_build_tools_by_version_not_by_string(tmp_path: Path) -> None:
    """`9.0.0` sorts above `36.0.0` as a string. Picking it would be a silent red."""
    result = run_against_stub(
        tmp_path, stdout=apksigner_output(BASELINE), version="36.0.0", also_install=("9.0.0",)
    )
    assert result.returncode == EXIT_OK


def test_the_diagnostic_names_the_binary_the_directory_and_the_losers(tmp_path: Path) -> None:
    result = run_against_stub(
        tmp_path, stdout="", returncode=1, version="36.0.0", also_install=("9.0.0",)
    )
    assert result.returncode == EXIT_APK_UNVERIFIED
    assert "THEYGROW_RELEASE_APK_UNVERIFIED" in result.stderr
    assert str(tmp_path / "sdk" / "build-tools" / "36.0.0" / "apksigner") in result.stderr
    assert "found via: build-tools/36.0.0" in result.stderr
    assert "9.0.0" in result.stderr
    assert "<- CHOSEN" in result.stderr
    assert "exit code: 1" in result.stderr
    assert "argv:" in result.stderr


def test_the_same_sdk_under_both_env_vars_is_counted_once(tmp_path: Path) -> None:
    """GitHub's runner image points ANDROID_HOME and ANDROID_SDK_ROOT at one directory.

    Counted twice, the diagnostic would report four tools where two exist —
    small, but this block's whole job is to be trusted about what it saw.
    """
    result = run_against_stub(
        tmp_path, stdout="", returncode=1, also_install=("9.0.0",), sdk_root_too=True
    )
    assert result.returncode == EXIT_APK_UNVERIFIED
    assert "build-tools candidates considered (2):" in result.stderr
    # Both roots are still reported, because which ones were consulted is a
    # different fact from how many tools they hold.
    assert result.stderr.count("(build-tools/ present)") == 2


def test_an_absent_apksigner_says_where_it_looked(tmp_path: Path) -> None:
    result = run_against_stub(tmp_path, plant_apksigner=False)
    assert result.returncode == EXIT_APKSIGNER_ABSENT
    assert "THEYGROW_RELEASE_APKSIGNER_ABSENT" in result.stderr
    assert "resolved: NONE" in result.stderr
    assert "ANDROID_HOME=" in result.stderr
    assert "ANDROID_SDK_ROOT: unset" in result.stderr
    assert "candidates considered: none" in result.stderr


# --------------------------------------------------------------------------
# The READING line. Each of the three shapes must be legible from the log
# ALONE — no checkout, no source.
# --------------------------------------------------------------------------


def test_an_empty_parsed_stream_reads_as_an_invocation_defect(tmp_path: Path) -> None:
    """Certificate block on stderr, nothing on stdout: the wrong-stream hypothesis."""
    result = run_against_stub(tmp_path, stdout="", stderr=apksigner_output(FOREIGN))
    assert result.returncode == EXIT_UNPARSEABLE
    assert "THEYGROW_RELEASE_CERT_UNPARSEABLE" in result.stderr
    assert "READING: nothing arrived on stdout" in result.stderr
    assert "came back on stderr instead" in result.stderr
    assert "INVOCATION defect" in result.stderr
    assert "NOT a pattern defect" in result.stderr
    assert "(EMPTY — nothing at all arrived here)" in result.stderr
    # The block that WAS produced is shown, so the shape can be read at once.
    assert "certificate SHA-256 digest" in result.stderr


def test_a_present_block_the_pattern_missed_reads_as_a_pattern_defect(tmp_path: Path) -> None:
    """The other live hypothesis: a real block, a line shape nothing here handles."""
    mangled = (
        "Verifies\n"
        "Number of signers: 1\n"
        f"Signer #1 certificate SHA256 digest: {FOREIGN}\n"
        f"Signer #1 public key SHA-256 digest: {BASELINE}\n"
    )
    result = run_against_stub(tmp_path, stdout=mangled)
    assert result.returncode == EXIT_UNPARSEABLE
    assert "READING: the certificate block IS on stdout" in result.stderr
    assert "PATTERN defect" in result.stderr
    # Verbatim, under the per-line bound, so the real shape can be transcribed
    # into a fixture from the log rather than retyped from memory.
    assert f"Signer #1 certificate SHA256 digest: {FOREIGN}" in result.stderr


def test_output_that_is_not_apksigner_at_all_points_at_the_binary(tmp_path: Path) -> None:
    result = run_against_stub(tmp_path, stdout="Usage: apksigner <command> [options]\n")
    assert result.returncode == EXIT_UNPARSEABLE
    assert "not `apksigner verify --print-certs` output" in result.stderr
    assert "INVOCATION defect" in result.stderr


def test_both_streams_silent_says_so(tmp_path: Path) -> None:
    result = run_against_stub(tmp_path, stdout="", stderr="")
    assert result.returncode == EXIT_UNPARSEABLE
    assert "and nothing on stderr either" in result.stderr
    assert "INVOCATION defect" in result.stderr


# --------------------------------------------------------------------------
# The bound and the redaction. A diagnostic that can become a dump, or that
# can print a person's name, is not shippable near a signing key.
# --------------------------------------------------------------------------


def test_the_excerpt_is_bounded_and_says_what_it_dropped(tmp_path: Path) -> None:
    flood = "".join(f"Signer #{index} noise {'x' * 400}\n" for index in range(1, 501))
    result = run_against_stub(tmp_path, stdout=flood, stderr=flood)
    assert result.returncode == EXIT_UNPARSEABLE
    # Two streams, each capped at 24 lines of at most ~200 rendered characters,
    # plus the fixed preamble. An unbounded dump would be ~400 KB.
    assert len(result.stderr) < 15_000
    assert "chars on this line)" in result.stderr
    assert "further lines omitted by the excerpt bound" in result.stderr
    # The counts are reported in full even though the lines are not.
    assert "500 lines" in result.stderr


def test_the_certificate_dn_value_is_redacted(tmp_path: Path) -> None:
    """The one line in apksigner's output that can carry a person's name."""
    named = (
        "Verifies\n"
        "Signer #1 certificate DN: CN=Ada Lovelace, OU=owner, O=theygrow, C=ZZ\n"
        f"Signer #1 public key SHA-256 digest: {FOREIGN}\n"
    )
    result = run_against_stub(tmp_path, stdout=named)
    assert result.returncode == EXIT_UNPARSEABLE
    assert "Ada Lovelace" not in result.stderr
    # The LINE survives: "a certificate block was present" is the half that
    # distinguishes the two hypotheses.
    assert "Signer #1 certificate DN: <redacted:" in result.stderr
