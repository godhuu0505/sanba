# syntax=docker/dockerfile:1
# build context = リポジトリ直下 (ADR-0014 §9)。共有パッケージ packages/sanba_shared を
# 同梱するため、相対 path 依存 (../../packages/sanba_shared) を保ったまま COPY する。
FROM python:3.13-slim@sha256:eb43ff125d8d58d7449dcba7d336c23bcac412f526d861db493b9994d8010280 AS base

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy
WORKDIR /app

# uv for fast, reproducible installs
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 共有パッケージ + アプリ。構造を保つことで pyproject の [tool.uv.sources] が解決できる。
COPY packages/sanba_shared ./packages/sanba_shared
COPY apps/agent/pyproject.toml ./apps/agent/pyproject.toml
COPY apps/agent/src ./apps/agent/src
# BuildKit キャッシュマウントで uv のダウンロード済み wheel を再ビルド間で再利用する。
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system ./apps/agent

# LiveKit Agents need plugin model files. 本番/CI ではビルド時に同梱して
# コールドスタートを速くする (既定 DOWNLOAD_MODELS=1)。ローカルは compose で
# DOWNLOAD_MODELS=0 を渡してスキップし、ビルドを軽くする (モデルは実行時に取得)。
ARG DOWNLOAD_MODELS=1
RUN if [ "$DOWNLOAD_MODELS" = "1" ]; then \
      python -m sanba_agent.main download-files || true; \
    fi

# Run as an unprivileged user (defense in depth).
RUN useradd --create-home --uid 10001 appuser
USER appuser

ENTRYPOINT ["python", "-m", "sanba_agent.main"]
CMD ["start"]
