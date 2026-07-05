# syntax=docker/dockerfile:1
# ベースイメージは digest でピン（Scorecard Pinned-Dependencies / 供給網対策）。
# タグ 3.12-slim の digest。更新は Dependabot(docker) に任せる。
FROM python:3.12-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS base

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
