"""本番調査委譲（issue #547）の off-loop 実行と delegate_investigation ツールのテスト。

LiveKit ランタイム無しで、run_investigation の会話注入（untrusted fence・release・失敗時の
一言）と、ツールの三重ゲート・多重委譲抑止・injector 起動を検証する。
"""

from __future__ import annotations

from typing import Any

import pytest
from sanba_shared.repository import SessionRepository

from sanba_agent import main
from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.holmes_delegation import InvestigationResult
from sanba_agent.main import SANBAAgent, run_investigation
from sanba_agent.retrieval import GroundingStore


class FakeSession:
    async def interrupt(self) -> None:
        return None

    async def generate_reply(self, **kwargs: Any) -> None:
        return None


def _guard_recorder():
    calls: list[dict[str, Any]] = []

    async def guard(*, kind: str, reinject: str | None, **gen: Any) -> None:
        calls.append({"kind": kind, "reinject": reinject, **gen})

    return guard, calls


class FakeAgent:
    def __init__(self) -> None:
        self.session_id = "s1"
        self.released = 0

    def release_investigation(self) -> None:
        self.released += 1


class FakeDelegator:
    def __init__(self, result: InvestigationResult) -> None:
        self._result = result
        self.asked: list[str] = []
        self.callers: list[str] = []

    async def investigate(self, question: str, *, caller: str = "") -> InvestigationResult:
        self.asked.append(question)
        self.callers.append(caller)
        return self._result


@pytest.mark.asyncio
async def test_run_investigation_injects_fenced_result_and_releases():
    guard, calls = _guard_recorder()
    agent = FakeAgent()
    delegator = FakeDelegator(InvestigationResult(ok=True, text="5xx は 0 件\n直近1時間で異常なし"))
    await run_investigation(agent, FakeSession(), "5xx はある?", guard, delegator)  # type: ignore[arg-type]
    assert delegator.asked == ["5xx はある?"]
    assert delegator.callers == ["s1"]
    assert agent.released == 1
    assert len(calls) == 1
    call = calls[0]
    assert call["kind"] == "investigation_result"
    assert "5xx は 0 件" in call["instructions"]
    assert "<sre-investigation>" in call["instructions"]
    assert call["reinject"] == call["instructions"]


@pytest.mark.asyncio
async def test_run_investigation_failure_notifies_and_releases():
    guard, calls = _guard_recorder()
    agent = FakeAgent()
    delegator = FakeDelegator(InvestigationResult(ok=False, error="boom"))
    await run_investigation(agent, FakeSession(), "q", guard, delegator)  # type: ignore[arg-type]
    assert agent.released == 1
    assert calls[0]["kind"] == "investigation_error"
    assert calls[0]["reinject"] is None
    assert "boom" not in calls[0]["instructions"]


def _real_agent() -> SANBAAgent:
    repo = SessionRepository()
    repo._client = None
    pub = EventPublisher("s1", RecordingTransport())
    return SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=pub)


def _configure_operator(agent: SANBAAgent, monkeypatch) -> None:
    agent._owner_email = "ops@sanba.example.com"
    agent._allow_repo_grounding = True
    monkeypatch.setattr(main.settings, "holmesgpt_agent_enabled", True)
    monkeypatch.setattr(main.settings, "holmesgpt_agent_base_url", "https://facade.example.com")
    monkeypatch.setattr(main.settings, "admin_emails", "ops@sanba.example.com")


@pytest.mark.asyncio
async def test_delegate_investigation_denied_for_non_operator():
    agent = _real_agent()
    dispatched: list[str] = []
    agent.set_investigation_injector(dispatched.append)
    tool = type(agent).delegate_investigation.__wrapped__
    result = await tool(agent, None, "本番のエラーを調べて")
    assert result["accepted"] is False
    assert result["reason"] == "not_allowed"
    assert dispatched == []


@pytest.mark.asyncio
async def test_delegate_investigation_accepts_once_then_rejects_while_in_flight(monkeypatch):
    agent = _real_agent()
    _configure_operator(agent, monkeypatch)
    dispatched: list[str] = []
    agent.set_investigation_injector(dispatched.append)
    tool = type(agent).delegate_investigation.__wrapped__

    first = await tool(agent, None, "直近1時間の 5xx を調べて")
    assert first["accepted"] is True
    assert dispatched == ["直近1時間の 5xx を調べて"]

    second = await tool(agent, None, "ついでにメモリも")
    assert second["accepted"] is False
    assert second["reason"] == "in_flight"

    agent.release_investigation()
    third = await tool(agent, None, "再調査して")
    assert third["accepted"] is True
    assert dispatched[-1] == "再調査して"


@pytest.mark.asyncio
async def test_delegate_investigation_unavailable_without_injector(monkeypatch):
    agent = _real_agent()
    _configure_operator(agent, monkeypatch)
    tool = type(agent).delegate_investigation.__wrapped__
    result = await tool(agent, None, "調べて")
    assert result["accepted"] is False
    assert result["reason"] == "unavailable"
