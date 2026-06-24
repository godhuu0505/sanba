variable "project_id" {
  type        = string
  description = "GCP project id"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag to deploy"
}

variable "billing_account" {
  type        = string
  default     = ""
  description = "Billing account id for the budget alert (optional)"
}

variable "monthly_budget_jpy" {
  type    = number
  default = 30000
}

# ---- Cost knobs --------------------------------------------------------------
# Cloud Run の always-on は最大のコスト要因。api/web はリクエスト時のみ課金
# (scale-to-zero + cpu_idle)。agent は LiveKit に常駐登録するワーカーなので
# min=1 が機能上の既定だが、使わない時間帯は 0 に絞ってコストを止められる。
variable "agent_min_instances" {
  type        = number
  default     = 1
  description = "Min warm agent workers. 0 = scale to zero (cheapest, but no worker registered)."
}

variable "agent_max_instances" {
  type    = number
  default = 5
}

variable "service_max_instances" {
  type        = number
  default     = 4
  description = "Max instances for the stateless api/web services."
}

# Artifact Registry のクリーンアップ: 直近 N 個のイメージだけ残しストレージ課金を抑える。
variable "image_keep_count" {
  type    = number
  default = 5
}

# ---- Runtime config (plain env on Cloud Run) ---------------------------------
# 本番は Vertex AI を既定にして「キーレス」(実行 SA の aiplatform.user) で Gemini を叩く。
# → GOOGLE_API_KEY をシークレットに置かなくてよい (GCP 連携の加点ポイント)。
variable "use_vertexai" {
  type    = bool
  default = true
}

variable "gemini_live_model" {
  type    = string
  default = "gemini-2.0-flash-live-001"
}

variable "gemini_reasoning_model" {
  type    = string
  default = "gemini-2.5-flash"
}

variable "data_retention_days" {
  type    = number
  default = 30
}

# Google ログイン (ADR-0012)。ID トークン検証の aud に使う OAuth Web クライアント ID。
# 秘匿物ではないので Secret Manager ではなく平文 env で注入する。空のままだと API は
# 認証経路をフェイルクローズする (AUTH_DEV_BYPASS=false 前提)。client secret は本方式
# (ID トークン検証のみ) では不要なので変数化しない。
variable "google_oauth_client_id" {
  type        = string
  default     = ""
  description = "OAuth 2.0 Web client ID for Google login. Verified as the id_token audience by the API."
}

variable "livekit_url" {
  type        = string
  default     = ""
  description = "LiveKit Cloud websocket URL (wss://...). Required for the real voice path."
}

variable "elasticsearch_url" {
  type        = string
  default     = ""
  description = "Managed Elasticsearch endpoint. Empty = agent falls back to in-memory grounding."
}

variable "otel_exporter_otlp_endpoint" {
  type        = string
  default     = ""
  description = "OTLP/gRPC endpoint for traces (e.g. an OpenTelemetry Collector sidecar that forwards to Cloud Trace). Empty = tracing is skipped."
}

# ---- Custom domain / Load Balancer ------------------------------------------
# 本番 URL を Cloud Run 既定の *.run.app から独自ドメインへ。Global 外部 HTTPS LB +
# Serverless NEG + Google 管理 SSL 証明書で配信する (本番志向: WAF/CDN 拡張余地)。
# domain が空のときは LB 関連リソースを一切作らない (既定の run.app 運用のまま)。
variable "domain" {
  type        = string
  default     = ""
  description = "Apex domain for production (e.g. \"sanba.com\"). Empty = no LB/custom domain (use *.run.app)."
}

# Cloud DNS をこの Terraform で管理するか。true ならゾーンを作り、A レコードを LB IP に
# 向ける。ドメイン取得後、レジストラの NS をこのゾーンの NS に向ければ証明書が発行される。
# 既に別 DNS で運用する場合は false にし、出力された LB IP を手動で A レコードに設定する。
variable "manage_dns" {
  type        = bool
  default     = true
  description = "Create a Cloud DNS managed zone + A records for `domain`. false = bring your own DNS."
}

variable "dns_managed_zone_name" {
  type        = string
  default     = "sanba"
  description = "Cloud DNS managed zone resource name (used only when manage_dns = true)."
}

# ---- Secrets (Secret Manager) ------------------------------------------------
# 方針: Secret Manager を値の唯一の置き場にする。terraform は箱 (secret) と Cloud Run 参照だけを
# 管理し、アプリ秘匿値そのものは管理しない (gcloud で SM に直接投入)。よって livekit/elasticsearch/
# google の「値」変数は持たない (GitHub Secrets / state に秘匿値を残さないため)。詳細は secrets.tf。

# session-signing-secret は自動生成のため例外的に値を扱う。空なら強い値を生成して SM に格納する。
variable "session_signing_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Signs session invites. Empty = a strong value is generated and stored. 通常は空のまま。"
}

# Secret Manager に作成する「箱」の集合。値は terraform 管理外 (gcloud で投入)。
variable "app_secret_ids" {
  type        = list(string)
  default     = ["livekit-api-key", "livekit-api-secret", "elasticsearch-api-key", "google-api-key"]
  description = "Secret Manager に作成する app secret の id (sanba- 接頭辞は自動付与)。値は管理しない。"
}

# 値を投入済みで Cloud Run に注入する app secret。値を SM に入れてからここへ追加して apply する。
# 空コンテナを Cloud Run が参照すると起動失敗するため、active なものだけ紐付ける。
variable "active_app_secret_ids" {
  type        = list(string)
  default     = []
  description = "値投入済みで Cloud Run に注入する app secret id。app_secret_ids の部分集合。"
}
