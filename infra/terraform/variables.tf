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
  default = null
  # null（未指定）のとき cloud_run.tf の agent_env で "gemini-live-2.5-flash-native-audio" になる。
  # 明示指定した場合はその値を優先する。
}

variable "gemini_reasoning_model" {
  type    = string
  default = "gemini-2.5-flash"
}

variable "data_retention_days" {
  type    = number
  default = 30
}

# ---- Session materials / video analysis (ADR-0040) --------------------------
# 動画解析パイプライン（GCS 直送 → Cloud Tasks → 専用 worker）の段階導入フラグ。
# 既定 false: バケット/キュー/worker SA は作るが、worker Cloud Run service は作らない
# （worker image が Artifact Registry に無い状態で apply が失敗するのを避ける）。
# worker image を CI が push できるようになってから true にして worker を立てる。
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

# ---- ゲスト入場 (ADR-0032) ----
variable "guest_join_enabled" {
  type        = bool
  default     = false
  description = "scope=end_user リンクをログインなしで受けるか（ADR-0032 / GUEST_JOIN_ENABLED）。段階リリース用フラグ。"
}

# ---- ログイン nonce チャレンジ (ADR-0047) ----
variable "require_login_nonce" {
  type        = bool
  default     = false
  description = "create/join で ID トークンの nonce claim をサーバ照合するか（ADR-0047 / REQUIRE_LOGIN_NONCE）。ID トークン注入対策。段階リリース用フラグ（web の nonce フロー確認後に true）。"
}

# ---- ルーム作成の許可リスト (ADR-0012 §3) ----
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

# Google ログイン (ADR-0012)。ID トークン検証の aud に使う OAuth Web クライアント ID。
# 秘匿物ではないので Secret Manager ではなく平文 env で注入する。空のままだと API は
# 認証経路をフェイルクローズする (AUTH_DEV_BYPASS=false 前提)。client secret は本方式
# (ID トークン検証のみ) では不要なので変数化しない。
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

# ---- Custom domain / Load Balancer ------------------------------------------
# 本番 URL を Cloud Run 既定の *.run.app から独自ドメインへ。Global 外部 HTTPS LB +
# Serverless NEG + Google 管理 SSL 証明書で配信する (本番志向: WAF/CDN 拡張余地)。
# domain が空のときは LB 関連リソースを一切作らない (既定の run.app 運用のまま)。
# OSS なのでドメインはハードコードせず、デプロイ側 (GitHub Variables / tfvars) で各自が設定する。
variable "domain" {
  type        = string
  default     = ""
  description = "Apex domain you own for production (e.g. \"example.com\"). Empty = no LB/custom domain (use *.run.app)."
}

# web をサブドメインに置きたい場合に設定する (例: "youken" → web は youken.<domain>)。
# 空 = apex (<domain> と www.<domain>) で web を配信する従来の挙動。
# 設定すると: web=<sub>.<domain> / api=api.<sub>.<domain> / apex と www は web へ 301 リダイレクト。
variable "web_subdomain" {
  type        = string
  default     = ""
  description = "Optional subdomain to serve the web app at (e.g. \"app\" → app.<domain>). Empty = serve at apex. When set, apex/www 301-redirect to it and api lives at api.<web_subdomain>.<domain>."
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

# 管理ゾーンの DNSSEC 状態。Cloud Domains が自動作成した DNSSEC 有効ゾーンを import する場合は "on"。
# 明示的に DNSSEC を無効化するなら "off"。移行中ゾーンは "transfer"。
# 未設定 (null / 空文字) の場合は dnssec_config ブロックを送らない。
# これにより DNSSEC 有効ゾーンへの apply は GCP が 400 で止める元のフェイルセーフ動作を維持する。
variable "dns_dnssec_state" {
  type        = string
  default     = null
  description = "DNSSEC state of the managed zone: \"on\" (Cloud Domains zone), \"off\" (explicit disable), \"transfer\" (migration), or null/empty (omit block; fail-safe: GCP returns 400 if zone has DNSSEC enabled)."
  validation {
    condition     = var.dns_dnssec_state == null || contains(["", "off", "on", "transfer"], var.dns_dnssec_state)
    error_message = "dns_dnssec_state must be \"off\", \"on\", \"transfer\", or omitted."
  }
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
  default     = ["livekit-api-key", "livekit-api-secret", "elasticsearch-api-key", "google-api-key", "github-app-private-key", "github-app-client-secret"]
  description = "Secret Manager に作成する app secret の id (sanba- 接頭辞は自動付与)。値は管理しない。"
}

# 値を投入済みで Cloud Run に注入する app secret。値を SM に入れてからここへ追加して apply する。
# 空コンテナを Cloud Run が参照すると起動失敗するため、active なものだけ紐付ける。
variable "active_app_secret_ids" {
  type        = list(string)
  default     = []
  description = "値投入済みで Cloud Run に注入する app secret id。app_secret_ids の部分集合。"
}

# ---- GitHub App: per-user repo linking (ADR-0028) ----
# 秘匿値 (private key / client secret) は app_secret_ids の箱 (github-app-private-key /
# github-app-client-secret) に gcloud で投入し、active_app_secret_ids に足すと api に注入される。
# 以下は秘匿物でない平文設定 (api の env に直接入る)。
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

# 空なら domain 有効時に api ホストから自動導出する (https://api.<host>/api/github/link/callback)。
variable "github_app_callback_url" {
  type        = string
  default     = ""
  description = "install 完了後に GitHub が戻す api の絶対 URL (App 登録側の Setup/Callback URL と一致させる)。空=domain から自動導出。"
}

# 空なら domain 有効時に web ホストの /settings へ導出する。
variable "github_app_web_return_url" {
  type        = string
  default     = ""
  description = "連携保存後にユーザーを戻す web 設定画面の URL。空=domain から web の /settings を導出。"
}
