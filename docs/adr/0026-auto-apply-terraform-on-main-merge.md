# ADR-0026: main マージで terraform を自動 apply する CD パイプライン（migrate → deploy の順序保証）

- ステータス: Proposed
- 日付: 2026-07-04

## コンテキスト
main マージ時の自動化は、これまで以下の分業だった（ADR-0016）:

- `ci.yml` — PR / main push で lint・型・テスト・ビルド（quality-gate に集約）。
- `deploy.yml` — main push で変更 app のイメージをビルドし Cloud Run へ差し替え。
- `terraform.yml` — PR で `terraform plan` を自動コメント、**apply は GitHub Mobile からの
  workflow_dispatch のみ（手動）**。

つまり「ビルド・デプロイ」は自動だが、**マイグレーション相当の工程だけが手動**に残っていた。
SANBA の永続層は Firestore（スキーマレス）で、伝統的な DB マイグレーションは存在しない。
その代わりに TTL フィールド・（将来の）複合インデックス・Cloud Run の env/secret/スケール等の
「コードが依存する宣言的設定」を Terraform が一元管理しており、これがこのプロダクトの
マイグレーションに相当する。

手動 apply 運用には 2 つの問題があった:

1. **反映漏れ**: infra 変更を含む PR をマージしても、apply を忘れると本番は古い設定のまま。
   新イメージだけが先に出て、必要な env/secret が無く新リビジョンが壊れる事故パターンがある。
2. **順序保証が無い**: apply とイメージ差し替えが別トリガーのため、「設定 → コード」の順で
   反映されることを仕組みで担保できない。

## 決定
**main へのマージで「migrate（terraform apply）→ ビルド → deploy」を 1 本のパイプラインとして
自動実行する**。実装は以下:

- `terraform.yml` に `workflow_call` トリガーを追加し、再利用可能ワークフロー化する
  （plan → 保存した plan を apply、という既存の安全な流れをそのまま共有）。
- `deploy.yml` の paths-filter に `infra`（`infra/terraform/**` + `terraform.yml` 自身）を追加し、
  infra 変更があるときだけ `migrate` ジョブが `terraform.yml` を `action=apply` で呼ぶ。
- `deploy` ジョブは `needs: [changes, migrate]` とし、**migrate 成功（または infra 変更なしで
  skipped）のときだけ**イメージ差し替えに進む。migrate 失敗時は deploy も止める。
- `deploy.yml` の concurrency を `cancel-in-progress: false` に変更する。apply /
  `gcloud run deploy` の途中キャンセルは中途半端な状態を残すため。pending は最新 1 件だけ
  残る GitHub の仕様により、連続マージでも最終的に最新 SHA が反映される。
- `migrate` ジョブに job-level concurrency（`terraform-<ref>`、cancel しない）を付け、
  手動 apply（terraform.yml の dispatch）と直列化して state 競合を避ける。

既存の安全弁は維持する: PR での plan コメント（人間レビュー）、`production` environment
（required reviewers を設定すれば apply 前の承認ゲートになり、後段の deploy も承認まで待つ）、
fork PR ガード、GCP 未配線時の skip。手動 apply（dispatch）はロールバック・初回構築用に残す。

## 理由 / 検討した代替案
- **A. deploy.yml から terraform.yml を workflow_call（採用）**: 1 つの run 内で
  `migrate → deploy` の依存関係を `needs` で表現でき、順序保証が最も単純・可視。
  TF のセットアップ（pinned install + checksum / WIF / GCS backend）を複製しない。
- **B. terraform.yml に push: main トリガーを追加**: 実装は最小だが、deploy.yml とは別 run に
  なるため「apply 完了後にイメージ差し替え」の順序を保証できない。`workflow_run` で連鎖させる
  案は、infra 変更が無いマージで deploy が起動しなくなる等の分岐が複雑になり却下。
- **C. 手動 apply の現状維持**: 「plan を人間が見てから反映」を最重視する案だが、反映漏れと
  順序不整合という運用リスクが残る。plan レビューは PR 時点で済んでおり、マージ後の手動
  apply は同じ plan の再実行にすぎない。承認をマージ後にも残したい場合は `production`
  environment の required reviewers で実現できるため却下。
- **D. Firestore 専用のマイグレーションツール導入（firebase-tools 等）**: 現状インデックス・TTL は
  Terraform 管理で二重管理になるだけ。データ変換を伴うマイグレーションが必要になった時点で
  別 ADR として検討する。

## 影響 / フォローアップ
- **観測性**: migrate / deploy は同一 run に並ぶため、Actions の run 1 つで
  「何が反映されたか」を追える。apply 結果はジョブログと `$GITHUB_STEP_SUMMARY` に残る。
  Four Keys（デプロイ頻度・変更のリードタイム）は main マージ＝本番反映となり計測が素直になる。
- **IaC**: `infra/terraform` への変更は従来どおり PR レビュー必須（CLAUDE.md）。本 ADR は
  「レビュー済み plan の反映」を自動化するだけで、レビューを省くものではない。
- **セキュリティ**: 権限は据え置き（apply は `TF_DEPLOY_SA`、deploy は `DEPLOY_SA`、いずれも
  WIF キーレス）。fork PR からは migrate は起動しない（push: main のみ）。
- **運用**: `production` environment に required reviewers を設定するかはリポジトリ管理者の
  判断（設定すれば半自動 = 承認付き CD、しなければ全自動 CD）。runbook §6.6 を更新済み。
- **テスト**: branch protection の必須チェック（`quality-gate`）が PR 段階の品質を担保する
  前提は不変。デプロイ後のスモークテスト自動化（`/healthz` 叩き等）は今後の改善候補。
- 本 ADR は提案中。初回の main マージで migrate → deploy が期待どおり流れることを確認して
  Accepted にする。
