# コントリビューションガイド — SANBA

SANBA への貢献に感謝します。本プロジェクトは **DevOps × AI Agent Hackathon 2026** 応募プロジェクトであり、
「本番志向（production-ready）」「観測できないものは運用できない」を原則に開発しています。
AI コーディングエージェントも人間も、同じ基準で貢献してください。

> 開発全体の規約は [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) に集約しています。本書はその実務手順です。

## はじめに

- 質問・提案・バグ報告は **Issue**（[テンプレート](.github/ISSUE_TEMPLATE)）から。
- 行動規範は [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) に従ってください。
- 脆弱性は Issue ではなく [`SECURITY.md`](SECURITY.md) の手順で報告してください。

## 開発環境のセットアップ

前提: Rancher Desktop (dockerd) + `docker compose`、タスクランナー [`just`](https://github.com/casey/just)（唯一の正・エントリポイント。未導入なら `uv tool install rust-just`。brew / cargo / mise でも可）。

```bash
just setup             # .env.local を .env.example から自動生成 (ローカル既定値入り) + 依存インストール
just up                # web / api / agent / livekit / firestore / elasticsearch
just verify            # 各コンポーネントの疎通スモークテスト
```

詳細は [`docs/how-to/local-dev.md`](docs/how-to/local-dev.md) を参照。

## ブランチとコミット

- `main` から作業ブランチを切る（例: `feat/voice-barge-in`、`fix/token-ttl`）。
- コミットは **[Conventional Commits](https://www.conventionalcommits.org/ja/)**：
  `feat:` / `fix:` / `chore:` / `docs:` / `ci:` / `refactor:` / `test:` ...
- シークレットは絶対にコミットしない（`gitleaks` が検出）。`.env.local` / `.env` は gitignore 済。

## 提出前のローカル検証（CI と同じ）

PR を出す前に、CI と同じ検証をローカルで通してください。

```bash
just lint    # ruff（agent/api）+ eslint（web）+ 型チェック（mypy / tsc --noEmit）
just test    # 単体 / 結合テスト（pytest）

# web の build まで確認したいとき（CI の web ジョブ相当）
cd apps/web && npm run build
just build   # Docker イメージのビルド
```

- **Python**: `ruff`（lint + format）、`mypy`、型ヒント必須、`pytest`。
- **TypeScript**: `eslint` + `prettier`、`tsc --noEmit`。
- 振る舞いを変えたら**テストを伴わせる**。LLM 出力は代表シナリオの評価データセットで CI 回帰確認（[ADR-0005](docs/adr/0005-llm-judge-eval-loop.md) / [ADR-0051](docs/adr/0051-google-native-observability-and-llmops.md)）。

## Pull Request

1. [PR テンプレート](.github/pull_request_template.md) を埋める（目的・変更点・テスト・観測性・セキュリティ）。
2. 新しい処理を足したら **トレース / ログ / メトリクスを通す**（観測できない追加処理は不可）。
3. ローカル専用実装・ハードコードされた認証情報/エンドポイントを避ける（Cloud Run へデプロイ可能な状態を保つ）。
4. CI（lint / 型 / テスト / build / セキュリティスキャン / LLM 評価）が緑であること。
5. 設計に関わる判断をしたら **ADR**（`docs/adr/NNNN-*.md`）を追加する。
6. セキュリティ影響のある変更は `/security-review` を回し、指摘に対応する。

## ラベル運用

issue / PR のラベルは軸ベース（`type:` / `priority:` / `area:` / `status:` ...）で設計し、
`.github/labels.yml` を単一の真実として IaC 管理する。手動で編集せず manifest を変更すること。
詳細は [`docs/how-to/labels.md`](docs/how-to/labels.md)。

## やってはいけないこと

「薄いエージェント実装」「CI を空にする / テストを消して通す」「観測性・IaC を後回しにした手作業デプロイ」
などの禁止事項は [`CLAUDE.md`](CLAUDE.md) の「やってはいけないこと」を単一の正とする（ここには再掲しない）。
