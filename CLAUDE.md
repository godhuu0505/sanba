# CLAUDE.md — Kikitori 開発ガイド (AIコーディング規約)

このリポジトリで AI コーディングエージェント（Claude Code / Gemini CLI 等）が守るべきルール。
人間レビュアーも同じ基準で運用する。

## プロダクト
- **Kikitori**: 音声(speech-to-speech)で要件を聞き取るマルチエージェント。
- 詳細: `README.md` / `docs/architecture.md`。

## 原則
1. **成果物の品質に責任を持つのは人間**。AIは下書き・自動化を担うが、設計判断とレビューは人間が行う。
2. **本番志向 (production-ready)**: ローカルでしか動かないPoCで終わらせない。Cloud Run へデプロイ可能な状態を保つ。
3. **観測できないものは運用できない**: 新しい処理を足したら必ずトレース/ログ/メトリクスを通す。
4. **指標をハックしない**: Four Keys 等は本質的なボトルネック改善のために計測する。見栄えのためのPR分割等はしない。

## ディレクトリ規約
- `apps/agent` — Python 3.12 / `uv` 管理。LiveKit Agents worker と ADK 定義。
- `apps/api`   — Python 3.12 / FastAPI。LiveKit トークン発行とオーケストレーション。
- `apps/web`   — Next.js (App Router) / TypeScript。
- `infra/`     — Terraform と可観測性スタックの設定。変更は必ずレビュー。
- `docs/`      — 設計判断は ADR (`docs/adr/NNNN-*.md`) に残す。

## コーディング規約
- Python: `ruff`（lint + format）、`pytest`、型ヒント必須。`mypy` を通す。
- TypeScript: `biome` または `eslint` + `prettier`、`tsc --noEmit`。
- コミットは Conventional Commits（`feat:`, `fix:`, `chore:`, `docs:`, `ci:` ...）。
- シークレットはコミットしない。`.env`（gitignore 済）と Secret Manager を使う。

## テスト方針
- 単体: ツール/プロンプト整形/状態遷移のロジック。
- 結合: API ↔ Firestore、Agent ↔ ADK のツール呼び出し。
- システム/E2E: LiveKit ルームへの参加〜要件ドキュメント生成までを Playwright で。
- LLM出力は Langfuse の評価データセットで回帰テストする（LLMOps）。

## セキュリティ
- PR では `/security-review` を回し、指摘に対応する。
- CI のセキュリティスキャン（`.github/workflows/security.yml`: pip-audit / npm audit / gitleaks /
  Trivy、`codeql.yml`、`dependabot.yml`）の結果を確認する。advisory は段階的に解消する。
- シークレットは絶対にコミットしない（gitleaks が検出）。`.env`（gitignore 済）と Secret Manager を使う。
- コンテナは非 root 実行・最小ベースを維持する。

## やってはいけないこと
- 単発の Gemini API 呼び出しを「エージェント」と称する薄い実装。
- CI を空にする / テストを消して通す。
- 観測性・IaC を後回しにして手作業デプロイする。
