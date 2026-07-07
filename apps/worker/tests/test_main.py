"""HTTP handler tests for the worker (health + task retry/exhaustion semantics)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sanba_shared.repository import SessionRepository

import sanba_worker.main as main


@pytest.fixture()
def client_with_material() -> Iterator[tuple[TestClient, SessionRepository]]:
    repo = SessionRepository()
    repo.save_material(
        "s1", {"id": "asset-x", "name": "d.mp4", "kind": "video", "status": "analyzing"}
    )
    orig = main._repo
    main._repo = repo
    try:
        yield TestClient(main.app), repo
    finally:
        main._repo = orig


def test_health() -> None:
    assert TestClient(main.app).get("/health").json() == {"status": "ok"}


def test_transient_error_before_last_attempt_returns_503(
    client_with_material: tuple[TestClient, SessionRepository], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, repo = client_with_material

    def _boom(*_a, **_k):
        raise RuntimeError("es down")

    monkeypatch.setattr(main, "process_video", _boom)
    resp = client.post(
        "/tasks/analyze-video",
        json={"session_id": "s1", "asset_id": "asset-x", "gcs_uri": "gs://b/o.mp4"},
        headers={"X-CloudTasks-TaskRetryCount": "0"},
    )
    assert resp.status_code == 503
    # まだ failed 化しない（リトライ余地あり）。
    assert repo.get_material("s1", "asset-x")["status"] == "analyzing"


def test_transient_error_on_last_attempt_marks_failed_and_200(
    client_with_material: tuple[TestClient, SessionRepository], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, repo = client_with_material

    def _boom(*_a, **_k):
        raise RuntimeError("es down")

    monkeypatch.setattr(main, "process_video", _boom)
    resp = client.post(
        "/tasks/analyze-video",
        json={"session_id": "s1", "asset_id": "asset-x", "gcs_uri": "gs://b/o.mp4"},
        headers={"X-CloudTasks-TaskRetryCount": str(main.MAX_TASK_ATTEMPTS - 1)},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "failed"
    # 枯渇時はハンドラ内で failed 化する（Cloud Tasks は再呼び出ししないため）。
    assert repo.get_material("s1", "asset-x")["status"] == "failed"


def test_bad_payload_returns_400(
    client_with_material: tuple[TestClient, SessionRepository],
) -> None:
    client, _ = client_with_material
    resp = client.post("/tasks/analyze-video", json={"asset_id": "x"})  # session_id 欠落
    assert resp.status_code == 400


def test_publish_visual_emits_progress_and_visual(monkeypatch: pytest.MonkeyPatch) -> None:
    """done の解析結果が analysis.progress(done) + analysis.visual として publish される。"""
    import asyncio

    from sanba_worker.analysis import TaskResult

    sent: list[bytes] = []

    class _Recorder:
        async def send(self, payload: bytes, *, topic: str, reliable: bool) -> None:
            sent.append(payload)

    monkeypatch.setattr(main.settings, "enable_realtime_publish", True)
    monkeypatch.setattr(main, "build_sender", lambda *a, **k: _Recorder())
    monkeypatch.setattr(main, "_repo", SessionRepository())

    asyncio.run(
        main._publish_visual(
            "s1", "asset-x", TaskResult("done", extracted=1, observations=["[00:01] ログイン画面"])
        )
    )
    joined = b"".join(sent)
    assert b"analysis.visual" in joined
    assert b"analysis.progress" in joined
    assert b"asset-x" in joined and "ログイン画面".encode() in joined


def test_publish_visual_noop_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from sanba_worker.analysis import TaskResult

    called = False

    def _fail(*a, **k):
        nonlocal called
        called = True
        raise AssertionError("should not build a sender when publish is disabled")

    monkeypatch.setattr(main.settings, "enable_realtime_publish", False)
    monkeypatch.setattr(main, "build_sender", _fail)
    asyncio.run(main._publish_visual("s1", "asset-x", TaskResult("done", extracted=0)))
    assert called is False
