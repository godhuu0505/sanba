output "facade_url" {
  description = "Cloud Run URL of the A2A facade (HOLMESGPT_AGENT_BASE_URL for developers)"
  value       = google_cloud_run_v2_service.a2a_facade.uri
}

output "holmes_service_account" {
  description = "Runtime service account of the facade + sidecar"
  value       = google_service_account.holmes_facade.email
}

output "image_base" {
  description = "Artifact Registry base path for the facade and sidecar images"
  value       = local.image_base
}
