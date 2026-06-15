#!/bin/bash
# SANBA — PostToolUse hook
# Edit/Write で変更された Python ファイルを自動で ruff format / ruff check --fix する。
# 「フォーマットの揺れ」をレビューから排除し、AI の生成物を常に規約準拠に保つ。
set -euo pipefail

# stdin に渡る tool 入力 JSON から file_path を取り出す（jq 不要の素朴な抽出）。
input="$(cat)"
file_path="$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"

[ -z "${file_path:-}" ] && exit 0
[ -f "$file_path" ] || exit 0

case "$file_path" in
  *.py)
    if command -v ruff >/dev/null 2>&1; then
      ruff format "$file_path" >/dev/null 2>&1 || true
      ruff check --fix "$file_path" >/dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
