# インタビュー品質（LLMOps）の可視化 — ログベースメトリクス + Cloud Monitoring ダッシュボード。
#
# 設計 (ADR-0051 / #376):
#   - agent はセッション終了時に LLM-as-judge の採点を `session_scored` 構造化ログへ出す
#     (evaluation.score_session)。ここではそのログから値を抽出する **ログベースメトリクス**を作り、
#     Cloud Monitoring ダッシュボードで総合スコア/観点別スコア/採点件数を可視化する。
#   - 追加コード不要（既存ログを基点にする）。Langfuse の score sink を置き換える Google ネイティブ経路。
#
# 結合の前提 (why):
#   value_extractor の正規表現は `session_scored` のログ本文フォーマットに結合している
#   （`overall=0.0 scores={'nfr_coverage': 0.0, ...}`）。evaluation.py のログ整形を変えるときは
#   ここの正規表現も合わせて更新する（テキストログの表記に依存するため、構造化 JSON ログへ
#   移行できれば jsonPayload 抽出に切り替えるのが望ましい）。

locals {
  # 観点別スコア。key はメトリクス名の接尾辞、pattern は session_scored ログからの抽出正規表現。
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

  # 採点ログの母集合。agent の session_scored のみ（他サービス/他ログを混ぜない）。
  session_scored_filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"sanba-agent\" AND textPayload:\"session_scored\""
}

# 観点別スコアの分布メトリクス（0.0〜1.0 を 0.1 刻みで分布化）。
resource "google_logging_metric" "session_quality" {
  for_each = local.quality_metric_map

  name   = "sanba/session_quality_${each.key}"
  filter = local.session_scored_filter

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

# 採点済みセッション数（母集団の把握用カウンタ）。
resource "google_logging_metric" "sessions_scored_count" {
  name   = "sanba/sessions_scored_count"
  filter = local.session_scored_filter

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "採点済みセッション数"
  }
}

# 品質ダッシュボード。観点別スコアの平均推移 + 採点件数。
# NOTE: dashboard_json の内部構造は terraform のスキーマ検証対象外（不透明文字列）。
#       初回 apply 後に Cloud Monitoring 上で表示を確認すること。
resource "google_monitoring_dashboard" "sanba_quality" {
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
              title = "採点済みセッション数（合計）"
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
