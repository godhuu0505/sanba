"""ルーム作成 allowlist（ADR-0012 §3）とログイン nonce 束縛（ADR-0046）の結線テスト。

`require_user` を override して本人確認を固定し、`settings` を monkeypatch して allowlist /
nonce フラグの各経路（許可・拒否・欠落・不一致）を検証する。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth import create_auth_nonce
from sanba_api.auth_google import AuthUser, require_user
from sanba_api.config import settings
from sanba_api.main import app

client = TestClient(app)

_CREATE_BODY = {"roles": ["pm"], "consent_acknowledged": True}


def _user(email: str = "user@example.com", nonce: str | None = None) -> AuthUser:
    return AuthUser(sub="sub-1", email=email, email_verified=True, name="U", nonce=nonce)


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    yield
    app.dependency_overrides.pop(require_user, None)


def _login_as(user: AuthUser) -> None:
    app.dependency_overrides[require_user] = lambda: user


# ── ルーム作成 allowlist (ADR-0012 §3) ─────────────────────────────────────────


def test_create_denied_for_non_allowlisted(monkeypatch) -> None:
    monkeypatch.setattr(settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(settings, "require_login_nonce", False, raising=True)
    monkeypatch.setattr(settings, "admin_emails", "", raising=True)
    monkeypatch.setattr(settings, "room_creator_allowlist", "team.example", raising=True)
    _login_as(_user("outsider@gmail.com"))

    res = client.post("/api/sessions", json=_CREATE_BODY)
    assert res.status_code == 403


def test_create_allowed_for_allowlisted_domain(monkeypatch) -> None:
    monkeypatch.setattr(settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(settings, "require_login_nonce", False, raising=True)
    monkeypatch.setattr(settings, "admin_emails", "", raising=True)
    monkeypatch.setattr(settings, "room_creator_allowlist", "team.example", raising=True)
    _login_as(_user("member@team.example"))

    res = client.post("/api/sessions", json=_CREATE_BODY)
    assert res.status_code == 200
    assert res.json()["session_id"].startswith("sess-")


def test_create_unrestricted_when_allowlist_empty(monkeypatch) -> None:
    """allowlist 空なら現行どおり誰でも作成可（後方互換）。"""
    monkeypatch.setattr(settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(settings, "require_login_nonce", False, raising=True)
    monkeypatch.setattr(settings, "admin_emails", "", raising=True)
    monkeypatch.setattr(settings, "room_creator_allowlist", "", raising=True)
    _login_as(_user("anyone@gmail.com"))

    assert client.post("/api/sessions", json=_CREATE_BODY).status_code == 200


# ── ログイン nonce 束縛 (ADR-0046) ─────────────────────────────────────────────


def test_create_off_by_default_ignores_nonce(monkeypatch) -> None:
    """require_login_nonce=false（既定）では nonce 無しでも作成できる（挙動不変）。"""
    monkeypatch.setattr(settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(settings, "require_login_nonce", False, raising=True)
    monkeypatch.setattr(settings, "room_creator_allowlist", "", raising=True)
    _login_as(_user(nonce=None))

    assert client.post("/api/sessions", json=_CREATE_BODY).status_code == 200


def test_create_requires_nonce_when_enabled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "auth_dev_bypass", False, raising=True)
    monkeypatch.setattr(settings, "require_login_nonce", True, raising=True)
    monkeypatch.setattr(settings, "room_creator_allowlist", "", raising=True)
    raw, envelope = create_auth_nonce(settings.session_signing_secret, 600)
    _login_as(_user(nonce=raw))

    # nonce ヘッダ欠落 → 401。
    assert client.post("/api/sessions", json=_CREATE_BODY).status_code == 401
    # 正しい envelope かつ claim 一致 → 200。
    ok = client.post("/api/sessions", json=_CREATE_BODY, headers={"X-Auth-Nonce": envelope})
    assert ok.status_code == 200
    # claim 不一致（別の nonce の envelope）→ 401。
    _, other = create_auth_nonce(settings.session_signing_secret, 600)
    bad = client.post("/api/sessions", json=_CREATE_BODY, headers={"X-Auth-Nonce": other})
    assert bad.status_code == 401


def test_dev_bypass_skips_nonce_even_when_enabled(monkeypatch) -> None:
    """ローカル dev bypass は nonce を持たないため素通し（require_login_nonce=true でも）。"""
    monkeypatch.setattr(settings, "auth_dev_bypass", True, raising=True)
    monkeypatch.setattr(settings, "require_login_nonce", True, raising=True)
    monkeypatch.setattr(settings, "room_creator_allowlist", "", raising=True)
    # dev bypass では require_user 自体が固定 dev identity を返すため override しない。
    assert client.post("/api/sessions", json=_CREATE_BODY).status_code == 200


def test_auth_nonce_endpoint_roundtrips() -> None:
    res = client.get("/api/auth/nonce")
    assert res.status_code == 200
    body = res.json()
    from sanba_api.auth import verify_auth_nonce

    assert verify_auth_nonce(body["token"], settings.session_signing_secret) == body["nonce"]
