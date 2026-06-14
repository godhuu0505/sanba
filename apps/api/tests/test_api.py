"""API tests for the invite-gated session flow (issue #8)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from kikitori_api.main import app

client = TestClient(app)


def _create(roles: list[str]) -> dict:
    return client.post(
        "/api/sessions", json={"roles": roles, "consent_acknowledged": True}
    ).json()


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
    assert body["identity"].startswith("pm-")


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
