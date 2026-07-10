"""Video analysis task logic (ADR-0040).

Cloud Tasks から push された 1 動画を解析し、grounding へ投入して素材メタを更新する。
副作用（GCS 取得・Gemini 解析）は差し込み可能にし、GCP 無しで単体テストできるようにする。

冪等性と破棄競合の扱い（ADR-0040 §3）:
  - 処理前に material.status を確認し、`analyzing` 以外（done/failed/削除）は skip する。
  - Gemini 解析後・書き込み直前にも material の存在/状態を再確認し、解析中に
    `DELETE /context/file/{asset_id}` で破棄された素材を復活させない。
恒久エラー（実長超過・非対応）は failed 化して done 扱い（リトライさせない）。一時エラー
（ES/GCS 障害）は例外を送出し、呼び出し側（main）が最終試行かどうかで failed 化を判断する。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import structlog
from pydantic import BaseModel, Field
from sanba_shared.analytics import (
    COMPONENT_EMBEDDING,
    COMPONENT_VISION,
    UsageRecorder,
    vertex_billing_labels,
)
from sanba_shared.grounding import ContextIndexer
from sanba_shared.media import VideoAnalysis, analyze_video
from sanba_shared.repository import SessionRepository

from .config import WorkerSettings
from .storage import ensure_allowed_bucket

log = structlog.get_logger(__name__)


class VideoTaskPayload(BaseModel):
    """Cloud Tasks が worker に渡す動画解析ジョブ。"""

    session_id: str
    asset_id: str
    gcs_uri: str | None = None
    content_type: str = "video/mp4"
    filename: str = ""
    duration_seconds: float | None = Field(default=None, ge=0)


@dataclass
class TaskResult:
    """解析の結末。`status` は done / failed / skipped。"""

    status: str
    reason: str = ""
    extracted: int = 0
    observations: list[str] = field(default_factory=list)


BytesFetcher = Callable[[str], bytes]
VideoAnalyzer = Callable[..., VideoAnalysis]


def _still_analyzing(repo: SessionRepository, session_id: str, asset_id: str) -> bool:
    material = repo.get_material(session_id, asset_id)
    return material is not None and material.get("status") == "analyzing"


def _mark_failed(repo: SessionRepository, session_id: str, asset_id: str, reason: str) -> None:
    if repo.get_material(session_id, asset_id) is None:
        return
    repo.save_material(session_id, {"id": asset_id, "status": "failed"})
    log.info("video_analysis_failed", session=session_id, asset_id=asset_id, reason=reason)


def process_video(
    payload: VideoTaskPayload,
    *,
    repo: SessionRepository,
    indexer: ContextIndexer,
    settings: WorkerSettings,
    analyze: VideoAnalyzer = analyze_video,
    fetch_bytes: BytesFetcher | None = None,
    usage_recorder: UsageRecorder | None = None,
) -> TaskResult:
    """1 動画を解析し grounding へ投入。冪等・破棄競合安全（ADR-0040 §3）。

    `usage_recorder` があれば動画解析（vision）と観察の索引（embedding）のトークン usage を
    `ai_usage` として排出する（ADR-0061）。記録は fail-soft で解析本体を止めない。
    """
    session_id, asset_id = payload.session_id, payload.asset_id

    material = repo.get_material(session_id, asset_id)
    if material is None:
        log.info("video_task_skipped", session=session_id, asset_id=asset_id, reason="not_found")
        return TaskResult("skipped", "not_found")
    if material.get("status") != "analyzing":
        return TaskResult("skipped", f"status_{material.get('status')}")

    if (
        payload.duration_seconds is not None
        and payload.duration_seconds > settings.max_video_duration_seconds
    ):
        _mark_failed(repo, session_id, asset_id, "video_too_long")
        return TaskResult("failed", "video_too_long")

    if payload.gcs_uri is not None:
        try:
            ensure_allowed_bucket(payload.gcs_uri, settings.gcs_bucket)
        except ValueError as exc:
            _mark_failed(repo, session_id, asset_id, f"disallowed_bucket:{exc}")
            return TaskResult("failed", "disallowed_bucket")

    config = settings.media_config()
    usage_kwargs: dict[str, object] = {}
    if usage_recorder is not None:
        usage_kwargs = {
            "on_usage": lambda usage: usage_recorder.record(
                COMPONENT_VISION, settings.gemini_vision_model, usage
            ),
            "billing_labels": vertex_billing_labels(
                session_id,
                usage_recorder.product_id,
                use_vertexai=settings.google_genai_use_vertexai,
            ),
        }
    if settings.google_genai_use_vertexai and payload.gcs_uri:
        result = analyze(
            config, gcs_uri=payload.gcs_uri, content_type=payload.content_type, **usage_kwargs
        )
    else:
        if fetch_bytes is None or payload.gcs_uri is None:
            raise RuntimeError("local video analysis requires a bytes fetcher and gcs_uri")
        raw = fetch_bytes(payload.gcs_uri)
        if len(raw) > settings.max_inline_video_bytes:
            _mark_failed(repo, session_id, asset_id, "video_too_large_for_local")
            return TaskResult("failed", "video_too_large_for_local")
        result = analyze(config, raw=raw, content_type=payload.content_type, **usage_kwargs)

    if not _still_analyzing(repo, session_id, asset_id):
        log.info(
            "video_task_discarded",
            session=session_id,
            asset_id=asset_id,
            reason="deleted_during_analysis",
        )
        return TaskResult("skipped", "deleted_during_analysis")

    indexed = 0
    if result.observations:
        embed_hook = None
        if usage_recorder is not None:
            recorder = usage_recorder

            def embed_hook(usage):  # type: ignore[no-untyped-def]
                recorder.record(COMPONENT_EMBEDDING, settings.gemini_embed_model, usage)

        indexed = indexer.index_context(
            session_id, result.observations, f"asset:{asset_id}", usage_hook=embed_hook
        )

    done_record: dict[str, object] = {
        "id": asset_id,
        "status": "done",
        "extracted": result.extracted,
    }
    if result.observations:
        done_record["extracted_texts"] = list(result.observations)
    repo.save_material(session_id, done_record)
    log.info(
        "video_analyzed",
        session=session_id,
        asset_id=asset_id,
        observations=result.extracted,
        indexed=indexed,
    )
    return TaskResult("done", extracted=result.extracted, observations=list(result.observations))
