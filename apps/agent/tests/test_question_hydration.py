"""現在質問のハイドレーション（#212 / ADR-0020）の agent 側 orchestration テスト。

`SANBAAgent.clear_current_question` の id 照合（§5-3）・tombstone 化・`question.cleared`
伝播（§5-5）・current 追跡のリセット（§5-6）を、LiveKit ランタイム無しで検証する。
"""

from __future__ import annotations

import pytest
from sanba_shared.repository import SessionRepository

from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.main import SANBAAgent
from sanba_agent.retrieval import GroundingStore


def _agent() -> tuple[SANBAAgent, SessionRepository, RecordingTransport, EventPublisher]:
    repo = SessionRepository()
    repo._client = None  # メモリ fallback
    transport = RecordingTransport()
    pub = EventPublisher("s1", transport)
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=pub)
    return agent, repo, transport, pub


@pytest.mark.asyncio
async def test_clear_current_question_tombstones_and_publishes() -> None:
    agent, repo, transport, _pub = _agent()
    repo.save_current_question("s1", {"id": "q1", "prompt": "並び順は？"}, asked_seq=1)
    agent._current_question_id = "q1"

    await agent.clear_current_question("q1")

    # tombstone 化（物理削除しない / §5-9）。
    doc = repo._mem_questions["s1"]
    assert doc["cleared"] is True
    assert "prompt" not in doc
    # question.cleared が全参加者へ伝播する（§5-5）。
    ev = transport.sent[-1]["event"]
    assert ev["type"] == "question.cleared"
    assert ev["question_id"] == "q1"
    # current 追跡がリセットされ、後続の音声/テキストが同じ問いを再クリアしない（§5-6）。
    assert agent.current_question_id is None


@pytest.mark.asyncio
async def test_clear_current_question_id_mismatch_keeps_pointer() -> None:
    # §5-3: current が q2 のとき、古い q1 回答ではクリアも publish もしない。
    agent, repo, transport, _pub = _agent()
    repo.save_current_question("s1", {"id": "q2", "prompt": "p2"}, asked_seq=5)
    agent._current_question_id = "q2"

    await agent.clear_current_question("q1")

    assert repo._mem_questions["s1"]["id"] == "q2"
    assert repo._mem_questions["s1"]["cleared"] is False
    assert transport.sent == []  # 新しい問いを消さない＝publish しない
    assert agent.current_question_id == "q2"


@pytest.mark.asyncio
async def test_clear_without_publisher_is_noop() -> None:
    # publisher 未設定でも会話は成立する（クリアは付加価値）。例外を投げない。
    repo = SessionRepository()
    repo._client = None
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=None)
    await agent.clear_current_question("q1")  # no-op
