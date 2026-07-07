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

variable "image_keep_count" {
  type    = number
  default = 5
}

variable "use_vertexai" {
  type    = bool
  default = true
}

variable "gemini_live_model" {
  type    = string
  default = null
}

variable "gemini_reasoning_model" {
  type    = string
  default = "gemini-2.5-flash"
}

variable "data_retention_days" {
  type    = number
  default = 30
}

variable "enable_video_analysis" {
  type        = bool
  default     = false
  description = "Provision the sanba-worker Cloud Run service and wire the API to enqueue video analysis (ADR-0040). Needs a built worker image."
}

variable "materials_bucket_name" {
  type        = string
  default     = ""
  description = "GCS bucket name for session materials (images/videos). Empty = <project_id>-sanba-materials. Must be globally unique."
}

variable "video_tasks_queue" {
  type        = string
  default     = "sanba-video-analysis"
  description = "Cloud Tasks queue name for the async video analysis pipeline."
}

variable "worker_request_timeout_seconds" {
  type        = number
  default     = 900
  description = "Cloud Run request timeout for the worker (must exceed the worst-case video analysis time; default 5min is too short for 10min videos)."
}

variable "max_video_duration_seconds" {
  type        = number
  default     = 600
  description = "Reject uploaded videos longer than this in the worker (ADR-0040: 10min cap for short screen recordings)."
}

variable "guest_join_enabled" {
  type        = bool
  default     = false
  description = "scope=end_user リンクをログインなしで受けるか（ADR-0032 / GUEST_JOIN_ENABLED）。段階リリース用フラグ。"
}

variable "require_login_nonce" {
  type        = bool
  default     = false
  description = "create/join で ID トークンの nonce claim をサーバ照合するか（ADR-0047 / REQUIRE_LOGIN_NONCE）。ID トークン注入対策。段階リリース用フラグ（web の nonce フロー確認後に true）。"
}

variable "room_creator_allowlist" {
  type        = string
  default     = ""
  description = "ルーム作成を許可する email/ドメインのカンマ区切り（ADR-0012 §3 / ROOM_CREATOR_ALLOWLIST）。空=制限なし。admin は常に可。"
}

variable "invite_join_rate_per_minute" {
  type        = number
  default     = 10
  description = "深掘りリンク（invite）単位のセッション作成レート制限（毎分 / ADR-0032 / INVITE_JOIN_RATE_PER_MINUTE）。"
}

variable "google_oauth_client_id" {
  type        = string
  default     = ""
  description = "OAuth 2.0 Web client ID for Google login. Verified as the id_token audience by the API."
}

variable "admin_emails" {
  type        = string
  default     = ""
  description = "Comma-separated allowlist of Google account emails that may use the admin UI (ADR-0014). Not a secret."
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

variable "terraform_deployer_sa" {
  type        = string
  default     = ""
  description = "terraform apply を実行する CI SA の email（#388）。空なら tf-deployer@<project>.iam.gserviceaccount.com を使う。ログメトリクス/ダッシュボード作成権限をこの SA に付与する。"
}

variable "deploy_sa" {
  type        = string
  default     = ""
  description = "SA email of the CI identity used by deploy.yml (vars.DEPLOY_SA). Granted read on the Picker API key secret so the web build can bake NEXT_PUBLIC_GOOGLE_API_KEY. Empty = no grant (Drive import stays unconfigured)."
}

variable "domain" {
  type        = string
  default     = ""
  description = "Apex domain you own for production (e.g. \"example.com\"). Empty = no LB/custom domain (use *.run.app)."
}

variable "web_subdomain" {
  type        = string
  default     = ""
  description = "Optional subdomain to serve the web app at (e.g. \"app\" → app.<domain>). Empty = serve at apex. When set, apex/www 301-redirect to it and api lives at api.<web_subdomain>.<domain>."
}

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

variable "dns_dnssec_state" {
  type        = string
  default     = null
  description = "DNSSEC state of the managed zone: \"on\" (Cloud Domains zone), \"off\" (explicit disable), \"transfer\" (migration), or null/empty (omit block; fail-safe: GCP returns 400 if zone has DNSSEC enabled)."
  validation {
    condition     = var.dns_dnssec_state == null || contains(["", "off", "on", "transfer"], var.dns_dnssec_state)
    error_message = "dns_dnssec_state must be \"off\", \"on\", \"transfer\", or omitted."
  }
}


variable "session_signing_secret" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Signs session invites. Empty = a strong value is generated and stored. 通常は空のまま。"
}

variable "app_secret_ids" {
  type        = list(string)
  default     = ["livekit-api-key", "livekit-api-secret", "elasticsearch-api-key", "google-api-key", "github-app-private-key", "github-app-client-secret"]
  description = "Secret Manager に作成する app secret の id (sanba- 接頭辞は自動付与)。値は管理しない。"
}

variable "active_app_secret_ids" {
  type        = list(string)
  default     = []
  description = "値投入済みで Cloud Run に注入する app secret id。app_secret_ids の部分集合。"
}

variable "github_app_enabled" {
  type        = bool
  default     = false
  description = "GitHub App 連携を有効化するか。true でも秘匿値 (private key / client secret) が active でないと api 側でフェイルクローズする。"
}

variable "github_app_id" {
  type        = string
  default     = ""
  description = "GitHub App の数値 ID (App 認証 JWT の iss)。秘匿物ではない。"
}

variable "github_app_slug" {
  type        = string
  default     = ""
  description = "GitHub App の slug (install URL github.com/apps/<slug>/installations/new に使う)。"
}

variable "github_app_client_id" {
  type        = string
  default     = ""
  description = "GitHub App の OAuth client id (user-to-server)。秘匿物ではない。secret は github-app-client-secret 箱で渡す。"
}

variable "github_app_callback_url" {
  type        = string
  default     = ""
  description = "install 完了後に GitHub が戻す api の絶対 URL (App 登録側の Setup/Callback URL と一致させる)。空=domain から自動導出。"
}

variable "github_app_web_return_url" {
  type        = string
  default     = ""
  description = "連携保存後にユーザーを戻す web 設定画面の URL。空=domain から web の /settings を導出。"
}
