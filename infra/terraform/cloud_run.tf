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
    # ログイン nonce チャレンジ (ADR-0047)。ID トークン注入対策。段階リリース用フラグ。
    REQUIRE_LOGIN_NONCE = tostring(var.require_login_nonce)
    # ルーム作成の許可リスト (ADR-0012 §3)。email/ドメイン集合。空=制限なし。平文 env。
    ROOM_CREATOR_ALLOWLIST = var.room_creator_allowlist
    # ゲスト入場 (ADR-0032)。段階リリース用フラグ（既定 false）。
    GUEST_JOIN_ENABLED          = tostring(var.guest_join_enabled)
    INVITE_JOIN_RATE_PER_MINUTE = tostring(var.invite_join_rate_per_minute)
    # CORS は web のオリジンに限定する。独自ドメイン有効時は web を配信するホスト (local.web_hosts:
    # apex モードは apex+www、subdomain モードは <sub>.<domain>) に加え、カットオーバー中も現行の
    # run.app web が落ちないよう web.uri も併許可する (DNS 伝播・証明書 ACTIVE・web 再デプロイが
    # 終わるまで run.app からの API 呼び出しが続くため)。apex/www は web へ 301 されオリジンには
    # ならないため redirect_hosts は含めない。未設定時は Cloud Run 既定の web URL のみ。
    ALLOWED_ORIGINS = local.domain_enabled ? join(",", concat([for h in local.web_hosts : "https://${h}"], [google_cloud_run_v2_service.web.uri])) : google_cloud_run_v2_service.web.uri
    # 素材の永続化先（ADR-0040）。設定すると AssetStore が in-memory から GCS へ切り替わり、
    # 画像アップロードも即座に永続化される。動画は直送 + Cloud Tasks で worker が解析する。
    GCS_BUCKET            = google_storage_bucket.materials.name
    ENABLE_VIDEO_ANALYSIS = tostring(var.enable_video_analysis)
    VIDEO_TASKS_QUEUE     = google_cloud_tasks_queue.video_analysis.name
    VIDEO_TASKS_LOCATION  = var.region
    # worker サービスは enable_video_analysis のときだけ存在する。splat + join で
    # count=0（未作成）のとき空文字にする（[0] 参照だと plan が落ちるため）。
    WORKER_URL        = join("", google_cloud_run_v2_service.worker[*].uri)
    WORKER_INVOKER_SA = google_service_account.worker.email
    # GitHub App 連携 (ADR-0028)。秘匿物でない設定は平文 env。秘匿値 (private key /
    # client secret) は api_secret_env 経由で SM から注入する。callback/return URL は
    # 明示指定が無ければ domain の api/web ホストから導出する（GitHub App は実在の公開 URL
    # を要求するため、domain 無効時は空 = 導出不能で連携はフェイルクローズ）。
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
        limits = { cpu = "2", memory = "2Gi" }
        # 常駐ワーカーなので常時 CPU 割当。加えて ADR-0037 の背景処理（先読み検索・
        # バックグラウンド分析）はリクエスト応答外の CPU 消費を前提とするため、
        # cpu_idle=true へ変更してはならない。
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
