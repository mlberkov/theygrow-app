"""RSN-P2 — synthesised `apksigner verify --verbose --print-certs` output.

Builds the comparand programmatically rather than storing recorded files, the
way `app/tests/schema/harness.py` and `app/tests/export/harness.py` build theirs.

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
"""

from __future__ import annotations

import sys
from pathlib import Path

_DN = "CN=they grow, OU=release, O=theygrow, L=x, ST=x, C=ZZ"


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
