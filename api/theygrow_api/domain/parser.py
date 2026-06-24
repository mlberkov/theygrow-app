"""Note parser — verbatim lift from the engine (ADR-005 §7: transfer, not rewrite).

Donor: ``memory_rag.core.domain.parser`` (read as out-of-perimeter code donor
under ADR-005; no engine import, no runtime edge). Transferred unchanged.

Strict ISO ``YYYY-MM-DD`` on the first non-empty line of the payload; remaining
non-empty lines become events. Returns ``None`` when the first non-empty line is
not an ISO date — the caller decides the fallback rather than inventing a date.
In M4-P1 the re-derivation pass (``theygrow_api.derivation``) turns ``None`` into
a ``created_at`` fallback so every live ``{note, draft}`` message stays
searchable (M4-DL-001); the engine instead surfaced it as ``INVALID_INPUT``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True, slots=True)
class ParsedNote:
    """Result of a successful parse: a date and the event lines that follow."""

    note_date: date
    events: list[str]
    first_line: str


def _split_non_empty_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def _parse_iso_date(token: str) -> date | None:
    try:
        return date.fromisoformat(token)
    except ValueError:
        return None


def parse_note(payload: str) -> ParsedNote | None:
    """Parse ``payload`` into ``(note_date, events)``.

    The first non-empty line must be an ISO ``YYYY-MM-DD`` date. The remaining
    non-empty lines become events, in order, one event per line.
    """
    lines = _split_non_empty_lines(payload or "")
    if not lines:
        return None

    first_line = lines[0]
    parsed_date = _parse_iso_date(first_line)
    if parsed_date is None:
        return None

    return ParsedNote(note_date=parsed_date, events=lines[1:], first_line=first_line)
