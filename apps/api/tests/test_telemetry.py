"""Tests for the material UI telemetry ingest endpoint.

web UI 由来の投入種別/中断イベントを、第三者クライアント分析 SDK ではなくサーバ側 OTLP
カウンタへ集約する（observability.record_material_event）。ここでは受領の契約を検証する:
- join 済みセッショントークン必須（匿名のメトリクス汚染を塞ぐ・契約 §4）。
- event は許可リストで検証（未知 event は 422）。
- 属性は列挙値のみ（未知値は other へ丸めて受理する＝高カーディナリティ/PII 流入を防ぐ）。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth import create_session_token
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    app.dependency_overrides[require_user] = lambda: AuthUser(
        sub="owner-123456789", email="owner@example.com", email_verified=True, name="Owner"
    )
    yield
    app.dependency_overrides.pop(require_user, None)


def _new_session() -> str:
    created = client.post("/api/sessions", json={"roles": ["pm"], "consent_acknowledged": True})
    return created.json()["session_id"]


def _session_auth(session_id: str) -> dict[str, str]:
    token = create_session_token(
        session_id, "owner-123456789", "pm", settings.session_signing_secret, 3600
    )
    return {"Authorization": f"Bearer {token}"}


def test_telemetry_requires_session_token() -> None:
    res = client.post(
        "/api/sessions/sess-x/telemetry",
        json={"event": "material.source_selected", "source": "upload"},
    )
    assert res.status_code == 401


def test_telemetry_rejects_mismatched_session() -> None:
    sid = _new_session()
    other = _new_session()
    res = client.post(
        f"/api/sessions/{other}/telemetry",
        json={"event": "material.cancel", "status": "uploading", "result": "aborted"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 403


def test_telemetry_records_source_selected() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/telemetry",
        json={"event": "material.source_selected", "source": "camera"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json() == {"recorded": True}


def test_telemetry_records_cancel() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/telemetry",
        json={"event": "material.cancel", "status": "analyzing", "result": "discarded"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json()["recorded"] is True


def test_telemetry_records_join_abort() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/telemetry",
        json={"event": "join.abort", "result": "aborted"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json() == {"recorded": True}


def test_telemetry_join_abort_coerces_unknown_result() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/telemetry",
        json={"event": "join.abort", "result": "free-text@example.com"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json()["recorded"] is True


def test_telemetry_rejects_unknown_event() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/telemetry",
        json={"event": "user.email", "source": "leak@example.com"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 422


def test_telemetry_coerces_unknown_attr_values() -> None:
    sid = _new_session()
    res = client.post(
        f"/api/sessions/{sid}/telemetry",
        json={"event": "material.source_selected", "source": "some-free-text-pii"},
        headers=_session_auth(sid),
    )
    assert res.status_code == 200
    assert res.json()["recorded"] is True
