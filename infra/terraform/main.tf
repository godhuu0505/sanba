terraform {
  required_version = ">= 1.8"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # リモート state (チーム/CI で共有・ロック)。bucket は環境差を避けるためコードに固定せず
  # init 時に渡す: terraform init -backend-config="bucket=<TF_STATE_BUCKET>" -backend-config="prefix=terraform/state"
  # ローカルで state を使わず検証だけしたいときは `terraform init -backend=false` でよい。
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
  # billingbudgets 等「quota project 必須」の API 用。ADC に quota_project_id があっても
  # provider はこれが無いと X-Goog-User-Project を送らず、リクエストが gcloud 既定 project
  # (764086051850) に落ちて 403 (SERVICE_DISABLED) になる。CI の SA 認証とも整合する。
  user_project_override = true
  billing_project       = var.project_id
}

# ---- Required APIs ----
# アプリ稼働用 API に加え、terraform 自身が使う基盤 API も明示的に管理して新規プロジェクトでも
# 再現可能にする (iam/cloudresourcemanager は SA/IAM リソースの前提)。state 用 GCS と WIF
# (iamcredentials/sts/storage) はブートストラップ依存だが、実態と揃えるため列挙する。
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudtrace.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    # --- terraform / CI 基盤 (実態に合わせて管理) ---
    "cloudresourcemanager.googleapis.com", # project IAM 操作 (runtime_roles の前提)
    "iam.googleapis.com",                  # service account 作成の前提
    "iamcredentials.googleapis.com",       # WIF / SA インパーソネーション
    "sts.googleapis.com",                  # WIF トークン交換
    "storage.googleapis.com",              # GCS リモート state
    "billingbudgets.googleapis.com",       # 予算アラート (google_billing_budget)
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---- Artifact Registry for container images ----
# Cleanup policy で直近 N 個だけ残し、古いイメージのストレージ課金を抑える (コスト最適化)。
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "sanba"
  format        = "DOCKER"
  depends_on    = [google_project_service.services]

  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.image_keep_count
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s" # 30 日より古いものは削除候補 (keep-recent が優先)
    }
  }
}

# ---- Firestore (Native mode) ----
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.services]
}

# TTL policy: documents are deleted once their `expireAt` timestamp passes.
# The agent writes `expireAt` based on DATA_RETENTION_DAYS (issue #10).
resource "google_firestore_field" "utterances_ttl" {
  database   = google_firestore_database.default.name
  collection = "utterances"
  field      = "expireAt"
  ttl_config {}
}

resource "google_firestore_field" "requirements_ttl" {
  database   = google_firestore_database.default.name
  collection = "requirements"
  field      = "expireAt"
  ttl_config {}
}

# 現在質問ポインタ（sessions/{id}/questions/current, #212 / ADR-0020 §5-8）の TTL。
# 未回答のまま離脱した質問（prompt/options に PII を含みうる）が、発話・draft 要件の 30 日
# TTL を迂回して残り続けないようにする。tombstone（回答済み）も同じ expireAt で消える。
resource "google_firestore_field" "questions_ttl" {
  database   = google_firestore_database.default.name
  collection = "questions"
  field      = "expireAt"
  ttl_config {}
}

# ---- Service account for Cloud Run workloads (least privilege) ----
resource "google_service_account" "runtime" {
  account_id   = "sanba-runtime"
  display_name = "SANBA Cloud Run runtime"
  depends_on   = [google_project_service.services] # iam API 有効化を待つ
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/datastore.user",
    "roles/aiplatform.user",
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/secretmanager.secretAccessor",
  ])
  project    = var.project_id
  role       = each.value
  member     = "serviceAccount:${google_service_account.runtime.email}"
  depends_on = [google_project_service.services] # cloudresourcemanager API 有効化を待つ
}

# ---- Budget alert (cost guardrail) ----
resource "google_billing_budget" "monthly" {
  count           = var.billing_account == "" ? 0 : 1
  billing_account = var.billing_account
  display_name    = "sanba-monthly"
  amount {
    specified_amount {
      currency_code = "JPY"
      units         = var.monthly_budget_jpy
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
  depends_on = [google_project_service.services] # billingbudgets API 有効化を待つ
}
