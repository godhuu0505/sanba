"""Worker HTTP entrypoint: Cloud Tasks push handler for video analysis (ADR-0040).

Cloud Run + IAM が OIDC を検証し、Cloud Tasks 用 SA からの invoke のみ通す（invoker 限定）。
本ハンドラは冪等・破棄競合安全な `process_video` を呼び、リトライ枯渇時の failed 化を
`X-CloudTasks-TaskRetryCount` で判定する（Cloud Tasks は上限到達後にハンドラを呼ばないため）。
"""

from __future__ import annotations

import contextlib

import structlog
from fastapi import FastAPI, HTTPException, Request
from sanba_shared.analytics import UsageRecorder
from sanba_shared.analytics_sink import AnalyticsConfig, AnalyticsSink
from sanba_shared.grounding import ContextIndexer
from sanba_shared.pii import mask_pii
from sanba_shared.realtime import STAGE_DONE, AnalysisPublisher, build_sender
from sanba_shared.repository import SessionRepository

from .analysis import TaskResult, VideoTaskPayload, _mark_failed, process_video
from .config import settings
from .observability import get_tracer, record_analysis, setup_observability
from .storage import gcs_fetch_bytes

log = structlog.get_logger(__name__)

app = FastAPI(title="sanba-worker")
setup_observability(app)
_tracer = get_tracer(__name__)

_repo = SessionRepository()
_indexer = ContextIndexer(settings.grounding_config(), masker=mask_pii)
if settings.require_elasticsearch and _indexer.is_memory:
    raise RuntimeError(
        "REQUIRE_ELASTICSEARCH is set but Elasticsearch is not reachable; "
        "set ELASTICSEARCH_URL correctly or unset REQUIRE_ELASTICSEARCH"
    )
if _indexer.is_memory:
    log.warning("grounding_memory_fallback")
_analytics_sink = AnalyticsSink(
    AnalyticsConfig(
        elasticsearch_url=settings.elasticsearch_url,
        elasticsearch_api_key=settings.elasticsearch_api_key,
    )
)

MAX_TASK_ATTEMPTS = 5


def _usage_recorder(session_id: str) -> UsageRecorder:
    """タスクのセッション文脈を束ねた ai_usage recorder（ADR-0061）。

    排出と同時に `sessions/{id}.ai_cost` へ加算し、agent の `session_summary` に合流させる。
    メタ読み取り失敗は文脈なし recorder に倒し、解析本処理を止めない。
    """
    meta = None
    try:
        meta = _repo.get_session(session_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("analytics_recorder_meta_failed", session=session_id, error=str(exc))

    def _increment(component: str, payload: dict) -> None:  # type: ignore[type-arg]
        tokens = payload.get("tokens", {})
        _repo.add_session_ai_cost(
            session_id,
            component=component,
            usd=float(payload.get("estimated_usd", 0.0)),
            input_tokens=int(tokens.get("input_tokens", 0)),
            output_tokens=int(tokens.get("output_tokens", 0)),
            requests=int(payload.get("requests", 1)),
        )

    return UsageRecorder(
        _analytics_sink,
        session_id,
        product_id=meta.product_id if meta is not None else None,
        interview_mode=meta.interview_mode.value if meta is not None else None,
        on_record=_increment,
    )


async def _publish_visual(session_id: str, asset_id: str, result: TaskResult) -> None:
    """解析完了を会話ルームへ live 配信する（analysis.progress=done + analysis.visual）。

    web は素材行を done にし、agent（PR-V4）はこれを受けて動画内容を深掘りする。publish は
    付加価値なので、LiveKit 未設定/未接続・送信失敗でも解析本処理を止めない（fail-open）。
    素材の状態遷移自体は Firestore + ハイドレーション GET で成立する（ADR-0023 二層目）。
    `asset_id` は素材 ID（"asset-…"）で、web の素材行・agent のフィルタと一致させる。
    """
    if not settings.enable_realtime_publish:
        return
    sender = build_sender(
        settings.livekit_publish_url,
        settings.livekit_api_key,
        settings.livekit_api_secret,
        session_id,
    )
    publisher = AnalysisPublisher(session_id, sender, _repo)
    with contextlib.suppress(Exception):
        await publisher.progress(asset_id, STAGE_DONE)
        await publisher.visual(asset_id, result.observations)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/tasks/analyze-video")
async def analyze_video_task(req: Request) -> dict[str, str]:
    body = await req.json()
    try:
        payload = VideoTaskPayload.model_validate(body)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"bad payload: {exc}") from exc

    retry_count = int(req.headers.get("X-CloudTasks-TaskRetryCount", "0"))
    try:
        span_cm = (
            _tracer.start_as_current_span("sanba.worker.analyze_video")
            if _tracer
            else contextlib.nullcontext(None)
        )
        with span_cm as span:
            if span is not None:
                span.set_attribute("sanba.session_id", payload.session_id)
                span.set_attribute("sanba.asset_id", payload.asset_id)
                span.set_attribute("sanba.retry_count", retry_count)
            result = process_video(
                payload,
                repo=_repo,
                indexer=_indexer,
                settings=settings,
                fetch_bytes=gcs_fetch_bytes,
                usage_recorder=_usage_recorder(payload.session_id),
            )
            if span is not None:
                span.set_attribute("sanba.result", result.status)
        record_analysis(result.status)
        if result.status == "done":
            await _publish_visual(payload.session_id, payload.asset_id, result)
        return {"status": result.status, "reason": result.reason}
    except Exception as exc:
        log.warning(
            "video_task_error",
            session=payload.session_id,
            asset_id=payload.asset_id,
            retry=retry_count,
            error=str(exc),
        )
        if retry_count >= MAX_TASK_ATTEMPTS - 1:
            _mark_failed(_repo, payload.session_id, payload.asset_id, f"exhausted:{exc}")
            record_analysis("failed")
            return {"status": "failed", "reason": "retries_exhausted"}
        record_analysis("error")
        raise HTTPException(status_code=503, detail="transient error, retry") from exc
