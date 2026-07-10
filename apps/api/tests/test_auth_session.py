"""サーバサイドセッション（ADR-0060）の統合テスト。

`FastAPI` の TestClient で `/api/session/exchange`, `/api/session/me`, `/api/session`
経路を実際に叩き、Cookie が発行されること、Cookie 経由の後続リクエストが 200 を返すこと、
無効/期限切れセッションが 401 になること、logout で Cookie が破棄されることを検証する。
"""

from __future__ import annotations

import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth_google import AuthUser
from sanba_api.config import settings
from sanba_api.main import app
from sanba_api.routers.session import (
    SESSION_COOKIE_NAME,
    configure_session_store,
    get_session_store,
)
from sanba_api.session_store import InMemorySessionStore


@pytest.fixture(autouse=True)
def _in_memory_store() -> Iterator[InMemorySessionStore]:
    store = InMemorySessionStore()
    configure_session_store(store)
    yield store
    configure_session_store(None)


@pytest.fixture(autouse=True)
def _dev_bypass_off() -> Iterator[None]:
    prev = settings.auth_dev_bypass
    settings.auth_dev_bypass = False
    yield
    settings.auth_dev_bypass = prev


@pytest.fixture
def _configured_oauth() -> Iterator[str]:
    prev = settings.google_oauth_client_id
    settings.google_oauth_client_id = "test-client-id.apps.googleusercontent.com"
    yield settings.google_oauth_client_id
    settings.google_oauth_client_id = prev


@pytest.fixture
def _fake_verifier(monkeypatch: pytest.MonkeyPatch, _configured_oauth: str) -> None:
    def fake_verify(token: str, client_id: str) -> AuthUser:
        if token == "invalid":
            from sanba_api.auth_google import GoogleTokenError

            raise GoogleTokenError("bad token")
        return AuthUser(
            sub="google-sub-123",
            email="user@example.com",
            email_verified=True,
            name="Test User",
        )

    monkeypatch.setattr("sanba_api.routers.session.verify_google_id_token", fake_verify)


def test_exchange_issues_cookie_and_persists_session(_fake_verifier: None) -> None:
    client = TestClient(app)
    res = client.post("/api/session/exchange", json={"id_token": "valid"})
    assert res.status_code == 200
    body = res.json()
    assert body["sub"] == "google-sub-123"
    assert body["email"] == "user@example.com"
    cookie = res.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    store = get_session_store()
    assert isinstance(store, InMemorySessionStore)
    session = store.get(cookie)
    assert session is not None
    assert session.google_sub == "google-sub-123"


def test_exchange_preserves_picture_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    prev_bypass = settings.auth_dev_bypass
    prev_client = settings.google_oauth_client_id
    settings.auth_dev_bypass = False
    settings.google_oauth_client_id = "test-client-id"

    def fake_verify(token: str, client_id: str) -> AuthUser:
        return AuthUser(
            sub="sub-with-picture",
            email="picture@example.com",
            email_verified=True,
            name="Picture User",
            picture="https://example.com/avatar.png",
        )

    monkeypatch.setattr("sanba_api.routers.session.verify_google_id_token", fake_verify)
    try:
        client = TestClient(app)
        res = client.post("/api/session/exchange", json={"id_token": "valid"})
        assert res.status_code == 200
        assert res.json()["picture"] == "https://example.com/avatar.png"

        cookie = res.cookies.get(SESSION_COOKIE_NAME)
        assert cookie is not None
        me = client.get("/api/session/me", cookies={SESSION_COOKIE_NAME: cookie})
        assert me.json()["picture"] == "https://example.com/avatar.png"
    finally:
        settings.auth_dev_bypass = prev_bypass
        settings.google_oauth_client_id = prev_client


def test_exchange_rejects_invalid_id_token(_fake_verifier: None) -> None:
    client = TestClient(app)
    res = client.post("/api/session/exchange", json={"id_token": "invalid"})
    assert res.status_code == 401
    assert res.cookies.get(SESSION_COOKIE_NAME) is None


def test_me_hydrates_from_cookie_and_extends_ttl(_fake_verifier: None) -> None:
    client = TestClient(app)
    ex = client.post("/api/session/exchange", json={"id_token": "valid"})
    cookie = ex.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    res = client.get("/api/session/me", cookies={SESSION_COOKIE_NAME: cookie})
    assert res.status_code == 200
    body = res.json()
    assert body["email"] == "user@example.com"
    assert body["idle_expires_at"] > 0


def test_me_returns_401_without_cookie() -> None:
    client = TestClient(app)
    res = client.get("/api/session/me")
    assert res.status_code == 401


def test_me_returns_401_with_expired_session(
    _fake_verifier: None, _in_memory_store: InMemorySessionStore
) -> None:
    client = TestClient(app)
    ex = client.post("/api/session/exchange", json={"id_token": "valid"})
    cookie = ex.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    session = _in_memory_store.get(cookie)
    assert session is not None
    from dataclasses import replace as dc_replace

    _in_memory_store.create(dc_replace(session, expires_at=int(time.time()) - 10))

    res = client.get("/api/session/me", cookies={SESSION_COOKIE_NAME: cookie})
    assert res.status_code == 401


def test_revoke_clears_cookie_and_invalidates_session(
    _fake_verifier: None, _in_memory_store: InMemorySessionStore
) -> None:
    client = TestClient(app)
    ex = client.post("/api/session/exchange", json={"id_token": "valid"})
    cookie = ex.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    res = client.delete(
        "/api/session",
        cookies={SESSION_COOKIE_NAME: cookie},
        headers={"Origin": "http://localhost:3000"},
    )
    assert res.status_code == 204
    assert _in_memory_store.get(cookie) is None

    hit = client.get("/api/session/me", cookies={SESSION_COOKIE_NAME: cookie})
    assert hit.status_code == 401


def test_exchange_in_dev_bypass_issues_session() -> None:
    prev = settings.auth_dev_bypass
    settings.auth_dev_bypass = True
    try:
        client = TestClient(app)
        res = client.post("/api/session/exchange", json={"id_token": "dev-bypass"})
        assert res.status_code == 200
        assert res.json()["sub"] == "dev-user"
        assert res.cookies.get(SESSION_COOKIE_NAME) is not None
    finally:
        settings.auth_dev_bypass = prev


def test_cookie_authenticates_require_user(_fake_verifier: None) -> None:
    client = TestClient(app)
    ex = client.post("/api/session/exchange", json={"id_token": "valid"})
    cookie = ex.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    res = client.get("/api/sessions/mine", cookies={SESSION_COOKIE_NAME: cookie})
    assert res.status_code == 200


def test_cookie_write_from_disallowed_origin_is_rejected(_fake_verifier: None) -> None:
    client = TestClient(app)
    ex = client.post("/api/session/exchange", json={"id_token": "valid"})
    cookie = ex.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    res = client.delete(
        "/api/session",
        cookies={SESSION_COOKIE_NAME: cookie},
        headers={"Origin": "https://evil.example.com"},
    )
    assert res.status_code == 403


def test_cookie_write_without_origin_is_rejected(_fake_verifier: None) -> None:
    """Origin ヘッダ欠落の Cookie 付き unsafe method は素通りさせず 403 で弾く（SEC-025）。"""
    client = TestClient(app)
    ex = client.post("/api/session/exchange", json={"id_token": "valid"})
    cookie = ex.cookies.get(SESSION_COOKIE_NAME)
    assert cookie is not None

    res = client.delete("/api/session", cookies={SESSION_COOKIE_NAME: cookie})
    assert res.status_code == 403


def test_bearer_write_without_cookie_is_not_origin_checked(_fake_verifier: None) -> None:
    client = TestClient(app)
    res = client.post(
        "/api/session/exchange",
        json={"id_token": "valid"},
        headers={"Origin": "https://evil.example.com"},
    )
    assert res.status_code == 200


def _set_cookie_header_of(res: object) -> str | None:
    headers = getattr(res, "headers", None)
    if headers is None:
        return None
    get_list = getattr(headers, "get_list", None)
    values: list[str] = list(get_list("set-cookie")) if callable(get_list) else []
    for text in values:
        if f"{SESSION_COOKIE_NAME}=" in text:
            return text
    return None


def _set_cookie_domain_of(res: object) -> str | None:
    text = _set_cookie_header_of(res)
    if text is None:
        return None
    for part in text.split(";"):
        token = part.strip()
        if token.lower().startswith("domain="):
            return token.split("=", 1)[1]
    return ""


def _set_cookie_value_of(res: object) -> str | None:
    text = _set_cookie_header_of(res)
    if text is None:
        return None
    prefix = f"{SESSION_COOKIE_NAME}="
    return text.split(";", 1)[0][len(prefix) :]


def test_session_cookie_domain_is_applied_when_configured(_fake_verifier: None) -> None:
    prev = settings.session_cookie_domain
    settings.session_cookie_domain = ".youken.sanba.net"
    try:
        client = TestClient(app)
        res = client.post("/api/session/exchange", json={"id_token": "valid"})
        assert _set_cookie_domain_of(res) == ".youken.sanba.net"
    finally:
        settings.session_cookie_domain = prev


def test_session_cookie_omits_domain_when_unset(_fake_verifier: None) -> None:
    prev = settings.session_cookie_domain
    settings.session_cookie_domain = ""
    try:
        client = TestClient(app)
        res = client.post("/api/session/exchange", json={"id_token": "valid"})
        header = _set_cookie_header_of(res)
        assert header is not None
        assert "domain=" not in header.lower()
    finally:
        settings.session_cookie_domain = prev


def test_logout_delete_cookie_uses_same_domain_as_issue(_fake_verifier: None) -> None:
    prev = settings.session_cookie_domain
    settings.session_cookie_domain = ".youken.sanba.net"
    try:
        client = TestClient(app)
        ex = client.post("/api/session/exchange", json={"id_token": "valid"})
        assert _set_cookie_domain_of(ex) == ".youken.sanba.net"

        sid = _set_cookie_value_of(ex)
        assert sid
        rev = client.delete(
            "/api/session",
            cookies={SESSION_COOKIE_NAME: sid},
            headers={"Origin": "http://localhost:3000"},
        )
        assert rev.status_code == 204
        assert _set_cookie_domain_of(rev) == ".youken.sanba.net"
    finally:
        settings.session_cookie_domain = prev
