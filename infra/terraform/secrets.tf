# Secret Manager — Cloud Run が参照する機微情報。
#
# 方針:
#   - session-signing-secret は常に作る (未指定なら強い値を自動生成して保管)。
#   - 任意のシークレット (livekit/google/elasticsearch) は値が入っているものだけ作る。
#   - キー集合 (for_each) は plan 時に確定させる: random_password の値 (apply 時まで unknown)
#     をフィルタ条件に使わない。任意分の有無は var の値 (plan 時に既知) だけで判定する。
#   - 実行 SA には main.tf で roles/secretmanager.secretAccessor を付与済み。

resource "random_password" "session_signing" {
  length  = 48
  special = false
}

locals {
  # 未指定なら自動生成。値は apply 時まで unknown でも、キー集合には影響しない。
  session_secret_value = var.session_signing_secret != "" ? var.session_signing_secret : random_password.session_signing.result

  # 任意シークレット (キー => 値)。値はすべて var 由来 = plan 時に既知。
  optional_secret_values = {
    "livekit-api-key"       = var.livekit_api_key
    "livekit-api-secret"    = var.livekit_api_secret
    "google-api-key"        = var.google_api_key
    "elasticsearch-api-key" = var.elasticsearch_api_key
  }
  # 値そのものは sensitive だが「設定されているか否か」は秘匿情報ではない。空判定だけ
  # nonsensitive() で取り出し、キー集合 (= secret_keys / for_each) を非 sensitive に保つ。
  optional_secrets = { for k, v in local.optional_secret_values : k => v if nonsensitive(v) != "" }

  # 作成するシークレットのキー集合 (常設 + 任意)。plan 時に確定する。
  secret_keys = toset(concat(["session-signing-secret"], keys(local.optional_secrets)))

  # 各サービスが参照する ENV名 => シークレットキー (存在するものだけ)。
  api_secret_env = { for env, key in {
    SESSION_SIGNING_SECRET = "session-signing-secret"
    LIVEKIT_API_KEY        = "livekit-api-key"
    LIVEKIT_API_SECRET     = "livekit-api-secret"
    GOOGLE_API_KEY         = "google-api-key"
    ELASTICSEARCH_API_KEY  = "elasticsearch-api-key"
  } : env => key if contains(local.secret_keys, key) }

  agent_secret_env = { for env, key in {
    LIVEKIT_API_KEY       = "livekit-api-key"
    LIVEKIT_API_SECRET    = "livekit-api-secret"
    GOOGLE_API_KEY        = "google-api-key"
    ELASTICSEARCH_API_KEY = "elasticsearch-api-key"
  } : env => key if contains(local.secret_keys, key) }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secret_keys
  secret_id = "sanba-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "app" {
  for_each = local.secret_keys
  secret   = google_secret_manager_secret.app[each.key].id
  # session-signing-secret だけ自動生成値、それ以外は var 由来の任意値。
  secret_data = each.key == "session-signing-secret" ? local.session_secret_value : local.optional_secret_values[each.key]
}
