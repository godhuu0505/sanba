"""OpenTelemetry wiring for the API.

観測できないものは運用できない (CLAUDE.md)。アプリ起動時に一度だけ初期化する。
agent 側 (sanba_agent.observability) と対になる実装。OTLP エンドポイント未設定なら
graceful にスキップする (ローカルのアプリ最小構成では雑音を出さない)。
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI

from .config import settings

log = structlog.get_logger(__name__)
_initialised = False


def setup_observability(app: FastAPI) -> None:
    """Configure OTel tracing + FastAPI instrumentation. Safe to call once."""
    global _initialised
    if _initialised:
        return
    _initialised = True

    if not settings.otel_exporter_otlp_endpoint:
        log.info("otel_disabled", reason="no endpoint configured")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create({"service.name": settings.otel_service_name})
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint, insecure=True)
            )
        )
        trace.set_tracer_provider(provider)
        # HTTP リクエストを自動でスパン化する (依存は pyproject に宣言済み)。
        FastAPIInstrumentor.instrument_app(app)
        log.info("otel_initialised", endpoint=settings.otel_exporter_otlp_endpoint)
    except Exception as exc:  # pragma: no cover - depends on env
        log.warning("otel_init_failed", error=str(exc))
