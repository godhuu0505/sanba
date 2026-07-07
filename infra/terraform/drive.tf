# 参考資料の Google ドライブ取り込み（ADR-0049）。
#
# Google Picker は「ユーザーの drive.file 同意（OAuth トークン）」に加えて、呼び出し元
# プロジェクトを示す "ブラウザ API キー" を必須とする。キーは JS バンドルへ焼かれ最終的に
# 公開されるため、本質的な防御は秘匿ではなく HTTP リファラ制限 + API ターゲット制限にある。
# ここではその制限付きキーを IaC で払い出し、値は Secret Manager を唯一の置き場にする
# （NEXT_PUBLIC だが GitHub Variables には散らさない）。web ビルド（deploy.yml）が WIF で
# 読み出して焼き込む。secrets.tf の「箱だけ管理・値は gcloud 投入」方針の例外
# （自動生成値は terraform が version まで作る＝session-signing-secret と同じ）に倣う。

locals {
  # Picker のリファラ制限に使う web オリジン群（CORS の算出・cloud_run.tf と揃える）。
  # 独自ドメイン有効時は web を配信するホスト、常に Cloud Run の run.app URL も許可に入れる。
  picker_web_origins = local.domain_enabled ? concat(
    [for h in local.web_hosts : "https://${h}"],
    [google_cloud_run_v2_service.web.uri],
  ) : [google_cloud_run_v2_service.web.uri]

  picker_allowed_referrers = [for o in local.picker_web_origins : "${o}/*"]
}

resource "google_apikeys_key" "picker" {
  name         = "sanba-picker-browser-key"
  display_name = "SANBA Google Picker (browser)"
  project      = var.project_id

  restrictions {
    browser_key_restrictions {
      allowed_referrers = local.picker_allowed_referrers
    }
    # 最小権限: このキーで叩ける API を Drive と Picker に限定する。
    api_targets {
      service = "drive.googleapis.com"
    }
    api_targets {
      service = "picker.googleapis.com"
    }
  }

  depends_on = [google_project_service.services]
}

# 値の唯一の置き場は Secret Manager（GitHub Variables には置かない）。terraform が生成する
# キーなので、session-signing-secret と同じく version まで terraform が作る（state には
# 暗号化 + アクセス制御された GCS backend が前提。かつ露出前提の低機微値）。
resource "google_secret_manager_secret" "picker_api_key" {
  secret_id = "sanba-next-public-google-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "picker_api_key" {
  secret      = google_secret_manager_secret.picker_api_key.id
  secret_data = google_apikeys_key.picker.key_string
}

# web ビルド（deploy.yml）の CI SA にだけ、この Secret の read を付与（最小権限）。
# deploy_sa 未指定なら付与しない＝ web ビルドは値を取得できず Drive 導線は未構成で無効になる
# （fail-safe: ローカルアップロードには影響しない）。
resource "google_secret_manager_secret_iam_member" "picker_api_key_ci" {
  count     = var.deploy_sa != "" ? 1 : 0
  secret_id = google_secret_manager_secret.picker_api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.deploy_sa}"
}
