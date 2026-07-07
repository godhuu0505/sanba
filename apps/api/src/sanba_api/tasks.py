"""Cloud Tasks enqueue for the async video analysis pipeline (ADR-0040).

api は upload-complete で 1 動画 = 1 タスクを enqueue し、worker（`apps/worker`）が pull される。
task 名を `session_id` + `asset_id` 由来にして重複 enqueue を排除する（同一動画を別セッションに
上げると内容ハッシュ asset_id は衝突しうるため、session を含めて分離する）。

経路は 3 つ:
  - 本番: Cloud Tasks（OIDC トークン = worker_invoker_sa、宛先 = worker_url）。
  - ローカル: `local_direct_dispatch` で worker を直接 HTTP で叩く（Tasks エミュレータが無い）。
  - 未設定: no-op（fail-open。素材は analyzing のまま残るが reconcile で拾う）。
副作用（Cloud Tasks クライアント / httpx）は差し込み可能にして単体テストできるようにする。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import structlog

from .config import settings

log = structlog.get_logger(__name__)

_TASK_NAME_SAFE = re.compile(r"[^A-Za-z0-9_-]")

Dispatcher = Callable[[str, dict[str, Any], str | None], None]


def _task_id(session_id: str, asset_id: str) -> str:
    return _TASK_NAME_SAFE.sub("-", f"{session_id}-{asset_id}")


def build_payload(
    session_id: str,
    asset_id: str,
    gcs_uri: str,
    content_type: str,
    filename: str,
    duration_seconds: float | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "session_id": session_id,
        "asset_id": asset_id,
        "gcs_uri": gcs_uri,
        "content_type": content_type,
        "filename": filename,
    }
    if duration_seconds is not None:
        payload["duration_seconds"] = duration_seconds
    return payload


def _dispatch_direct(
    url: str, payload: dict[str, Any], _sa: str | None
) -> None:  # pragma: no cover
    import httpx

    httpx.post(f"{url}/tasks/analyze-video", json=payload, timeout=10.0)


def _dispatch_cloud_tasks(  # pragma: no cover - needs GCP
    url: str, payload: dict[str, Any], oidc_sa: str | None
) -> None:
    import json

    from google.cloud import tasks_v2  # type: ignore[attr-defined]

    client = tasks_v2.CloudTasksClient()
    parent = client.queue_path(
        settings.google_cloud_project, settings.video_tasks_location, settings.video_tasks_queue
    )
    task: dict[str, Any] = {
        "name": client.task_path(
            settings.google_cloud_project,
            settings.video_tasks_location,
            settings.video_tasks_queue,
            _task_id(payload["session_id"], payload["asset_id"]),
        ),
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST,
            "url": f"{url}/tasks/analyze-video",
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(payload).encode("utf-8"),
        },
    }
    if oidc_sa:
        task["http_request"]["oidc_token"] = {
            "service_account_email": oidc_sa,
            "audience": url,
        }
    client.create_task(parent=parent, task=task)  # type: ignore[arg-type]


def enqueue_video_analysis(
    payload: dict[str, Any],
    *,
    dispatcher: Dispatcher | None = None,
) -> str:
    """動画解析タスクを enqueue する。経路の選択結果（cloud_tasks/direct/skipped）を返す。"""
    if not settings.worker_url:
        log.info("video_enqueue_skipped", reason="no_worker_url", asset_id=payload.get("asset_id"))
        return "skipped"

    if settings.local_direct_dispatch:
        dispatch = dispatcher or _dispatch_direct
        dispatch(settings.worker_url, payload, None)
        log.info("video_enqueued", mode="direct", asset_id=payload.get("asset_id"))
        return "direct"

    if not settings.video_tasks_queue:
        log.info("video_enqueue_skipped", reason="no_queue", asset_id=payload.get("asset_id"))
        return "skipped"

    dispatch = dispatcher or _dispatch_cloud_tasks
    dispatch(settings.worker_url, payload, settings.worker_invoker_sa or None)
    log.info("video_enqueued", mode="cloud_tasks", asset_id=payload.get("asset_id"))
    return "cloud_tasks"
