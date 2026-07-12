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

  session_cost_summary_filter   = "${local.agent_log_prefix} AND textPayload:\"session_cost_summary\""
  analytics_emit_failure_filter = "resource.type=\"cloud_run_revision\" AND textPayload:\"analytics_emit_failed\""
  separate_stt_fallback_filter  = "${local.agent_log_prefix} AND textPayload:\"separate_stt_unavailable\""

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

resource "google_logging_metric" "session_cost_usd" {
  name   = "sanba/session_cost_usd"
  filter = local.session_cost_summary_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = "1"
    display_name = "セッションあたり推定 AI コスト (USD)"
  }

  value_extractor = "REGEXP_EXTRACT(textPayload, \"total_usd=([0-9.]+)\")"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 16
      growth_factor      = 2
      scale              = 0.005
    }
  }
}

resource "google_logging_metric" "session_cost_count" {
  name   = "sanba/session_cost_count"
  filter = local.session_cost_summary_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "コスト集計済みセッション数"
  }
}

resource "google_logging_metric" "analytics_emit_failures" {
  name   = "sanba/analytics_emit_failures"
  filter = local.analytics_emit_failure_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "分析イベント排出失敗数 (ADR-0061)"
    labels {
      key         = "service"
      value_type  = "STRING"
      description = "排出に失敗したサービス (sanba-agent / sanba-api / sanba-worker)"
    }
  }

  label_extractors = {
    service = "EXTRACT(resource.labels.service_name)"
  }
}

resource "google_logging_metric" "separate_stt_fallback" {
  name   = "sanba/separate_stt_fallback"
  filter = local.separate_stt_fallback_filter

  depends_on = [time_sleep.observability_iam_propagation]

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "分離 STT 構築失敗で native 転写へ縮退した回数 (ADR-0066 S1)"
  }
}

resource "time_sleep" "metric_availability" {
  depends_on = [
    google_logging_metric.grounding_memory_fallback,
    google_logging_metric.background_task_failures,
    google_logging_metric.session_cost_usd,
    google_logging_metric.analytics_emit_failures,
    google_logging_metric.separate_stt_fallback,
  ]
  create_duration = "180s"
}

resource "google_monitoring_alert_policy" "grounding_memory_fallback" {
  display_name = "SANBA — grounding が in-memory へ縮退"
  combiner     = "OR"

  depends_on = [time_sleep.metric_availability]

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

resource "google_monitoring_alert_policy" "separate_stt_fallback" {
  display_name = "SANBA — 分離 STT が native 転写へ縮退"
  combiner     = "OR"

  depends_on = [time_sleep.metric_availability]

  documentation {
    content   = "SEPARATE_STT_ENABLED=true なのに Chirp（分離 STT）の構築に失敗し、native 転写へフォールバックした（PR #518 の fail-soft）。会話は継続するが transcript 品質が S1 導入前に戻る。STT_MODEL / STT_LOCATION の対応リージョン・Speech-to-Text v2 API の有効化・runtime SA の roles/speech.client を確認する（#516 / ADR-0066 S1）。"
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "separate_stt_fallback > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.separate_stt_fallback.name}\" AND resource.type=\"cloud_run_revision\""
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

  depends_on = [time_sleep.metric_availability]

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

resource "google_monitoring_alert_policy" "session_cost_anomaly" {
  display_name = "SANBA — セッション AI コストがしきい値超過 (USD)"
  combiner     = "OR"

  depends_on = [time_sleep.metric_availability]

  documentation {
    content   = "1 会話セッションの推定 AI コスト (session_cost_summary の total_usd) がしきい値を超えた。長時間セッション・文脈再処理の肥大・単価改定・暴走リトライの可能性がある。Kibana の sanba-analytics ダッシュボードでセッション別内訳（component / model）を確認し、必要なら context window compression 設定と単価テーブル (sanba_shared.analytics.PRICING) を見直す（ADR-0061）。"
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "session_cost_usd p99 > threshold"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.session_cost_usd.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.session_cost_alert_usd
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_99"
      }
      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.alert_notification_channels
}

resource "google_monitoring_alert_policy" "analytics_emit_failures" {
  display_name = "SANBA — 分析イベント排出失敗が継続"
  combiner     = "OR"

  depends_on = [time_sleep.metric_availability]

  documentation {
    content   = "ai_usage / session_summary イベントの排出（構造化ログ + Elasticsearch index）が失敗し続けている。コスト・KPI 分析にデータ欠落が生じる（会話本体は fail-soft で継続する）。ELASTICSEARCH_URL の疎通・API キー権限・sanba-analytics テンプレートの状態を確認する（ADR-0061）。"
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "analytics_emit_failures > 10 / 5min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.analytics_emit_failures.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
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
            yPos   = 15
            width  = 6
            height = 4
            widget = {
              title = "セッションあたり推定 AI コスト USD（中央値・1時間）"
              scorecard = {
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.session_cost_usd.name}\" resource.type=\"cloud_run_revision\""
                    aggregation = {
                      alignmentPeriod    = "3600s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_50"
                      crossSeriesReducer = "REDUCE_MEAN"
                    }
                  }
                }
                sparkChartView = {
                  sparkChartType = "SPARK_LINE"
                }
              }
            }
          },
          {
            xPos   = 6
            yPos   = 15
            width  = 6
            height = 4
            widget = {
              title = "セッションコスト p99 (USD) / 分析イベント排出失敗"
              xyChart = {
                dataSets = [
                  {
                    plotType = "LINE"
                    timeSeriesQuery = {
                      timeSeriesFilter = {
                        filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.session_cost_usd.name}\" resource.type=\"cloud_run_revision\""
                        aggregation = {
                          alignmentPeriod    = "3600s"
                          perSeriesAligner   = "ALIGN_PERCENTILE_99"
                          crossSeriesReducer = "REDUCE_MEAN"
                        }
                      }
                    }
                  },
                  {
                    plotType = "LINE"
                    timeSeriesQuery = {
                      timeSeriesFilter = {
                        filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.analytics_emit_failures.name}\" resource.type=\"cloud_run_revision\""
                        aggregation = {
                          alignmentPeriod    = "3600s"
                          perSeriesAligner   = "ALIGN_DELTA"
                          crossSeriesReducer = "REDUCE_SUM"
                        }
                      }
                    }
                  },
                ]
                yAxis = {
                  label = "usd / failures"
                  scale = "LINEAR"
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
