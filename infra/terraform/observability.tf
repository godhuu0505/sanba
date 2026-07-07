locals {
  quality_metric_defs = [
    {
      key     = "overall"
      display = "総合スコア (overall)"
      pattern = "overall=([0-9.]+)"
    },
    {
      key     = "nfr_coverage"
      display = "非機能カバレッジ (nfr_coverage)"
      pattern = "'nfr_coverage': ([0-9.]+)"
    },
    {
      key     = "question_specificity"
      display = "問いの具体性 (question_specificity)"
      pattern = "'question_specificity': ([0-9.]+)"
    },
    {
      key     = "contradiction_handling"
      display = "矛盾・抜けの検知 (contradiction_handling)"
      pattern = "'contradiction_handling': ([0-9.]+)"
    },
  ]
  quality_metric_map = { for m in local.quality_metric_defs : m.key => m }

  session_scored_filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"sanba-agent\" AND textPayload:\"session_scored\""

  tf_deployer_sa = var.terraform_deployer_sa != "" ? var.terraform_deployer_sa : "tf-deployer@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "tf_deployer_observability" {
  for_each = toset([
    "roles/logging.configWriter",
    "roles/monitoring.dashboardEditor",
  ])
  project    = var.project_id
  role       = each.value
  member     = "serviceAccount:${local.tf_deployer_sa}"
  depends_on = [google_project_service.services]
}

resource "time_sleep" "observability_iam_propagation" {
  depends_on      = [google_project_iam_member.tf_deployer_observability]
  create_duration = "60s"
}

resource "google_logging_metric" "session_quality" {
  for_each = local.quality_metric_map

  name   = "sanba/session_quality_${each.key}"
  filter = local.session_scored_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "1"
    display_name = each.value.display
  }

  value_extractor = "REGEXP_EXTRACT(textPayload, \"${each.value.pattern}\")"

  bucket_options {
    linear_buckets {
      num_finite_buckets = 10
      width              = 0.1
      offset             = 0
    }
  }
}

resource "google_logging_metric" "sessions_scored_count" {
  name   = "sanba/sessions_scored_count"
  filter = local.session_scored_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "採点済みセッション数"
  }
}

resource "google_monitoring_dashboard" "sanba_quality" {
  depends_on = [time_sleep.observability_iam_propagation]

  dashboard_json = jsonencode({
    displayName = "SANBA — インタビュー品質 (LLMOps)"
    mosaicLayout = {
      columns = 12
      tiles = concat(
        [
          for i, m in local.quality_metric_defs : {
            xPos   = (i % 2) * 6
            yPos   = floor(i / 2) * 4
            width  = 6
            height = 4
            widget = {
              title = m.display
              xyChart = {
                dataSets = [{
                  plotType = "LINE"
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.session_quality[m.key].name}\" resource.type=\"cloud_run_revision\""
                      aggregation = {
                        alignmentPeriod    = "3600s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_MEAN"
                      }
                    }
                  }
                }]
                yAxis = {
                  label = "score (0.0-1.0)"
                  scale = "LINEAR"
                }
              }
            }
          }
        ],
        [
          {
            xPos   = 0
            yPos   = 8
            width  = 12
            height = 3
            widget = {
              title = "採点済みセッション数（1時間あたり）"
              scorecard = {
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.sessions_scored_count.name}\" resource.type=\"cloud_run_revision\""
                    aggregation = {
                      alignmentPeriod    = "3600s"
                      perSeriesAligner   = "ALIGN_DELTA"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
                sparkChartView = {
                  sparkChartType = "SPARK_LINE"
                }
              }
            }
          }
        ],
      )
    }
  })
}
