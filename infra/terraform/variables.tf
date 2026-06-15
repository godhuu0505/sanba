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

# ---- Secrets (Secret Manager) ------------------------------------------------
# 空文字のものはシークレットを作らない。session_signing_secret は空なら自動生成する。
variable "session_signing_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Signs session invites. Empty = a strong value is generated and stored."
}

variable "livekit_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "livekit_api_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "google_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Only needed when use_vertexai = false (AI Studio key). Prefer Vertex (keyless)."
}

variable "elasticsearch_api_key" {
  type      = string
  default   = ""
  sensitive = true
}
