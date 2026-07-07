locals {
  domain_enabled = var.domain != ""
  dns_enabled    = local.domain_enabled && var.manage_dns

  has_web_subdomain = var.web_subdomain != ""

  web_host = local.has_web_subdomain ? "${var.web_subdomain}.${var.domain}" : var.domain
  api_host = local.domain_enabled ? "api.${local.web_host}" : ""

  web_hosts = local.domain_enabled ? (local.has_web_subdomain ? [local.web_host] : [var.domain, "www.${var.domain}"]) : []
  redirect_hosts = local.has_web_subdomain ? [var.domain, "www.${var.domain}"] : []

  cert_domains = local.domain_enabled ? distinct(concat(local.web_hosts, local.redirect_hosts, [local.api_host])) : []
  lb_hostnames = local.domain_enabled ? distinct(concat(local.web_hosts, local.redirect_hosts, [local.api_host])) : []
}

resource "google_project_service" "lb" {
  for_each           = local.domain_enabled ? toset(["compute.googleapis.com", "dns.googleapis.com"]) : toset([])
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_global_address" "lb" {
  count      = local.domain_enabled ? 1 : 0
  name       = "sanba-lb-ip"
  depends_on = [google_project_service.lb]
}

resource "google_compute_region_network_endpoint_group" "web" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-web-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.web.name }
  depends_on = [google_project_service.lb]
}

resource "google_compute_region_network_endpoint_group" "api" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.api.name }
  depends_on = [google_project_service.lb]
}

resource "google_compute_backend_service" "web" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-web-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  backend { group = google_compute_region_network_endpoint_group.web[0].id }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
  depends_on = [google_project_service.lb]
}

resource "google_compute_backend_service" "api" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-api-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  backend { group = google_compute_region_network_endpoint_group.api[0].id }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
  depends_on = [google_project_service.lb]
}

resource "google_compute_url_map" "https" {
  count           = local.domain_enabled ? 1 : 0
  name            = "sanba-https"
  default_service = google_compute_backend_service.web[0].id

  host_rule {
    hosts        = local.web_hosts
    path_matcher = "web"
  }
  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.web[0].id
  }

  host_rule {
    hosts        = [local.api_host]
    path_matcher = "api"
  }
  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api[0].id
  }

  dynamic "host_rule" {
    for_each = length(local.redirect_hosts) > 0 ? [1] : []
    content {
      hosts        = local.redirect_hosts
      path_matcher = "apexredirect"
    }
  }
  dynamic "path_matcher" {
    for_each = length(local.redirect_hosts) > 0 ? [1] : []
    content {
      name = "apexredirect"
      default_url_redirect {
        host_redirect          = local.web_host
        https_redirect         = true
        redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
        strip_query            = false
      }
    }
  }
}

resource "google_compute_managed_ssl_certificate" "default" {
  count = local.domain_enabled ? 1 : 0
  name  = "sanba-cert"
  managed { domains = local.cert_domains }
  depends_on = [google_project_service.lb]
}

resource "google_compute_target_https_proxy" "default" {
  count            = local.domain_enabled ? 1 : 0
  name             = "sanba-https-proxy"
  url_map          = google_compute_url_map.https[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.default[0].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-https-fr"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.default[0].id
  port_range            = "443"
  ip_address            = google_compute_global_address.lb[0].address
}

resource "google_compute_url_map" "redirect" {
  count = local.domain_enabled ? 1 : 0
  name  = "sanba-http-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
  depends_on = [google_project_service.lb]
}

resource "google_compute_target_http_proxy" "redirect" {
  count   = local.domain_enabled ? 1 : 0
  name    = "sanba-http-proxy"
  url_map = google_compute_url_map.redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-http-fr"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.redirect[0].id
  port_range            = "80"
  ip_address            = google_compute_global_address.lb[0].address
}

resource "google_dns_managed_zone" "primary" {
  count       = local.dns_enabled ? 1 : 0
  name        = var.dns_managed_zone_name
  dns_name    = "${var.domain}."
  description = "SANBA production zone"

  dynamic "dnssec_config" {
    for_each = (var.dns_dnssec_state != null && var.dns_dnssec_state != "") ? [var.dns_dnssec_state] : []
    content {
      state = dnssec_config.value
    }
  }

  depends_on = [google_project_service.lb]
}

resource "google_dns_record_set" "lb" {
  for_each     = local.dns_enabled ? toset(local.lb_hostnames) : toset([])
  name         = "${each.value}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.primary[0].name
  rrdatas      = [google_compute_global_address.lb[0].address]
}
