# Session materials bucket + async video-analysis pipeline (ADR-0040).
#
# 目的:
#   - 素材（画像/動画）を Cloud Storage に永続化する。GCS_BUCKET 未設定だと AssetStore が
#     in-memory にフォールバックし、Cloud Run インスタンス終了で素材が消える（本番の既知欠陥）。
#     このバケットを api に配線することで画像アップロードも即座に永続化される。
#   - 動画は「GCS 直送 → Cloud Tasks → 専用 worker で Gemini 動画解析 → grounding 投入」の
#     非同期パイプラインで解析する（ADR-0040）。worker サービスは image が要るため
#     enable_video_analysis で段階導入する（既定 false。worker image が揃ってから true）。
#
# コスト/セキュリティ:
#   - バケットは uniform access + public access 完全禁止（署名付き URL 経由のみ）。
#   - lifecycle でオブジェクトを data_retention_days で自動削除し、Firestore materials の
#     TTL（expireAt）と保持期間を揃える（同意文言「30 日で削除」と整合）。
#   - worker は最小権限 SA（バケット読取 + Firestore + Vertex AI）。api SA には
#     enqueue と当該バケットのみの objectAdmin を付与する。

locals {
  materials_bucket = var.materials_bucket_name != "" ? var.materials_bucket_name : "${var.project_id}-sanba-materials"

  worker_env = merge(local.common_env, {
    OTEL_SERVICE_NAME      = "sanba-worker"
    GCS_BUCKET             = google_storage_bucket.materials.name
    ENABLE_VIDEO_ANALYSIS  = "true"
    GEMINI_REASONING_MODEL = var.gemini_reasoning_model
    # 動画の実長上限（分）。超過はハンドラで failed 化する（ADR-0040 §2）。
    MAX_VIDEO_DURATION_SECONDS = tostring(var.max_video_duration_seconds)
  })
}

# ---- Materials bucket -------------------------------------------------------
resource "google_storage_bucket" "materials" {
  name                        = local.materials_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # 素材は消えてよい一時データだが、誤 destroy でユーザ素材を吹き飛ばさないよう force_destroy は false。
  force_destroy = false
  depends_on    = [google_project_service.services]

  # 保持期間を過ぎた素材を自動削除（Firestore materials TTL と同じ日数）。
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = var.data_retention_days
    }
  }

  # ブラウザからの直送（署名付き resumable URL, ADR-0040 §2）を許可する CORS。
  # 署名付き URL 自体が認可なので "*" でも実害は小さいが、オリジンは web 配信ホストに絞る
  # （api の ALLOWED_ORIGINS と同じ集合）。domain 未設定時は Cloud Run 既定の web URL のみ。
  cors {
    origin          = local.domain_enabled ? concat([for h in local.web_hosts : "https://${h}"], [google_cloud_run_v2_service.web.uri]) : [google_cloud_run_v2_service.web.uri]
    method          = ["PUT", "POST", "GET", "HEAD"]
    response_header = ["Content-Type", "x-goog-resumable", "x-goog-content-length-range"]
    max_age_seconds = 3600
  }
}

# ---- Cloud Tasks queue for video analysis -----------------------------------
# api が upload-complete で 1 動画 = 1 タスクを enqueue し、worker が pull される。
# task 名は session_id + asset_id 由来（api 側）で重複排除する（ADR-0040 §3）。
resource "google_cloud_tasks_queue" "video_analysis" {
  name     = var.video_tasks_queue
  location = var.region

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }
  # 一時障害（Gemini/ES）に対する再試行。枯渇時は worker がハンドラ内で failed 化する
  # （Cloud Tasks は上限到達後にハンドラを呼ばないため。ADR-0040 §3）。
  retry_config {
    max_attempts  = 5
    min_backoff   = "10s"
    max_backoff   = "300s"
    max_doublings = 4
  }

  depends_on = [google_project_service.services]
}

# ---- Worker service account (least privilege) -------------------------------
resource "google_service_account" "worker" {
  account_id   = "sanba-worker"
  display_name = "SANBA video analysis worker"
  depends_on   = [google_project_service.services]
}

resource "google_project_iam_member" "worker_roles" {
  for_each = toset([
    "roles/datastore.user",              # Firestore materials 更新
    "roles/aiplatform.user",             # Vertex AI Gemini 動画解析（キーレス）
    "roles/cloudtrace.agent",            # OTel トレース
    "roles/logging.logWriter",           # 構造化ログ
    "roles/monitoring.metricWriter",     # メトリクス
    "roles/secretmanager.secretAccessor" # ES / API キー等（active なものだけ注入）
  ])
  project    = var.project_id
  role       = each.value
  member     = "serviceAccount:${google_service_account.worker.email}"
  depends_on = [google_project_service.services]
}

# worker はバケットを read のみ（gs:// を Gemini に渡す / bytes を読む）。
resource "google_storage_bucket_iam_member" "worker_read" {
  bucket = google_storage_bucket.materials.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.worker.email}"
}

# ---- API runtime SA: enqueue + bucket read/write/delete ---------------------
resource "google_project_iam_member" "runtime_cloudtasks" {
  project    = var.project_id
  role       = "roles/cloudtasks.enqueuer"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.services]
}

# 当該バケットのみ objectAdmin（作成/一覧/削除）。既存 DELETE /context/file/{asset_id} が
# prefix list + blob delete を行うため read だけでは真の破棄が失敗する（ADR-0040 §1）。
resource "google_storage_bucket_iam_member" "runtime_materials" {
  bucket = google_storage_bucket.materials.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# 動画の直送（ADR-0040 §2）で api が v4 署名付き URL を発行するには、鍵ファイルの無い
# Cloud Run SA が IAM SignBlob で自分自身に署名できる必要がある（tokenCreator on self）。
resource "google_service_account_iam_member" "runtime_sign_self" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

# api がタスク作成時に OIDC トークンを worker SA として発行するため actAs を付与する。
resource "google_service_account_iam_member" "api_acts_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

# ---- Worker Cloud Run service (gated: needs the worker image) ----------------
# enable_video_analysis=false の間は作らない（worker image が Artifact Registry に無い状態で
# apply が失敗しないように）。worker image を CI が push できるようになってから true にする。
resource "google_cloud_run_v2_service" "worker" {
  count    = var.enable_video_analysis ? 1 : 0
  name     = "sanba-worker"
  location = var.region
  template {
    service_account = google_service_account.worker.email
    scaling {
      # push worker。処理中だけ課金すればよいので scale-to-zero。
      min_instance_count = 0
      max_instance_count = var.service_max_instances
    }
    # 既定 5 分では 10 分動画の Gemini 解析が 504 → 無駄リトライになるため明示的に延ばす（ADR-0040）。
    timeout = "${var.worker_request_timeout_seconds}s"
    containers {
      image = "${local.image_base}/worker:${var.image_tag}"
      ports { container_port = 8080 }
      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = true # タスク処理中のみ CPU 割当（push worker）
      }
      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.worker_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [
    google_artifact_registry_repository.images,
    google_secret_manager_secret.app,
  ]
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

# worker は private。Cloud Tasks が OIDC(worker SA) で叩くので worker SA に invoker を付与する。
resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  count    = var.enable_video_analysis ? 1 : 0
  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.worker.email}"
}
