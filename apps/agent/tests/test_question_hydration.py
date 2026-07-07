"""現在質問のハイドレーションの agent 側 orchestration テスト。

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
async def test_ask_question_persists_then_tracks_current() -> None:
    # ask_question は現在質問を保存し、§5-6 用の current 追跡を確定する。
    agent, repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__  # function_tool の素の関数
    await ask(agent, None, "並び順は？", ["関連度順", "新着順"])
    doc = repo._mem_questions["s1"]
    assert doc["cleared"] is False
    assert doc["prompt"] == "並び順は？"
    assert doc["asked_seq"] >= 1
    assert agent.current_question_id == doc["id"]
    assert transport.sent[-1]["event"]["type"] == "question.asked"


@pytest.mark.asyncio
async def test_ask_question_persist_failure_resets_current_tracking() -> None:
    # §5-1: 保存失敗時は送信せず、current 追跡も None に戻す（存在しない id への再クリアを防ぐ）。
    agent, repo, transport, pub = _agent()

    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("firestore down")

    repo.save_current_question = boom  # type: ignore[method-assign]
    ask = type(agent).ask_question.__wrapped__
    res = await ask(agent, None, "氏名は？")
    # 会話は止まらない（tool は asked を返す）が、保存できないので送信も seq 消費もしない。
    assert res["asked"]
    assert transport.sent == []
    assert pub.seq == 0
    # current 追跡は巻き戻る（後続発話が存在しない id でクリア試行しない）。
    assert agent.current_question_id is None


@pytest.mark.asyncio
async def test_second_question_same_turn_supersedes_first() -> None:
    # #374: プロンプトは「畳みかけない」と指示済みだが、モデルが従わず同一ターンで 2 問
    # 出すことがある（実セッションで観測）。tool 層で前の金枠を畳んでから新問を出し、
    # 常に最新の 1 問だけを提示する（競合する 2 つの金枠を同時に立てない）。
    agent, repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "Q1?")
    r2 = await ask(agent, None, "Q2?")  # 同一ターン（_user_turn は不変）
    types = [t["event"]["type"] for t in transport.sent]
    # 2 度目は「前問を cleared → 新問を asked」の clean transition になる。
    assert types == ["question.asked", "question.cleared", "question.asked"]
    assert r1["asked"] != r2["asked"]
    assert agent.current_question_id == r2["asked"]
    # Firestore の現在質問も最新（Q2）を指し、未クリア。
    assert repo._mem_questions["s1"]["id"] == r2["asked"]
    assert repo._mem_questions["s1"]["cleared"] is False


@pytest.mark.asyncio
async def test_question_in_new_turn_is_not_superseded_by_guard() -> None:
    # 別ターンでの問いは 1ターン1問ガードの対象外（前ターンの未回答は §5-6 が別途畳む）。
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "Q1?")
    agent._user_turn += 1  # 次のユーザーターンへ進む
    transport.sent.clear()
    await ask(agent, None, "Q2?")
    types = [t["event"]["type"] for t in transport.sent]
    assert types == ["question.asked"]  # ガードは発火せず、新問を出すだけ


@pytest.mark.asyncio
async def test_clear_without_publisher_is_noop() -> None:
    # publisher 未設定でも会話は成立する（クリアは付加価値）。例外を投げない。
    repo = SessionRepository()
    repo._client = None
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=None)
    await agent.clear_current_question("q1")  # no-op
