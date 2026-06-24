"""M4-P1 — note parser (verbatim engine lift). Pure unit; no DB.

Covers the donor contract: ISO ``YYYY-MM-DD`` first non-empty line, remaining
non-empty lines become events (one per line), blank lines dropped, and ``None``
when the first non-empty line is not an ISO date (the caller's fallback signal).
"""

from __future__ import annotations

from datetime import date

from theygrow_api.domain.parser import ParsedNote, parse_note


def test_date_led_payload_parses_date_and_events() -> None:
    parsed = parse_note("2026-03-15\nfever 38.1\nslept poorly")
    assert isinstance(parsed, ParsedNote)
    assert parsed.note_date == date(2026, 3, 15)
    assert parsed.events == ["fever 38.1", "slept poorly"]
    assert parsed.first_line == "2026-03-15"


def test_blank_lines_are_dropped_and_lines_stripped() -> None:
    parsed = parse_note("\n  2026-03-15  \n\n   first event  \n\n  second \n")
    assert parsed is not None
    assert parsed.note_date == date(2026, 3, 15)
    assert parsed.events == ["first event", "second"]


def test_date_only_payload_yields_note_with_no_events() -> None:
    parsed = parse_note("2026-03-15")
    assert parsed is not None
    assert parsed.events == []


def test_non_date_first_line_returns_none() -> None:
    # Caller (derivation) turns this into the created_at fallback (M4-DL-001).
    assert parse_note("woke up early\n2026-03-15") is None


def test_empty_payload_returns_none() -> None:
    assert parse_note("") is None
    assert parse_note("   \n  \n") is None


def test_non_iso_date_format_returns_none() -> None:
    # Strict ISO only: 15/03/2026 is not date.fromisoformat-parseable.
    assert parse_note("15/03/2026\nevent") is None
