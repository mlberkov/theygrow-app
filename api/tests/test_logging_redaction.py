"""PII-redaction forward guard: known PII field names never reach a sink."""

import io
import logging

from theygrow_api.logging import REDACTED, PiiRedactionFilter


def test_redacts_known_pii_field_before_handler_formats() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s child=%(child_name)s"))

    logger = logging.getLogger("test_pii_redaction")
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.addFilter(PiiRedactionFilter())

    logger.info("event", extra={"child_name": "Alice"})

    out = stream.getvalue()
    assert "Alice" not in out
    assert REDACTED in out
