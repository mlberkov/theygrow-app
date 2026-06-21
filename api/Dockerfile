# theygrow-api — FastAPI backend container (M2-P3).
#
# Builds the api-scoped PEP 621 package and serves it with uvicorn on the
# Cloud Run standard port 8080. Build context is the /api subtree (self-contained
# per-app build). The health route needs NO environment — it constructs no config
# and opens no connections; real DB use (M3) reads its connection from the
# environment at runtime.
FROM python:3.12-slim

WORKDIR /srv

# Install the api package from its own subtree (build context = ./api).
COPY pyproject.toml ./
COPY theygrow_api ./theygrow_api
RUN pip install --no-cache-dir .

EXPOSE 8080

CMD ["uvicorn", "theygrow_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
