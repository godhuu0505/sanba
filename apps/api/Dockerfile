# syntax=docker/dockerfile:1
FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml ./
COPY src ./src
RUN uv pip install --system --no-cache .

# Run as an unprivileged user (defense in depth).
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8080
# Cloud Run provides $PORT; default to 8080 locally.
CMD ["sh", "-c", "uvicorn sanba_api.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
