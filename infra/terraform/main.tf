terraform {
  required_version = ">= 1.8"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }
  backend "gcs" {}
}

provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudtasks.googleapis.com",
    "drive.googleapis.com",
    "picker.googleapis.com",
    "apikeys.googleapis.com",
    "cloudtrace.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
    "billingbudgets.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "sanba"
  format        = "DOCKER"
  depends_on    = [google_project_service.services]

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.image_keep_count
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s"
    }
  }
}

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.services]
}

resource "google_firestore_field" "utterances_ttl" {
  database   = google_firestore_database.default.name
  collection = "utterances"
  field      = "expireAt"
  ttl_config {}
}

resource "google_firestore_field" "requirements_ttl" {
  database   = google_firestore_database.default.name
  collection = "requirements"
  field      = "expireAt"
  ttl_config {}
}

resource "google_firestore_field" "questions_ttl" {
  database   = google_firestore_database.default.name
  collection = "questions"
  field      = "expireAt"
  ttl_config {}
}

resource "google_firestore_field" "sessions_ttl" {
  database   = google_firestore_database.default.name
  collection = "sessions"
  field      = "expireAt"
  ttl_config {}
}

resource "google_firestore_field" "auth_sessions_ttl" {
  database   = google_firestore_database.default.name
  collection = "auth_sessions"
  field      = "expires_at"
  ttl_config {}
}

resource "google_firestore_field" "transcripts_ttl" {
  database   = google_firestore_database.default.name
  collection = "transcripts"
  field      = "expireAt"
  ttl_config {}
}

resource "google_service_account" "runtime" {
  account_id   = "sanba-runtime"
  display_name = "SANBA Cloud Run runtime"
  depends_on   = [google_project_service.services]
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/datastore.user",
    "roles/aiplatform.user",
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/secretmanager.secretAccessor",
  ])
  project    = var.project_id
  role       = each.value
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.services]
}

resource "google_project_service" "bigquery" {
  count              = var.enable_billing_export ? 1 : 0
  service            = "bigquery.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_iam_member" "tf_deployer_bigquery" {
  count      = var.enable_billing_export ? 1 : 0
  project    = var.project_id
  role       = "roles/bigquery.user"
  member     = "serviceAccount:${local.tf_deployer_sa}"
  depends_on = [google_project_service.bigquery]
}

resource "time_sleep" "bigquery_iam_propagation" {
  count           = var.enable_billing_export ? 1 : 0
  depends_on      = [google_project_iam_member.tf_deployer_bigquery]
  create_duration = "60s"
}

resource "google_bigquery_dataset" "billing_export" {
  count         = var.enable_billing_export ? 1 : 0
  dataset_id    = "billing_export"
  friendly_name = "Cloud Billing export (ADR-0061)"
  description   = "Cloud Billing の Detailed usage cost export の出力先。エクスポート自体は請求先アカウント側の設定（コンソール/gcloud billing）でこの dataset を指す必要がある。Vertex AI リクエストの billing labels (session_id / product_id) がここに反映され、推定コストとの突合に使う。"
  location      = var.billing_export_location
  depends_on    = [google_project_service.bigquery, time_sleep.bigquery_iam_propagation]
}

resource "google_billing_budget" "monthly" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "sanba-monthly"
  amount {
    specified_amount {
      currency_code = "JPY"
      units         = var.monthly_budget_jpy
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
  depends_on = [google_project_service.services]
}
