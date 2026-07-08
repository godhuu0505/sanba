"""OpenTelemetry wiring for the API.

観測できないものは運用できない (CLAUDE.md)。アプリ起動時に一度だけ初期化する。
agent 側 (sanba_agent.observability) と対になる実装で、エクスポータ選択は同じ優先順位:
OTLP エンドポイント明示 → Cloud Trace 直送 (Vertex 実行時) → 無効 (ローカル/テスト)。
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import FastAPI
from opentelemetry import metrics

from .config import settings

log = structlog.get_logger(__name__)
_initialised = False


def get_tracer(name: str) -> Any:
    """名前付き OTel トレーサを返す（未初期化なら no-op トレーサ / agent と同方式）。"""
    try:
        from opentelemetry import trace

        return trace.get_tracer(name)
    except Exception:  # pragma: no cover
        return None


def select_exporter_kind() -> str:
    """どのスパンエクスポータを使うかを設定から決める（純関数・ネットワーク不要 / ADR-0051）。

    agent 側 (sanba_agent.observability.select_exporter_kind) と同じ優先順位:
      1. ``OTEL_EXPORTER_OTLP_ENDPOINT`` 明示時 → "otlp"（Collector サイドカー等へ）。
      2. 未指定でも Cloud Trace 直送が有効かつ Vertex 実行（＝GCP 上・ADC あり）→ "cloud_trace"。
      3. それ以外（ローカル/テスト）→ "disabled"。
    """
    if settings.otel_exporter_otlp_endpoint:
        return "otlp"
    if settings.otel_traces_to_cloud_trace and settings.google_genai_use_vertexai:
        return "cloud_trace"
    return "disabled"


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


_rate_limit_counter = metrics.get_meter("sanba_api.ratelimit").create_counter(
    "sanba_join_rate_limited_total",
    description="join レートリミットで 429 短絡した回数 (limiter=ip/invite ごと)",
)


def record_rate_limited(limiter: str = "ip") -> None:
    """join レートリミット発火（429 短絡）を計上する。

    limiter=ip: ミドルウェアの IP 単位。limiter=invite: 深掘りリンク単位
    （ADR-0032 決定5 / FR-2.6）。
    """
    try:
        _rate_limit_counter.add(1, {"limiter": limiter})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


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


_question_hydration_counter = metrics.get_meter("sanba_api.questions").create_counter(
    "sanba_question_hydrations_total",
    description="現在質問ハイドレーション数 (result=question/empty ごと)",
)


def record_question_hydration(has_question: bool) -> None:
    """現在質問ハイドレーションを計上する (result=question:復元あり / empty:未提示or回答済み)。"""
    try:
        _question_hydration_counter.add(1, {"result": "question" if has_question else "empty"})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_material_event_counter = metrics.get_meter("sanba_api.materials").create_counter(
    "sanba_material_events_total",
    description="素材 UI イベント数 (event/source/status/result ごと)",
)


def record_material_event(
    event: str,
    *,
    source: str = "none",
    status: str = "none",
    result: str = "none",
) -> None:
    """素材 UI イベントを計上する（列挙値のみ・PII 非送信）。

    - event: material.source_selected / material.cancel / material.discard
    - source: camera / screen / upload / drive / other / none
    - status: uploading / analyzing / other / none
    - result: aborted / discarded / error / deleted / not_found / other / none
    """
    try:
        _material_event_counter.add(
            1, {"event": event, "source": source, "status": status, "result": result}
        )
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_product_counter = metrics.get_meter("sanba_api.products").create_counter(
    "sanba_product_events_total",
    description="product 管理イベント数 (event=created/updated/deleted/github_set ごと / ADR-0031)",
)


def record_product_event(event: str) -> None:
    """product 管理イベントを計上する（event=created/updated/deleted/github_set）。"""
    try:
        _product_counter.add(1, {"event": event})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_member_counter = metrics.get_meter("sanba_api.products").create_counter(
    "sanba_product_member_events_total",
    description=(
        "product メンバー管理イベント数 "
        "(event=invite_created/invite_accepted/invite_declined/invite_revoked/member_removed"
        " / ADR-0036)"
    ),
)


def record_member_event(event: str) -> None:
    """メンバー管理イベントを計上する
    （event=invite_created/invite_accepted/invite_declined/invite_revoked/member_removed）。"""
    try:
        _member_counter.add(1, {"event": event})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_member_invite_email_counter = metrics.get_meter("sanba_api.products").create_counter(
    "sanba_member_invite_emails_total",
    description="メンバー招待メールの送信数 (result=sent/failed/skipped / ADR-0036)",
)


def record_member_invite_email(result: str) -> None:
    """メンバー招待メールの送信結果を計上する（result=sent/failed/skipped）。"""
    try:
        _member_invite_email_counter.add(1, {"result": result})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_guest_join_counter = metrics.get_meter("sanba_api.guest").create_counter(
    "sanba_guest_join_total",
    description=(
        "ゲスト入場の試行数 (result=granted/flag_off/scope_mismatch/rate_limited / ADR-0032)"
    ),
)


def record_guest_join(result: str) -> None:
    """ゲスト入場イベントを計上する（result=granted/flag_off/scope_mismatch/rate_limited）。"""
    try:
        _guest_join_counter.add(1, {"result": result})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_join_ui_counter = metrics.get_meter("sanba_api.guest").create_counter(
    "sanba_join_ui_events_total",
    description="リンク入場 UI の離脱イベント数 (event=join.abort, result=aborted/error)",
)


def record_join_ui_event(event: str, result: str = "none") -> None:
    """リンク入場 UI イベントを計上する（event=join.abort / result=aborted/error/other/none）。"""
    try:
        _join_ui_counter.add(1, {"event": event, "result": result})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_my_sessions_counter = metrics.get_meter("sanba_api.sessions").create_counter(
    "sanba_my_sessions_listed_total",
    description="本人セッション一覧取得リクエスト数 (result=empty/listed ごと)",
)


def record_my_sessions_listed(count: int) -> None:
    """本人セッション一覧取得を 1 リクエストとして計上する。

    返した件数ではなくリクエストを 1 ずつ計上する (record_auth_event と統一)。0 件でも確実に
    計上し、result=empty/listed で空履歴ユーザーの頻度を観測できるようにする (件数を加算する
    方式だと 0 件が no-op になり観測の死角になるため)。
    """
    try:
        _my_sessions_counter.add(1, {"result": "empty" if count == 0 else "listed"})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_my_requirements_counter = metrics.get_meter("sanba_api.sessions").create_counter(
    "sanba_my_requirements_viewed_total",
    description="本人セッションの要件絵巻閲覧リクエスト数 (result=empty/viewed ごと)",
)


def record_my_requirements_viewed(count: int) -> None:
    """本人セッションの要件絵巻閲覧を 1 リクエストとして計上する。

    要件 0 件でも確実に計上し (加算方式だと 0 件が no-op になる死角)、
    result=empty/viewed で「開いたが要件が無かった」頻度を観測する。
    """
    try:
        _my_requirements_counter.add(1, {"result": "empty" if count == 0 else "viewed"})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


_result_document_counter = metrics.get_meter("sanba_api.sessions").create_counter(
    "sanba_result_document_rendered_total",
    description="要件結果ドキュメントの生成数 (audience / format=custom|default ごと)",
)


def record_result_document_rendered(audience: str, is_custom: bool) -> None:
    """要件結果ドキュメントの生成を 1 リクエストとして計上する。"""
    try:
        _result_document_counter.add(
            1, {"audience": audience, "format": "custom" if is_custom else "default"}
        )
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


def setup_observability(app: FastAPI) -> None:
    """Configure OTel tracing (Cloud Trace 直送 / OTLP / 無効) + FastAPI instrumentation.

    Safe to call once。エクスポータ選択は agent 側と同じ ``select_exporter_kind`` に一元化する。
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
