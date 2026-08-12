"""Write the fixture artifact to disk, for the veraPDF gate to validate.

CI-only, and deliberately thin. It reuses `harness.seeded_store()` and
`harness.build_artifact()` unchanged, so the file veraPDF certifies is the file
`pytest app/tests/export` asserts against and the file the shipped builder
produces — not a third thing assembled for the validator's benefit.

Run as:  python3 app/tests/export/emit_fixture.py <output directory>

Standard library only, and no pytest: the `android-instrumented` job has Node
and Java but installs no Python packages, and adding an install step to buy one
import would be a poor trade.
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
# app/tests is the import root for both test packages, exactly as pytest
# resolves them; without this `schema.harness` is unreachable from a bare run.
sys.path.insert(0, str(REPO_ROOT / "app" / "tests"))

from export.harness import build_artifact, seeded_store  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: emit_fixture.py <output directory>", file=sys.stderr)
        return 2

    out = Path(argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)

    connection = seeded_store()
    try:
        raw = build_artifact(connection, out, name="fixture.zip")
    finally:
        connection.close()

    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        if "print/archive.pdf" not in names:
            print(f"the artifact carries no print layer: {names}", file=sys.stderr)
            return 1
        pdf = archive.read("print/archive.pdf")

    (out / "archive.pdf").write_bytes(pdf)
    print(f"wrote {out / 'archive.pdf'} ({len(pdf)} bytes) from a {len(raw)}-byte artifact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
