"""現在質問のハイドレーションの agent 側 orchestration テスト。

`SANBAAgent.clear_current_question` の id 照合（§5-3）・tombstone 化・`question.cleared`
伝播（§5-5）・current 追跡のリセット（§5-6）を、LiveKit ランタイム無しで検証する。
"""

from __future__ import annotations

import pytest
from livekit.agents.llm import StopResponse
from sanba_shared.repository import SessionRepository

from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.main import ASK_QUESTION_RESTART_REASKS, SANBAAgent
from sanba_agent.retrieval import GroundingStore


def _agent() -> tuple[SANBAAgent, SessionRepository, RecordingTransport, EventPublisher]:
    repo = SessionRepository()
    repo._client = None
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

    doc = repo._mem_questions["s1"]
    assert doc["cleared"] is True
    assert "prompt" not in doc
    ev = transport.sent[-1]["event"]
    assert ev["type"] == "question.cleared"
    assert ev["question_id"] == "q1"
    assert agent.current_question_id is None


@pytest.mark.asyncio
async def test_clear_current_question_id_mismatch_keeps_pointer() -> None:
    agent, repo, transport, _pub = _agent()
    repo.save_current_question("s1", {"id": "q2", "prompt": "p2"}, asked_seq=5)
    agent._current_question_id = "q2"

    await agent.clear_current_question("q1")

    assert repo._mem_questions["s1"]["id"] == "q2"
    assert repo._mem_questions["s1"]["cleared"] is False
    assert transport.sent == []
    assert agent.current_question_id == "q2"


@pytest.mark.asyncio
async def test_ask_question_persists_then_tracks_current() -> None:
    agent, repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "並び順は？", ["関連度順", "新着順"])
    doc = repo._mem_questions["s1"]
    assert doc["cleared"] is False
    assert doc["prompt"] == "並び順は？"
    assert doc["asked_seq"] >= 1
    assert agent.current_question_id == doc["id"]
    assert transport.sent[-1]["event"]["type"] == "question.asked"


@pytest.mark.asyncio
async def test_ask_question_persist_failure_resets_current_tracking() -> None:
    agent, repo, transport, pub = _agent()

    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("firestore down")

    repo.save_current_question = boom  # type: ignore[method-assign]
    ask = type(agent).ask_question.__wrapped__
    res = await ask(agent, None, "氏名は？")
    assert res["asked"]
    assert transport.sent == []
    assert pub.seq == 0
    assert agent.current_question_id is None


@pytest.mark.asyncio
async def test_second_question_same_turn_supersedes_first() -> None:
    agent, repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "Q1?")
    r2 = await ask(agent, None, "Q2?")
    types = [t["event"]["type"] for t in transport.sent]
    assert types == ["question.asked", "question.cleared", "question.asked"]
    assert r1["asked"] != r2["asked"]
    assert agent.current_question_id == r2["asked"]
    assert repo._mem_questions["s1"]["id"] == r2["asked"]
    assert repo._mem_questions["s1"]["cleared"] is False
    assert "note" not in r1, "1問目は畳みかけ注意を返さない"
    assert "note" in r2 and "1ターン" in r2["note"], "2問目は1ターン1問の注意を返す（#374）"


@pytest.mark.asyncio
async def test_options_question_survives_optionless_followup_same_turn() -> None:
    """同一ターンで 選択肢付き→選択肢無し の順に来ても、選択肢付きが残る（#434 task4 / C(a)）。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "並び順は？", ["関連度順", "新着順"])
    transport.sent.clear()
    r2 = await ask(agent, None, "他に何かありますか？")
    types = [t["event"]["type"] for t in transport.sent]
    assert types == [], "選択肢無しの後発は publish しない（現行の選択肢付きを維持）"
    assert agent.current_question_id == r1["asked"]
    assert r2["asked"] == r1["asked"]
    assert "note" in r2 and "スキップ" in r2["note"]


@pytest.mark.asyncio
async def test_optionless_question_is_superseded_by_options_same_turn() -> None:
    """逆順（選択肢無し→選択肢付き）は従来どおり supersede する（C(a)）。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "自由回答の問い")
    r2 = await ask(agent, None, "選択肢の問い", ["A", "B"])
    types = [t["event"]["type"] for t in transport.sent]
    assert types == ["question.asked", "question.cleared", "question.asked"]
    assert agent.current_question_id == r2["asked"]
    assert r1["asked"] != r2["asked"]


@pytest.mark.asyncio
async def test_two_options_questions_same_turn_supersede() -> None:
    """両方とも選択肢付きなら従来どおり後発が supersede する（C(a)）。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "Q1?", ["A", "B"])
    r2 = await ask(agent, None, "Q2?", ["C", "D"])
    types = [t["event"]["type"] for t in transport.sent]
    assert types == ["question.asked", "question.cleared", "question.asked"]
    assert agent.current_question_id == r2["asked"]
    assert r1["asked"] != r2["asked"]


@pytest.mark.asyncio
async def test_question_in_new_turn_is_not_superseded_by_guard() -> None:
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "Q1?")
    agent._user_turn += 1
    transport.sent.clear()
    r2 = await ask(agent, None, "Q2?")
    types = [t["event"]["type"] for t in transport.sent]
    assert types == ["question.asked"]
    assert "note" not in r2, "別ターンの問いは畳みかけではないので注意を返さない"


@pytest.mark.asyncio
async def test_clear_without_publisher_is_noop() -> None:
    repo = SessionRepository()
    repo._client = None
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=None)
    await agent.clear_current_question("q1")


@pytest.mark.asyncio
async def test_same_prompt_reask_same_turn_is_skipped() -> None:
    """同一ターンで同じ問いを再掲しても supersede せず現状維持する（sess-29dc6e7e の暴走対策）。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "Q1?")
    transport.sent.clear()
    r2 = await ask(agent, None, "Q1?")
    assert transport.sent == [], "再掲は publish しない（画面の問いピンを揺らさない）"
    assert r2["asked"] == r1["asked"]
    assert "note" in r2 and "提示済み" in r2["note"]
    assert "stop" not in r2, "1回目の再掲はまだ打ち切らない"


@pytest.mark.asyncio
async def test_same_prompt_repeat_circuit_breaks() -> None:
    """同一問いの再掲が続いたら StopResponse で打ち切る（sess-ffcff138 の livelock 対策）。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "Q1?")
    await ask(agent, None, "Q1?")
    transport.sent.clear()
    with pytest.raises(StopResponse):
        await ask(agent, None, "Q1?")
    assert transport.sent == []

    agent.record_utterance("participant", "回答します")
    r4 = await ask(agent, None, "Q2?")
    assert "note" not in r4, "新しいターンでは再び問いを立てられる"


@pytest.mark.asyncio
async def test_supersede_circuit_breaks_within_turn() -> None:
    """同一ターンの差し替えが上限を超えたら StopResponse で打ち切る（sess-ffcff138 対策）。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "Q1?")
    await ask(agent, None, "Q2?")
    r3 = await ask(agent, None, "Q3?")
    assert r3["asked"] != ""
    transport.sent.clear()
    with pytest.raises(StopResponse):
        await ask(agent, None, "Q4?")
    assert agent.current_question_id == r3["asked"], "現状の問いを維持する"
    assert transport.sent == []

    agent.record_utterance("participant", "回答します")
    r5 = await ask(agent, None, "Q5?")
    assert "note" not in r5, "新しいターンでは再び問いを立てられる"
    assert agent.current_question_id == r5["asked"]


@pytest.mark.asyncio
async def test_question_loop_escalates_to_restart() -> None:
    """再呼び出しがハード上限を超えたら restart フックへエスカレーションする（#468 経路）。"""
    agent, _repo, _transport, _pub = _agent()
    restarts: list[bool] = []
    agent.set_restart_hook(lambda: restarts.append(True))
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "Q1?")
    await ask(agent, None, "Q1?")
    for _ in range(ASK_QUESTION_RESTART_REASKS - 2):
        with pytest.raises(StopResponse):
            await ask(agent, None, "Q1?")
    assert restarts == []
    with pytest.raises(StopResponse):
        await ask(agent, None, "Q1?")
    assert restarts == [True]

    agent.record_utterance("participant", "回答します")
    r = await ask(agent, None, "Q2?")
    assert "note" not in r, "リセット後は新しい問いを立てられる"


@pytest.mark.asyncio
async def test_question_loop_without_restart_hook_only_stops() -> None:
    """restart フック未注入（単体テスト等）でも StopResponse で止まり続ける。"""
    agent, _repo, _transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    await ask(agent, None, "Q1?")
    await ask(agent, None, "Q1?")
    for _ in range(ASK_QUESTION_RESTART_REASKS + 2):
        with pytest.raises(StopResponse):
            await ask(agent, None, "Q1?")


@pytest.mark.asyncio
async def test_same_prompt_with_options_added_still_supersedes() -> None:
    """同じ文言でも選択肢を付け足す再質問は正当な差し替えとして通す。"""
    agent, _repo, transport, _pub = _agent()
    ask = type(agent).ask_question.__wrapped__
    r1 = await ask(agent, None, "並び順は？")
    r2 = await ask(agent, None, "並び順は？", ["関連度順", "新着順"])
    types = [t["event"]["type"] for t in transport.sent]
    assert types == ["question.asked", "question.cleared", "question.asked"]
    assert r2["asked"] != r1["asked"]
    assert agent.current_question_id == r2["asked"]


@pytest.mark.asyncio
async def test_current_question_hydrates_on_new_process() -> None:
    """新プロセスがセッションを引き継ぐとき、未回答の金枠ピンの current 追跡も復元する。"""
    repo = SessionRepository()
    repo._client = None
    repo.save_current_question(
        "s1", {"id": "req_abc-8", "prompt": "並び順は？", "options": []}, asked_seq=12
    )
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=None)
    assert agent.current_question_id == "req_abc-8"
    assert agent._questions["req_abc-8"] == "並び順は？"
    assert agent._question_seq == 8, "採番は引き継いだ id の連番から続ける"
    assert agent._question_asked_turn == agent._user_turn, (
        "復元した未回答質問は現在のターンで提示済みとして扱い、差し替え保護を効かせる"
    )


@pytest.mark.asyncio
async def test_cleared_current_question_restores_seq_but_not_current() -> None:
    """tombstone は current に復元しないが、採番は id 連番から継いで再利用を防ぐ。"""
    repo = SessionRepository()
    repo._client = None
    repo.save_current_question("s1", {"id": "req_x-5", "prompt": "済みの問い"}, asked_seq=3)
    repo.clear_current_question("s1", "req_x-5", cleared_seq=4)
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=None)
    assert agent.current_question_id is None
    assert agent._question_seq == 5, "同じ prompt を再提示しても …-6 になり id 再利用しない"


@pytest.mark.asyncio
async def test_hydrated_options_question_survives_optionless_followup() -> None:
    """復元した選択肢付きピンは、引き継ぎ直後の選択肢なし再質問に潰されない。"""
    repo = SessionRepository()
    repo._client = None
    repo.save_current_question(
        "s1",
        {
            "id": "req_abc-8",
            "prompt": "並び順は？",
            "options": [{"label": "関連度順", "value": "関連度順"}],
        },
        asked_seq=12,
    )
    transport = RecordingTransport()
    pub = EventPublisher("s1", transport)
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=pub)
    ask = type(agent).ask_question.__wrapped__
    r = await ask(agent, None, "他に何かありますか？")
    assert r["asked"] == "req_abc-8", "選択肢付きの復元ピンを維持する"
    assert transport.sent == []
