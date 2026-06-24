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
  value       = tolist(local.all_secret_ids)
  description = "Secret Manager に作成した箱 (値は terraform 管理外。gcloud で投入する)。"
}

# ---- Custom domain / Load Balancer (domain 設定時のみ意味を持つ) -------------
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
    web = "https://${var.domain}"
    www = "https://www.${var.domain}"
    api = "https://api.${var.domain}"
  } : {}
  description = "Production URLs once DNS + managed certificate are active."
}

output "cert_domains" {
  value       = local.cert_domains
  description = "Domains covered by the Google-managed SSL certificate."
}
