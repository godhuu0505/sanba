output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "web_url" {
  value = google_cloud_run_v2_service.web.uri
}

output "agent_service" {
  value = google_cloud_run_v2_service.agent.name
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "image_repository" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/sanba"
  description = "Artifact Registry path. CI pushes images here as <repo>/<app>:<sha>."
}

output "managed_secrets" {
  value       = tolist(local.secret_keys)
  description = "Secret Manager secrets created for Cloud Run (values are not exposed)."
}
