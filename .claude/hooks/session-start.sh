#!/bin/bash
# SANBA — SessionStart hook
# AI コーディングエージェント（Claude Code on the web 等）のセッション開始時に、
# テスト/リンタ/型チェックがすぐ走るよう依存関係を整える。
# 設計方針: 冪等・非対話・キャッシュフレンドリ（uv sync / npm install を使う）。
set -euo pipefail

# リモート（Claude Code on the web）以外では何もしない。ローカルは各自の環境を尊重する。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

log() { printf '\033[36m[session-start]\033[0m %s\n' "$1"; }

# --- Python: agent / api (uv 管理) ---
if command -v uv >/dev/null 2>&1; then
  for app in packages/sanba_shared apps/agent apps/api; do
    if [ -f "$app/pyproject.toml" ]; then
      log "uv sync ($app)"
      (cd "$app" && uv sync --all-extras --dev)
    fi
  done
else
  log "uv が見つからないため Python 依存関係のインストールをスキップ"
fi

# --- just: ドキュメント上の主要エントリポイント（ベストエフォート）---
if ! command -v just >/dev/null 2>&1; then
  log "just をインストール (uv tool install rust-just)"
  uv tool install rust-just >/dev/null 2>&1 || log "just のインストールに失敗（手動で 'uv tool install rust-just' を）"
fi

# --- Web: Next.js (npm) ---
if command -v npm >/dev/null 2>&1 && [ -f apps/web/package.json ]; then
  log "npm ci (apps/web)"
  (cd apps/web && npm ci --no-audit --no-fund)
else
  log "npm または apps/web が無いため Web 依存関係をスキップ"
fi

# --- ローカル開発用の .env.local を用意（未作成時のみ）---
# .env.example はそのまま `just up` が通るローカル既定値が入っているため、コピーで設定が揃う。
if [ ! -f .env.local ] && [ -f .env.example ]; then
  log ".env.local を .env.example から作成"
  cp .env.example .env.local
fi

log "セットアップ完了"
