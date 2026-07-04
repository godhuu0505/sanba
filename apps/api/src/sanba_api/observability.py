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


# join エンドポイントのレートリミット発火カウンタ（#80 / #257 Codex 指摘）。認証より前に
# 429 で短絡するため、auth イベント（sanba_auth_events_total）には現れない。DoS 緩和が
# 本番で実際に発動しているかを計測する（CLAUDE.md 原則3: 観測できないものは運用できない）。
_rate_limit_counter = metrics.get_meter("sanba_api.ratelimit").create_counter(
    "sanba_join_rate_limited_total",
    description="join レートリミットで 429 短絡した回数",
)


def record_rate_limited() -> None:
    """join レートリミット発火（429 短絡）を計上する。"""
    try:
        _rate_limit_counter.add(1)
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


# 現在質問ハイドレーション（GET /questions/current）のカウンタ（#212 / ADR-0020 §5）。
# requirements_hydrated と同様に「未回答の問いが復元できたか」を計測する（契約 §5）。
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


# web UI 由来の素材イベント（投入種別選択 #232 / 中断 #243 / サーバ破棄 #245）のカウンタ。
# クライアント観測を第三者分析 SDK ではなくサーバ側 OTLP に集約する（CLAUDE.md 原則3 /
# 既存 metrics 基盤に一致する最小構成）。PII/自由記述は載せない: event/source/status/result
# は列挙値のみ（main.py の許可リストで検証し、未知値は other へ丸めて高カーディナリティ/PII
# 流入を防ぐ）。
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


# product 管理イベント（登録/更新/削除/repo 紐づけ / ADR-0031）のカウンタ。深掘りリンクの
# 準備がどれだけ行われているかを観測する（CLAUDE.md 原則3）。event は列挙値のみ・PII 非送信。
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


# 本人セッション一覧 (GET /api/sessions/mine) のカウンタ (#250)。ホーム「過去の要件を見る」
# (#215) に供給する一覧の取得を計測する (契約 §5 / CLAUDE.md 原則3)。リクエストを 1 ずつ計上し
# (record_auth_event と統一)、result=empty/listed で「履歴が空のユーザーの頻度」を観測する。
_my_sessions_counter = metrics.get_meter("sanba_api.sessions").create_counter(
    "sanba_my_sessions_listed_total",
    description="本人セッション一覧取得リクエスト数 (result=empty/listed ごと / #250)",
)


def record_my_sessions_listed(count: int) -> None:
    """本人セッション一覧取得を 1 リクエストとして計上する (#250)。

    返した件数ではなくリクエストを 1 ずつ計上する (record_auth_event と統一)。0 件でも確実に
    計上し、result=empty/listed で空履歴ユーザーの頻度を観測できるようにする (件数を加算する
    方式だと 0 件が no-op になり観測の死角になるため)。
    """
    try:
        _my_sessions_counter.add(1, {"result": "empty" if count == 0 else "listed"})
    except Exception:  # pragma: no cover - メトリクスは本処理を止めない
        pass


# 本人セッションの要件絵巻閲覧 (GET /api/sessions/mine/{id}/requirements) のカウンタ。
# ホーム履歴 (#215/#250) からの詳細閲覧ファネルを観測する (CLAUDE.md 原則3)。
# record_my_sessions_listed と同じく 1 リクエスト 1 計上・result=empty/viewed。
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
                OTLPSpanExporter(
                    endpoint=settings.otel_exporter_otlp_endpoint,
                    insecure=settings.otel_exporter_insecure,
                )
            )
        )
        trace.set_tracer_provider(provider)
        # HTTP リクエストを自動でスパン化する (依存は pyproject に宣言済み)。
        FastAPIInstrumentor.instrument_app(app)
        log.info("otel_initialised", endpoint=settings.otel_exporter_otlp_endpoint)
    except Exception as exc:  # pragma: no cover - depends on env
        log.warning("otel_init_failed", error=str(exc))
