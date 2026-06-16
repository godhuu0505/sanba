<!-- タイトルは Conventional Commits 形式で（例: feat: 音声 barge-in 対応） -->

## 目的 / Why
<!-- この変更で何を解決するか。関連 Issue があれば「Closes #123」 -->

## 変更点 / What
<!-- 主要な変更を箇条書きで -->
-

## テスト / How verified
<!-- どう検証したか。`just lint` / `just test` の結果、手動確認の手順など -->
- [ ] `just lint`（ruff / mypy）が通る
- [ ] `apps/web` を変更した場合は `cd apps/web && npm run typecheck` が通る
- [ ] `just test`（単体 / 結合）が通る
- [ ] 必要なら `just verify` で疎通確認した

## 観測性 / Observability
<!-- 新しい処理にトレース / ログ / メトリクスを通したか（CLAUDE.md 原則3） -->
- [ ] 追加処理に観測性を通した（または該当なし）

## セキュリティ / Security
- [ ] シークレットを含めていない（`.env` / 鍵 / PII）
- [ ] セキュリティ影響があれば `/security-review` を回した（または該当なし）

## 設計判断 / ADR
- [ ] 設計に関わる判断をした場合、`docs/adr/NNNN-*.md` を追加した（または該当なし）

## チェックリスト
- [ ] 本番志向（ローカル専用実装・ハードコードを避けた）
- [ ] ドキュメント（README / docs）を必要に応じて更新した
