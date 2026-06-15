# Secret Manager — Cloud Run が参照する機微情報。
#
# 方針:
#   - 値が空のものはシークレットを作らない (例: Vertex 利用時は GOOGLE_API_KEY 不要)。
#   - session_signing_secret は未指定なら強い値を自動生成して保管する。
#   - 実行 SA には main.tf で roles/secretmanager.secretAccessor を付与済み。

resource "random_password" "session_signing" {
  length  = 48
  special = false
}

locals {
  session_secret_value = var.session_signing_secret != "" ? var.session_signing_secret : random_password.session_signing.result

  # シークレットキー => 値。空文字は下で除外する。
  secret_values = {
    "session-signing-secret" = local.session_secret_value
    "livekit-api-key"        = var.livekit_api_key
    "livekit-api-secret"     = var.livekit_api_secret
    "google-api-key"         = var.google_api_key
    "elasticsearch-api-key"  = var.elasticsearch_api_key
  }

  # 実際に作成するシークレット (値が入っているものだけ)。
  secrets = { for k, v in local.secret_values : k => v if v != "" }

  # 各サービスが参照する ENV名 => シークレットキー (存在するものだけ)。
  api_secret_env = { for env, key in {
    SESSION_SIGNING_SECRET = "session-signing-secret"
    LIVEKIT_API_KEY        = "livekit-api-key"
    LIVEKIT_API_SECRET     = "livekit-api-secret"
    GOOGLE_API_KEY         = "google-api-key"
    ELASTICSEARCH_API_KEY  = "elasticsearch-api-key"
  } : env => key if contains(keys(local.secrets), key) }

  agent_secret_env = { for env, key in {
    LIVEKIT_API_KEY       = "livekit-api-key"
    LIVEKIT_API_SECRET    = "livekit-api-secret"
    GOOGLE_API_KEY        = "google-api-key"
    ELASTICSEARCH_API_KEY = "elasticsearch-api-key"
  } : env => key if contains(keys(local.secrets), key) }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secrets
  secret_id = "sanba-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "app" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = each.value
}
