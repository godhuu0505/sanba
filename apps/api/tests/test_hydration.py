"""Tests for hydration & export APIs (Issue #100, contract §4).

トークン認可（join 済みトークン必須）と、要件/検知のスナップショット整形・起票を検証する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth import create_session_token
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.main import _read_repo, app

client = TestClient(app)


def _fake_user() -> AuthUser:
    return AuthUser(sub="owner-123456789", email="o@example.com", email_verified=True, name="Owner")


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    app.dependency_overrides[require_user] = _fake_user
    # 各テストはインメモリ読み出しを使う（Firestore 無し環境）。
    _read_repo._mem_requirements.clear()
    _read_repo._mem_detections.clear()
    yield
    app.dependency_overrides.pop(require_user, None)


def _token(session_id: str, role: str = "pm") -> str:
    return create_session_token(
        session_id, "owner-123456789", role, settings.session_signing_secret, 3600
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ── 認可 ──────────────────────────────────────────────────────────────────
def test_requirements_requires_session_token() -> None:
    res = client.get("/api/sessions/sess-1/requirements")
    assert res.status_code == 401


def test_requirements_rejects_token_for_other_session() -> None:
    res = client.get("/api/sessions/sess-1/requirements", headers=_auth(_token("sess-OTHER")))
    assert res.status_code == 403


def test_requirements_rejects_tampered_token() -> None:
    tampered = _token("sess-1")[:-2] + "xx"
    res = client.get("/api/sessions/sess-1/requirements", headers=_auth(tampered))
    assert res.status_code == 403


# ── GET /requirements（P0）────────────────────────────────────────────────
def test_requirements_snapshot_shape() -> None:
    _read_repo._seed_requirement(
        "sess-1",
        {
            "id": "r1",
            "statement": "キーワード検索を新設する",
            "category": "functional",
            "priority": "must",
            "confidence": 0.9,
            "source_speaker": "顧客",
        },
    )
    res = client.get("/api/sessions/sess-1/requirements", headers=_auth(_token("sess-1")))
    assert res.status_code == 200
    body = res.json()
    assert body["seq"] == 0
    assert len(body["items"]) == 1
    item = body["items"][0]
    # 契約 §3 の requirement 形（citations / status 補完）。
    assert item["id"] == "r1"
    assert item["priority"] == "must"
    assert item["citations"] == []
    assert item["status"] == "confirmed"


# ── GET /detections?open=1（P1）───────────────────────────────────────────
def test_detections_returns_only_unresolved() -> None:
    _read_repo._seed_detection(
        "sess-2", {"id": "d1", "kind": "gap", "summary": "性能未確認", "resolved": False}
    )
    _read_repo._seed_detection(
        "sess-2", {"id": "d2", "kind": "contradiction", "summary": "解消済み", "resolved": True}
    )
    res = client.get("/api/sessions/sess-2/detections?open=1", headers=_auth(_token("sess-2")))
    assert res.status_code == 200
    items = res.json()["items"]
    assert [d["id"] for d in items] == ["d1"]


# ── POST /export（P1）──────────────────────────────────────────────────────
def test_export_disabled_by_default() -> None:
    res = client.post("/api/sessions/sess-3/export", headers=_auth(_token("sess-3")))
    assert res.status_code == 200
    body = res.json()
    assert body["exported"] is False
    assert body["reason"]
