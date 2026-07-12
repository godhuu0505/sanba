locals {
  image_base = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

resource "google_cloud_run_v2_service" "a2a_facade" {
  name     = "sanba-a2a-facade"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.holmes_facade.email
    timeout         = "600s"

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      name       = "facade"
      image      = "${local.image_base}/a2a-facade:${var.image_tag}"
      depends_on = ["holmes"]

      ports {
        container_port = 8080
      }

      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }

      env {
        name  = "A2A_FACADE_BACKEND"
        value = "holmesgpt"
      }
      env {
        name  = "A2A_FACADE_AGENT_ID"
        value = var.agent_id
      }
      env {
        name  = "A2A_FACADE_HOLMES_URL"
        value = "http://127.0.0.1:8081"
      }
      env {
        name  = "A2A_FACADE_AGENT_INSTRUCTIONS"
        value = var.agent_instructions
      }
      env {
        name  = "A2A_FACADE_PUBLIC_URL"
        value = var.public_url
      }
    }

    containers {
      name  = "gcp-obs-mcp"
      image = "${local.image_base}/gcp-obs-mcp:${var.image_tag}"

      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }

      startup_probe {
        tcp_socket {
          port = 8002
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        failure_threshold     = 18
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.production_project_id
      }
    }

    containers {
      name  = "firestore-mcp"
      image = "${local.image_base}/firestore-mcp:${var.image_tag}"

      resources {
        limits = { cpu = "1", memory = "256Mi" }
      }

      startup_probe {
        tcp_socket {
          port = 8003
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        failure_threshold     = 18
      }
    }

    containers {
      name       = "holmes"
      image      = "${local.image_base}/holmes-sidecar:${var.image_tag}"
      depends_on = ["gcp-obs-mcp", "firestore-mcp"]

      resources {
        limits = { cpu = "1", memory = "2Gi" }
      }

      startup_probe {
        tcp_socket {
          port = 8081
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 30
      }

      env {
        name  = "HOLMES_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "HOLMES_PORT"
        value = "8081"
      }
      env {
        name  = "HOLMES_MODEL"
        value = var.holmes_model
      }
      env {
        name  = "VERTEXAI_PROJECT"
        value = var.project_id
      }
      env {
        name  = "VERTEXAI_LOCATION"
        value = var.region
      }
      env {
        name  = "ES_API_URL"
        value = var.elasticsearch_url
      }
      env {
        name  = "GCP_OBS_MCP_URL"
        value = "http://127.0.0.1:8002/mcp"
      }
      env {
        name  = "FIRESTORE_MCP_URL"
        value = "http://127.0.0.1:8003/mcp"
      }
      env {
        name = "ES_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.elasticsearch_api_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_secret_manager_secret_iam_member.holmes_es_key_accessor,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "developer_invoker" {
  for_each = toset(var.developer_members)
  name     = google_cloud_run_v2_service.a2a_facade.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.key
}
