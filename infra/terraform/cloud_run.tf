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
    # Gemini Live のモデル名。明示指定(var.gemini_live_model)を優先し、未指定なら
    # gemini-live-2.5-flash-native-audio（Vertex GA）。gemini-2.0-flash-live-001 は廃止済み。
    GEMINI_LIVE_MODEL      = coalesce(var.gemini_live_model, "gemini-live-2.5-flash-native-audio")
    GEMINI_REASONING_MODEL = var.gemini_reasoning_model
    OTEL_SERVICE_NAME      = "sanba-agent"
  })

  api_env = merge(local.common_env, {
    OTEL_SERVICE_NAME = "sanba-api"
    REQUIRE_CONSENT   = "true"
    # Google ログイン (ADR-0012)。ID トークン検証の aud。秘匿物ではないので平文 env。
    GOOGLE_OAUTH_CLIENT_ID = var.google_oauth_client_id
    # 管理画面の許可リスト (ADR-0014 §2)。email 集合で秘匿物ではないため平文 env。
    ADMIN_EMAILS = var.admin_emails
    # CORS は web のオリジンに限定する。独自ドメイン有効時は web を配信するホスト (local.web_hosts:
    # apex モードは apex+www、subdomain モードは <sub>.<domain>) に加え、カットオーバー中も現行の
    # run.app web が落ちないよう web.uri も併許可する (DNS 伝播・証明書 ACTIVE・web 再デプロイが
    # 終わるまで run.app からの API 呼び出しが続くため)。apex/www は web へ 301 されオリジンには
    # ならないため redirect_hosts は含めない。未設定時は Cloud Run 既定の web URL のみ。
    ALLOWED_ORIGINS = local.domain_enabled ? join(",", concat([for h in local.web_hosts : "https://${h}"], [google_cloud_run_v2_service.web.uri])) : google_cloud_run_v2_service.web.uri
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
    google_secret_manager_secret.app,
    google_secret_manager_secret_version.session_signing,
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
      # LiveKit Agents ワーカーの health server は既定で :8081 を listen する。Cloud Run の
      # 起動プローブをそのポートに合わせる (未指定だと 8080 を probe して起動失敗する)。
      ports { container_port = 8081 }
      resources {
        # 常駐ワーカー。Gemini Live セッション中に 1Gi を超過し OOM で再起動する事象を実機で
        # 確認したため 2Gi にする（"Memory limit of 1024 MiB exceeded"）。
        limits   = { cpu = "2", memory = "2Gi" }
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
