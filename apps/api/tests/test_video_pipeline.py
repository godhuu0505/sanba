"""Tests for the async video analysis wiring on the API side (ADR-0040).

enqueue の経路選択・直送 upload-init/complete・kind 別上限・reconcile を検証する。
Cloud Tasks / GCS / worker への実接続は差し込み・in-memory で置き換える。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api import tasks
from sanba_api.auth import create_session_token
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.deps import _asset_store, _repo
from sanba_api.main import app
from sanba_api.routers import sessions as sessions_router

client = TestClient(app)


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    app.dependency_overrides[require_user] = lambda: AuthUser(
        sub="owner-123456789", email="owner@example.com", email_verified=True, name="Owner"
    )
    yield
    app.dependency_overrides.pop(require_user, None)


@pytest.fixture()
def _video_enabled(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict]]:
    """動画解析を有効化し、enqueue 呼び出しを捕捉する。"""
    monkeypatch.setattr(settings, "enable_video_analysis", True)
    captured: list[dict] = []
    monkeypatch.setattr(
        sessions_router, "enqueue_video_analysis", lambda payload: captured.append(payload)
    )
    yield captured


def _session() -> str:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    return created.json()["session_id"]


def _auth(session_id: str) -> dict[str, str]:
    token = create_session_token(
        session_id, "owner-123456789", "pm", settings.session_signing_secret, 3600
    )
    return {"Authorization": f"Bearer {token}"}


def test_enqueue_skipped_without_worker_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "worker_url", "")
    assert tasks.enqueue_video_analysis({"asset_id": "a", "session_id": "s"}) == "skipped"


def test_enqueue_direct_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "worker_url", "http://worker:8080")
    monkeypatch.setattr(settings, "local_direct_dispatch", True)
    seen: list[tuple] = []
    mode = tasks.enqueue_video_analysis(
        {"asset_id": "a", "session_id": "s"},
        dispatcher=lambda url, payload, sa: seen.append((url, payload, sa)),
    )
    assert mode == "direct"
    assert seen[0][0] == "http://worker:8080"


def test_enqueue_cloud_tasks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "worker_url", "http://worker:8080")
    monkeypatch.setattr(settings, "local_direct_dispatch", False)
    monkeypatch.setattr(settings, "video_tasks_queue", "q")
    monkeypatch.setattr(settings, "worker_invoker_sa", "sa@example.iam")
    seen: list[tuple] = []
    mode = tasks.enqueue_video_analysis(
        {"asset_id": "a", "session_id": "s"},
        dispatcher=lambda url, payload, sa: seen.append((url, payload, sa)),
    )
    assert mode == "cloud_tasks"
    assert seen[0][2] == "sa@example.iam"


def test_upload_init_returns_signed_url(_video_enabled: list[dict]) -> None:
    sid = _session()
    resp = client.post(
        f"/api/sessions/{sid}/context/file/upload-init",
        json={"filename": "demo.mp4", "content_type": "video/mp4", "size": 1000},
        headers=_auth(sid),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["asset_id"].startswith("asset-")
    assert body["upload_url"]
    assert "x-goog-content-length-range" in body["headers"]
    mats = {m["id"]: m for m in _repo.list_materials(sid)}
    assert mats[body["asset_id"]]["status"] == "uploading"


def test_upload_init_rejects_non_video(_video_enabled: list[dict]) -> None:
    sid = _session()
    resp = client.post(
        f"/api/sessions/{sid}/context/file/upload-init",
        json={"filename": "mock.png", "content_type": "image/png", "size": 1000},
        headers=_auth(sid),
    )
    assert resp.status_code == 415


def test_upload_init_rejects_oversized(_video_enabled: list[dict]) -> None:
    sid = _session()
    resp = client.post(
        f"/api/sessions/{sid}/context/file/upload-init",
        json={"filename": "big.mp4", "content_type": "video/mp4", "size": 999_000_000},
        headers=_auth(sid),
    )
    assert resp.status_code == 413


def test_upload_init_disabled_returns_409(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "enable_video_analysis", False)
    sid = _session()
    resp = client.post(
        f"/api/sessions/{sid}/context/file/upload-init",
        json={"filename": "demo.mp4", "content_type": "video/mp4", "size": 1000},
        headers=_auth(sid),
    )
    assert resp.status_code == 409


def test_upload_complete_missing_object_409(_video_enabled: list[dict]) -> None:
    sid = _session()
    init = client.post(
        f"/api/sessions/{sid}/context/file/upload-init",
        json={"filename": "demo.mp4", "content_type": "video/mp4", "size": 1000},
        headers=_auth(sid),
    ).json()
    resp = client.post(
        f"/api/sessions/{sid}/context/file/upload-complete",
        json={"asset_id": init["asset_id"], "content_type": "video/mp4", "filename": "demo.mp4"},
        headers=_auth(sid),
    )
    assert resp.status_code == 409


def test_upload_complete_enqueues(_video_enabled: list[dict]) -> None:
    sid = _session()
    init = client.post(
        f"/api/sessions/{sid}/context/file/upload-init",
        json={"filename": "demo.mp4", "content_type": "video/mp4", "size": 1000},
        headers=_auth(sid),
    ).json()
    asset_id = init["asset_id"]
    blob = _asset_store.blob_name(sid, asset_id, "video/mp4")
    _asset_store._mem[blob] = b"video-bytes"
    resp = client.post(
        f"/api/sessions/{sid}/context/file/upload-complete",
        json={
            "asset_id": asset_id,
            "content_type": "video/mp4",
            "filename": "demo.mp4",
            "duration_seconds": 42,
        },
        headers=_auth(sid),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["analysis_pending"] is True
    mats = {m["id"]: m for m in _repo.list_materials(sid)}
    assert mats[asset_id]["status"] == "analyzing"
    assert _video_enabled and _video_enabled[-1]["asset_id"] == asset_id
    assert _video_enabled[-1]["duration_seconds"] == 42


def test_reconcile_marks_stuck_analyzing_failed(
    _video_enabled: list[dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "analysis_stuck_after_seconds", 1)
    sid = _session()
    _repo.save_material(
        sid,
        {
            "id": "asset-stuck",
            "name": "d.mp4",
            "kind": "video",
            "status": "analyzing",
            "analyzing_since": 0.0,
        },
    )
    resp = client.get(f"/api/sessions/{sid}/context/files", headers=_auth(sid))
    assert resp.status_code == 200
    row = {m["id"]: m for m in resp.json()["items"]}["asset-stuck"]
    assert row["status"] == "failed"
