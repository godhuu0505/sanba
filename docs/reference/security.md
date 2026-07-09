# セキュリティ & データガバナンス — SANBA

「本番品質（届けるものをつくる）」の前提として、最低限のセキュリティとデータ取り扱いを定義する。
（関連 issue: #8 アクセス制御 / #9 CIスキャン / #10 データガバナンス）

## 1. アクセス制御（#8）
- セッション参加は**署名付き招待トークン**（HMAC、session_id + role + 有効期限）が必須。
  `session_id` を推測しただけでは参加できない。
- LiveKit 参加トークンは **TTL 付き・room スコープ**で発行。
- `/join` に per-IP レート制限。CORS は許可ドメインに限定。
- 本番では `SESSION_SIGNING_SECRET` を **Secret Manager** で強い値に設定。

## 2. データフロー & 取り扱い区分
| データ | 保存先 | 機微度 | 取り扱い |
|---|---|---|---|
| 音声ストリーム | LiveKit（一時） | 高 | 既定では録音を永続化しない |
| 書き起こし（発話） | Firestore | 高 | PIIマスク後に保持、保持期間で自動削除 |
| 確定要件 | Firestore | 中 | 保持期間で自動削除 |
| RAG grounding（資料・要件・発話） | Elasticsearch | 中〜高 | **索引前に PII マスク**、ILM で期限切れ削除 |
| 参考資料アップロード | Elasticsearch | 中〜高 | チャンク化＋PIIマスク後に索引 |
| transcript 全文（セッション終了時 / ADR-0061） | Firestore（`sessions/{id}/transcripts/full`） | 高 | **PII マスク後に保存**。ゲストは 30 日 TTL、ログインセッションは P5 分析のため保持 |
| コスト・KPI 分析イベント（ADR-0061） | Elasticsearch（`sanba-analytics-*`）+ Cloud Logging | 低 | ID・トークン数・金額・スコアのみで会話本文を含めない。ILM（既定 365 日）で削除 |

## 3. 同意（#10）
- セッション作成時に**録音・AI処理への明示的な同意**が必須（`require_consent`）。
  同意なしの作成は 400。Web は同意チェックボックスで参加をゲートする。

## 4. PII マスキング（#10）
- メール / 電話番号 / 長い数字列（カード・ID）を**索引前に**プレースホルダ化
  （`pii.mask_pii`）。agent（発話・要件）と api（資料）の両経路で適用。
- 既定 ON（`MASK_PII_BEFORE_INDEX=true`）。高精度化が必要なら **Cloud DLP** に置換可能。

## 5. 保持期間（#10）
- Firestore: 書き込み時に `expireAt` を付与。フィールド TTL ポリシーで期限切れを自動削除
  （`infra/terraform` の `google_firestore_field`）。
- Elasticsearch: ILM で `sanba-grounding` の古いドキュメントを削除（運用設定）。
- 既定 `DATA_RETENTION_DAYS=30`。0 で無期限。
- transcript 全文（ADR-0061）: ゲストセッションは他のセッションデータと同じく `expireAt`
  （既定 30 日）で自動削除。ログインユーザーのセッションは将来のナレッジ改善分析（P5）の
  ため保持する（削除はセッション文書と合わせて運用で行う）。
- 分析イベント（`sanba-analytics-*`）: 会話本文を含まないため長期保持を許容し、
  `just analytics-setup` が張る ILM（`ANALYTICS_RETENTION_DAYS`、既定 365 日）で削除する。

## 6. 暗号化 & 最小権限
- 保存時/通信時暗号化は GCP デフォルト（必要なら CMEK を検討）。
- Cloud Run のランタイム SA は最小権限（`infra/terraform` の IAM、`secretAccessor` 等）。
- Elasticsearch は API キーをスコープして接続。

## 7. CI セキュリティ（#9）
- Dependabot / pip-audit / npm audit / gitleaks / Trivy / CodeQL。
- **CodeQL**: public リポジトリでは Code scanning が有効で SARIF アップロードが成功するため、
  `codeql.yml` は gating（init/analyze/upload の失敗で CI を赤にする）。Code scanning を無効化すると
  アップロードが失敗して merge を塞ぐため、その際は再度 advisory（`continue-on-error`）に戻す。

## 8. public リポジトリでの Actions ハードニング
リポジトリを public 化すると、第三者が fork から PR・レビュー・コメントを送れる。
特権を持つワークフローが外部入力で起動しないよう、次を守る。

- **特権ワークフローの起動を信頼済みアクターに限定**: `claude-review-response.yml` は
  secrets（Claude OAuth）と write 権限を持つため、人間レビュー経路を
  `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` に限定する。外部の第三者の
  レビューでは起動しない（プロンプトインジェクション経由のトークン窃取・改ざん防止）。
- **最小権限の明示**: 各ワークフローに top-level `permissions:`（既定 `contents: read`）を置き、
  書き込みが必要なジョブだけ昇格する。リポジトリの既定 `GITHUB_TOKEN` 権限を read-only に
  設定しても各ワークフローが必要権限を自前で宣言しているため動作する（§8.1 手順2 の前提）。
- **third-party Action の full SHA ピン**: GitHub 製以外の Action は commit full SHA で固定する
  （`@vX` タグ運用はしない。バージョンはコメントで併記、Dependabot が更新）。ワークフロー内で
  `curl | sh` で入れるツール（gitleaks / Trivy / Terraform）はバージョン固定＋チェックサム照合にする
  （`terraform.yml` は公式 SHA256SUMS と照合）。供給網（タグ書き換え・改ざん）対策。
- **fork PR と secrets**: `pull_request` で fork から起動した場合、GitHub は secrets を渡さない。
  `llm-eval.yml` はこの場合 heuristic 評価に自動フォールバックする（gate は維持）。
- **デプロイ経路の分離**: `deploy.yml` は `push:[main]` と `workflow_dispatch` のみ。fork PR からは
  起動できず、GCP 認証は WIF（鍵レス）。
- **terraform plan の fork ガード**: `terraform.yml` は `pull_request` で plan を走らせるため、
  job `if:` に `github.event.pull_request.head.repo.fork == false` を置き、fork 由来の改変コードに
  対する plan（WIF 認証 → data source 経由で既存インフラを読む）を起動段階で止める。WIF の
  `attribute-condition` は `pull_request` の OIDC token では `repository` が base になり fork を
  判別できないため、この一次防御をワークフロー側に置く（多層防御。詳細は
  `docs/how-to/deploy-gcp.md §3`）。plan コメントは `terraform show` の出力をそのまま貼るが、
  秘匿リソース属性（`random_password.result` / `secret_data` 等）は provider が `sensitive` 扱いで
  `(sensitive value)` に伏せるため、同一リポジトリ PR でも値は露出しない。
## 8.1 リポジトリ設定ハードニング（GUI 運用手順・#68）
public 化に伴い、**コード変更を伴わないリポジトリ設定**で多層防御を固める。これらは IaC 化されない
GUI 運用手順のため、実施したら issue #68 に**実施者・日時とスクリーンショット**をコメントで残す
（監査証跡）。当面「信頼チーム専用」運用が前提。

| # | 設定箇所 | 望ましい状態 | ねらい |
|---|---|---|---|
| 1 | Settings → Actions → General → Fork pull request workflows | 「Require approval for first-time contributors」以上（推奨「all outside collaborators」） | 未信頼コードの CI / `docker build` / scan が承認なしに走らない |
| 2 | 同 → Workflow permissions | 「Read repository contents and packages permissions」（read-only）＋「Allow GitHub Actions to create and approve pull requests」をオフ | 既定 `GITHUB_TOKEN` を read-only に（各 workflow は必要権限を個別宣言済み） |
| 3 | Settings → Code security | Secret scanning: Enable ／ Push protection: Enable（public は無料） | CI の gitleaks と多層化（push 前にシークレットを止める） |
| 4 | Settings → Branches → branch protection (main) | 「Require approval of the most recent reviewable push」を有効化 | 自己承認の悪用防止（最新 push の再承認を要求） |
| 5 | `deploy.yml` / `terraform.yml` の dispatch 権限 | write 権限者のみ `workflow_dispatch` 可であることを確認 | 本番反映トリガーを信頼済みアクターに限定 |

> 手順4の branch protection は #62（人間1承認＋`quality-gate` 必須＋bot は approve/merge 不可＋
> stale approval 失効）を前提に整合させる。#62 は棚卸しで close 済みのため、最新 push の再承認要求は
> 本 issue で単独実施する。WIF の attribute condition（`repository`＋`ref=main` 限定）の確認は
> `infra/terraform` 側で別途行う（`docs/how-to/deploy-gcp.md §3`）。

**実施記録**（GUI 設定は IaC 化されないため、実施の都度ここに追記する）:

| 日付 | 実施者 | 内容 |
|---|---|---|
| 2026-06-29 | @godhuu0505 | 手順1〜5 を設定（fork PR の Actions 承認・GITHUB_TOKEN read-only＋PR 作成/承認オフ・Secret scanning/push protection・最新 push の再承認要求・本番 dispatch の権限確認）。設定画面のスクリーンショットは issue #68 にコメントで添付。 |

設定変更や再点検をしたら、この表に行を追加して証跡を残す。

**コード側で恒久対応済み**（上表の前提となる多層防御）:
- 全ワークフローが top-level `permissions:` を宣言済み（既定 `contents: read`、書き込みが要るジョブだけ昇格。checkout しない `review-status.yml` は `pull-requests: write` のみ）→ 手順2 の read-only 既定で問題なく動く。
- third-party Action は full SHA ピン、`curl | sh` ツールはバージョン固定＋チェックサム照合済み（gitleaks: 公式 checksums.txt 照合 / Trivy: install スクリプトを `| sudo sh` で直接実行せず sha256 照合してから実行＝スクリプト自身も binary を checksums.txt で照合する二段構え / Terraform: 公式 SHA256SUMS 照合）。
- 特権ワークフロー（`claude-review-response.yml` 等）は fork PR・未信頼アクターでは起動しない（上記参照）。

## 残課題
- 完全な IdP 連携（Firebase Auth / Identity Platform）。
- 録音を保持する場合の保管設計と削除リクエスト対応。
- agent/api で重複している PII マスカ・索引ロジックの共有パッケージ化。
