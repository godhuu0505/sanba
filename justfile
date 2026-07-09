# SANBA task runner — the single entrypoint for local dev tasks.
# Install with `uv tool install rust-just` (or brew / cargo / mise).
# https://github.com/casey/just
#
# レシピはカテゴリ (group) ごとに分類している。`just --list` でグループ別に並ぶ。
#   setup  … 環境構築 (依存インストール・.env.local 生成)
#   run    … 起動・停止・状態確認 (docker compose)
#   dev    … ネイティブ実行 (docker を介さず個別に速く回す)
#   verify … 検証 (疎通スモーク / test / lint / fmt)
#   ops    … 運用・IaC (Four Keys / Terraform)
set shell := ["bash", "-cu"]

# ローカル実行用の環境変数ファイル。初回 `just setup` で .env.example から自動生成する
# (gitignore 済。シークレットはコミットしない)。
env_file := ".env.local"
# アプリ最小構成。compose は app だけ。--env-file で .env.local を読ませる
# (各サービスの env_file: 指定に加え、compose ファイル内の ${VAR} 補間にも使われる)。
compose := "docker compose --env-file " + env_file
# 補助スタック (可観測性 / LLMOps / DORA) を重ねた全部入り。
compose_full := "docker compose --env-file " + env_file + " -f docker-compose.yml -f docker-compose.tools.yml"

# List available recipes (グループ別に表示)
default:
    @just --list

# ───────────────────────────── 環境構築 (setup) ─────────────────────────────

# 初回ローカル環境構築: .env.local を用意し、全アプリの依存をインストールする (冪等)
[group('setup')]
setup: _env
    cd packages/sanba_shared && uv sync --all-extras --dev
    cd apps/agent && uv sync --all-extras --dev
    cd apps/api && uv sync --all-extras --dev
    cd infra/four-keys/collector && uv sync --all-extras --dev
    cd apps/web && npm install --no-audit --no-fund
    @echo ">> セットアップ完了。'just up' で起動、'just init' なら構築〜起動まで一気通貫。"

# 初回構築から起動までを一気通貫 (ゼロから最小構成を立ち上げる)
[group('setup')]
init: setup up
    @echo ">> 起動完了。'just verify' で疎通確認、http://localhost:3000 を開いてください。"

# .env.local が無ければ .env.example から作成する (既存の秘密情報は上書きしない)。
# .env.example はそのまま `just up` が通るローカル既定値 (devkey/secret / localhost /
# AUTH_DEV_BYPASS=true 等) が入っているため、コピーした時点でローカル設定は自動で揃う。
_env:
    @if [ -f {{env_file}} ]; then echo ">> {{env_file}} は用意済み (上書きしません)"; else cp .env.example {{env_file}} && echo ">> {{env_file}} を .env.example から作成しました (そのまま 'just up' 可。GOOGLE_API_KEY / LIVEKIT_* は必要に応じて設定)"; fi

# ───────────────────────────── 起動・停止 (run) ─────────────────────────────

# ローカルのアプリ最小構成を起動 (web/api/agent/livekit/firestore/elasticsearch)
[group('run')]
up:
    {{compose}} up -d --build

# 補助スタックも重ねて全部入りで起動 (+ observability / four-keys)
[group('run')]
up-full:
    {{compose_full}} up -d --build

# ブラウザでローカル Web (http://localhost:3000) を開く (Linux: xdg-open / macOS: open)
[group('run')]
open:
    @command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:3000 || open http://localhost:3000

# スタックを停止 (補助スタック込みで確実に落とす)
[group('run')]
down:
    {{compose_full}} down

# 補助スタックだけ落とす (アプリは残す)
[group('run')]
tools-down:
    {{compose_full}} stop otel-collector prometheus loki tempo grafana four-keys

# 起動中サービス一覧
[group('run')]
ps:
    {{compose_full}} ps

# ログを追従
[group('run')]
logs:
    {{compose_full}} logs -f --tail=100

# 全イメージをビルド
[group('run')]
build:
    {{compose_full}} build

# ───────────────────────── ネイティブ実行 (dev) ─────────────────────────

# エージェントワーカーをローカル実行
[group('dev')]
agent-dev:
    cd apps/agent && uv run python -m sanba_agent.main dev

# API をローカル実行
[group('dev')]
api-dev:
    cd apps/api && uv run uvicorn sanba_api.main:app --reload --port 8080

# Web をローカル実行
[group('dev')]
web-dev:
    cd apps/web && npm run dev

# ───────────────────────────── 検証 (verify) ─────────────────────────────

# ローカルスタックの疎通スモークテスト (アプリ最小構成)
[group('verify')]
verify:
    ./scripts/verify-local.sh

# 疎通スモークテスト (補助スタック込み)
[group('verify')]
verify-full:
    ./scripts/verify-local.sh --full

# 全テストを実行
[group('verify')]
test:
    cd packages/sanba_shared && uv run pytest -q
    cd apps/agent && uv run pytest -q
    cd apps/api && uv run pytest -q
    cd apps/worker && uv run pytest -q
    cd infra/four-keys/collector && uv run pytest -q

# lint + 型チェック
[group('verify')]
lint: check-comments
    cd packages/sanba_shared && uv run ruff check . && uv run mypy src
    cd apps/agent && uv run ruff check . && uv run mypy src
    cd apps/api && uv run ruff check . && uv run mypy src
    cd apps/worker && uv run ruff check . && uv run mypy src
    cd infra/four-keys/collector && uv run ruff check . && uv run mypy src
    cd apps/web && npm run lint && npm run typecheck

# 説明的コメントの追加を禁止する (CLAUDE.md)。noqa/type: ignore/eslint-disable 等は許可
[group('verify')]
check-comments:
    python3 scripts/check_no_comments.py
    node scripts/check-no-comments.mjs

# フォーマット
[group('verify')]
fmt:
    cd apps/agent && uv run ruff format .
    cd apps/api && uv run ruff format .

# ADR 索引 (docs/adr/README.md) を再生成する。ADR を追加・改訂したら実行して commit する
[group('verify')]
docs-index:
    python3 scripts/gen-docs-index.py

# ADR 索引が最新か検証する (CI 向け / 更新漏れがあれば非ゼロ終了)
[group('verify')]
docs-check:
    python3 scripts/gen-docs-index.py --check

# ───────────────────────────── 運用・IaC (ops) ─────────────────────────────

# Four Keys メトリクスを一度だけ表示 (DORA 自己計測)
[group('ops')]
four-keys:
    cd infra/four-keys/collector && uv run python -m fourkeys collect --json

# Terraform plan
[group('ops')]
tf-plan:
    cd infra/terraform && terraform plan

# Terraform apply
[group('ops')]
tf-apply:
    cd infra/terraform && terraform apply

# sanba-analytics (ADR-0061) の ES データストリーム/ILM/単価 index と Kibana ダッシュボードを冪等セットアップ
[group('ops')]
analytics-setup:
    cd packages/sanba_shared && uv run python ../../scripts/setup_analytics.py
