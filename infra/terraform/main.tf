# Terraform for the Google Cloud footprint. Review and pin module/provider
# versions before `terraform apply`.
#
# Provisions:
#   - Required APIs (Run, Build, Artifact Registry, Vertex AI, Trace)
#   - An Artifact Registry repo for the container image
#   - A least-privilege runtime service account
#   - The Cloud Run service (the required Google Cloud execution product)
#
# Elasticsearch is provisioned separately (Elastic Cloud); pass its URL/key as
# Cloud Run env vars / Secret Manager — see infra/README.md.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudtrace.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = "interviewer"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  account_id   = "interviewer-runtime"
  display_name = "Voice Requirements Interviewer (Cloud Run runtime)"
}

# Vertex AI access for the agents + Cloud Trace for observability.
resource "google_project_iam_member" "vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "true"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# Public access for the demo (lock down for anything beyond the hackathon).
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
