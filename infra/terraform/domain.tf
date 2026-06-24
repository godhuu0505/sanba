# Custom domain via Global External Application Load Balancer.
#
# OSS なのでドメインはハードコードしない。`var.domain` (apex) と任意の `var.web_subdomain`
# でデプロイ側が各自設定する。以下の例はメンテナ環境 (domain="sanba.net", web_subdomain="youken")。
#
# 構成 (domain != "" のときだけ作成):
#   A) web_subdomain = "" (既定: apex 配信)
#        ├─ <domain> / www.<domain> → web (Serverless NEG → Cloud Run sanba-web)
#        └─ api.<domain>            → api (Serverless NEG → Cloud Run sanba-api)
#   B) web_subdomain = "youken" (例: サブドメイン配信)
#        ├─ youken.sanba.net        → web
#        ├─ api.youken.sanba.net    → api
#        └─ sanba.net / www.sanba.net → youken.sanba.net へ 301 リダイレクト
#   どちらも HTTP(80) は 301 で HTTPS(443) へリダイレクト。
#
# なぜ LB か (ドメインマッピングでなく):
#   - 安定した Anycast IP・Cloud Armor(WAF)/Cloud CDN への拡張余地 = production-ready。
#   - host ベースで web/api/redirect を 1 つの証明書・1 IP に集約できる。
#
# ドメイン未取得からの流れ:
#   1) terraform apply で Cloud DNS ゾーン + LB IP を作る。
#   2) 出力 `dns_name_servers` をレジストラの NS に設定 (取得後)。
#   3) Google 管理証明書は A レコードが LB IP を指してから自動発行 (数分〜最大数十分)。

locals {
  domain_enabled = var.domain != ""
  dns_enabled    = local.domain_enabled && var.manage_dns

  has_web_subdomain = var.web_subdomain != ""

  # web を配信する主ホスト。subdomain モードでは <sub>.<domain>、apex モードでは <domain>。
  web_host = local.has_web_subdomain ? "${var.web_subdomain}.${var.domain}" : var.domain
  # api は web_host の下に置く (apex モードでは api.<domain>、subdomain モードでは api.<sub>.<domain>)。
  api_host = local.domain_enabled ? "api.${local.web_host}" : ""

  # LB で web を直接配信するホスト群。apex モードは apex+www、subdomain モードは <sub>.<domain> のみ。
  web_hosts = local.domain_enabled ? (local.has_web_subdomain ? [local.web_host] : [var.domain, "www.${var.domain}"]) : []
  # web_host へ 301 リダイレクトするホスト群 (subdomain モードでの apex+www のみ)。
  redirect_hosts = local.has_web_subdomain ? [var.domain, "www.${var.domain}"] : []

  # 証明書・DNS は LB で終端する全ホスト (web + redirect + api) をカバーする。
  cert_domains = local.domain_enabled ? distinct(concat(local.web_hosts, local.redirect_hosts, [local.api_host])) : []
  lb_hostnames = local.domain_enabled ? distinct(concat(local.web_hosts, local.redirect_hosts, [local.api_host])) : []
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
  # LB のリクエストログを Cloud Logging に流す (host ルーティング/4xx/5xx を追えるように)。
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

# ---- URL map: host ベースで web / api を振り分け ---------------------------
# default_service も web だが、apex/www を明示 host_rule にして意図を読めるようにする
# (将来サブドメインを足したとき web に無言で吸われるのを防ぐ)。
resource "google_compute_url_map" "https" {
  count           = local.domain_enabled ? 1 : 0
  name            = "sanba-https"
  default_service = google_compute_backend_service.web[0].id

  host_rule {
    hosts        = local.web_hosts # web_host (+ apex モードでは www) → web
    path_matcher = "web"
  }
  path_matcher {
    name            = "web"
    default_service = google_compute_backend_service.web[0].id
  }

  host_rule {
    hosts        = [local.api_host] # api.<web_host> → api
    path_matcher = "api"
  }
  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api[0].id
  }

  # apex / www → web_host への 301 (subdomain モードのみ)。HTTPS 上の host リダイレクト。
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

# ---- Google 管理 SSL 証明書 (apex + www + api) -----------------------------
resource "google_compute_managed_ssl_certificate" "default" {
  count = local.domain_enabled ? 1 : 0
  name  = "sanba-cert"
  managed { domains = local.cert_domains }
  # 他リソースを参照しないため、Compute API 有効化を明示的に待つ。
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

# ---- HTTP(80) → HTTPS(443) リダイレクト ------------------------------------
resource "google_compute_url_map" "redirect" {
  count = local.domain_enabled ? 1 : 0
  name  = "sanba-http-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
  # backend を参照しないため、Compute API 有効化を明示的に待つ。
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

# ---- Cloud DNS (manage_dns = true のときのみ) -------------------------------
resource "google_dns_managed_zone" "primary" {
  count       = local.dns_enabled ? 1 : 0
  name        = var.dns_managed_zone_name
  dns_name    = "${var.domain}."
  description = "SANBA production zone"

  # DNSSEC。Cloud Domains で登録すると既定で DNSSEC が on になり DS レコードも登録される。
  # その既存ゾーンを import した場合、ここで state を明示しないと Terraform が DNSSEC を無効化
  # しようとし (a) GCP が "dnssecConfig is required" で 400、(b) 仮に通れば DS と不整合で名前解決が壊れる。
  # dns_dnssec_state が未設定 (null / 空文字) の場合はブロックを送らず元のフェイルセーフ動作を維持する。
  # Cloud Domains 由来のゾーンを import したら dns_dnssec_state="on" を明示すること。
  dynamic "dnssec_config" {
    for_each = (var.dns_dnssec_state != null && var.dns_dnssec_state != "") ? [var.dns_dnssec_state] : []
    content {
      state = dnssec_config.value
    }
  }

  depends_on = [google_project_service.lb]
}

# LB で終端する全ホスト (web / www / api / apex redirect) を 1 つの A レコード集合として作る。
# 構成 (apex モード / subdomain モード) に応じて lb_hostnames が変わり、レコードも自動追従する。
resource "google_dns_record_set" "lb" {
  for_each     = local.dns_enabled ? toset(local.lb_hostnames) : toset([])
  name         = "${each.value}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.primary[0].name
  rrdatas      = [google_compute_global_address.lb[0].address]
}
