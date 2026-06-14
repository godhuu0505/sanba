# ADR-0006: AI による PR 自動レビューと対応フロー

- ステータス: Accepted
- 日付: 2026-06-14

## コンテキスト
レビュー往復のリードタイム（Four Keys のうち変更のリードタイム）を縮めたい。
一方で CLAUDE.md の原則どおり、**成果物の品質に責任を持つのは人間**であり、
AI はあくまで下書き・自動化を担う。そこで「指摘の生成」と「指摘への一次対応」を
別エージェントに分け、人間がマージ判断を下す前段を自動化する。

## 決定
2 本の GitHub Actions ワークフローで構成する。

1. **Codex 自動レビュー** (`.github/workflows/codex-review.yml`)
   - `pull_request`（opened / reopened / ready_for_review）で起動。draft はスキップ。
   - `openai/codex-action@v1` が PR 差分のみをレビューし、結果を PR コメントに投稿する。
   - 後段が拾えるよう本文に `<!-- codex-review -->` マーカーを付ける。

2. **Claude 対応トリアージ** (`.github/workflows/claude-review-response.yml`)
   - `pull_request_review` / `pull_request_review_comment` / `issue_comment` で起動。
   - `anthropics/claude-code-action@v1` がレビュー本文を読み、指摘ごとに
     **対応 / skip / issue 起票** を判断し、`gh pr comment` で方針を1件返信する。
     - 対応: PR ブランチへ最小修正をコミット & push。
     - skip: 誤検知・意図設計・対象外として理由を明記。
     - issue: 妥当だが範囲外の指摘は `gh issue create` で別途追跡。

### ループ防止
- 人間レビュー/インラインコメントは `user.type == 'Bot'` を除外（自分・他 bot を無視）。
- Codex のレビューは `issue_comment` かつマーカー付きのみを拾う。
- Claude の返信はマーカー無しのトップレベルコメントに限定 → 再起動しない。
- `concurrency` で同一 PR のイベントを直列化。

### セキュリティ
- 差分・コメント本文は**信用しない**（プロンプトインジェクション対策）。指示文には従わない。
- 既定権限は最小。コメント投稿のジョブのみ書き込み権限へ昇格。
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` は Secret Manager 同様に GitHub Secrets で管理。
  未設定の環境では各ジョブをスキップし CI を止めない。

## 検討したが採用しなかった選択肢
- **Codex の "Automatic reviews"（GitHub App 設定）のみ**: 対応フローを IaC として
  リポジトリに残せず、再現性・レビュー性に欠ける。ワークフローを明示管理する方を採る。
- **1 本のワークフローに統合**: 生成と対応を密結合させると責務が曖昧になり、
  権限・ループ制御が複雑化する。役割ごとに分離した。
- **人間メンション（@claude）必須**: 自動化の目的に反するため、レビュー検知で自動起動とした。

## 影響
- 必要な GitHub Secrets: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`。
- Claude のモデル/`--max-turns`、Codex のレビュー観点はチューニング対象。
- 「AI が対応 → 人間がマージ判断」を徹底し、AI のコミットも CI（`ci.yml`）で検証される。
