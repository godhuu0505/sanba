# `.claude/` — SANBA ハーネスエンジニアリング

AI コーディングエージェント（Claude Code 等）が **速く・規約通りに・高品質に** 動くための
リポジトリ同梱ハーネス。人間の開発体験も同時に改善する。設定の本文は `CLAUDE.md` を参照。

## 構成

| パス | 役割 |
| --- | --- |
| `settings.json` | 権限の許可リスト（定型コマンドの確認プロンプトを削減）と Hook 登録 |
| `hooks/session-start.sh` | セッション開始時に依存関係を整備（uv sync / npm install / just）。`CLAUDE_CODE_REMOTE=true` のときのみ実行 |
| `hooks/format-after-edit.sh` | Edit/Write 後に変更 Python を `ruff format` + `ruff check --fix` で自動整形 |
| `commands/check.md` | `/check` — CI（lint/型/テスト/build）と等価な検証をローカルで実行 |
| `commands/adr.md` | `/adr <タイトル>` — `docs/adr/NNNN-*.md` を採番付きで雛形生成 |
| `agents/sanba-reviewer.md` | CLAUDE.md 準拠をレビューするサブエージェント（本番志向・観測性・薄い実装の禁止・セキュリティ） |

## 効くポイント（なぜ加速・高品質になるか）

- **立ち上がりが速い**: web セッションでも最初からテスト/リンタが動く（SessionStart hook）。
- **手戻りが減る**: 整形は自動、検証は `/check` で CI と同じ基準を push 前に再現。
- **規約が形骸化しない**: `sanba-reviewer` が CLAUDE.md の原則を機械的に当てる。
- **摩擦が小さい**: 定型コマンドは許可リスト済みで、確認プロンプトに中断されない。

## メンテナンス

- 新しい定型コマンドが頻出したら `settings.json` の `permissions.allow` に追記する。
- CI（`.github/workflows/ci.yml`）を変えたら `/check` の手順も合わせる。
- SessionStart hook は同期実行。起動を速くしたい場合は async 化を検討（`{"async": true}` を先頭に出力）。
