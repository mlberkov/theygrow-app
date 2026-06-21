"""FastAPI application skeleton (M2-P2).

Exposes a single, in-process ``GET /api/health`` endpoint. No business behavior,
no DB connection, no config dependency — the health route needs zero environment
to run. The ``/api`` prefix keeps the path stable for the future same-origin
nginx proxy (``location /api/`` → FastAPI) that lands in M2-P3.
"""

from fastapi import APIRouter, FastAPI

api_router = APIRouter(prefix="/api")


@api_router.get("/health")
def health() -> dict[str, str]:
    """In-process liveness of the API skeleton. Carries no PII."""
    return {"status": "ok", "service": "theygrow-api"}


def create_app() -> FastAPI:
    """Construct the FastAPI application."""
    app = FastAPI(title="theygrow-api")
    app.include_router(api_router)
    return app


app = create_app()
