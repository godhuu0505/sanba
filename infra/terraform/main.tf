terraform {
  required_version = ">= 1.8"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  # backend "gcs" { bucket = "kikitori-tfstate" prefix = "terraform/state" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---- Required APIs ----
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudtrace.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---- Artifact Registry for container images ----
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "kikitori"
  format        = "DOCKER"
  depends_on    = [google_project_service.services]
}

# ---- Firestore (Native mode) ----
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.services]
}

# TTL policy: documents are deleted once their `expireAt` timestamp passes.
# The agent writes `expireAt` based on DATA_RETENTION_DAYS (issue #10).
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

# ---- Service account for Cloud Run workloads (least privilege) ----
resource "google_service_account" "runtime" {
  account_id   = "kikitori-runtime"
  display_name = "Kikitori Cloud Run runtime"
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
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---- Budget alert (cost guardrail) ----
resource "google_billing_budget" "monthly" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "kikitori-monthly"
  amount {
    specified_amount {
      currency_code = "JPY"
      units         = var.monthly_budget_jpy
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
}
