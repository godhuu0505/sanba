# syntax=docker/dockerfile:1
# build context = リポジトリ直下 (ADR-0014 §9)。共有パッケージ packages/sanba_shared を
# 同梱するため、相対 path 依存 (../../packages/sanba_shared) を保ったまま COPY する。
FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS base

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/apps/agent/.venv
WORKDIR /app

# uv for fast, reproducible installs
COPY --from=ghcr.io/astral-sh/uv:latest@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /usr/local/bin/uv

# 共有パッケージ + アプリ。構造を保つことで pyproject の [tool.uv.sources] が解決できる。
COPY packages/sanba_shared ./packages/sanba_shared
COPY apps/agent/pyproject.toml apps/agent/uv.lock ./apps/agent/
COPY apps/agent/src ./apps/agent/src
# uv.lock を使った再現ビルド: --frozen で lock を更新せずそのまま解決し (供給網統制)、
# --no-dev で dev グループ (pytest/ruff/mypy) を除外する。BuildKit キャッシュマウントで
# ダウンロード済み wheel を再ビルド間で再利用する。
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --project apps/agent
ENV PATH="/app/apps/agent/.venv/bin:${PATH}"

# LiveKit Agents need plugin model files. 本番/CI ではビルド時に同梱して
# コールドスタートを速くする (既定 DOWNLOAD_MODELS=1)。ローカルは compose で
# DOWNLOAD_MODELS=0 を渡してスキップし、ビルドを軽くする (モデルは実行時に取得)。
ARG DOWNLOAD_MODELS=1
RUN if [ "$DOWNLOAD_MODELS" = "1" ]; then \
      python -m sanba_agent.main download-files || true; \
    fi

# Run as an unprivileged user (defense in depth).
# .cache を事前に uid 10001 所有で作成することで、compose の named volume
# (agent-cache:/home/appuser/.cache) 初回マウント時に volume root が appuser
# 所有としてコピーされ、HF/torch 等のキャッシュ書き込みが permission denied
# にならないようにする。
RUN useradd --create-home --uid 10001 appuser && \
    mkdir -p /home/appuser/.cache && \
    chown -R 10001:10001 /home/appuser/.cache
USER appuser

ENTRYPOINT ["python", "-m", "sanba_agent.main"]
CMD ["start"]
