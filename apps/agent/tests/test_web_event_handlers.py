"""web → agent イベント（user.text / user.answered, 契約 §4.5）の会話ターン化テスト。

テキスト入力が音声入力と同じ扱いになること——発話記録（transcript.final）→ 未回答
current のクリア → 読み上げ中断（バージイン同等）→ user ターンとしての応答生成——を、
LiveKit ランタイム無しの偽セッションで検証する（#185 / #181）。
"""

from __future__ import annotations

import asyncio
from typing import Any

from sanba_shared.repository import SessionRepository

from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.main import SANBAAgent, respond_to_answer, respond_to_user_text
from sanba_agent.retrieval import GroundingStore


class FakeAgentSession:
    """AgentSession の代役。interrupt / generate_reply の呼び出し順と引数を記録する。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def interrupt(self) -> None:
        self.calls.append(("interrupt", {}))

    async def generate_reply(self, **kwargs: Any) -> None:
        self.calls.append(("generate_reply", dict(kwargs)))


async def _drain_publishes() -> None:
    """record_utterance の publish は fire-and-forget。数ティック進めて送信を完了させる。"""
    for _ in range(3):
        await asyncio.sleep(0)


def _agent() -> tuple[SANBAAgent, SessionRepository, RecordingTransport]:
    repo = SessionRepository()
    repo._client = None  # メモリ fallback
    transport = RecordingTransport()
    pub = EventPublisher("s1", transport)
    agent = SANBAAgent(session_id="s1", repo=repo, grounding=GroundingStore(), publisher=pub)
    return agent, repo, transport


async def test_user_text_interrupts_then_replies_as_user_turn() -> None:
    # 音声と同じ扱い: 読み上げを中断してから、本文を user ターンとして応答生成する。
    agent, _repo, transport = _agent()
    session = FakeAgentSession()

    await respond_to_user_text(agent, session, "決済は Stripe にしたい", None)  # type: ignore[arg-type]

    assert [name for name, _ in session.calls] == ["interrupt", "generate_reply"]
    _, kwargs = session.calls[-1]
    # instructions への埋め込みではなく user_input（音声転写と同じ user ターン）で渡す。
    assert kwargs == {"user_input": "決済は Stripe にしたい"}
    # 発話として記録され transcript.final が web へ届く（会話履歴に反映される）。
    await _drain_publishes()
    finals = [s["event"] for s in transport.sent if s["event"]["type"] == "transcript.final"]
    assert len(finals) == 1
    assert finals[0]["text"] == "決済は Stripe にしたい"
    assert finals[0]["role"] == "participant"


async def test_user_text_clears_bound_current_question() -> None:
    # §5-6: 受信時点で束ねた current 質問 id を、テキスト回答とみなしてクリアする。
    agent, repo, _transport = _agent()
    repo.save_current_question("s1", {"id": "q1", "prompt": "並び順は？"}, asked_seq=1)
    agent._current_question_id = "q1"
    session = FakeAgentSession()

    await respond_to_user_text(agent, session, "新着順で", "q1")  # type: ignore[arg-type]

    assert repo._mem_questions["s1"]["cleared"] is True
    assert agent.current_question_id is None
    assert [name for name, _ in session.calls] == ["interrupt", "generate_reply"]


async def test_user_text_without_current_question_skips_clear() -> None:
    # current が無ければクリア経路を通らず、応答生成だけが走る。
    agent, repo, _transport = _agent()
    session = FakeAgentSession()

    await respond_to_user_text(agent, session, "こんにちは", None)  # type: ignore[arg-type]

    assert "s1" not in repo._mem_questions
    assert [name for name, _ in session.calls] == ["interrupt", "generate_reply"]


async def test_user_answered_interrupts_and_advances_with_question_context() -> None:
    # 回答も読み上げ中断のうえ、問い本文つきの instructions で要件を一歩進める（#181）。
    agent, repo, transport = _agent()
    repo.save_current_question("s1", {"id": "q1", "prompt": "対象OSは？"}, asked_seq=1)
    agent._current_question_id = "q1"
    agent._questions["q1"] = "対象OSは？"
    session = FakeAgentSession()

    await respond_to_answer(agent, session, "q1", "iOS のみ")  # type: ignore[arg-type]

    assert repo._mem_questions["s1"]["cleared"] is True
    assert [name for name, _ in session.calls] == ["interrupt", "generate_reply"]
    _, kwargs = session.calls[-1]
    assert "対象OSは？" in kwargs["instructions"]
    assert "iOS のみ" in kwargs["instructions"]
    # 回答は「問い本文つき」で発話記録される（Codex P2）。
    await _drain_publishes()
    finals = [s["event"] for s in transport.sent if s["event"]["type"] == "transcript.final"]
    assert any("対象OSは？" in ev["text"] and "iOS のみ" in ev["text"] for ev in finals)
