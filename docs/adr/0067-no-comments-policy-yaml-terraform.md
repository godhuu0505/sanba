# ADR-0067: コメント禁止規約の YAML / Terraform への拡張とコメント内容の docs 移設

- ステータス: Accepted
- 日付: 2026-07-11
- 関連: CLAUDE.md「コーディング規約」、`scripts/check_no_comments.py`、ADR-0050（ドキュメント配置）

## コンテキスト

コメント禁止規約（what はコードで表現し、why はコミットメッセージ / PR 説明 / ADR に書く）の
機械的検査は Python（`check_no_comments.py`）と web の TS/TSX（`check-no-comments.mjs`）だけを
対象にしていた。その結果、検査対象外の GitHub Actions ワークフロー・docker-compose・
Terraform・各種設定 YAML には説明コメントが蓄積し続け（棚卸し時点で全行コメント約 430 行）、
直近の PR（#493 / #498 等）でも新規追加が続いていた。規約の趣旨（コメントとコードの乖離による
誤読の防止）はファイル種別を選ばない。

## 決定

1. **コメント禁止規約の検査対象に YAML と Terraform を追加する**。対象パスは
   `.github/`（workflows・dependabot・labels・labeler）、`docker-compose*.yml`、
   `infra/terraform/`、`infra/observability/`。検査は `check_no_comments.py` に実装する
   （stdlib のみ。CI の `no-comments` ジョブと `just check-comments` は従来どおり）。
2. **機能的プラグマだけを許可する**（Python の `# noqa` 等と同格のもの）:
   - Action の commit SHA ピンに併記するバージョン注記（`uses: owner/action@<sha> # vX.Y.Z`）。
     CLAUDE.md セキュリティ規約が要求し、Dependabot が更新する。
   - シェバン（`#!`）、`# shellcheck ...`、`# yamllint ...`（YAML / run ブロック内シェル）。
   - `# tflint-ignore ...`、`# checkov:skip ...`、`# trivy:ignore ...`（Terraform）。
3. **既存コメントの内容は削除ではなく docs へ移設する**。移設先の対応:
   - ワークフローの設計判断 → `docs/reference/ci-cd-workflows.md`（新設。各ワークフローの why の正）
   - セキュリティのゲート方針・Actions ハードニング → `docs/reference/security.md` §7/§8（既存を現行化）
   - docker-compose の設計メモ → `docs/how-to/local-dev.md` §5.5（新設）
   - agent warm/sleep の 2 段反映と fail fast → `docs/how-to/pre-launch-cost-controls.md` §2
   - ラベルの rename 禁止・状態機械 → `docs/how-to/labels.md`（既存に追記）
   - Picker API キーの IaC 払い出し（drive.tf） → ADR-0049 補遺

## 理由

- 説明コメントの乖離リスクは YAML / Terraform でも同じ（例: security.md に残っていた Trivy の
  記述は install スクリプト照合方式のまま陳腐化しており、実体は digest 固定イメージ実行に
  移行済みだった。本 ADR の移設作業で現行化した）。
- ワークフローは「設定」ではなく CI/CD の実装コードであり、アプリコードと同じ規律を適用する。
- 一方で SHA ピンのバージョン注記のように、外部ツール（Dependabot）が読み書きする注記は
  コメント以外に置き場がなく、機能的プラグマとして許可する。

## 影響

- `.github/**`・`docker-compose*.yml`・`infra/**` の説明コメントを全削除（内容は上記 docs へ）。
- `scripts/check_no_comments.py` が YAML / Terraform を検査する（行スキャン + 引用符/ヒアドキュメント
  認識。YAML のブロックスカラー内も `run:` のシェルコメントを含めて検査対象）。
- CLAUDE.md のコーディング規約に検査対象の拡張と許可プラグマを追記。
- ワークフローの why を変更する PR は、YAML と同時に `docs/reference/ci-cd-workflows.md` を
  更新する運用になる。
