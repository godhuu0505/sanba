from __future__ import annotations

from sanba_external_agents.holmesgpt.client import HolmesAgentClient
from sanba_external_agents.holmesgpt.config import HolmesgptAgentSettings


def test_ask_is_noop_when_unconfigured():
    client = HolmesAgentClient(HolmesgptAgentSettings(enabled=False))
    result = client.ask("sess-x を調査して")
    assert result.delegated is False
    assert result.error == "holmesgpt_agent_not_configured"


def test_configured_requires_enabled_and_base_url():
    assert HolmesgptAgentSettings(enabled=True, base_url="").configured is False
    assert HolmesgptAgentSettings(enabled=False, base_url="http://x").configured is False
    assert HolmesgptAgentSettings(enabled=True, base_url="http://x").configured is True


def test_timeout_default_covers_agentic_investigation():
    assert HolmesgptAgentSettings().request_timeout_seconds == 300.0


def test_ask_extracts_text_from_a2a_message(monkeypatch):
    client = HolmesAgentClient(HolmesgptAgentSettings(enabled=True, base_url="http://facade"))
    response = {
        "jsonrpc": "2.0",
        "id": "m1",
        "result": {
            "kind": "message",
            "role": "agent",
            "parts": [{"kind": "text", "text": "調査結果です"}],
        },
    }
    monkeypatch.setattr(client, "_send", lambda question: response)
    result = client.ask("sess-x を調査して")
    assert result.delegated is True
    assert result.text == "調査結果です"
    assert result.raw == response


def test_ask_is_fail_soft_on_transport_error(monkeypatch):
    client = HolmesAgentClient(HolmesgptAgentSettings(enabled=True, base_url="http://facade"))

    def boom(question: str) -> dict:
        raise OSError("connection refused")

    monkeypatch.setattr(client, "_send", boom)
    result = client.ask("sess-x を調査して")
    assert result.delegated is False
    assert "connection refused" in (result.error or "")
