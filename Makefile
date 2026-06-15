.DEFAULT_GOAL := help
COMPOSE := docker compose

.PHONY: help up down logs build test lint fmt agent-dev api-dev web-dev tf-plan tf-apply

help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## ローカルスタックを起動 (agent/api/web/observability)
	$(COMPOSE) up -d --build

down: ## スタックを停止
	$(COMPOSE) down

logs: ## ログを追従
	$(COMPOSE) logs -f --tail=100

build: ## 全イメージをビルド
	$(COMPOSE) build

test: ## 全テストを実行
	cd apps/agent && uv run pytest -q
	cd apps/api && uv run pytest -q

lint: ## lint
	cd apps/agent && uv run ruff check . && uv run mypy src
	cd apps/api && uv run ruff check . && uv run mypy src

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
