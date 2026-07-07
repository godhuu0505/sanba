locals {
  session_key = "session-signing-secret"

  all_secret_ids = toset(concat([local.session_key], var.app_secret_ids))

  active_secret_ids = toset(concat(
    [local.session_key],
    [for k in var.active_app_secret_ids : k if contains(var.app_secret_ids, k)],
  ))

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

  worker_secret_env = { for env, key in {
    LIVEKIT_API_KEY       = "livekit-api-key"
    LIVEKIT_API_SECRET    = "livekit-api-secret"
    GOOGLE_API_KEY        = "google-api-key"
    ELASTICSEARCH_API_KEY = "elasticsearch-api-key"
  } : env => key if contains(local.active_secret_ids, key) }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.all_secret_ids
  secret_id = "sanba-${each.key}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "random_password" "session_signing" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret_version" "session_signing" {
  secret      = google_secret_manager_secret.app[local.session_key].id
  secret_data = var.session_signing_secret != "" ? var.session_signing_secret : random_password.session_signing.result
}
