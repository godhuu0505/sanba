# Cloud Run services for the API and the web client.
# The voice agent worker connects out to LiveKit; it can run on Cloud Run too
# (min_instances >= 1 to keep the worker registered).

locals {
  image_base = "${var.region}-docker.pkg.dev/${var.project_id}/sanba"
}

resource "google_cloud_run_v2_service" "api" {
  name     = "sanba-api"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }
    containers {
      image = "${local.image_base}/api:${var.image_tag}"
      ports { container_port = 8080 }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [google_artifact_registry_repository.images]
}

resource "google_cloud_run_v2_service" "agent" {
  name     = "sanba-agent"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    # Keep at least one warm worker registered with LiveKit.
    scaling {
      min_instance_count = 1
      max_instance_count = 20
    }
    containers {
      image = "${local.image_base}/agent:${var.image_tag}"
      resources {
        limits = { cpu = "2", memory = "1Gi" }
      }
    }
  }
  depends_on = [google_artifact_registry_repository.images]
}

resource "google_cloud_run_v2_service" "web" {
  name     = "sanba-web"
  location = var.region
  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }
    containers {
      image = "${local.image_base}/web:${var.image_tag}"
      ports { container_port = 3000 }
    }
  }
  depends_on = [google_artifact_registry_repository.images]
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
