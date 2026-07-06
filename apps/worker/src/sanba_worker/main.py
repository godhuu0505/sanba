"""Worker HTTP entrypoint: Cloud Tasks push handler for video analysis (ADR-0040).

Cloud Run + IAM が OIDC を検証し、Cloud Tasks 用 SA からの invoke のみ通す（invoker 限定）。
本ハンドラは冪等・破棄競合安全な `process_video` を呼び、リトライ枯渇時の failed 化を
`X-CloudTasks-TaskRetryCount` で判定する（Cloud Tasks は上限到達後にハンドラを呼ばないため）。
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI, HTTPException, Request
from sanba_shared.grounding import ContextIndexer
from sanba_shared.pii import mask_pii
from sanba_shared.repository import SessionRepository

from .analysis import VideoTaskPayload, _mark_failed, process_video
from .config import settings
from .observability import record_analysis
from .storage import gcs_fetch_bytes

log = structlog.get_logger(__name__)

app = FastAPI(title="sanba-worker")

_repo = SessionRepository()
_indexer = ContextIndexer(settings.grounding_config(), masker=mask_pii)

# キューの max_attempts と揃える（ADR-0040 §3。ずれても reaper が滞留素材を拾う保険がある）。
MAX_TASK_ATTEMPTS = 5


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
