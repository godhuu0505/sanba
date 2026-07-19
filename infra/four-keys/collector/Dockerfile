# syntax=docker/dockerfile:1
# ベースイメージは digest でピン（Scorecard Pinned-Dependencies / 供給網対策）。
# タグ 3.12-slim の digest。更新は Dependabot(docker) に任せる。
FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /usr/local/bin/uv

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
