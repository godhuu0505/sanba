---
description: CI と同じ検証（lint / 型 / テスト / build）をローカルで通す
allowed-tools: Bash(uv run:*), Bash(npm run:*), Bash(just:*), Bash(make:*), Bash(cd:*)
---

`.github/workflows/ci.yml` と等価な検証をローカルで実行し、push 前に必ず緑にする。
失敗したら原因を特定して修正し、再実行する。途中で諦めず全項目を緑にすること。

実行する検証（各アプリ）:

1. **agent** — `cd apps/agent && uv run ruff check . && uv run mypy src && uv run pytest -q`
2. **api** — `cd apps/api && uv run ruff check . && uv run mypy src && uv run pytest -q`
3. **web** — `cd apps/web && npm run typecheck && npm run build`

補足:
- まとめて回すなら `just lint && just test`（`just` 不在時は `make lint && make test`）でも可。
- フォーマット差分が出たら `uv run ruff format .` を当ててから再チェック。
- 最後に「どの項目が緑/赤か」を簡潔に要約して報告する。
