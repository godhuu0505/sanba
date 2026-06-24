"""管理画面 API のテスト (ADR-0014)。

- require_admin: 許可/非許可 email、未設定フェイルクローズ、dev でも許可リスト照合。
- セッション永続化 → 一覧 → 要件の編集/承認 (出所メタ保全・TTL 状態)。
すべて Firestore 非接続のメモリ fallback で走る (_repo._client is None)。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sanba_shared.models import Priority, Requirement, RequirementCategory

from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.main import _repo, app

client = TestClient(app)


def _user(email: str) -> AuthUser:
    return AuthUser(sub=f"sub-{email}", email=email, email_verified=True, name=email)


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    # 許可リストに admin@example.com を入れる。各テストで login ユーザーを差し替える。
    monkeypatch.setattr(settings, "admin_emails", "admin@example.com")
    # メモリ fallback を毎回クリーンにする (テスト間の汚染を避ける)。
    _repo._mem_sessions.clear()
    _repo._mem_requirements.clear()
    _repo._mem_utterances.clear()
    assert _repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    yield
    app.dependency_overrides.pop(require_user, None)


def _login(email: str) -> None:
    app.dependency_overrides[require_user] = lambda: _user(email)


# ---- require_admin --------------------------------------------------------
def test_non_admin_is_forbidden() -> None:
    _login("nobody@example.com")
    res = client.get("/api/admin/sessions")
    assert res.status_code == 403


def test_admin_is_allowed() -> None:
    _login("admin@example.com")
    res = client.get("/api/admin/sessions")
    assert res.status_code == 200
    assert res.json() == []


def test_admin_email_match_is_case_insensitive() -> None:
    _login("ADMIN@example.com")
    assert client.get("/api/admin/sessions").status_code == 200


def test_missing_admin_emails_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "admin_emails", "")
    _login("admin@example.com")
    assert client.get("/api/admin/sessions").status_code == 503


# ---- セッション永続化と一覧 ----------------------------------------------
def test_create_session_persists_and_lists() -> None:
    _login("admin@example.com")  # owner も admin として作成する
    created = client.post(
        "/api/sessions",
        json={"title": "テスト要件", "roles": ["pm"], "consent_acknowledged": True},
    ).json()
    sid = created["session_id"]

    sessions = client.get("/api/admin/sessions").json()
    assert [s["id"] for s in sessions] == [sid]
    assert sessions[0]["title"] == "テスト要件"
    assert sessions[0]["owner_email"] == "admin@example.com"


def test_requirements_listing_404_for_unknown_session() -> None:
    _login("admin@example.com")
    assert client.get("/api/admin/sessions/nope/requirements").status_code == 404


# ---- 要件の編集・承認 ------------------------------------------------------
def _seed_session_with_requirement(sid: str) -> None:
    from sanba_shared.models import SessionMeta

    _repo.create_session_doc(
        SessionMeta(id=sid, title="t", owner_sub="o", owner_email="o@example.com", roles=["pm"])
    )
    _repo.save_requirement(
        sid,
        Requirement(
            id="r1",
            category=RequirementCategory.FUNCTIONAL,
            statement="ログインできること",
            priority=Priority.MUST,
            source_speaker="customer",
            confidence=0.9,
        ),
    )


def test_edit_requirement_only_touches_allowed_fields() -> None:
    _login("admin@example.com")
    _seed_session_with_requirement("sess-1")
    res = client.patch(
        "/api/admin/sessions/sess-1/requirements/r1",
        json={"statement": "SSO でログイン", "priority": "should"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["statement"] == "SSO でログイン"
    assert body["priority"] == "should"
    # 出所メタは不変。
    assert body["source_speaker"] == "customer"
    assert body["confidence"] == 0.9
    assert body["status"] == "draft"


def test_approve_sets_approver() -> None:
    _login("admin@example.com")
    _seed_session_with_requirement("sess-1")
    res = client.patch(
        "/api/admin/sessions/sess-1/requirements/r1",
        json={"status": "approved"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "approved"
    assert body["approved_by"] == "admin@example.com"
    assert body["approved_at"] is not None


def test_patch_unknown_requirement_404() -> None:
    _login("admin@example.com")
    _seed_session_with_requirement("sess-1")
    res = client.patch(
        "/api/admin/sessions/sess-1/requirements/missing",
        json={"status": "approved"},
    )
    assert res.status_code == 404
