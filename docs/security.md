# セキュリティ & データガバナンス — Kikitori

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
- Elasticsearch: ILM で `kikitori-grounding` の古いドキュメントを削除（運用設定）。
- 既定 `DATA_RETENTION_DAYS=30`。0 で無期限。

## 6. 暗号化 & 最小権限
- 保存時/通信時暗号化は GCP デフォルト（必要なら CMEK を検討）。
- Cloud Run のランタイム SA は最小権限（`infra/terraform` の IAM、`secretAccessor` 等）。
- Elasticsearch は API キーをスコープして接続。

## 7. CI セキュリティ（#9）
- Dependabot / pip-audit / npm audit / gitleaks / Trivy / CodeQL。
- **CodeQL の結果アップロードにはリポジトリ設定で「Code scanning（GitHub Advanced Security）」の
  有効化が必要**。有効化までは advisory（CIは緑のまま）。

## 残課題
- 完全な IdP 連携（Firebase Auth / Identity Platform）。
- 録音を保持する場合の保管設計と削除リクエスト対応。
- agent/api で重複している PII マスカ・索引ロジックの共有パッケージ化。
