# Secret Manager — Cloud Run が参照する機微情報。
#
# 方針 (Secret Manager を「値の唯一の置き場」にする / シークレットの散在を避ける):
#   - terraform は「箱 (secret) + Cloud Run からの参照」だけを管理し、**値 (version) は管理しない**。
#     これによりアプリの秘匿値が GitHub Secrets にも terraform state にも残らない。
#   - アプリ秘匿値 (livekit/elasticsearch/google) は `gcloud secrets versions add` で SM に直接投入する
#     (手順は docs/how-to/deploy-gcp.md)。値を入れた secret を active_app_secret_ids に足して apply すると
#     Cloud Run に注入される。空の箱を Cloud Run が参照すると起動失敗するため、active なものだけ紐付ける。
#   - 例外: session-signing-secret はユーザ提供ではなく自動生成のため、ここで生成して version まで作る
#     (GitHub は経由しない。state には乱数が入るが、暗号化 + アクセス制御された GCS backend が前提)。
#   - 実行 SA には main.tf で roles/secretmanager.secretAccessor を付与済み。

locals {
  session_key = "session-signing-secret"

  # 作成する secret の箱の集合 (常設の session + アプリ秘匿値の箱)。値は管理しない。
  all_secret_ids = toset(concat([local.session_key], var.app_secret_ids))

  # Cloud Run に注入する secret: session は常に。アプリ秘匿値は「値が投入済み」と宣言された
  # (active_app_secret_ids に含まれ、かつ箱が存在する) ものだけ。
  active_secret_ids = toset(concat(
    [local.session_key],
    [for k in var.active_app_secret_ids : k if contains(var.app_secret_ids, k)],
  ))

  # 各サービスが参照する ENV名 => シークレットキー (active なものだけ注入する)。
  api_secret_env = { for env, key in {
    SESSION_SIGNING_SECRET   = "session-signing-secret"
    LIVEKIT_API_KEY          = "livekit-api-key"
    LIVEKIT_API_SECRET       = "livekit-api-secret"
    GOOGLE_API_KEY           = "google-api-key"
    ELASTICSEARCH_API_KEY    = "elasticsearch-api-key"
    GITHUB_APP_PRIVATE_KEY   = "github-app-private-key"
    GITHUB_APP_CLIENT_SECRET = "github-app-client-secret"
  } : env => key if contains(local.active_secret_ids, key) }

  agent_secret_env = { for env, key in {
    LIVEKIT_API_KEY       = "livekit-api-key"
    LIVEKIT_API_SECRET    = "livekit-api-secret"
    GOOGLE_API_KEY        = "google-api-key"
    ELASTICSEARCH_API_KEY = "elasticsearch-api-key"
  } : env => key if contains(local.active_secret_ids, key) }

  # worker（動画解析）: grounding 投入に ES、AI Studio 経路なら google-api-key。LiveKit へ
  # analysis.visual を publish するため livekit key/secret も要る（ADR-0040 §4）。
  worker_secret_env = { for env, key in {
    LIVEKIT_API_KEY       = "livekit-api-key"
    LIVEKIT_API_SECRET    = "livekit-api-secret"
    GOOGLE_API_KEY        = "google-api-key"
    ELASTICSEARCH_API_KEY = "elasticsearch-api-key"
  } : env => key if contains(local.active_secret_ids, key) }
}

# ---- Secret の箱 (値は terraform 管理外。gcloud で版を投入する) ----
resource "google_secret_manager_secret" "app" {
  for_each  = local.all_secret_ids
  secret_id = "sanba-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# ---- session-signing-secret だけは自動生成して版まで作る ----
resource "random_password" "session_signing" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret_version" "session_signing" {
  secret      = google_secret_manager_secret.app[local.session_key].id
  secret_data = var.session_signing_secret != "" ? var.session_signing_secret : random_password.session_signing.result
}

# 旧構成 (google_secret_manager_secret_version.app[*]) からの移行は state mv で一度だけ行う:
#   terraform state mv \
#     'google_secret_manager_secret_version.app["session-signing-secret"]' \
#     google_secret_manager_secret_version.session_signing
# これで session-signing-secret の version を destroy/recreate せずに引き継げる (runbook 参照)。
