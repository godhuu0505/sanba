# SANBA task runner. `just` is the primary entrypoint; the Makefile remains as
# a thin compatibility shim. https://github.com/casey/just
set shell := ["bash", "-cu"]

compose := "docker compose"

# List available recipes
default:
    @just --list

# ローカルスタックを起動 (agent/api/web/observability)
up:
    {{compose}} up -d --build

# スタックを停止
down:
    {{compose}} down

# ログを追従
logs:
    {{compose}} logs -f --tail=100

# 全イメージをビルド
build:
    {{compose}} build

# 全テストを実行
test:
    cd apps/agent && uv run pytest -q
    cd apps/api && uv run pytest -q
    cd infra/four-keys/collector && uv run pytest -q

# lint + 型チェック
lint:
    cd apps/agent && uv run ruff check . && uv run mypy src
    cd apps/api && uv run ruff check . && uv run mypy src
    cd infra/four-keys/collector && uv run ruff check . && uv run mypy src

# Four Keys メトリクスを一度だけ表示 (DORA 自己計測)
four-keys:
    cd infra/four-keys/collector && uv run python -m fourkeys collect --json

# フォーマット
fmt:
    cd apps/agent && uv run ruff format .
    cd apps/api && uv run ruff format .

# エージェントワーカーをローカル実行
agent-dev:
    cd apps/agent && uv run python -m sanba_agent.main dev

# API をローカル実行
api-dev:
    cd apps/api && uv run uvicorn sanba_api.main:app --reload --port 8080

# Web をローカル実行
web-dev:
    cd apps/web && npm run dev

# Terraform plan
tf-plan:
    cd infra/terraform && terraform plan

# Terraform apply
tf-apply:
    cd infra/terraform && terraform apply
