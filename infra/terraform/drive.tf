locals {
  picker_web_origins = local.domain_enabled ? concat(
    [for h in local.web_hosts : "https://${h}"],
    [google_cloud_run_v2_service.web.uri],
  ) : [google_cloud_run_v2_service.web.uri]

  picker_allowed_referrers = [for o in local.picker_web_origins : "${o}/*"]
}

resource "google_project_iam_member" "tf_deployer_apikeys" {
  project    = var.project_id
  role       = "roles/serviceusage.apiKeysAdmin"
  member     = "serviceAccount:${local.tf_deployer_sa}"
  depends_on = [google_project_service.services]
}

resource "time_sleep" "apikeys_iam_propagation" {
  depends_on      = [google_project_iam_member.tf_deployer_apikeys]
  create_duration = "60s"
}

resource "google_apikeys_key" "picker" {
  name         = "sanba-picker-browser-key"
  display_name = "SANBA Google Picker (browser)"
  project      = var.project_id

  restrictions {
    browser_key_restrictions {
      allowed_referrers = local.picker_allowed_referrers
    }
    api_targets {
      service = "drive.googleapis.com"
    }
    api_targets {
      service = "picker.googleapis.com"
    }
  }

  depends_on = [google_project_service.services, time_sleep.apikeys_iam_propagation]
}

resource "google_secret_manager_secret" "picker_api_key" {
  secret_id = "sanba-next-public-google-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "picker_api_key" {
  secret      = google_secret_manager_secret.picker_api_key.id
  secret_data = google_apikeys_key.picker.key_string
}

resource "google_secret_manager_secret_iam_member" "picker_api_key_ci" {
  count     = var.deploy_sa != "" ? 1 : 0
  secret_id = google_secret_manager_secret.picker_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.deploy_sa}"
}
