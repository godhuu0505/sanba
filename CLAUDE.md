# CLAUDE.md — SANBA 開発ガイド (AIコーディング規約)

このリポジトリで AI コーディングエージェント（Claude Code / Codex / Gemini CLI 等）が守るべきルール。
人間レビュアーも同じ基準で運用する。`AGENTS.md` はこのファイルへの symlink（同一実体）で、
クロスツール標準として複数のエージェントが同じ規約を読む（配置方針は `docs/adr/0050-documentation-placement-and-lifecycle.md`）。

## プロダクト
- **SANBA**: 音声(speech-to-speech)で対話し、要件を解像度高く生み出すマルチエージェント。名前の由来は「産婆術（Socratic maieutics）」＝相手の中にある答えを問いで引き出す技法。
- 詳細: `README.md` / `docs/reference/architecture.md`。

## 原則
1. **成果物の品質に責任を持つのは人間**。AIは下書き・自動化を担うが、設計判断とレビューは人間が行う。
2. **本番志向 (production-ready)**: ローカルでしか動かないPoCで終わらせない。Cloud Run へデプロイ可能な状態を保つ。
3. **観測できないものは運用できない**: 新しい処理を足したら必ずトレース/ログ/メトリクスを通す。
4. **指標をハックしない**: Four Keys 等は本質的なボトルネック改善のために計測する。見栄えのためのPR分割等はしない。

## ディレクトリ規約
- `apps/agent`   — Python 3.12 / `uv` 管理。LiveKit Agents worker と ADK 定義。
- `apps/api`     — Python 3.12 / FastAPI。LiveKit トークン発行とオーケストレーション。
- `apps/web`     — Next.js (App Router) / TypeScript。
- `apps/worker`  — Python 3.12 / FastAPI。アップロード動画の非同期解析ワーカー（ADR-0040、Cloud Tasks push 受け口）。
- `packages/sanba_shared` — セッション/要件モデルと永続化を agent・api・worker で共有（ADR-0014）。
- `infra/`       — Terraform と可観測性スタックの設定。変更は必ずレビュー。
- `docs/`        — 設計判断は ADR (`docs/adr/NNNN-*.md`) に残す。

## コーディング規約
- Python: `ruff`（lint + format）、`pytest`、型ヒント必須。`mypy` を通す。
- TypeScript: `biome` または `eslint` + `prettier`、`tsc --noEmit`。
- コミットは Conventional Commits（`feat:`, `fix:`, `chore:`, `docs:`, `ci:` ...）。
- シークレットはコミットしない。`.env`（gitignore 済）と Secret Manager を使う。
- **コメントは原則書かない**。何をしているか（what）はコードとネーミングで表現し、コメントで説明しない。
  - 書いてよいのは、コードだけでは分からない **why**（設計判断の理由、既知の制約、一見不要に見えるが実は必要な処理の理由、非自明な仕様の背景）に限る。
  - 変更の経緯・チケット番号・対応した Issue・「なぜ直したか」はコメントではなく **コミットメッセージ / PR 説明** に書く。コードは将来のリファクタで無関係になっても残り続け、コメントだけが古びて嘘をつくため。
  - 既存コードを触ったら、そのファイル内の不要な what コメント・経緯コメント・コメントアウトされた死んだコードは合わせて削除する。

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
- GitHub Actions（供給網・最小権限）:
  - GitHub 製以外の Action は **commit full SHA でピン**する（`@vX` タグ運用は禁止。バージョンはコメントで併記し、Dependabot が更新する）。
  - ワークフロー内で `curl | sh` 等で入れるツールは**バージョン固定＋チェックサム照合**にする（例: `terraform.yml` の SHA256SUMS 照合）。
  - 各ワークフローは top-level `permissions:` を既定 `contents: read` にし、書き込みが要るジョブだけ昇格する（既定 `GITHUB_TOKEN` を read-only 運用するための前提）。
  - リポジトリ設定面のハードニング（fork PR の Actions 承認・Secret scanning / push protection・branch protection 等）は `docs/reference/security.md §8` を参照。
- 上記は要点。アクセス制御・PII マスキング・保持期間・データフロー等の設計と一次情報は
  `docs/reference/security.md` を正とする（ここには写経せず参照する）。

## やってはいけないこと
- 単発の Gemini API 呼び出しを「エージェント」と称する薄い実装。
- CI を空にする / テストを消して通す。
- 観測性・IaC を後回しにして手作業デプロイする。

## レビュー指針（自動レビュー・人間レビュー共通）
自動レビュー（Codex GitHub 連携など）と人間レビューはこの節を指針にする。
- レビューコメント・要約・指摘の説明はすべて **日本語**で書く（Always write review comments in Japanese）。
- 各指摘に重大度（P0/P1/P2）を添える。**ロジックの誤り・境界条件・並行性・リソースリーク**を最優先で指摘する。
- 上の「原則」「コーディング規約」「セキュリティ」に反する追加を指摘する
  （観測されない処理・ローカル専用実装/ハードコード・シークレット混入・テスト/型/lint 崩れ・薄いエージェント実装）。
- 指摘が無ければ「指摘なし（LGTM）」。
