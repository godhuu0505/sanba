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

  agent_log_prefix               = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"sanba-agent\""
  grounding_fallback_filter      = "${local.agent_log_prefix} AND textPayload:\"elasticsearch_unavailable_using_memory\""
  background_task_failure_filter = "${local.agent_log_prefix} AND textPayload:\"_task_failed\""

  tf_deployer_sa = var.terraform_deployer_sa != "" ? var.terraform_deployer_sa : "tf-deployer@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "tf_deployer_observability" {
  for_each = toset([
    "roles/logging.configWriter",
    "roles/monitoring.dashboardEditor",
    "roles/monitoring.alertPolicyEditor",
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

resource "google_logging_metric" "grounding_memory_fallback" {
  name   = "sanba/grounding_memory_fallback"
  filter = local.grounding_fallback_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "grounding が in-memory へ縮退した回数"
  }
}

resource "google_logging_metric" "background_task_failures" {
  name   = "sanba/background_task_failures"
  filter = local.background_task_failure_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "背景タスク失敗数"
    labels {
      key         = "task"
      value_type  = "STRING"
      description = "失敗した背景タスク種別（publish / persist / prefetch / web_event 等）"
    }
  }

  label_extractors = {
    task = "REGEXP_EXTRACT(textPayload, \"([a-z_]+)_task_failed\")"
  }
}

resource "google_monitoring_alert_policy" "grounding_memory_fallback" {
  display_name = "SANBA — grounding が in-memory へ縮退"
  combiner     = "OR"

  depends_on = [time_sleep.observability_iam_propagation]

  documentation {
    content   = "本番 agent が Elasticsearch へ接続できず in-memory grounding へフォールバックした。永続ベクトル検索/KB が効かないため要件の裏付け精度が落ちる。ELASTICSEARCH_URL の疎通・API キー・クラスタ稼働を確認する（#376）。"
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "grounding_memory_fallback > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.grounding_memory_fallback.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.alert_notification_channels
}

resource "google_monitoring_alert_policy" "background_task_failures" {
  display_name = "SANBA — 背景タスク失敗が継続"
  combiner     = "OR"

  depends_on = [time_sleep.observability_iam_propagation]

  documentation {
    content   = "背景タスク（publish / persist / prefetch / web_event）の失敗が継続している。イベント配信・永続化・先読みの取りこぼしにつながるため、Cloud Trace とログで原因を切り分ける（#376）。"
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "background_task_failures > 5 / 5min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.background_task_failures.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.alert_notification_channels
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
        [
          {
            xPos   = 0
            yPos   = 11
            width  = 6
            height = 4
            widget = {
              title = "grounding in-memory 縮退（1時間あたり）"
              xyChart = {
                dataSets = [{
                  plotType = "LINE"
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.grounding_memory_fallback.name}\" resource.type=\"cloud_run_revision\""
                      aggregation = {
                        alignmentPeriod    = "3600s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_SUM"
                      }
                    }
                  }
                }]
                yAxis = {
                  label = "count"
                  scale = "LINEAR"
                }
              }
            }
          },
          {
            xPos   = 6
            yPos   = 11
            width  = 6
            height = 4
            widget = {
              title = "背景タスク失敗（種別ごと・1時間あたり）"
              xyChart = {
                dataSets = [{
                  plotType = "LINE"
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.background_task_failures.name}\" resource.type=\"cloud_run_revision\""
                      aggregation = {
                        alignmentPeriod    = "3600s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_SUM"
                        groupByFields      = ["metric.label.task"]
                      }
                    }
                  }
                }]
                yAxis = {
                  label = "failures"
                  scale = "LINEAR"
                }
              }
            }
          }
        ],
      )
    }
  })
}
