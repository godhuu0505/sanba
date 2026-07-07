"""OpenTelemetry (Cloud Trace) wiring.

観測できないものは運用できない (CLAUDE.md)。エージェント起動時に一度だけ初期化する。
トレースは Cloud Trace 直送、品質スコアは構造化ログ → Cloud Monitoring（ADR-0051）。
"""

from __future__ import annotations

from typing import Any

import structlog

from .config import settings

log = structlog.get_logger(__name__)
_initialised = False


def get_tracer(name: str) -> Any:
    """名前付き OTel トレーサを返す（OTel 未導入・未初期化なら None）。

    SDK プロバイダ未設定時（otel_disabled）でも trace.get_tracer は no-op トレーサを返し、
    span 生成は非記録で安価。呼び出し側は `if tracer` で nullcontext にフォールバックする
    （events.py と同じ方式）。エンドポイント設定時にだけ実スパンがエクスポートされる。
    """
    try:
        from opentelemetry import trace

        return trace.get_tracer(name)
    except Exception:  # pragma: no cover
        return None


def select_exporter_kind() -> str:
    """どのスパンエクスポータを使うかを設定から決める（純関数・ネットワーク不要 / ADR-0051）。

    優先順位:
      1. ``OTEL_EXPORTER_OTLP_ENDPOINT`` 明示時 → "otlp"（Collector サイドカー等へ）。
      2. 未指定でも Cloud Trace 直送が有効かつ Vertex 実行（＝GCP 上・ADC あり）→ "cloud_trace"。
      3. それ以外（ローカル/テスト）→ "disabled"。
    """
    if settings.otel_exporter_otlp_endpoint:
        return "otlp"
    if settings.otel_traces_to_cloud_trace and settings.google_genai_use_vertexai:
        return "cloud_trace"
    return "disabled"


def setup_observability() -> None:
    """Configure the OTel tracing exporter (Cloud Trace 直送 / OTLP / 無効)。Safe to call once."""
    global _initialised
    if _initialised:
        return
    _initialised = True

    kind = select_exporter_kind()
    if kind == "disabled":
        log.info("otel_disabled", reason="no exporter selected")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        if kind == "otlp":
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

            exporter: object = OTLPSpanExporter(
                endpoint=settings.otel_exporter_otlp_endpoint,
                insecure=settings.otel_exporter_insecure,
            )
        else:
            from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter

            exporter = CloudTraceSpanExporter(project_id=settings.google_cloud_project or None)

        resource = Resource.create({"service.name": settings.otel_service_name})
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(BatchSpanProcessor(exporter))  # type: ignore[arg-type]
        trace.set_tracer_provider(provider)
        log.info("otel_initialised", exporter=kind)
    except Exception as exc:  # pragma: no cover
        log.warning("otel_init_failed", exporter=kind, error=str(exc))
