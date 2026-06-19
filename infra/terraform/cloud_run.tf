# Cloud Run services for the API, the web client and the voice agent worker.
#
# コスト最適化:
#   - api / web は cpu_idle=true + min=0 → リクエスト時だけ課金 (scale-to-zero)。
#   - agent は LiveKit に常駐登録するワーカーなので cpu 常時割当。min は変数で 0 に絞れる。
# 環境変数:
#   - 平文の設定は env で、機微情報は Secret Manager 参照 (secrets.tf) で注入する。
#   - 本番は use_vertexai=true 既定 → Gemini はキーレス (実行 SA の aiplatform.user)。

locals {
  image_base = "${var.region}-docker.pkg.dev/${var.project_id}/sanba"

  # agent / api 共通の平文 env。
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
    GEMINI_LIVE_MODEL      = var.gemini_live_model
    GEMINI_REASONING_MODEL = var.gemini_reasoning_model
    OTEL_SERVICE_NAME      = "sanba-agent"
  })

  api_env = merge(local.common_env, {
    OTEL_SERVICE_NAME = "sanba-api"
    REQUIRE_CONSENT   = "true"
    # CORS は web のオリジンに限定する。独自ドメイン有効時は sanba.com / www.sanba.com に加え、
    # カットオーバー中も現行の run.app web が落ちないよう web.uri も併許可する
    # (DNS 伝播・証明書 ACTIVE・web 再デプロイが終わるまで run.app からの API 呼び出しが続くため)。
    # 未設定時は Cloud Run 既定の web URL のみ。api.sanba.com 自身はオリジンにならないため除外。
    ALLOWED_ORIGINS = local.domain_enabled ? "https://${var.domain},https://www.${var.domain},${google_cloud_run_v2_service.web.uri}" : google_cloud_run_v2_service.web.uri
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
        cpu_idle = true # リクエスト時のみ課金 (scale-to-zero)
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
    google_secret_manager_secret_version.app,
  ]
  # 画像タグは CI (deploy.yml) が更新する。terraform は env/secret/スケールのみ管理。
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service" "agent" {
  name     = "sanba-agent"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    # LiveKit に登録された warm ワーカーを最低 1 つ保つ (0 にするとコスト停止だが受け口も消える)。
    scaling {
      min_instance_count = var.agent_min_instances
      max_instance_count = var.agent_max_instances
    }
    containers {
      image = "${local.image_base}/agent:${var.image_tag}"
      resources {
        limits   = { cpu = "2", memory = "1Gi" }
        cpu_idle = false # 常駐ワーカーなので常時 CPU 割当
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
    google_secret_manager_secret_version.app,
  ]
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service" "web" {
  name     = "sanba-web"
  location = var.region
  template {
    # web も最小権限の runtime SA で動かす (デフォルト compute SA の roles/editor を避ける)。
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

# Public access for web + api (agent stays private).
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
