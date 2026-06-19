# Custom domain via Global External Application Load Balancer.
#
# 構成 (domain != "" のときだけ作成):
#   Internet
#     └─ Global 外部 HTTPS LB (Anycast IP, Google 管理 SSL 証明書)
#          ├─ sanba.com / www.sanba.com → web (Serverless NEG → Cloud Run sanba-web)
#          └─ api.sanba.com             → api (Serverless NEG → Cloud Run sanba-api)
#   HTTP(80) は 301 で HTTPS(443) へリダイレクト。
#
# なぜ LB か (ドメインマッピングでなく):
#   - 安定した Anycast IP・Cloud Armor(WAF)/Cloud CDN への拡張余地 = production-ready。
#   - host ベースで web/api を 1 つの証明書・1 IP に集約できる。
#
# ドメイン未取得からの流れ:
#   1) terraform apply で Cloud DNS ゾーン + LB IP を作る。
#   2) 出力 `dns_name_servers` をレジストラの NS に設定 (取得後)。
#   3) Google 管理証明書は A レコードが LB IP を指してから自動発行 (数分〜最大数十分)。

locals {
  domain_enabled = var.domain != ""
  dns_enabled    = local.domain_enabled && var.manage_dns

  web_hosts    = local.domain_enabled ? [var.domain, "www.${var.domain}"] : []
  api_host     = local.domain_enabled ? "api.${var.domain}" : ""
  cert_domains = local.domain_enabled ? concat(local.web_hosts, [local.api_host]) : []
}

# LB / DNS に必要な API。domain 無効時は有効化しない (compute 有効化は default network
# 生成などの副作用があるため、使うときだけ on にする)。
resource "google_project_service" "lb" {
  for_each           = local.domain_enabled ? toset(["compute.googleapis.com", "dns.googleapis.com"]) : toset([])
  service            = each.value
  disable_on_destroy = false
}

# ---- Anycast IP -------------------------------------------------------------
resource "google_compute_global_address" "lb" {
  count      = local.domain_enabled ? 1 : 0
  name       = "sanba-lb-ip"
  depends_on = [google_project_service.lb]
}

# ---- Serverless NEGs (Cloud Run backends) -----------------------------------
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

# ---- Backend services -------------------------------------------------------
# Serverless NEG はヘルスチェック不要。EXTERNAL_MANAGED = Global 外部 Application LB。
resource "google_compute_backend_service" "web" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-web-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  backend { group = google_compute_region_network_endpoint_group.web[0].id }
  depends_on = [google_project_service.lb]
}

resource "google_compute_backend_service" "api" {
  count                 = local.domain_enabled ? 1 : 0
  name                  = "sanba-api-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  backend { group = google_compute_region_network_endpoint_group.api[0].id }
  depends_on = [google_project_service.lb]
}

# ---- URL map: host ベースで web / api を振り分け ---------------------------
# default_service も web だが、apex/www を明示 host_rule にして意図を読めるようにする
# (将来サブドメインを足したとき web に無言で吸われるのを防ぐ)。
resource "google_compute_url_map" "https" {
  count           = local.domain_enabled ? 1 : 0
  name            = "sanba-https"
  default_service = google_compute_backend_service.web[0].id

  host_rule {
    hosts        = local.web_hosts # sanba.com / www.sanba.com → web
    path_matcher = "web"
  }
  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.web[0].id
  }

  host_rule {
    hosts        = [local.api_host] # api.sanba.com → api
    path_matcher = "api"
  }
  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api[0].id
  }
}

# ---- Google 管理 SSL 証明書 (apex + www + api) -----------------------------
resource "google_compute_managed_ssl_certificate" "default" {
  count = local.domain_enabled ? 1 : 0
  name  = "sanba-cert"
  managed { domains = local.cert_domains }
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

# ---- HTTP(80) → HTTPS(443) リダイレクト ------------------------------------
resource "google_compute_url_map" "redirect" {
  count = local.domain_enabled ? 1 : 0
  name  = "sanba-http-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
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

# ---- Cloud DNS (manage_dns = true のときのみ) -------------------------------
resource "google_dns_managed_zone" "primary" {
  count       = local.dns_enabled ? 1 : 0
  name        = var.dns_managed_zone_name
  dns_name    = "${var.domain}."
  description = "SANBA production zone"
  depends_on  = [google_project_service.lb]
}

resource "google_dns_record_set" "root" {
  count        = local.dns_enabled ? 1 : 0
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.primary[0].name
  rrdatas      = [google_compute_global_address.lb[0].address]
}

resource "google_dns_record_set" "www" {
  count        = local.dns_enabled ? 1 : 0
  name         = "www.${var.domain}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.primary[0].name
  rrdatas      = [google_compute_global_address.lb[0].address]
}

resource "google_dns_record_set" "api" {
  count        = local.dns_enabled ? 1 : 0
  name         = "api.${var.domain}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.primary[0].name
  rrdatas      = [google_compute_global_address.lb[0].address]
}
