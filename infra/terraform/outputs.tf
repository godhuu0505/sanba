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

output "materials_bucket" {
  value       = google_storage_bucket.materials.name
  description = "GCS bucket holding session materials (images/videos). Wired to the API as GCS_BUCKET."
}

output "video_tasks_queue" {
  value       = google_cloud_tasks_queue.video_analysis.id
  description = "Cloud Tasks queue for the async video analysis pipeline."
}

output "worker_service_account" {
  value       = google_service_account.worker.email
  description = "Least-privilege SA the video analysis worker runs as (and Cloud Tasks authenticates with)."
}

output "worker_url" {
  value       = join("", google_cloud_run_v2_service.worker[*].uri)
  description = "Worker Cloud Run URL (empty unless enable_video_analysis = true)."
}

output "image_repository" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/sanba"
  description = "Artifact Registry path. CI pushes images here as <repo>/<app>:<sha>."
}

output "managed_secrets" {
  value       = tolist(local.all_secret_ids)
  description = "Secret Manager に作成した箱 (値は terraform 管理外。gcloud で投入する)。"
}

output "picker_api_key_secret" {
  value       = google_secret_manager_secret.picker_api_key.secret_id
  description = "Secret Manager secret holding NEXT_PUBLIC_GOOGLE_API_KEY (browser Picker key). The web build reads it via WIF at build time."
}

output "lb_ip" {
  value       = local.domain_enabled ? google_compute_global_address.lb[0].address : ""
  description = "Anycast IP of the HTTPS load balancer. Point your A records here (apex/www/api)."
}

output "dns_name_servers" {
  value       = local.dns_enabled ? google_dns_managed_zone.primary[0].name_servers : []
  description = "Cloud DNS name servers. Set these at your registrar after buying the domain."
}

output "public_urls" {
  value = local.domain_enabled ? {
    web         = "https://${local.web_host}"
    api         = "https://${local.api_host}"
    web_aliases = join(", ", [for h in local.web_hosts : "https://${h}"])
    redirects   = join(", ", [for h in local.redirect_hosts : "https://${h}"])
  } : {}
  description = "Production URLs once DNS + managed certificate are active."
}

output "cert_domains" {
  value       = local.cert_domains
  description = "Domains covered by the Google-managed SSL certificate."
}
