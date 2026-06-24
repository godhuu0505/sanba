# syntax=docker/dockerfile:1
# build context = リポジトリ直下 (ADR-0014 §9)。共有パッケージ packages/sanba_shared を
# 同梱するため、相対 path 依存 (../../packages/sanba_shared) を保ったまま COPY する。
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 共有パッケージ + アプリ。構造を保つことで pyproject の [tool.uv.sources] が解決できる。
COPY packages/sanba_shared ./packages/sanba_shared
COPY apps/api/pyproject.toml ./apps/api/pyproject.toml
COPY apps/api/src ./apps/api/src
RUN uv pip install --system --no-cache ./apps/api

# Run as an unprivileged user (defense in depth).
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8080
# Cloud Run provides $PORT; default to 8080 locally.
CMD ["sh", "-c", "uvicorn sanba_api.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
