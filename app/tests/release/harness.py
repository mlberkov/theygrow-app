"""RSN-P2 — synthesised `apksigner verify --verbose --print-certs` output.

Builds its comparands programmatically, the way `app/tests/schema/harness.py`
and `app/tests/export/harness.py` build theirs — with ONE recorded exception,
added in RSN-P4 and reached through `recorded_output()`. The exception exists
because the synthesised half could not have caught the defect that opened that
packet: every shape in this file is a shape the repository already believed in,
and the line build-tools 37.0.0 actually prints was not among them. So exactly
one file of real tool bytes is kept, and everything that can be synthesised
still is.

WHAT THIS DOES AND DOES NOT PROVE. This is output the repository wrote, so the
suite built on it proves the comparator's LOGIC — that it finds the right line,
normalises both sides, and returns the right exit code — and NOT that the
comparator parses what apksigner really prints. That second claim is executed by
the `android` job in .github/workflows/ci.yml, which runs the real apksigner
against the real debug APK. Neither half is sufficient alone and the split is
deliberate: this half runs everywhere with no Android SDK, that half runs
wherever an SDK exists.

The public-key digest is deliberately DIFFERENT from the certificate digest, as
it is on a real APK — that difference is the whole point of the decoy test.

RSN-P3 adds `fake_apksigner` on the same terms and with the same limit. A stub
this repository wrote proves the comparator's PLUMBING — which binary it picks,
which stream it parses, what it says when it cannot parse — and proves nothing at
all about what a real apksigner prints. That second claim still belongs to the
`android` job and to no test here.

RSN-P4 adds `recorded_output` and `scheme_qualified_output`. The recorded file
narrows the gap without closing it: it proves the parser reads the shape one real
apksigner printed ONCE, on one image, on one day. It does not prove the tool still
prints it — that claim is executed by the `android` job and by nothing here, which
is exactly the split that let a pattern defect live in a green suite for two
packets.
"""

from __future__ import annotations

import sys
from pathlib import Path

_DN = "CN=they grow, OU=release, O=theygrow, L=x, ST=x, C=ZZ"

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def recorded_output(name: str) -> str:
    """Read a recorded apksigner capture, dropping its `#` provenance header.

    The header is inside the file rather than beside it on purpose (the
    `native/android/release-signing/cert-sha256.txt` convention): provenance in a
    second file is provenance that can be read without. apksigner emits no line
    beginning with `#`, so the rule cannot eat recorded output, and the suite
    asserts the surviving body's byte and line counts against the figures the run
    log itself reported — a transcription that drifted would red rather than
    quietly become a fixture of something nobody printed.
    """
    raw = (FIXTURES / name).read_text(encoding="utf-8")
    return "".join(f"{line}\n" for line in raw.splitlines() if not line.startswith("#"))


def _derived(digest: str, width: int) -> str:
    """A stable, obviously-synthetic filler digest derived from `digest`."""
    return (digest[::-1] * 2)[:width]


def apksigner_output(
    *cert_digests: str,
    verifies: bool = True,
    include_certificate_digest: bool = True,
) -> str:
    """Render the output apksigner produces for `cert_digests`, one block per signer.

    `include_certificate_digest=False` omits the `certificate SHA-256 digest`
    line while keeping the `public key SHA-256 digest` line — the shape that
    catches a parser matching on "SHA-256 digest" alone.
    """
    header = [
        "Verifies" if verifies else "DOES NOT VERIFY",
        "Verified using v1 scheme (JAR signing): false",
        f"Verified using v2 scheme (APK Signature Scheme v2): {str(verifies).lower()}",
        f"Verified using v3 scheme (APK Signature Scheme v3): {str(verifies).lower()}",
        "Verified using v3.1 scheme (APK Signature Scheme v3.1): false",
        "Verified using v4 scheme (APK Signature Scheme v4): false",
        "Verified for SourceStamp: false",
        f"Number of signers: {len(cert_digests)}",
    ]

    body: list[str] = []
    for index, digest in enumerate(cert_digests, start=1):
        body.append(f"Signer #{index} certificate DN: {_DN}")
        if include_certificate_digest:
            body.append(f"Signer #{index} certificate SHA-256 digest: {digest}")
        body.append(f"Signer #{index} certificate SHA-1 digest: {_derived(digest, 40)}")
        body.append(f"Signer #{index} certificate MD5 digest: {_derived(digest, 32)}")
        body.append(f"Signer #{index} key algorithm: RSA")
        body.append(f"Signer #{index} key size (bits): 4096")
        body.append(f"Signer #{index} public key SHA-256 digest: {_derived(digest, 64)}")
        body.append(f"Signer #{index} public key SHA-1 digest: {_derived(digest, 40)}")
        body.append(f"Signer #{index} public key MD5 digest: {_derived(digest, 32)}")

    return "\n".join(header + body) + "\n"


def sdk_range_output(cert_digest: str) -> str:
    """The `Signer (minSdkVersion=…, maxSdkVersion=…) #1 …` form newer build-tools emit.

    Same certificate, different line prefix. The comparator must still find it,
    or a build-tools upgrade would silently turn every release run into an
    unparseable-output failure.
    """
    return (
        "Verifies\n"
        "Number of signers: 1\n"
        f"Signer (minSdkVersion=24, maxSdkVersion=2147483647) #1 certificate DN: {_DN}\n"
        "Signer (minSdkVersion=24, maxSdkVersion=2147483647) #1 certificate SHA-256 "
        f"digest: {cert_digest}\n"
        "Signer (minSdkVersion=24, maxSdkVersion=2147483647) #1 public key SHA-256 "
        f"digest: {_derived(cert_digest, 64)}\n"
    )


def scheme_qualified_output(
    *cert_digests: str,
    schemes: tuple[str, ...] = ("V2",),
    sdk_range: bool = False,
) -> str:
    """The `V2 Signer: …` form, one block per scheme per certificate.

    apksigner qualifies the signer line by signature scheme and, on the version
    that produced `fixtures/apksigner-buildtools-37.0.0.txt`, numbers it not at
    all. `schemes` renders one block per scheme, which is what an APK signed under
    several schemes prints: the SAME certificate reported more than once.

    `sdk_range=True` adds the rotation parenthetical to the scheme-qualified form
    — the combination of both prefixes. That combination is NOT observed anywhere
    in this repository's evidence; it is accepted by construction, because a
    parser that handles each half separately and fails on the pair would be a
    surprise nobody wants to meet on a release run.
    """
    qualifier = " (minSdkVersion=24, maxSdkVersion=2147483647) #1" if sdk_range else ":"
    header = ["Verifies", f"Number of signers: {len(cert_digests)}"]
    body: list[str] = []
    for digest in cert_digests:
        for scheme in schemes:
            signer = f"{scheme} Signer{qualifier}"
            body.append(f"{signer} certificate DN: {_DN}")
            body.append(f"{signer} certificate SHA-256 digest: {digest}")
            body.append(f"{signer} certificate SHA-1 digest: {_derived(digest, 40)}")
            body.append(f"{signer} certificate MD5 digest: {_derived(digest, 32)}")
            body.append(f"{signer} key algorithm: RSA")
            body.append(f"{signer} public key SHA-256 digest: {_derived(digest, 64)}")
            body.append(f"{signer} public key SHA-1 digest: {_derived(digest, 40)}")
            body.append(f"{signer} public key MD5 digest: {_derived(digest, 32)}")
    return "\n".join(header + body) + "\n"


def fake_apksigner(
    sdk_root: Path,
    *,
    stdout: str = "",
    stderr: str = "",
    returncode: int = 0,
    version: str = "36.0.0",
) -> Path:
    """Plant an executable apksigner stub at `<sdk_root>/build-tools/<version>/`.

    Returns `sdk_root`, so a caller can hand it straight to `ANDROID_HOME`. Call
    it more than once with different `version` values to build the several-
    versions-side-by-side layout GitHub's runner images carry, which is what the
    resolution order has to be right about.

    The payloads live in sibling files the stub copies out, rather than inside a
    heredoc: the byte streams have to be EXACT — "stdout was empty" is a distinct
    diagnosis from "stdout was one newline", and a heredoc cannot express the
    first. The stub is Python behind an absolute-path shebang and calls no
    external command, because the suite scrubs PATH to prove the ABSENT verdict
    and a stub that needed `cat` would die of that scrubbing instead of
    answering.
    """
    tool_dir = sdk_root / "build-tools" / version
    tool_dir.mkdir(parents=True, exist_ok=True)

    out_file = tool_dir / "stdout.txt"
    err_file = tool_dir / "stderr.txt"
    out_file.write_text(stdout, encoding="utf-8")
    err_file.write_text(stderr, encoding="utf-8")

    tool = tool_dir / "apksigner"
    tool.write_text(
        f"#!{sys.executable}\n"
        "import pathlib, sys\n"
        f"sys.stdout.write(pathlib.Path({str(out_file)!r}).read_text(encoding='utf-8'))\n"
        f"sys.stderr.write(pathlib.Path({str(err_file)!r}).read_text(encoding='utf-8'))\n"
        f"raise SystemExit({returncode})\n",
        encoding="utf-8",
    )
    tool.chmod(0o755)
    return sdk_root
