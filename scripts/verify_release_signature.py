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

DIAGNOSTICS (RSN-P3). A verdict that says "I could not parse this" without
showing what it saw forces a code change to learn anything — which is exactly
what happened on the first real run of this detector (CI run 31894850072, job
`android`): exit 4, and a log carrying no evidence about why. So the three
verdicts that are blind by construction — output the parser cannot read, an APK
apksigner refuses, and no apksigner at all — now also print, to stderr, how the
binary was resolved and which candidates lost, what argv was run, what came back
on EACH stream, and a bounded excerpt of both. The block ends on a one-line
READING that names which explanation the bytes support, because the reader who
needs it has the run log and nothing else — no checkout, no source.

The excerpt is apksigner's public certificate output, not key material (ADR-047
detector (c)), but the same discipline applies to how it is emitted: it is
bounded on three axes, it appears only on failure paths, and the one line that
can carry a person's name — the certificate DN — has its VALUE redacted while
the line itself stays visible, since "a certificate block was present" is the
diagnostically load-bearing half.

The diagnostics never move a verdict. RSN-P3 left what is parsed (stdout), what
is matched and the exit codes deliberately unmoved, because that push WAS the
measurement that would tell a later packet which of them to repair.

THE REPAIR (RSN-P4). The measurement came back on CI run 31896998977: the
certificate block was on stdout, stderr was empty, and the READING line named a
PATTERN defect. build-tools 37.0.0 prints `V2 Signer: certificate SHA-256
digest: <64 hex>` — scheme-qualified, and with no `#N` on the line at all — which
the pattern of the day missed three ways at once. The pattern is widened here to
the four shapes named in the ledger below, the older ones KEPT because the two
workflows need not run the same image, and the real bytes are recorded at
`app/tests/release/fixtures/`. What is NOT widened: `certificate` and `SHA-256`
stay mandatory and adjacent, because the same block carries five near-misses and
one of them is a 64-hex public-key digest that would read as a green on the
wrong key. The stream, the exit codes and the tokens the two workflows branch on
are still untouched.
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

# THE SHAPE LEDGER. This pattern is the whole reading half of the detector, so
# what it accepts and what it refuses are both written down here.
#
# ACCEPTED — all four are the same line with different prefixes, and the prefix
# is the part that varies by build-tools version and by how the APK was signed:
#
#   V2 Signer: certificate SHA-256 digest: <64 hex>                  <- OBSERVED
#   Signer #1 certificate SHA-256 digest: <64 hex>
#   Signer (minSdkVersion=24, maxSdkVersion=2147483647) #1 certificate SHA-256 digest: <64 hex>
#   V3 Signer (minSdkVersion=…, maxSdkVersion=…) #1 certificate SHA-256 digest: <64 hex>
#
# The first is what build-tools 37.0.0 actually printed on CI run 31896998977 —
# SCHEME-QUALIFIED, and with no `#N` anywhere on the line. The pattern that stood
# until RSN-P4 required `Signer` at the start AND a `#N`, so it missed that line
# three ways at once and the detector returned 4 on every run since RSN-P2. The
# older shapes are KEPT rather than replaced: the release workflow and the
# `android` job need not run the same runner image, so the shape that reaches
# this parser is not a single known quantity. `app/tests/release` pins all four,
# and the observed one against recorded bytes (`fixtures/`).
#
# REFUSED, and this is the half that matters. The same signer block carries FIVE
# near-misses, and one output holds all of them:
#
#   V2 Signer: certificate SHA-1 digest: <40 hex>        wrong algorithm
#   V2 Signer: certificate MD5 digest: <32 hex>          wrong algorithm
#   V2 Signer: public key SHA-256 digest: <64 hex>       WRONG THING, RIGHT SHAPE
#   V2 Signer: public key SHA-1 digest: <40 hex>         wrong thing and algorithm
#   V2 Signer: public key MD5 digest: <32 hex>           wrong thing and algorithm
#
# The third is the catastrophic one: 64 hex characters, indistinguishable by
# shape from the answer, belonging to a different thing. A pattern matching
# "SHA-256 digest" alone would compare it against a certificate fingerprint and
# be wrong in both directions — red on a correctly signed APK, and, if a baseline
# were ever recorded from the same wrong line, GREEN ON AN INCORRECTLY SIGNED
# ONE. That is why `certificate` and `SHA-256` are both mandatory and adjacent,
# and why each of the five is pinned by its own test.
#
# `[^:\n]` and not `[^:]`: `.`-like classes match newlines, and under
# re.MULTILINE the anchors are per-line while the class is not — so `[^:]` would
# happily join a `Signer` line to a `certificate SHA-256 digest:` line further
# down whenever no colon fell in between, reading a digest that is not on the
# signer line at all. Today's output always intervenes a colon, so that was
# latent rather than live; latent is exactly what surfaces on the next tool
# version. The horizontal-only `[ \t]` runs are the same rule applied to the
# separators. Leading whitespace is deliberately NOT tolerated: this parser is
# widened to the shapes that were MEASURED, and no further.
_CERT_DIGEST = re.compile(
    r"^(?:V\d+(?:\.\d+)?[ \t]+)?Signer\b[^:\n]*?:?[ \t]*"
    r"certificate[ \t]+SHA-256[ \t]+digest:[ \t]*([0-9a-fA-F]{64})[ \t]*$",
    re.MULTILINE,
)

# The accepted shapes, in the words the failure messages use. One string, so the
# ledger above, the unparseable verdict and the READING line cannot drift apart.
ACCEPTED_SHAPE = "`[V<n> ]Signer[ (minSdkVersion=…)][ #N] certificate SHA-256 digest: <64 hex>`"

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
            f"no line matching {ACCEPTED_SHAPE} was found in the apksigner output. The "
            "APK may be unsigned, this may not be apksigner output at all, or the output "
            "format may have changed again — either way the signature has NOT been "
            "verified and this must not pass. The diagnostic block below says which.",
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


class ToolChoice(NamedTuple):
    """Which apksigner was picked — and everything a reader needs to doubt it.

    `considered` is the whole candidate set, not just the winner: "picked the
    wrong one of several" and "there was only ever one" are different faults and
    the log has to tell them apart without a second run.
    """

    chosen: Path | None
    source: str
    considered: tuple[tuple[str, Path], ...]
    roots: tuple[str, ...]


class ToolRun(NamedTuple):
    """One apksigner invocation, kept whole: both streams, verbatim."""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


def find_apksigner() -> ToolChoice:
    """Locate the newest apksigner in the Android SDK, and record how.

    apksigner ships with build-tools and is NOT on PATH on GitHub's runner
    images, which carry several build-tools versions side by side. The newest is
    selected by version rather than pinned, because the image rotates which
    versions it keeps and a pin would rot into a red release run. The version
    comparison is on integer tuples, not strings: `9.0.0` sorts ABOVE `36.0.0`
    lexicographically, and picking the older tool is one of the ways this
    detector could fail for a reason unrelated to any signature.
    """
    roots: list[str] = []
    scored: list[tuple[tuple[int, ...], str, Path]] = []
    # GitHub's runner image sets ANDROID_HOME and ANDROID_SDK_ROOT to the SAME
    # directory, so without this every candidate would be listed twice and the
    # count in the diagnostic would be a small lie about how many tools exist.
    seen: set[Path] = set()

    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        root = os.environ.get(name)
        if not root:
            roots.append(f"{name}: unset")
            continue
        build_tools = Path(root) / "build-tools"
        if not build_tools.is_dir():
            roots.append(f"{name}={root} (no build-tools/ directory under it)")
            continue
        roots.append(f"{name}={root} (build-tools/ present)")
        for version_dir in sorted(build_tools.iterdir()):
            candidate = version_dir / "apksigner"
            if not candidate.is_file() or not os.access(candidate, os.X_OK):
                continue
            resolved = candidate.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            key = tuple(int(part) if part.isdigit() else 0 for part in version_dir.name.split("."))
            scored.append((key, version_dir.name, candidate))

    scored.sort(key=lambda entry: entry[0], reverse=True)
    considered = tuple((version, path) for _, version, path in scored)

    if scored:
        return ToolChoice(scored[0][2], f"build-tools/{scored[0][1]}", considered, tuple(roots))

    on_path = shutil.which("apksigner")
    if on_path is not None:
        return ToolChoice(Path(on_path), "PATH", considered, tuple(roots))
    return ToolChoice(None, "nowhere", considered, tuple(roots))


def invoke_apksigner(tool: Path, apk: Path) -> ToolRun:
    """Run the resolved tool once, keeping both streams.

    Fixed argv, no shell: the APK path is the only variable and it is not
    interpolated into a command string. stderr is CAPTURED but not parsed —
    which stream carries the certificate block is one of the open questions this
    packet exists to answer, and answering it by quietly parsing both would
    convert an unknown into a green without ever naming it.
    """
    argv = (str(tool), "verify", "--verbose", "--print-certs", str(apk))
    completed = subprocess.run(list(argv), capture_output=True, text=True, check=False)
    return ToolRun(argv, completed.returncode, completed.stdout, completed.stderr)


def absent_verdict() -> Verdict:
    return Verdict(
        EXIT_APKSIGNER_ABSENT,
        TOKEN_APKSIGNER_ABSENT,
        "no apksigner found under $ANDROID_HOME/build-tools/*/ or "
        "$ANDROID_SDK_ROOT/build-tools/*/, or on PATH. It ships "
        "with the Android SDK build-tools; if the runner image has stopped providing "
        "it, install one explicitly (`sdkmanager 'build-tools;36.0.0'`) rather than "
        "substituting a check that does not verify the signature.",
    )


def unverified_verdict(apk: Path, run: ToolRun) -> Verdict:
    return Verdict(
        EXIT_APK_UNVERIFIED,
        TOKEN_APK_UNVERIFIED,
        f"apksigner exited {run.returncode} — it will not verify {apk}. "
        "An APK whose signature apksigner rejects is never shippable. What it "
        "printed is below, bounded.",
    )


# ---------------------------------------------------------------------------
# RSN-P3 — the diagnostic block. Emitted on the three verdicts that are blind by
# construction, and on no other: a mismatch already prints both fingerprints and
# needs no excerpt, and on a release run an excerpt there would be noise over the
# release certificate for nothing.
# ---------------------------------------------------------------------------

# Bounded on three axes at once, so no pathological input can turn a failure
# message into a dump: a line count, a per-line character count, and a hard
# character cap per stream. Whatever is dropped is COUNTED in the footer — a
# silently truncated excerpt is its own kind of lie.
EXCERPT_MAX_LINES = 24
EXCERPT_MAX_LINE_CHARS = 160
EXCERPT_MAX_CHARS = 4000

# `Signer #1 certificate DN: CN=…` is the one line in apksigner's output that can
# carry a person's name. The label survives — its presence is exactly what
# separates "a certificate block was there" from "nothing was" — the value does
# not. The digest lines identify the key far more precisely anyway, and they are
# hex.
_DN_LINE = re.compile(r"^(?P<label>.*\bDN:)\s*(?P<value>\S.*)$")


def redact(line: str) -> str:
    """Strip a distinguished name's value, keeping the fact that it was there."""
    match = _DN_LINE.match(line)
    if match is None:
        return line
    return f"{match.group('label')} <redacted: {len(match.group('value'))} chars>"


def excerpt(label: str, text: str) -> str:
    """Render at most a bounded window of `text`, saying what it left out."""
    lines = text.splitlines()
    header = f"--- {label}: {len(text.encode('utf-8'))} bytes, {len(lines)} lines ---"

    if not text:
        return f"{header}\n(EMPTY — nothing at all arrived here)"
    if not text.strip():
        return f"{header}\n(WHITESPACE ONLY — no text arrived here)"

    rendered: list[str] = []
    budget = EXCERPT_MAX_CHARS
    for line in lines[:EXCERPT_MAX_LINES]:
        shown = redact(line)
        if len(shown) > EXCERPT_MAX_LINE_CHARS:
            dropped = len(shown) - EXCERPT_MAX_LINE_CHARS
            shown = f"{shown[:EXCERPT_MAX_LINE_CHARS]}… (+{dropped} chars on this line)"
        if len(shown) + 1 > budget:
            break
        rendered.append(shown)
        budget -= len(shown) + 1

    omitted = len(lines) - len(rendered)
    if omitted > 0:
        rendered.append(f"… ({omitted} further lines omitted by the excerpt bound)")
    return "\n".join([header, *rendered])


def markers(text: str) -> tuple[int, int]:
    """Count the two lines that say "this is a certificate block" at all."""
    lines = text.splitlines()
    return (
        sum(1 for line in lines if "Signer" in line),
        sum(1 for line in lines if "certificate" in line),
    )


def stream_facts(label: str, text: str) -> str:
    signer, certificate = markers(text)
    return (
        f"  {label}: {len(text.encode('utf-8'))} bytes, {len(text.splitlines())} lines, "
        f"{signer} line(s) mentioning `Signer`, {certificate} mentioning `certificate`"
    )


def reading(parsed_label: str, parsed: str, other_label: str | None, other: str) -> str:
    """Name, in one line, which explanation these bytes support.

    THE POINT OF THE WHOLE BLOCK. Someone reading only the run output — no
    checkout, no source — has to be able to say "the certificate block was there
    in a shape the pattern missed" or "there was nothing on the stream we parse".
    Leaving that to be inferred from raw bytes is how a red gets diagnosed by
    guesswork, which is the failure this packet was opened to end.
    """
    signer, certificate = markers(parsed)

    if not parsed.strip():
        if other_label is not None and other.strip():
            return (
                f"  READING: nothing arrived on {parsed_label}, the ONLY stream this comparator "
                f"parses — the output came back on {other_label} instead. The pattern was never "
                "reached, so this is an INVOCATION defect (which stream is read), NOT a pattern "
                "defect."
            )
        tail = f", and nothing on {other_label} either" if other_label is not None else ""
        return (
            f"  READING: nothing arrived on {parsed_label}{tail}. There was no output to parse "
            "at all, so this is an INVOCATION defect (which binary ran, and whether it produced "
            "anything — see the resolution above), NOT a pattern defect."
        )

    if signer or certificate:
        return (
            f"  READING: the certificate block IS on {parsed_label} — {signer} line(s) mentioning "
            f"`Signer`, {certificate} mentioning `certificate` — but not one of them matched "
            f"{ACCEPTED_SHAPE}. This is a PATTERN defect: read the `Signer` lines in the excerpt "
            "below verbatim and compare them to that shape. RSN-P4 widened this pattern once "
            "already, from a measurement exactly like this one; widen it to what THIS log shows "
            "and record those bytes as a fixture. Never widen it past `certificate SHA-256` — "
            "the public-key digest on the neighbouring line is the same shape and the wrong key."
        )

    return (
        f"  READING: {parsed_label} carried output, but not one line mentions `Signer` or "
        "`certificate` — this is not `apksigner verify --print-certs` output. This is an "
        "INVOCATION defect: check WHICH binary was resolved, listed above, NOT the pattern."
    )


def describe_choice(choice: ToolChoice) -> str:
    lines = ["--- how apksigner was resolved ---"]
    if choice.chosen is None:
        lines.append("  resolved: NONE — no apksigner was found")
    else:
        lines.append(f"  resolved: {choice.chosen}")
        lines.append(f"  found via: {choice.source}")
    lines.extend(f"  {root}" for root in choice.roots)
    if choice.considered:
        lines.append(f"  build-tools candidates considered ({len(choice.considered)}):")
        for version, path in choice.considered:
            chosen = "   <- CHOSEN" if path == choice.chosen else ""
            lines.append(f"    {version}: {path}{chosen}")
    else:
        lines.append("  build-tools candidates considered: none")
    return "\n".join(lines)


def describe_run(choice: ToolChoice, run: ToolRun) -> str:
    return "\n".join(
        [
            describe_choice(choice),
            "--- what was run ---",
            f"  argv: {list(run.argv)}",
            f"  exit code: {run.returncode}",
            "--- what came back ---",
            stream_facts("stdout (the ONLY stream this comparator parses)", run.stdout),
            stream_facts("stderr (captured, not parsed)", run.stderr),
            reading("stdout", run.stdout, "stderr", run.stderr),
            excerpt("apksigner stdout", run.stdout),
            excerpt("apksigner stderr", run.stderr),
        ]
    )


def describe_file(path: Path, text: str) -> str:
    return "\n".join(
        [
            "--- what was read ---",
            f"  file: {path}",
            stream_facts("file contents (parsed as apksigner output)", text),
            reading("the file", text, None, ""),
            excerpt(f"contents of {path}", text),
        ]
    )


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


def report(verdict: Verdict, diagnostic: str | None = None) -> int:
    """Print the verdict, then the diagnostic block if this verdict earns one.

    The fingerprint is printed either way — ADR-047 detector (a) wants it in the
    log — but the VERDICT is the returned exit code, never these lines.
    """
    stream = sys.stdout if verdict.code == EXIT_OK else sys.stderr
    print(f"{verdict.token}: {verdict.detail}", file=stream)
    if diagnostic is not None:
        print(diagnostic, file=sys.stderr)
    return verdict.code


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv[1:])

    try:
        baseline = load_baseline(args.baseline)
    except ValueError as failure:
        print(f"{TOKEN_BASELINE_INVALID}: {failure}", file=sys.stderr)
        return EXIT_BASELINE_INVALID

    if args.apk is not None:
        choice = find_apksigner()
        if choice.chosen is None:
            return report(absent_verdict(), describe_choice(choice))

        # WHICH TOOL BLESSED THIS, ON EVERY VERDICT AND NOT ONLY THE RED ONES.
        # The build-tools version is not pinned (see find_apksigner), and the
        # shape this parser reads has already changed once under a version bump
        # nobody watched. The full resolution block still appears only on 4/7/8;
        # this is one line, it carries no THEYGROW_RELEASE_* token, nothing parses
        # it, and it means a GREEN run also records what produced the output it
        # passed — so the next shape change is visible in a diff of two passing
        # logs rather than discovered by the red that follows it.
        print(f"apksigner: {choice.chosen} (found via {choice.source})")

        run = invoke_apksigner(choice.chosen, args.apk)
        if run.returncode != 0:
            return report(unverified_verdict(args.apk, run), describe_run(choice, run))

        verdict = evaluate(run.stdout, baseline)
        blind = describe_run(choice, run) if verdict.code == EXIT_UNPARSEABLE else None
        return report(verdict, blind)

    try:
        certs_output = args.certs_output.read_text(encoding="utf-8")
    except OSError as failure:
        print(f"{TOKEN_UNPARSEABLE}: cannot read {args.certs_output}: {failure}", file=sys.stderr)
        return EXIT_UNPARSEABLE

    verdict = evaluate(certs_output, baseline)
    blind = None
    if verdict.code == EXIT_UNPARSEABLE:
        blind = describe_file(args.certs_output, certs_output)
    return report(verdict, blind)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
