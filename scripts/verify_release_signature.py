#!/usr/bin/env python3
"""RSN-P2 — the release signature detector (ADR-047 detector (a)).

Answers one question, by machine: is this APK signed by OUR key? It runs
`apksigner verify --verbose --print-certs`, parses the signing certificate's
SHA-256 out of the output, and compares it to the fingerprint committed at
`native/android/release-signing/cert-sha256.txt`. A mismatch, a missing or
malformed baseline, output it cannot parse, more than one signing identity, or
an APK apksigner will not verify are all FAILURES with distinct exit codes.

WHY A SCRIPT AND NOT A `grep` IN THE WORKFLOW. The verdict has to be provably
able to go red, and the release workflow's positive path only ever runs with the
real keystore secret on an owner-triggered run. A comparator that only exists as
inline shell can never be executed by an ordinary secret-free CI run, so its
ability to fail could only be asserted by reading it. This file is executed
instead — by `app/tests/release/` against synthesised apksigner output, and by
the `android` job in ci.yml against a REAL apksigner reading a REAL debug APK,
whose certificate is by definition not the release certificate.

IN SCOPE: resolving apksigner, parsing its output, normalising both sides of the
comparison, and returning a verdict as an exit code plus a bare THEYGROW_RELEASE_*
token on stderr (the same greppable convention native/android/app/build.gradle
uses for its fail-closed guard).

NOT IN SCOPE: building anything, signing anything, publishing anything, or
reading any secret. This script never touches key material — a certificate
fingerprint is public, and both sides of a mismatch are printed on purpose so
the owner can see WHICH side is wrong without a second run.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

# Exit codes. Callers assert the SPECIFIC code, so "red for the wrong reason"
# is never mistaken for the red we were testing for.
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_MISMATCH = 3
EXIT_UNPARSEABLE = 4
EXIT_BASELINE_INVALID = 5
EXIT_MULTIPLE_SIGNERS = 6
EXIT_APKSIGNER_ABSENT = 7
EXIT_APK_UNVERIFIED = 8

TOKEN_OK = "THEYGROW_RELEASE_CERT_OK"
TOKEN_MISMATCH = "THEYGROW_RELEASE_CERT_MISMATCH"
TOKEN_UNPARSEABLE = "THEYGROW_RELEASE_CERT_UNPARSEABLE"
TOKEN_BASELINE_INVALID = "THEYGROW_RELEASE_CERT_BASELINE_INVALID"
TOKEN_MULTIPLE_SIGNERS = "THEYGROW_RELEASE_CERT_MULTIPLE_SIGNERS"
TOKEN_APKSIGNER_ABSENT = "THEYGROW_RELEASE_APKSIGNER_ABSENT"
TOKEN_APK_UNVERIFIED = "THEYGROW_RELEASE_APK_UNVERIFIED"

# THE `certificate` IN THIS PATTERN IS LOAD-BEARING. apksigner prints BOTH
#
#   Signer #1 certificate SHA-256 digest: <64 hex>
#   Signer #1 public key SHA-256 digest:  <64 hex>
#
# for the same signer, and they are DIFFERENT values. A pattern that matched
# "SHA-256 digest" alone would compare the public-key digest against a
# certificate fingerprint and be wrong in both directions — red on a correctly
# signed APK, and, if a baseline were ever recorded from the same wrong line,
# green on an incorrectly signed one. `app/tests/release` pins this with output
# that carries the public-key lines and no certificate line.
#
# The `Signer\b.*?#\d+` prefix tolerates the
# `Signer (minSdkVersion=24, maxSdkVersion=2147483647) #1 ...` form that newer
# build-tools emit when the signature differs across an SDK range.
_CERT_DIGEST = re.compile(
    r"^Signer\b.*?#\d+\s+certificate\s+SHA-256\s+digest:\s*([0-9a-fA-F]{64})\s*$",
    re.MULTILINE,
)

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class Verdict(NamedTuple):
    """The outcome of one comparison: what to exit with and what to say."""

    code: int
    token: str
    detail: str


def normalise(value: str) -> str:
    """Reduce a fingerprint to bare lowercase hex.

    The baseline is stored uppercase and colon-separated (keytool / Play Console
    form, so a human can check it); apksigner prints lowercase and colon-free.
    Both sides go through here, so neither format is privileged.
    """
    return re.sub(r"[\s:]", "", value).lower()


def load_baseline(path: Path) -> str:
    """Read the committed fingerprint, or raise ValueError describing why not."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as failure:
        raise ValueError(f"cannot read the baseline at {path}: {failure}") from failure

    lines = []
    for raw in text.splitlines():
        stripped = raw.split("#", 1)[0].strip()
        if stripped:
            lines.append(stripped)

    if not lines:
        raise ValueError(f"the baseline at {path} carries no fingerprint line")
    if len(lines) > 1:
        raise ValueError(
            f"the baseline at {path} carries {len(lines)} fingerprint lines; "
            "exactly one is allowed, so that what is being compared is unambiguous"
        )

    fingerprint = normalise(lines[0])
    if not _HEX64.match(fingerprint):
        raise ValueError(
            f"the baseline at {path} is not a SHA-256 fingerprint "
            "(expected 32 hex octets, colons optional)"
        )
    return fingerprint


def evaluate(certs_output: str, baseline: str) -> Verdict:
    """Compare apksigner's output against the baseline. The whole verdict lives here.

    Both entry modes funnel through this function, so there is exactly one
    parser and one comparison in the repository. A second, independently written
    one would be a second thing to forget.
    """
    found = {match.group(1).lower() for match in _CERT_DIGEST.finditer(certs_output)}

    if not found:
        return Verdict(
            EXIT_UNPARSEABLE,
            TOKEN_UNPARSEABLE,
            "no `Signer #N certificate SHA-256 digest:` line was found in the apksigner "
            "output. The APK may be unsigned, or the output format may have changed — "
            "either way the signature has NOT been verified and this must not pass.",
        )

    if len(found) > 1:
        listed = ", ".join(sorted(found))
        return Verdict(
            EXIT_MULTIPLE_SIGNERS,
            TOKEN_MULTIPLE_SIGNERS,
            f"the APK carries {len(found)} distinct signing certificates ({listed}). "
            "A release build of this app has exactly one signing identity; more than "
            "one means key rotation or a re-sign that nobody decided on.",
        )

    actual = found.pop()
    if actual != baseline:
        # BOTH VALUES, LABELLED. The first owner run is the first time the
        # committed baseline and the key in the secret ever meet, and two
        # different causes produce this same red: a wrong baseline, or a
        # keystore that is not the key the fingerprint came from. Printing one
        # side would force a second run to tell them apart. Both are public —
        # this is a certificate fingerprint, not key material.
        return Verdict(
            EXIT_MISMATCH,
            TOKEN_MISMATCH,
            "the APK is NOT signed by the expected key.\n"
            f"  apksigner reported: {actual}\n"
            f"  baseline expects:   {baseline}\n"
            "One of two things is wrong, and they are told apart by which side you "
            "trust: either the committed baseline is not this app's certificate, or "
            "the keystore in ANDROID_KEYSTORE_BASE64 is not the key that fingerprint "
            "came from. Do not relax this check to find out.",
        )

    return Verdict(EXIT_OK, TOKEN_OK, f"signed by the expected key: {actual}")


def find_apksigner() -> Path | None:
    """Locate the newest apksigner in the Android SDK, or None.

    apksigner ships with build-tools and is NOT on PATH on GitHub's runner
    images, which carry several build-tools versions side by side. The newest is
    selected by version rather than pinned, because the image rotates which
    versions it keeps and a pin would rot into a red release run.
    """
    best: tuple[tuple[int, ...], Path] | None = None
    for root in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")):
        if not root:
            continue
        build_tools = Path(root) / "build-tools"
        if not build_tools.is_dir():
            continue
        for version_dir in build_tools.iterdir():
            candidate = version_dir / "apksigner"
            if not candidate.is_file() or not os.access(candidate, os.X_OK):
                continue
            key = tuple(int(part) if part.isdigit() else 0 for part in version_dir.name.split("."))
            if best is None or key > best[0]:
                best = (key, candidate)
    if best is not None:
        return best[1]

    on_path = shutil.which("apksigner")
    return Path(on_path) if on_path else None


def certs_output_for_apk(apk: Path) -> tuple[str, Verdict | None]:
    """Run apksigner against `apk`. Returns (output, failure-verdict-or-None)."""
    tool = find_apksigner()
    if tool is None:
        return "", Verdict(
            EXIT_APKSIGNER_ABSENT,
            TOKEN_APKSIGNER_ABSENT,
            "no apksigner found under $ANDROID_HOME/build-tools/*/ or on PATH. It ships "
            "with the Android SDK build-tools; if the runner image has stopped providing "
            "it, install one explicitly (`sdkmanager 'build-tools;36.0.0'`) rather than "
            "substituting a check that does not verify the signature.",
        )

    # Fixed argv, no shell: the APK path is the only variable and it is not
    # interpolated into a command string.
    completed = subprocess.run(
        [str(tool), "verify", "--verbose", "--print-certs", str(apk)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return completed.stdout, Verdict(
            EXIT_APK_UNVERIFIED,
            TOKEN_APK_UNVERIFIED,
            f"apksigner exited {completed.returncode} — it will not verify {apk}. "
            "An APK whose signature apksigner rejects is never shippable.\n"
            f"--- apksigner stdout ---\n{completed.stdout.strip()}\n"
            f"--- apksigner stderr ---\n{completed.stderr.strip()}",
        )
    return completed.stdout, None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_release_signature.py",
        description="Compare an APK's signing certificate against the committed baseline.",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--apk",
        type=Path,
        help="APK to verify. Resolves and runs apksigner. This is the production mode.",
    )
    source.add_argument(
        "--certs-output",
        type=Path,
        help=(
            "File holding already-captured `apksigner --print-certs` output. The test "
            "seam: it feeds the same comparison, so no second parser exists."
        ),
    )
    parser.add_argument(
        "--baseline",
        type=Path,
        required=True,
        help="Path to the committed certificate fingerprint.",
    )
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv[1:])

    try:
        baseline = load_baseline(args.baseline)
    except ValueError as failure:
        print(f"{TOKEN_BASELINE_INVALID}: {failure}", file=sys.stderr)
        return EXIT_BASELINE_INVALID

    if args.apk is not None:
        certs_output, failure_verdict = certs_output_for_apk(args.apk)
        if failure_verdict is not None:
            print(f"{failure_verdict.token}: {failure_verdict.detail}", file=sys.stderr)
            return failure_verdict.code
    else:
        try:
            certs_output = args.certs_output.read_text(encoding="utf-8")
        except OSError as failure:
            print(
                f"{TOKEN_UNPARSEABLE}: cannot read {args.certs_output}: {failure}", file=sys.stderr
            )
            return EXIT_UNPARSEABLE

    verdict = evaluate(certs_output, baseline)

    # The fingerprint is printed either way — ADR-047 detector (a) wants it in
    # the log — but the VERDICT is the exit code above, never this line.
    if verdict.code == EXIT_OK:
        print(f"{verdict.token}: {verdict.detail}")
    else:
        print(f"{verdict.token}: {verdict.detail}", file=sys.stderr)
    return verdict.code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
