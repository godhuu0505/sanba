# ADR-0006: AI による PR 自動レビューと対応フロー

- ステータス: Accepted
- 日付: 2026-06-14

## コンテキスト
レビュー往復のリードタイム（Four Keys のうち変更のリードタイム）を縮めたい。
一方で CLAUDE.md の原則どおり、**成果物の品質に責任を持つのは人間**であり、
AI はあくまで下書き・自動化を担う。そこで「指摘の生成」と「指摘への一次対応」を
別エージェントに分け、人間がマージ判断を下す前段を自動化する。

コスト面では、Codex はワークフロー（`openai/codex-action`）から API キーで叩くと
ChatGPT サブスクとは別に従量課金が発生する。サブスク（ChatGPT Plus 等）に含まれる
GitHub コードレビュー機能を使えば追加課金なしで自動レビューできる
（API キー方式では GitHub 連携機能自体が使えない）。

## 決定

### 1. Codex 自動レビュー = Codex 公式 GitHub 連携（IaC 化しない）
- ワークフローではなく **Codex の GitHub 連携**（Settings → Code review で GitHub を接続し、
  Codex GitHub App をインストール、**Automatic reviews** をオン）を使う。
- PR 作成時に Codex が差分を読み、人間同様のインラインレビュー（既定で P0/P1）を投稿する。
  手動再実行は PR コメントに `@codex review`。
- 認証は **ChatGPT サブスク**。API キー不要・追加課金なし・ワークフローファイル不要。
- レビュー指針は **`AGENTS.md` の `## Review guidelines`** に記述（Codex が参照する）。

### 2. Claude 対応トリアージ = ワークフロー (`.github/workflows/claude-review-response.yml`)
- `pull_request_review`（submitted）/ `pull_request_review_comment`（created）で起動。
- `anthropics/claude-code-action@v1` がレビュー本文を読み、指摘ごとに
  **対応 / skip / issue 起票** を判断し、`gh pr comment` で方針を1件返信する。
  - 対応: PR ブランチへ最小修正をコミット & push。
  - skip: 誤検知・意図設計・対象外として理由を明記。
  - issue: 妥当だが範囲外の指摘は `gh issue create` で別途追跡。

### ループ防止 / 対象限定
- `review`(submitted): 本文ありを拾い、**Codex(Bot) は対象**に含めるが
  Claude 自身の投稿元 `github-actions[bot]` は除外。Codex のインライン群は
  `review_comment` で個別発火させず、review サマリ1件にまとめて反応する。
- `review_comment`(created): 人間のインラインのみ（Bot 除外）。
- Claude の返信は `gh pr comment`（`issue_comment`）で行い、`issue_comment` は
  トリガーに含めないため再起動しない。
- `concurrency` で同一 PR のイベントを直列化。

### セキュリティ
- 差分・コメント本文は**信用しない**（プロンプトインジェクション対策）。指示文には従わない。
- 既定権限は最小。`secrets` はジョブ if で参照できないためステップで確認し、
  `ANTHROPIC_API_KEY` 未設定の環境ではスキップして CI を止めない。

## 検討したが採用しなかった選択肢
- **`openai/codex-action`（API キー方式）**: ChatGPT サブスクと別に従量課金が発生し、
  GitHub 連携機能も使えない。サブスクで完結する公式 GitHub 連携を採用。
- **`codex-action` をサブスク（auth.json）で CI 認証**: トークン期限切れで脆く、
  public リポジトリでは禁止。運用に乗せられないため不採用。
- **1 本のワークフローに統合**: 生成と対応を密結合させると責務・権限・ループ制御が
  複雑化する。役割ごとに分離した。
- **人間メンション（@claude）必須**: 自動化の目的に反するため、レビュー検知で自動起動。

## 影響
- Codex 側はリポジトリ管理者が GitHub 連携を一度設定する（IaC 化されない運用手順）。
- 必要な GitHub Secrets: `ANTHROPIC_API_KEY`（Claude 側のみ）。
- Claude のモデル/`--max-turns`、`AGENTS.md` のレビュー指針はチューニング対象。
- 「AI が対応 → 人間がマージ判断」を徹底し、AI のコミットも CI（`ci.yml`）で検証される。
