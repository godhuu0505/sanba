"""OpenTelemetry wiring for the worker (traces + defensive no-op metrics).

新しい処理には観測性を通す（CLAUDE.md 原則3）。トレースは agent/api と同じ優先順位で
Cloud Trace 直送 / OTLP / 無効を選ぶ（ADR-0051）。動画解析の結末は
`sanba_video_analysis_total{result}` に集約する。エクスポータ未設定でも落ちない。
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI

from .config import settings

log = structlog.get_logger(__name__)
_initialised = False

_analysis_total: Any = None
_analysis_duration: Any = None

try:  # pragma: no cover
    from opentelemetry import metrics

    _meter = metrics.get_meter("sanba.worker")
    _analysis_total = _meter.create_counter(
        "sanba_video_analysis_total",
        description="Video analysis outcomes by result (done/failed/skipped/error).",
    )
    _analysis_duration = _meter.create_histogram(
        "sanba_video_analysis_seconds",
        unit="s",
        description="Wall-clock seconds spent analysing a video.",
    )
except Exception:  # pragma: no cover
    pass


def record_analysis(result: str, *, seconds: float | None = None) -> None:
    """解析結末を記録する（result=done/failed/skipped/error）。"""
    if _analysis_total is not None:  # pragma: no cover
        _analysis_total.add(1, {"result": result})
        if seconds is not None and _analysis_duration is not None:
            _analysis_duration.record(seconds, {"result": result})
    log.info("video_analysis_recorded", result=result, seconds=seconds)


def get_tracer(name: str) -> Any:
    """名前付き OTel トレーサを返す（未初期化なら no-op トレーサ / agent・api と同方式）。"""
    try:
        from opentelemetry import trace

        return trace.get_tracer(name)
    except Exception:  # pragma: no cover
        return None


def select_exporter_kind() -> str:
    """どのスパンエクスポータを使うかを設定から決める（純関数・ネットワーク不要 / ADR-0051）。

    agent/api と同じ優先順位:
      1. ``OTEL_EXPORTER_OTLP_ENDPOINT`` 明示時 → "otlp"（Collector サイドカー等へ）。
      2. 未指定でも Cloud Trace 直送が有効かつ Vertex 実行（＝GCP 上・ADC あり）→ "cloud_trace"。
      3. それ以外（ローカル/テスト）→ "disabled"。
    """
    if settings.otel_exporter_otlp_endpoint:
        return "otlp"
    if settings.otel_traces_to_cloud_trace and settings.google_genai_use_vertexai:
        return "cloud_trace"
    return "disabled"


def setup_observability(app: FastAPI) -> None:
    """Configure OTel tracing (Cloud Trace 直送 / OTLP / 無効) + FastAPI instrumentation.

    Safe to call once。Cloud Tasks push 受け口（ADR-0040）を span 化し、
    api → worker → 動画解析の経路を Cloud Trace 上で追えるようにする。
    """
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
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
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
        FastAPIInstrumentor.instrument_app(app)
        log.info("otel_initialised", exporter=kind)
    except Exception as exc:  # pragma: no cover - depends on env
        log.warning("otel_init_failed", exporter=kind, error=str(exc))
