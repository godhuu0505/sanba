"""API tests for the invite-gated session flow (issue #8).

These exercise the invite/authorization logic; the Google identity layer
(ADR-0012) is stubbed via a dependency override so a verified user is assumed.
Authentication enforcement itself is covered in test_auth_integration.py.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sanba_api.auth_google import AuthUser, require_user
from sanba_api.main import app

client = TestClient(app)


def _fake_user() -> AuthUser:
    return AuthUser(
        sub="owner-123456789",
        email="owner@example.com",
        email_verified=True,
        name="Owner",
    )


@pytest.fixture(autouse=True)
def _assume_logged_in() -> Iterator[None]:
    """全テストで「検証済みユーザーがログイン済み」を仮定する。"""
    app.dependency_overrides[require_user] = _fake_user
    yield
    app.dependency_overrides.pop(require_user, None)


def _create(roles: list[str]) -> dict:
    return client.post("/api/sessions", json={"roles": roles, "consent_acknowledged": True}).json()


def test_healthz() -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_create_session_mints_invites_per_role() -> None:
    res = client.post(
        "/api/sessions", json={"roles": ["pm", "engineer"], "consent_acknowledged": True}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["session_id"].startswith("sess-")
    assert set(body["invites"]) == {"pm", "engineer"}


def test_create_without_consent_is_rejected() -> None:
    res = client.post("/api/sessions", json={"roles": ["pm"]})
    assert res.status_code == 400


def test_create_then_join_happy_path() -> None:
    created = _create(["pm"])
    invite = created["invites"]["pm"]

    res = client.post(
        "/api/sessions/join",
        json={"invite": invite, "participant_name": "Alice"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["token"]
    assert body["session_id"] == created["session_id"]
    # identity は検証済み sub 由来 (self-申告名ではない) + ルーム内一意の nonce。
    assert body["identity"].startswith("pm-owner-12-")


def test_join_without_valid_invite_is_rejected() -> None:
    res = client.post(
        "/api/sessions/join",
        json={"invite": "not-a-real-invite", "participant_name": "Mallory"},
    )
    assert res.status_code == 403


def test_join_with_tampered_invite_is_rejected() -> None:
    created = _create(["pm"])
    tampered = created["invites"]["pm"][:-2] + "xx"
    res = client.post(
        "/api/sessions/join",
        json={"invite": tampered, "participant_name": "Mallory"},
    )
    assert res.status_code == 403
