"""OpenTelemetry + Langfuse wiring.

観測できないものは運用できない (CLAUDE.md)。エージェント起動時に一度だけ初期化する。
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
    except Exception:  # pragma: no cover - otel optional
        return None


def setup_observability() -> None:
    """Configure OTel tracing exporter. Safe to call multiple times."""
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
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create({"service.name": settings.otel_service_name})
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(
                    endpoint=settings.otel_exporter_otlp_endpoint,
                    insecure=settings.otel_exporter_insecure,
                )
            )
        )
        trace.set_tracer_provider(provider)
        log.info("otel_initialised", endpoint=settings.otel_exporter_otlp_endpoint)
    except Exception as exc:  # pragma: no cover
        log.warning("otel_init_failed", error=str(exc))


def get_langfuse():  # type: ignore[no-untyped-def]
    """Return a Langfuse client if configured, else None."""
    if not (settings.langfuse_public_key and settings.langfuse_secret_key):
        return None
    try:
        from langfuse import Langfuse

        return Langfuse(
            host=settings.langfuse_host,
            public_key=settings.langfuse_public_key,
            secret_key=settings.langfuse_secret_key,
        )
    except Exception as exc:  # pragma: no cover
        log.warning("langfuse_init_failed", error=str(exc))
        return None
