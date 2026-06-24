# syntax=docker/dockerfile:1
# build context = リポジトリ直下 (ADR-0014 §9)。共有パッケージ packages/sanba_shared を
# 同梱するため、相対 path 依存 (../../packages/sanba_shared) を保ったまま COPY する。
FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

# uv for fast, reproducible installs
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 共有パッケージ + アプリ。構造を保つことで pyproject の [tool.uv.sources] が解決できる。
COPY packages/sanba_shared ./packages/sanba_shared
COPY apps/agent/pyproject.toml ./apps/agent/pyproject.toml
COPY apps/agent/src ./apps/agent/src
RUN uv pip install --system --no-cache ./apps/agent

# LiveKit Agents need plugin model files; download at build time when present.
RUN python -m sanba_agent.main download-files || true

# Run as an unprivileged user (defense in depth).
RUN useradd --create-home --uid 10001 appuser
USER appuser

ENTRYPOINT ["python", "-m", "sanba_agent.main"]
CMD ["start"]
