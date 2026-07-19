# syntax=docker/dockerfile:1
# build context = リポジトリ直下 (ADR-0014 §9)。共有パッケージ packages/sanba_shared を
# 同梱するため、相対 path 依存 (../../packages/sanba_shared) を保ったまま COPY する。
FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /usr/local/bin/uv

# 共有パッケージ + アプリ。構造を保つことで pyproject の [tool.uv.sources] が解決できる。
COPY packages/sanba_shared ./packages/sanba_shared
COPY apps/api/pyproject.toml ./apps/api/pyproject.toml
COPY apps/api/src ./apps/api/src
# BuildKit キャッシュマウントで uv のダウンロード済み wheel を再ビルド間で再利用する
# (--no-cache は付けない。付けるとマウントの意味が無くなる)。
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system ./apps/api

# Run as an unprivileged user (defense in depth).
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8080
# Cloud Run provides $PORT; default to 8080 locally.
CMD ["sh", "-c", "uvicorn sanba_api.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
