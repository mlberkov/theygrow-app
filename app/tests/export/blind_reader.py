"""A reader that knows nothing about this repository.

THIS MODULE IS THE POINT OF THE PACKET, so it is kept honest by construction:
it imports only the Python standard library, it never touches
`app/m/v1/export/declaration.json` on disk, and every structural fact it uses
comes out of the artifact's own embedded copy. It is what a person in 2044 with
a zip file and no app would have to be able to write.

`test_artifact_selfdescribing.py` asserts the "only stdlib" half by reading this
file's own import statements, so the guarantee cannot rot into a comment.
"""

from __future__ import annotations

import json
import zipfile
from typing import Any


class Artifact:
    """An opened archive, navigated entirely through its own declaration."""

    def __init__(self, raw: bytes) -> None:
        import io

        self._zip = zipfile.ZipFile(io.BytesIO(raw))
        self.index: dict[str, Any] = json.loads(self._read("index.json"))
        self.manifest: dict[str, Any] = json.loads(self._read("MANIFEST.json"))
        # The declaration comes out of the ARTIFACT, never off disk.
        self.declaration: dict[str, Any] = self.index["declaration"]

    def _read(self, path: str) -> str:
        return self._zip.read(path).decode("utf-8")

    # --- structure, discovered rather than assumed -----------------------

    def dataset_names(self) -> list[str]:
        return [dataset["name"] for dataset in self.declaration["datasets"]]

    def columns_of(self, dataset: str) -> list[str]:
        for declared in self.declaration["datasets"]:
            if declared["name"] == dataset:
                return [column["name"] for column in declared["columns"]]
        raise KeyError(f"the artifact declares no dataset named {dataset!r}")

    def rows(self, dataset: str) -> list[dict[str, Any]]:
        """Rows of a declared dataset, taken from the sidecar index."""
        if dataset not in self.dataset_names():
            raise KeyError(f"the artifact declares no dataset named {dataset!r}")
        rows: list[dict[str, Any]] = self.index["datasets"][dataset]
        return rows

    def text_file(self, path: str) -> str:
        return self._read(path)

    def declared_file_paths(self) -> list[str]:
        return [entry["path"] for entry in self.declaration["files"]]

    # --- the one join a reader has to be able to make ---------------------

    def journal(self) -> list[dict[str, Any]]:
        """The journal, each spine row carrying its detail row.

        Every step here is read out of the declaration's `join` block rather than
        known in advance: which dataset is the spine, which of its columns is the
        key, which column names the detail dataset, and which column joins back.
        A reader needs no knowledge of the application to follow it.
        """
        join = self.declaration["join"]
        spine_key = join["spine_key"]
        detail_key = join["detail_key"]
        selector = join["detail_selector"]

        details: dict[str, dict[str, dict[str, Any]]] = {
            name: {str(row[detail_key]): row for row in self.rows(name)}
            for name in join["detail_datasets"]
        }

        joined = []
        for entry in self.rows(join["spine"]):
            dataset = str(entry[selector])
            detail = details.get(dataset, {}).get(str(entry[spine_key]))
            joined.append({**entry, "detail_dataset": dataset, "detail": detail})
        return joined
