# SANBA task runner. `just` is the primary entrypoint; the Makefile remains as
# a thin compatibility shim. https://github.com/casey/just
set shell := ["bash", "-cu"]

# アプリ最小構成。compose は app だけ。
compose := "docker compose"
# 補助スタック (可観測性 / LLMOps / DORA) を重ねた全部入り。
compose_full := "docker compose -f docker-compose.yml -f docker-compose.tools.yml"

# List available recipes
default:
    @just --list

# ローカルのアプリ最小構成を起動 (web/api/agent/livekit/firestore/elasticsearch)
up:
    {{compose}} up -d --build

# 補助スタックも重ねて全部入りで起動 (+ observability / langfuse / four-keys)
up-full:
    {{compose_full}} up -d --build

# スタックを停止 (補助スタック込みで確実に落とす)
down:
    {{compose_full}} down

# 補助スタックだけ落とす (アプリは残す)
tools-down:
    {{compose_full}} stop otel-collector prometheus loki tempo grafana four-keys langfuse langfuse-db

# 起動中サービス一覧
ps:
    {{compose_full}} ps

# ログを追従
logs:
    {{compose_full}} logs -f --tail=100

# 全イメージをビルド
build:
    {{compose_full}} build

# ローカルスタックの疎通スモークテスト (アプリ最小構成)
verify:
    ./scripts/verify-local.sh

# 疎通スモークテスト (補助スタック込み)
verify-full:
    ./scripts/verify-local.sh --full

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
