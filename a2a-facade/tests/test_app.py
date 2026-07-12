from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from sanba_a2a_facade.app import create_app
from sanba_a2a_facade.config import FacadeSettings

VERSION_HEADERS = {"A2A-Version": "0.3"}


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


def _send(text: str = "sess-x を調査", request_id: str = "m1") -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "message/send",
        "params": {
            "message": {
                "messageId": request_id,
                "role": "user",
                "parts": [{"text": text}],
            }
        },
    }


def _post(client: TestClient, payload: dict, agent_id: str = "sanba-sre-scout"):
    return client.post(f"/a2a/{agent_id}", json=payload, headers=VERSION_HEADERS)


def test_agent_card_reflects_backend_and_public_url():
    card = _client().get("/.well-known/agent-card.json").json()
    assert card["name"] == "SANBA SRE Scout"
    assert card["url"] == "https://facade.example.com/a2a/sanba-sre-scout"
    assert card["capabilities"]["streaming"] is False
    assert card["skills"][0]["id"] == "investigate"


def test_healthz():
    assert _client().get("/healthz").json()["status"] == "ok"


def test_message_send_returns_completed_task_with_answer():
    backend = FakeBackend(answer="110 イベント・エラー 0 件")
    result = _post(_client(backend), _send()).json()["result"]
    assert result["kind"] == "task"
    assert result["status"]["state"] == "completed"
    assert result["artifacts"][0]["parts"][0]["text"] == "110 イベント・エラー 0 件"
    assert backend.asked == ["sess-x を調査"]


def test_unknown_agent_id_is_404():
    assert _post(_client(), _send(), agent_id="other-agent").status_code == 404


def test_backend_failure_yields_failed_task_without_leaking_error():
    backend = FakeBackend(error=OSError("connection refused"))
    result = _post(_client(backend), _send()).json()["result"]
    assert result["status"]["state"] == "failed"
    assert "connection refused" not in str(result)
