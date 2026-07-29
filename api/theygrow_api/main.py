"""FastAPI application skeleton (M2-P2) + the readiness probe (A3-P2).

Two routes, and the difference between them is the whole point:

  * ``GET /api/health`` — LIVENESS. Unchanged since M2-P2 and deliberately frozen: no
    business behavior, no DB connection, no config dependency. It needs zero environment to
    answer, and its exact body is asserted by the eval runner's ``--health-url`` probe
    (``evals/runner.py``) and by both promotion smokes. Liveness must never acquire a
    database dependency: on a rollback to a revision with no Cloud SQL attachment, this is
    the route that keeps answering (A3-P2-INV-001 (a)).
  * ``GET /api/health/ready`` — READINESS (A3-P2). Constructs ``Settings``, borrows a
    connection from the process-cached engine and runs ``SELECT 1``. Fails closed and mute:
    a fixed status enum and nothing else, on either path (A3-P2-INV-001 (b)).

The ``/api`` prefix keeps the path stable for the same-origin nginx proxy (``location ^~
/api/`` -> FastAPI), which landed in A3-P1 and forwards the full URI — so a route added to
this router is same-origin-reachable with no delivery-side change.

``create_app`` also installs this process's logging boundary (see ``_configure_logging``). It
still constructs no ``Settings`` and opens no connection.
"""

import logging
from functools import lru_cache

from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse

from theygrow_api.db.readiness import check_readiness
from theygrow_api.logging import install_pii_redaction

api_router = APIRouter(prefix="/api")


@lru_cache(maxsize=1)
def _configure_logging() -> None:
    """Install this process's logging boundary — once (A3-P2).

    Until this packet the served app emitted no signals, so it configured no logging at all;
    each offline CLI's ``main()`` did it for itself. The readiness probe changes that on both
    counts. A signal emitted into a logger with no handler reaches nothing, so ``readiness.
    probe`` would never appear in Cloud Logging — which is where the RUNBOOK sends an operator
    to tell a bad secret from a missing attachment. And ``LoggingSignalSink``'s §4 guarantee
    ("emits through the PII-guarded logging boundary") is only true if the redaction filter is
    installed in THIS process.

    Deliberately environment-free: the level is the same fixed INFO the CLIs use, NOT
    ``Settings.log_level``. Reading ``Settings`` here would hand liveness a configuration
    dependency at import time and break A3-P2-INV-001 (a).
    """
    logging.basicConfig(level=logging.INFO)
    install_pii_redaction()


@api_router.get("/health")
def health() -> dict[str, str]:
    """In-process liveness of the API skeleton. Carries no PII."""
    return {"status": "ok", "service": "theygrow-api"}


@api_router.get("/health/ready")
def health_ready() -> JSONResponse:
    """Readiness: the database is reachable from this process right now.

    The body is a fixed status enum and nothing else — no instance name, no driver version,
    no timings, no exception text — on BOTH paths; the failure path is the same shape with a
    503. Timings and the bounded failure class ride the ``readiness.probe`` signal instead
    (``db/readiness.py``), which is where an operator diagnoses a red probe.
    """
    result = check_readiness()
    return JSONResponse(
        status_code=200 if result.ready else 503,
        content={"status": "ready" if result.ready else "unavailable"},
    )


def create_app() -> FastAPI:
    """Construct the FastAPI application. Constructs no ``Settings`` and opens no connection."""
    _configure_logging()
    app = FastAPI(title="theygrow-api")
    app.include_router(api_router)
    return app


app = create_app()
