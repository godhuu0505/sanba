"""OpenTelemetry wiring for the API.

観測できないものは運用できない (CLAUDE.md)。アプリ起動時に一度だけ初期化する。
agent 側 (sanba_agent.observability) と対になる実装。OTLP エンドポイント未設定なら
graceful にスキップする (ローカルのアプリ最小構成では雑音を出さない)。
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI
from opentelemetry import metrics

from .config import settings

log = structlog.get_logger(__name__)
_initialised = False

# 認証イベントのカウンタ。MeterProvider 未設定でも OTel API は no-op meter を返すため
# 常に安全に呼べる (OTLP 未設定のローカルでは送信されないだけ)。新しい認証経路を必ず
# メトリクスに通すための一点 (CLAUDE.md: 観測できないものは運用できない)。
_auth_counter = metrics.get_meter("sanba_api.auth").create_counter(
    "sanba_auth_events_total",
    description="Google ログイン検証イベント数 (result ごと)",
)


def record_auth_event(result: str) -> None:
    """認証経路のイベントを計上する (result=verified/rejected/dev_bypass/...)。"""
    try:
        _auth_counter.add(1, {"result": result})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


# マルチモーダル素材（画像/動画）アップロードのカウンタ（issue #103）。kind/result で分類し、
# 「何枚の素材が、解析まで通ったか」を計測する（契約 §5 / CLAUDE.md 原則3）。
_asset_counter = metrics.get_meter("sanba_api.assets").create_counter(
    "sanba_asset_uploads_total",
    description="画像/動画アップロード数 (kind/result ごと)",
)


def record_asset_upload(kind: str, result: str) -> None:
    """素材アップロードを計上する (kind=image/video, result=analyzed/stored/pending/rejected)。"""
    try:
        _asset_counter.add(1, {"kind": kind, "result": result})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


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
