.DEFAULT_GOAL := help
# アプリ最小構成 / 補助スタック込みの全部入り。
COMPOSE := docker compose
COMPOSE_FULL := docker compose -f docker-compose.yml -f docker-compose.tools.yml

.PHONY: help up up-full down tools-down ps logs build verify verify-full test lint fmt four-keys agent-dev api-dev web-dev tf-plan tf-apply

help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## アプリ最小構成を起動 (web/api/agent/livekit/firestore/elasticsearch)
	$(COMPOSE) up -d --build

up-full: ## 補助スタック込みで全部入り起動 (+ observability / langfuse / four-keys)
	$(COMPOSE_FULL) up -d --build

down: ## スタックを停止 (補助スタック込みで確実に落とす)
	$(COMPOSE_FULL) down

tools-down: ## 補助スタックだけ落とす (アプリは残す)
	$(COMPOSE_FULL) stop otel-collector prometheus loki tempo grafana four-keys langfuse langfuse-db

ps: ## 起動中サービス一覧
	$(COMPOSE_FULL) ps

logs: ## ログを追従
	$(COMPOSE_FULL) logs -f --tail=100

build: ## 全イメージをビルド
	$(COMPOSE_FULL) build

verify: ## ローカルスタックの疎通スモークテスト (アプリ最小構成)
	./scripts/verify-local.sh

verify-full: ## 疎通スモークテスト (補助スタック込み)
	./scripts/verify-local.sh --full

test: ## 全テストを実行
	cd apps/agent && uv run pytest -q
	cd apps/api && uv run pytest -q
	cd infra/four-keys/collector && uv run pytest -q

lint: ## lint
	cd apps/agent && uv run ruff check . && uv run mypy src
	cd apps/api && uv run ruff check . && uv run mypy src
	cd infra/four-keys/collector && uv run ruff check . && uv run mypy src

four-keys: ## Four Keys メトリクスを表示 (DORA 自己計測)
	cd infra/four-keys/collector && uv run python -m fourkeys collect --json

fmt: ## フォーマット
	cd apps/agent && uv run ruff format .
	cd apps/api && uv run ruff format .

agent-dev: ## エージェントワーカーをローカル実行
	cd apps/agent && uv run python -m sanba_agent.main dev

api-dev: ## API をローカル実行
	cd apps/api && uv run uvicorn sanba_api.main:app --reload --port 8080

web-dev: ## Web をローカル実行
	cd apps/web && npm run dev

tf-plan: ## Terraform plan
	cd infra/terraform && terraform plan

tf-apply: ## Terraform apply
	cd infra/terraform && terraform apply
