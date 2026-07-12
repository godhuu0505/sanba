from __future__ import annotations

import pytest

from sanba_a2a_facade.backends.holmesgpt import HolmesBackend


def _backend(instructions: str = "") -> HolmesBackend:
    return HolmesBackend(
        "http://localhost:8081/",
        name="SANBA SRE Scout",
        description="read-only investigation",
        instructions=instructions,
    )


def test_ask_returns_analysis(monkeypatch):
    backend = _backend()
    captured: dict = {}

    def fake_post(body: dict, timeout: float) -> dict:
        captured.update(body)
        return {"analysis": "調査結果", "tool_calls": []}

    monkeypatch.setattr(backend, "_post_chat", fake_post)
    assert backend.ask("sess-x を調査") == "調査結果"
    assert captured["ask"] == "sess-x を調査"


def test_ask_always_disables_todowrite(monkeypatch):
    backend = _backend()
    captured: dict = {}
    monkeypatch.setattr(
        backend, "_post_chat", lambda body, timeout: captured.update(body) or {"analysis": "x"}
    )
    backend.ask("q")
    assert captured["behavior_controls"] == {"todowrite_instructions": False}


def test_ask_injects_agent_instructions(monkeypatch):
    backend = _backend(instructions="索引は sanba-analytics-events。term クエリを使う。")
    captured: dict = {}
    monkeypatch.setattr(
        backend, "_post_chat", lambda body, timeout: captured.update(body) or {"analysis": "x"}
    )
    backend.ask("q")
    assert captured["additional_system_prompt"].startswith("索引は sanba-analytics-events")


def test_ask_omits_empty_instructions(monkeypatch):
    backend = _backend()
    captured: dict = {}
    monkeypatch.setattr(
        backend, "_post_chat", lambda body, timeout: captured.update(body) or {"analysis": "x"}
    )
    backend.ask("q")
    assert "additional_system_prompt" not in captured


def test_ask_raises_on_missing_analysis(monkeypatch):
    backend = _backend()
    monkeypatch.setattr(backend, "_post_chat", lambda body, timeout: {"analysis": None})
    with pytest.raises(ValueError):
        backend.ask("q")


def test_task_path_is_not_implemented_until_phase3():
    backend = _backend()
    with pytest.raises(NotImplementedError):
        backend.submit("q")
    with pytest.raises(NotImplementedError):
        backend.poll("task-1")
