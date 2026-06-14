"""API smoke tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from kikitori_api.main import app

client = TestClient(app)


def test_healthz() -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_join_creates_session_and_token() -> None:
    res = client.post(
        "/api/sessions/join",
        json={"participant_name": "Alice", "role": "pm"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["token"]
    assert body["session_id"].startswith("sess-")
    assert body["identity"].startswith("pm-")


def test_join_reuses_provided_session_id() -> None:
    res = client.post(
        "/api/sessions/join",
        json={"participant_name": "Bob", "session_id": "sess-fixed", "role": "engineer"},
    )
    assert res.json()["session_id"] == "sess-fixed"
