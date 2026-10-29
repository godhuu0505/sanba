terraform {
  required_version = ">= 1.17.1, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
  backend "gcs" {}
}
provider "google" {
  project = "sanba-prd"
  region  = "asia-northeast1"
}
locals {
  apps = {
    wkwk = { project = "wkwk-20261027-godhuu", service = "wkwk" }
    mnmn = { project = "mnmn-512822", service = "mnmn" }
    mfmf = { project = "mfmf-499612", service = "mfmf-candidate" }
  }
}
resource "google_dns_managed_zone" "primary" {
  name        = "sanba-net"
  dns_name    = "sanba.net."
  description = "Personal application domains; replaces zone deleted 2026-08-08"
  dnssec_config { state = "on" }
  lifecycle { prevent_destroy = true }
}
resource "google_compute_global_address" "apps" {
  name = "sanba-apps-ip"
}
resource "google_compute_region_network_endpoint_group" "app" {
  for_each              = local.apps
  project               = each.value.project
  name                  = "${each.key}-domain-neg"
  region                = "asia-northeast1"
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = each.value.service }
}
resource "google_compute_backend_service" "app" {
  for_each              = local.apps
  project               = each.value.project
  name                  = "${each.key}-domain-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  backend { group = google_compute_region_network_endpoint_group.app[each.key].id }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
}
resource "google_compute_backend_service" "unmatched" {
  name                  = "sanba-unmatched-host"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
}
resource "google_compute_url_map" "https" {
  name            = "sanba-apps-https"
  default_service = google_compute_backend_service.unmatched.id
  dynamic "host_rule" {
    for_each = local.apps
    content {
      hosts        = ["${host_rule.key}.sanba.net"]
      path_matcher = host_rule.key
    }
  }
  dynamic "path_matcher" {
    for_each = local.apps
    content {
      name            = path_matcher.key
      default_service = google_compute_backend_service.app[path_matcher.key].id
    }
  }
}
resource "google_compute_managed_ssl_certificate" "apps" {
  name = "sanba-personal-apps-cert"
  managed { domains = [for name in keys(local.apps) : "${name}.sanba.net"] }
}
resource "google_compute_target_https_proxy" "apps" {
  name             = "sanba-apps-https-proxy"
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.apps.id]
}
resource "google_compute_global_forwarding_rule" "https" {
  name                  = "sanba-apps-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.apps.id
  port_range            = "443"
  ip_address            = google_compute_global_address.apps.address
}
resource "google_compute_url_map" "http" {
  name            = "sanba-apps-http"
  default_service = google_compute_backend_service.unmatched.id
  dynamic "host_rule" {
    for_each = local.apps
    content {
      hosts        = ["${host_rule.key}.sanba.net"]
      path_matcher = host_rule.key
    }
  }
  dynamic "path_matcher" {
    for_each = local.apps
    content {
      name = path_matcher.key
      default_url_redirect {
        https_redirect         = true
        redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
        strip_query            = false
      }
    }
  }
}
resource "google_compute_target_http_proxy" "apps" {
  name    = "sanba-apps-http-proxy"
  url_map = google_compute_url_map.http.id
}
resource "google_compute_global_forwarding_rule" "http" {
  name                  = "sanba-apps-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.apps.id
  port_range            = "80"
  ip_address            = google_compute_global_address.apps.address
}
resource "google_dns_record_set" "app" {
  for_each     = local.apps
  managed_zone = google_dns_managed_zone.primary.name
  name         = "${each.key}.sanba.net."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.apps.address]
}
output "ip" { value = google_compute_global_address.apps.address }
output "name_servers" { value = google_dns_managed_zone.primary.name_servers }
