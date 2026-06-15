# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml ./
COPY src ./src
COPY sample_events.json ./sample_events.json
RUN uv pip install --system --no-cache .

# Non-root (defense in depth, CLAUDE.md security guidance).
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 9301
ENTRYPOINT ["python", "-m", "fourkeys"]
CMD ["serve"]
