# ADR-0007: 外部ソース連携コネクタ（GitHub）

- ステータス: Accepted（GitHub 読み取り + 要件書き戻し）／その他コネクタは保留
- 日付: 2026-06-14

## コンテキスト
要件定義の文脈は既存のIssueやドキュメントに散在し、確定要件は最終的にIssue/実装へ橋渡しされる。
これを自動化すると、佐藤将高CTO「Issue×worktree×Agent Teams」や山田CEO「開発生産性」に直結し、
「要件定義→実装」の地続き化でエージェントの必然性が高まる。一方、OAuth連携やレート制限は
デモ破綻リスクが高い。

## 決定
- **機能フラグで OFF を既定**にし、デモ・クリティカルパスに影響させない（`github_connector_enabled`）。
- まず **読み取り専用 GitHub コネクタ**: 指定リポジトリの Issue/README を grounding(`kind=context`)へ。
- **要件 → GitHub Issue 書き戻し**: 確定要件を MoSCoW で整形して Issue 化（`export_requirements_to_github` ツール）。
- 純粋なマッピング関数（issues→passages / requirements→issue body）は**ネットワーク非依存で単体テスト**。
- Google Drive / Slack 等の追加コネクタは**保留**（安定したものだけを段階的に有効化）。

## リスクと緩和
- OAuth/レート制限/デモ破綻 → 既定 OFF・feature flag・最小権限トークン・タイムアウト付き呼び出し。
- 実装エージェント起動（worktree 並列実装等）は**本ADRの範囲外**（別issueで検討）。

## 影響
- `apps/agent/src/sanba_agent/connectors/github.py` を追加、`httpx` 依存を追加。
- 有効化時のみ、セッション開始で GitHub コンテキストを取り込み、締めで Issue 書き戻し可能。
