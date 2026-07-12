# syntax=docker/dockerfile:1
FROM python:3.13-slim@sha256:eb43ff125d8d58d7449dcba7d336c23bcac412f526d861db493b9994d8010280

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /usr/local/bin/uv

COPY a2a-facade/pyproject.toml ./a2a-facade/pyproject.toml
COPY a2a-facade/src ./a2a-facade/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system ./a2a-facade

RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8080
CMD ["sh", "-c", "uvicorn --factory sanba_a2a_facade.app:create_app --host 0.0.0.0 --port ${PORT:-8080}"]
