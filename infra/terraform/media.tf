locals {
  materials_bucket = var.materials_bucket_name != "" ? var.materials_bucket_name : "${var.project_id}-sanba-materials"

  worker_env = merge(local.common_env, {
    OTEL_SERVICE_NAME          = "sanba-worker"
    GCS_BUCKET                 = google_storage_bucket.materials.name
    ENABLE_VIDEO_ANALYSIS      = "true"
    GEMINI_REASONING_MODEL     = var.gemini_reasoning_model
    MAX_VIDEO_DURATION_SECONDS = tostring(var.max_video_duration_seconds)
    OIDC_SERVICE_ACCOUNT       = google_service_account.worker.email
  })
}

resource "google_storage_bucket" "materials" {
  name                        = local.materials_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.services]

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = var.data_retention_days
    }
  }

  cors {
    origin          = local.domain_enabled ? concat([for h in local.web_hosts : "https://${h}"], [google_cloud_run_v2_service.web.uri]) : [google_cloud_run_v2_service.web.uri]
    method          = ["PUT", "POST", "GET", "HEAD"]
    response_header = ["Content-Type", "x-goog-resumable", "x-goog-content-length-range"]
    max_age_seconds = 3600
  }
}

resource "google_cloud_tasks_queue" "video_analysis" {
  name     = var.video_tasks_queue
  location = var.region

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }
  retry_config {
    max_attempts  = 5
    min_backoff   = "10s"
    max_backoff   = "300s"
    max_doublings = 4
  }

  depends_on = [google_project_service.services]
}

resource "google_service_account" "worker" {
  account_id   = "sanba-worker"
  display_name = "SANBA video analysis worker"
  depends_on   = [google_project_service.services]
}

resource "google_project_iam_member" "worker_roles" {
  for_each = toset([
    "roles/datastore.user",
    "roles/aiplatform.user",
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/secretmanager.secretAccessor"
  ])
  project    = var.project_id
  role       = each.value
  member     = "serviceAccount:${google_service_account.worker.email}"
  depends_on = [google_project_service.services]
}

resource "google_storage_bucket_iam_member" "worker_read" {
  bucket = google_storage_bucket.materials.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_project_iam_member" "runtime_cloudtasks" {
  project    = var.project_id
  role       = "roles/cloudtasks.enqueuer"
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.services]
}

resource "google_storage_bucket_iam_member" "runtime_materials" {
  bucket = google_storage_bucket.materials.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_service_account_iam_member" "runtime_sign_self" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_service_account_iam_member" "api_acts_as_worker" {
  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "worker" {
  count    = var.enable_video_analysis ? 1 : 0
  name     = "sanba-worker"
  location = var.region
  template {
    service_account = google_service_account.worker.email
    scaling {
      min_instance_count = 0
      max_instance_count = var.service_max_instances
    }
    timeout = "${var.worker_request_timeout_seconds}s"
    containers {
      image = "${local.image_base}/worker:${var.image_tag}"
      ports { container_port = 8080 }
      resources {
        limits   = { cpu = "1", memory = "1Gi" }
        cpu_idle = true
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

resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  count    = var.enable_video_analysis ? 1 : 0
  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.worker.email}"
}
