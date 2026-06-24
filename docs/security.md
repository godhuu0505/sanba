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
  書き込みが必要なジョブだけ昇格する。
- **fork PR と secrets**: `pull_request` で fork から起動した場合、GitHub は secrets を渡さない。
  `llm-eval.yml` はこの場合 heuristic 評価に自動フォールバックする（gate は維持）。
- **デプロイ経路の分離**: `deploy.yml` は `push:[main]` と `workflow_dispatch` のみ。fork PR からは
  起動できず、GCP 認証は WIF（鍵レス）。
- **terraform plan の fork ガード**: `terraform.yml` は `pull_request` で plan を走らせるため、
  job `if:` に `github.event.pull_request.head.repo.fork == false` を置き、fork 由来の改変コードに
  対する plan（WIF 認証 → data source 経由で既存インフラを読む）を起動段階で止める。WIF の
  `attribute-condition` は `pull_request` の OIDC token では `repository` が base になり fork を
  判別できないため、この一次防御をワークフロー側に置く（多層防御。詳細は
  `docs/runbooks/deploy-gcp.md §3`）。plan コメントは `terraform show` の出力をそのまま貼るが、
  秘匿リソース属性（`random_password.result` / `secret_data` 等）は provider が `sensitive` 扱いで
  `(sensitive value)` に伏せるため、同一リポジトリ PR でも値は露出しない。
- **未対応の推奨（フォローアップ）**: ブランチ保護（main への直 push 禁止・必須チェック・必須レビュー）、
  Actions の third-party action を full SHA ピン留め（供給網対策、Dependabot が更新）、
  GitHub Secret scanning / push protection の有効化。

## 残課題
- 完全な IdP 連携（Firebase Auth / Identity Platform）。
- 録音を保持する場合の保管設計と削除リクエスト対応。
- agent/api で重複している PII マスカ・索引ロジックの共有パッケージ化。
