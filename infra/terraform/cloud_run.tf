locals {
  image_base = "${var.region}-docker.pkg.dev/${var.project_id}/sanba"

  common_env = {
    GOOGLE_CLOUD_PROJECT        = var.project_id
    GOOGLE_CLOUD_LOCATION       = var.region
    GOOGLE_GENAI_USE_VERTEXAI   = tostring(var.use_vertexai)
    LIVEKIT_URL                 = var.livekit_url
    ELASTICSEARCH_URL           = var.elasticsearch_url
    MASK_PII_BEFORE_INDEX       = "true"
    DATA_RETENTION_DAYS         = tostring(var.data_retention_days)
    OTEL_EXPORTER_OTLP_ENDPOINT = var.otel_exporter_otlp_endpoint
  }

  agent_env = merge(local.common_env, {
    GEMINI_LIVE_MODEL      = coalesce(var.gemini_live_model, "gemini-live-2.5-flash-native-audio")
    GEMINI_REASONING_MODEL = var.gemini_reasoning_model
    OTEL_SERVICE_NAME      = "sanba-agent"
  })

  api_env = merge(local.common_env, {
    OTEL_SERVICE_NAME = "sanba-api"
    REQUIRE_CONSENT   = "true"
    GOOGLE_OAUTH_CLIENT_ID = var.google_oauth_client_id
    ADMIN_EMAILS = var.admin_emails
    REQUIRE_LOGIN_NONCE = tostring(var.require_login_nonce)
    ROOM_CREATOR_ALLOWLIST = var.room_creator_allowlist
    GUEST_JOIN_ENABLED          = tostring(var.guest_join_enabled)
    INVITE_JOIN_RATE_PER_MINUTE = tostring(var.invite_join_rate_per_minute)
    ALLOWED_ORIGINS = local.domain_enabled ? join(",", concat([for h in local.web_hosts : "https://${h}"], [google_cloud_run_v2_service.web.uri])) : google_cloud_run_v2_service.web.uri
    GCS_BUCKET            = google_storage_bucket.materials.name
    ENABLE_VIDEO_ANALYSIS = tostring(var.enable_video_analysis)
    VIDEO_TASKS_QUEUE     = google_cloud_tasks_queue.video_analysis.name
    VIDEO_TASKS_LOCATION  = var.region
    WORKER_URL        = join("", google_cloud_run_v2_service.worker[*].uri)
    WORKER_INVOKER_SA = google_service_account.worker.email
    GITHUB_APP_ENABLED   = tostring(var.github_app_enabled)
    GITHUB_APP_ID        = var.github_app_id
    GITHUB_APP_SLUG      = var.github_app_slug
    GITHUB_APP_CLIENT_ID = var.github_app_client_id
    GITHUB_APP_CALLBACK_URL = var.github_app_callback_url != "" ? var.github_app_callback_url : (
      local.domain_enabled ? "https://${local.api_host}/api/github/link/callback" : ""
    )
    GITHUB_APP_WEB_RETURN_URL = var.github_app_web_return_url != "" ? var.github_app_web_return_url : (
      local.domain_enabled ? "https://${local.web_host}/settings" : "${google_cloud_run_v2_service.web.uri}/settings"
    )
  })
}

resource "google_cloud_run_v2_service" "api" {
  name     = "sanba-api"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = var.service_max_instances
    }
    containers {
      image = "${local.image_base}/api:${var.image_tag}"
      ports { container_port = 8080 }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = local.api_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.api_secret_env
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
    google_secret_manager_secret_version.session_signing,
  ]
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service" "agent" {
  name     = "sanba-agent"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = var.agent_min_instances
      max_instance_count = var.agent_max_instances
    }
    containers {
      image = "${local.image_base}/agent:${var.image_tag}"
      ports { container_port = 8081 }
      resources {
        limits = { cpu = "2", memory = "2Gi" }
        cpu_idle = false
      }
      dynamic "env" {
        for_each = local.agent_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.agent_secret_env
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
    google_secret_manager_secret_version.session_signing,
  ]
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service" "web" {
  name     = "sanba-web"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = var.service_max_instances
    }
    containers {
      image = "${local.image_base}/web:${var.image_tag}"
      ports { container_port = 3000 }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
    }
  }
  depends_on = [google_artifact_registry_repository.images]
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
