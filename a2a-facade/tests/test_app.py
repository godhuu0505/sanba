from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from sanba_a2a_facade.app import create_app
from sanba_a2a_facade.config import FacadeSettings
from sanba_a2a_facade.jsonrpc import INTERNAL_ERROR, METHOD_NOT_FOUND, PARSE_ERROR


class FakeBackend:
    name = "SANBA SRE Scout"
    description = "read-only investigation"

    def __init__(self, answer: str = "調査結果", error: Exception | None = None) -> None:
        self._answer = answer
        self._error = error
        self.asked: list[str] = []

    def skills(self) -> list[dict[str, Any]]:
        return [{"id": "investigate", "name": "investigate", "description": "x", "tags": []}]

    def ask(self, text: str, *, timeout: float = 300.0) -> str:
        if self._error:
            raise self._error
        self.asked.append(text)
        return self._answer

    def submit(self, text: str) -> str:
        raise NotImplementedError

    def poll(self, task_id: str) -> tuple[str, str | None]:
        raise NotImplementedError


def _client(backend: FakeBackend | None = None) -> TestClient:
    config = FacadeSettings(agent_id="sanba-sre-scout", public_url="https://facade.example.com")
    return TestClient(create_app(backend or FakeBackend(), config))


def _send(text: str = "sess-x を調査") -> dict:
    return {
        "jsonrpc": "2.0",
        "id": "m1",
        "method": "message/send",
        "params": {
            "message": {
                "kind": "message",
                "role": "user",
                "messageId": "m1",
                "parts": [{"kind": "text", "text": text}],
            }
        },
    }


def test_agent_card_reflects_backend_and_public_url():
    card = _client().get("/.well-known/agent-card.json").json()
    assert card["name"] == "SANBA SRE Scout"
    assert card["url"] == "https://facade.example.com/a2a/sanba-sre-scout"
    assert card["capabilities"] == {"streaming": False, "pushNotifications": False}
    assert card["skills"][0]["id"] == "investigate"


def test_healthz():
    assert _client().get("/healthz").json()["status"] == "ok"


def test_message_send_returns_agent_message():
    backend = FakeBackend(answer="110 イベント・エラー 0 件")
    response = _client(backend).post("/a2a/sanba-sre-scout", json=_send()).json()
    assert response["id"] == "m1"
    assert response["result"]["parts"] == [{"kind": "text", "text": "110 イベント・エラー 0 件"}]
    assert backend.asked == ["sess-x を調査"]


def test_unknown_agent_id_is_404():
    assert _client().post("/a2a/other-agent", json=_send()).status_code == 404


def test_unknown_method_returns_jsonrpc_error():
    payload = _send()
    payload["method"] = "message/stream"
    response = _client().post("/a2a/sanba-sre-scout", json=payload).json()
    assert response["error"]["code"] == METHOD_NOT_FOUND


def test_invalid_json_returns_parse_error():
    client = _client()
    response = client.post(
        "/a2a/sanba-sre-scout",
        content=b"not-json",
        headers={"Content-Type": "application/json"},
    ).json()
    assert response["error"]["code"] == PARSE_ERROR


def test_backend_failure_is_fail_soft_internal_error():
    backend = FakeBackend(error=OSError("connection refused"))
    response = _client(backend).post("/a2a/sanba-sre-scout", json=_send()).json()
    assert response["error"]["code"] == INTERNAL_ERROR
    assert "connection refused" not in response["error"]["message"]
