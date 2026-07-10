"""会話履歴の transcript publish（SANBA 発話・ユーザー認識中/確定）の agent 側テスト。

LiveKit ランタイム無しで、SANBAAgent が web の会話履歴へ流すイベントを検証する:
  - ユーザー音声の認識中（partial）→ 確定（final）を同一 utterance_id で流す（吹き出しを畳む）。
  - SANBA（エージェント）発話を role=assistant の transcript.final で流す（左吹き出し）。
"""

from __future__ import annotations

import asyncio

import pytest
from sanba_shared.repository import SessionRepository

from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.main import SANBAAgent
from sanba_agent.retrieval import GroundingStore


def _agent() -> tuple[SANBAAgent, RecordingTransport]:
    repo = SessionRepository()
    repo._client = None
    transport = RecordingTransport()
    pub = EventPublisher("s1", transport)
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=pub)
    return agent, transport


async def _drain(agent: SANBAAgent) -> None:
    while agent._publish_tasks:
        await asyncio.gather(*list(agent._publish_tasks))


@pytest.mark.asyncio
async def test_user_partial_then_final_share_utterance_id() -> None:
    agent, transport = _agent()

    agent.publish_user_partial("価格の")
    agent.publish_user_partial("価格の安き")
    uid = agent._pending_user_uid
    assert uid is not None

    agent.record_user_final("価格の安きが大事")
    await _drain(agent)

    events = [s["event"] for s in transport.sent]
    partials = [e for e in events if e["type"] == "transcript.partial"]
    finals = [e for e in events if e["type"] == "transcript.final"]
    assert partials and all(e["utterance_id"] == uid for e in partials)
    assert len(finals) == 1
    assert finals[0]["utterance_id"] == uid
    assert finals[0]["role"] == "participant"
    assert finals[0]["text"] == "価格の安きが大事"
    assert agent._pending_user_uid is None


@pytest.mark.asyncio
async def test_agent_utterance_published_as_assistant() -> None:
    agent, transport = _agent()

    agent.publish_agent_utterance("何を規矩としましょう")
    agent.publish_agent_utterance("では価格順で進めます")
    await _drain(agent)

    finals = [s["event"] for s in transport.sent if s["event"]["type"] == "transcript.final"]
    assert [e["role"] for e in finals] == ["assistant", "assistant"]
    assert [e["utterance_id"] for e in finals] == ["a1", "a2"]
    assert finals[0]["text"] == "何を規矩としましょう"
    assert agent.transcript == []


@pytest.mark.asyncio
async def test_publish_helpers_noop_without_publisher() -> None:
    repo = SessionRepository()
    repo._client = None
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore())
    agent.publish_user_partial("x")
    agent.publish_agent_utterance("y")
    assert agent._pending_user_uid is None
    assert agent._agent_utterance_seq == 0


@pytest.mark.asyncio
async def test_transcript_hydrates_from_persisted_utterances() -> None:
    """新プロセスがセッションを引き継ぐとき発話ログから transcript を復元する（sess-29dc6e7e）。"""
    repo = SessionRepository()
    repo._client = None
    first = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore())
    first.record_utterance("participant", "会話ログを表示したい")
    first.record_utterance("participant", "今回のセッション分だけでよい")
    while first._persist_tasks:
        await asyncio.gather(*list(first._persist_tasks))

    second = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore())
    assert second.transcript == [
        "[u1] participant: 会話ログを表示したい",
        "[u2] participant: 今回のセッション分だけでよい",
    ]
    uid = second.record_utterance("participant", "追加の要望です")
    assert uid == "u3", "復元後の採番は既存の発話の続きから振る"


@pytest.mark.asyncio
async def test_transcript_hydration_failure_is_fail_soft() -> None:
    repo = SessionRepository()
    repo._client = None

    def _boom(session_id: str):  # type: ignore[no-untyped-def]
        raise RuntimeError("firestore down")

    repo.list_utterances = _boom  # type: ignore[assignment]
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore())
    assert agent.transcript == []
