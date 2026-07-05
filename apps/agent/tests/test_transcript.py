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
    repo._client = None  # メモリ fallback
    transport = RecordingTransport()
    pub = EventPublisher("s1", transport)
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=pub)
    return agent, transport


async def _drain(agent: SANBAAgent) -> None:
    # fire-and-forget の publish タスク（_publish）を完了させる。
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
    # partial（認識中）と final（確定）は同一 utterance_id を使い web で 1 吹き出しに畳む。
    assert partials and all(e["utterance_id"] == uid for e in partials)
    assert len(finals) == 1
    assert finals[0]["utterance_id"] == uid
    assert finals[0]["role"] == "participant"
    assert finals[0]["text"] == "価格の安きが大事"
    # 確定後は次の発話に備えて認識中 id をリセットする。
    assert agent._pending_user_uid is None


@pytest.mark.asyncio
async def test_agent_utterance_published_as_assistant() -> None:
    agent, transport = _agent()

    agent.publish_agent_utterance("何を規矩としましょう")
    agent.publish_agent_utterance("では価格順で進めます")
    await _drain(agent)

    finals = [s["event"] for s in transport.sent if s["event"]["type"] == "transcript.final"]
    assert [e["role"] for e in finals] == ["assistant", "assistant"]
    # participant の u{n} と衝突しない a{n} 空間で採番する。
    assert [e["utterance_id"] for e in finals] == ["a1", "a2"]
    assert finals[0]["text"] == "何を規矩としましょう"
    # SANBA 発話は分析用 transcript には載せない（LLM 応答は要件抽出の入力ではない）。
    assert agent.transcript == []


@pytest.mark.asyncio
async def test_publish_helpers_noop_without_publisher() -> None:
    repo = SessionRepository()
    repo._client = None
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore())
    # publisher 未設定でも例外を出さず、id 採番も進めない。
    agent.publish_user_partial("x")
    agent.publish_agent_utterance("y")
    assert agent._pending_user_uid is None
    assert agent._agent_utterance_seq == 0
