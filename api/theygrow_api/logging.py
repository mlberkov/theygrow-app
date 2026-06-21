"""PII-redaction forward guard (privacy precondition, AGENTS.md §4).

This establishes telemetry/redaction discipline from the first byte of code: a
logging filter that redacts known child-PII field names before any handler
formats a record. At M2-P2 there is NO live child-PII data path yet (those
arrive at M3); this is a *forward guard* so PII can never reach logs/telemetry as
data paths land. See docs/RUNTIME-INVARIANTS.md "No child PII in telemetry or
logs" and docs/INVARIANTS.md M2-P2-INV-001.
"""

import logging

#: Known child-PII structured field names that must never reach a log sink.
PII_FIELDS = frozenset({"child_name", "diary_text", "birthdate", "dob"})

#: Replacement token written in place of any redacted PII field value.
REDACTED = "[REDACTED]"


class PiiRedactionFilter(logging.Filter):
    """Redact known child-PII field names carried on a log record.

    Covers structured fields attached via ``logger.log(..., extra={...})`` (which
    become record attributes). It does NOT scrub free-text message bodies — the
    guard governs known structured PII field names only.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        for field in PII_FIELDS:
            if hasattr(record, field):
                setattr(record, field, REDACTED)
        return True


def install_pii_redaction(logger: logging.Logger | None = None) -> None:
    """Attach the redaction filter to ``logger`` (root logger if omitted)."""
    target = logger if logger is not None else logging.getLogger()
    target.addFilter(PiiRedactionFilter())
