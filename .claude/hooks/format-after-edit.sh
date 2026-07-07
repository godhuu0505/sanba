#!/bin/bash
set -euo pipefail

input="$(cat)"
file_path="$(printf '%s' "$input" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[ -z "${file_path:-}" ] && exit 0
[ -f "$file_path" ] || exit 0

case "$file_path" in
  *.py)
    if command -v ruff >/dev/null 2>&1; then
      ruff format "$file_path" >/dev/null 2>&1 || true
      ruff check --fix "$file_path" >/dev/null 2>&1 || true
    fi
    python3 "$repo_root/scripts/check_no_comments.py" "$file_path" || true
    ;;
  *.ts | *.tsx | *.js | *.jsx | *.mjs)
    node "$repo_root/scripts/check-no-comments.mjs" "$file_path" || true
    ;;
esac

exit 0
