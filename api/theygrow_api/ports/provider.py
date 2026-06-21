"""Provider-port seam for the family-memory engine — INTERFACE STUB ONLY.

The ``diary-memory-service`` engine stays OUT of the live perimeter
(AGENTS.md §3 / ADR-005): it is a code/data donor for the M3 ``/export`` import
and the M4 retrieval lift, never a live dependency of theygrow-app. This module
defines only the structural contract a future adapter will satisfy — no
implementation, no engine import, no network.
"""

from typing import Protocol, runtime_checkable


@runtime_checkable
class MemoryProvider(Protocol):
    """Structural interface a future family-memory provider adapter satisfies.

    Stub-only at M2-P2. The real adapter (and its concrete methods) land with the
    M4 retrieval lift; this seam exists so the boundary is explicit from the
    start and the engine never becomes a live import.
    """

    def health(self) -> bool:
        """Liveness of the provider seam. Concrete impl lands in M4."""
        ...
