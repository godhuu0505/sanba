terraform {
  required_version = ">= 1.8"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
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
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "iam.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "agents"
  format        = "DOCKER"
  depends_on    = [google_project_service.services]
}

resource "google_service_account" "holmes_facade" {
  account_id   = "holmes-facade"
  display_name = "A2A facade + HolmesGPT sidecar runtime (ADR-0069)"
  depends_on   = [google_project_service.services]
}

resource "google_project_iam_member" "holmes_vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.holmes_facade.email}"
}

resource "google_secret_manager_secret" "elasticsearch_api_key" {
  secret_id = "holmes-elasticsearch-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_iam_member" "holmes_es_key_accessor" {
  secret_id = google_secret_manager_secret.elasticsearch_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.holmes_facade.email}"
}

resource "google_project_iam_member" "holmes_production_readonly" {
  for_each = toset([
    "roles/logging.viewer",
    "roles/monitoring.viewer",
    "roles/cloudtrace.user",
    "roles/datastore.viewer",
  ])
  project = var.production_project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.holmes_facade.email}"
}
