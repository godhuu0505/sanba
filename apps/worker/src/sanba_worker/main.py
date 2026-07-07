"""Worker HTTP entrypoint: Cloud Tasks push handler for video analysis (ADR-0040).

Cloud Run + IAM が OIDC を検証し、Cloud Tasks 用 SA からの invoke のみ通す（invoker 限定）。
本ハンドラは冪等・破棄競合安全な `process_video` を呼び、リトライ枯渇時の failed 化を
`X-CloudTasks-TaskRetryCount` で判定する（Cloud Tasks は上限到達後にハンドラを呼ばないため）。
"""

from __future__ import annotations

import contextlib

import structlog
from fastapi import FastAPI, HTTPException, Request
from sanba_shared.grounding import ContextIndexer
from sanba_shared.pii import mask_pii
from sanba_shared.realtime import STAGE_DONE, AnalysisPublisher, build_sender
from sanba_shared.repository import SessionRepository

from .analysis import TaskResult, VideoTaskPayload, _mark_failed, process_video
from .config import settings
from .observability import record_analysis
from .storage import gcs_fetch_bytes

log = structlog.get_logger(__name__)

app = FastAPI(title="sanba-worker")

_repo = SessionRepository()
_indexer = ContextIndexer(settings.grounding_config(), masker=mask_pii)

# キューの max_attempts と揃える（ADR-0040 §3。ずれても reaper が滞留素材を拾う保険がある）。
MAX_TASK_ATTEMPTS = 5


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
    except Exception as exc:  # 恒久的に不正なペイロードはリトライしても無駄（400）。
        raise HTTPException(status_code=400, detail=f"bad payload: {exc}") from exc

    retry_count = int(req.headers.get("X-CloudTasks-TaskRetryCount", "0"))
    try:
        result = process_video(
            payload,
            repo=_repo,
            indexer=_indexer,
            settings=settings,
            fetch_bytes=gcs_fetch_bytes,
        )
        record_analysis(result.status)
        if result.status == "done":
            await _publish_visual(payload.session_id, payload.asset_id, result)
        return {"status": result.status, "reason": result.reason}
    except Exception as exc:
        # 一時エラー（ES/GCS 障害等）。最終試行なら failed 化して 2xx（Cloud Tasks は枯渇後に
        # ハンドラを呼ばないため、ここで確定させないと素材が analyzing のまま残る）。
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
