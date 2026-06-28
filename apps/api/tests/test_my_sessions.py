"""本人セッション一覧 API (GET /api/sessions/mine) のテスト (#250)。

- 認可は本人限定: 呼び出しユーザーの owner_sub と一致するものだけ返る (他人のは出ない)。
- idToken 必須: require_user をオーバーライドせず、本番相当構成で未ログインなら 401。
- 並びは created_at 降順、PII (owner_email) はレスポンスに含めない。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import SessionMeta

from sanba_api import auth_google
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import _repo, app

client = TestClient(app)


def _user(sub: str, email: str) -> AuthUser:
    return AuthUser(sub=sub, email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    _repo._mem_sessions.clear()
    assert _repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)


def _login(sub: str, email: str = "u@example.com") -> None:
    app.dependency_overrides[require_user] = lambda: _user(sub, email)


def _seed(sid: str, owner_sub: str, *, created: datetime, title: str = "t") -> None:
    _repo.create_session_doc(
        SessionMeta(
            id=sid,
            title=title,
            owner_sub=owner_sub,
            owner_email=f"{owner_sub}@example.com",
            roles=["pm"],
            created_at=created,
        )
    )


# ---- 認可: 本人限定 -------------------------------------------------------
def test_returns_only_callers_sessions() -> None:
    _seed("sess-mine-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _seed("sess-other", "bob", created=datetime(2024, 6, 21, tzinfo=UTC))
    _login("alice")

    res = client.get("/api/sessions/mine")
    assert res.status_code == 200
    body = res.json()
    assert [s["id"] for s in body] == ["sess-mine-1"]


def test_empty_when_no_sessions() -> None:
    _seed("sess-other", "bob", created=datetime(2024, 6, 21, tzinfo=UTC))
    _login("alice")
    assert client.get("/api/sessions/mine").json() == []


def test_sorted_by_created_at_desc() -> None:
    _seed("old", "alice", created=datetime(2024, 1, 1, tzinfo=UTC))
    _seed("new", "alice", created=datetime(2024, 12, 31, tzinfo=UTC))
    _seed("mid", "alice", created=datetime(2024, 6, 15, tzinfo=UTC))
    _login("alice")

    body = client.get("/api/sessions/mine").json()
    assert [s["id"] for s in body] == ["new", "mid", "old"]


def test_response_omits_pii_and_exposes_finalized() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC), title="新機能要件定義")
    _login("alice")

    row = client.get("/api/sessions/mine").json()[0]
    assert row["title"] == "新機能要件定義"
    assert row["finalized"] is False
    # PII (owner_email/owner_sub) はレスポンスに載せない (最小権限)。
    assert "owner_email" not in row
    assert "owner_sub" not in row


def test_finalized_flag_reflects_status() -> None:
    _seed("sess-1", "alice", created=datetime(2024, 6, 20, tzinfo=UTC))
    _repo.finalize_session("sess-1", confirmed_count=2, finalized_requirement_ids=["r1", "r2"])
    _login("alice")

    row = client.get("/api/sessions/mine").json()[0]
    assert row["status"] == "finalized"
    assert row["finalized"] is True


# ---- 認可: idToken 必須 ---------------------------------------------------
def test_requires_login_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """client_id 設定済み・bypass off で未ログイン (Bearer 無し) なら 401。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    assert client.get("/api/sessions/mine").status_code == 401


def test_invalid_bearer_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """壊れた ID トークンはサーバ検証で 401 になる。"""
    monkeypatch.setattr(auth_google.settings, "google_oauth_client_id", "cid", raising=True)
    monkeypatch.setattr(auth_google.settings, "auth_dev_bypass", False, raising=True)
    res = client.get("/api/sessions/mine", headers={"Authorization": "Bearer not-a-real-token"})
    assert res.status_code == 401
