"""書き込み系 I/O（Firestore 発話保存・grounding 索引）のイベントループ・オフロード。

音声パイプラインのループを塞がないよう、record_utterance の永続化を別スレッドへ逃がす
（読み取り系＝検索/先読みを to_thread に逃がしているのと同じ思想を書き込みにも適用）。
- 分析入力の transcript・採番・publish は同期のまま即時性を保つ。
- ループが無い同期環境（ユニットテスト）では従来どおり即時に永続化する。
- 永続化順は _persist_lock で「発話の到着順」に直列化する。
"""

from __future__ import annotations

import pytest
from sanba_shared.models import AnalysisResult, SessionMeta
from sanba_shared.repository import SessionRepository

from sanba_agent.main import SANBAAgent
from sanba_agent.retrieval import GroundingStore


def _agent() -> SANBAAgent:
    repo = SessionRepository()
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    repo.create_session_doc(SessionMeta(id="s1", title="t", owner_sub="owner", owner_email=""))
    return SANBAAgent("s1", repo, GroundingStore())


def _stub_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    """2 発話目で発火する背景分析を高速スタブへ差し替える（本テストの対象外）。"""

    async def _stub(transcript: str) -> AnalysisResult:
        return AnalysisResult(summary="s", next_question="q?", suggested_answer="a")

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _stub)


def test_sync_context_persists_inline() -> None:
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    assert agent._persist_tasks == set(), "ループが無ければオフロードせず同期実行する"
    assert [u.text for u in agent._repo._mem_utterances["s1"]] == ["請求管理のアプリを作りたい"]
    assert agent._grounding.search("請求管理 アプリ", k=3), "grounding にも索引済み"


@pytest.mark.asyncio
async def test_async_context_offloads_then_drains(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_analysis(monkeypatch)
    agent = _agent()
    agent.record_utterance("participant", "最初の発話")
    agent.record_utterance("participant", "次の発話")

    assert agent.transcript == ["[u1] participant: 最初の発話", "[u2] participant: 次の発話"]
    assert agent._persist_tasks, "音声ループ上では永続化を背景タスクへ逃がす"

    await agent.drain_background_tasks()

    stored = [u.text for u in agent._repo._mem_utterances["s1"]]
    assert stored == ["最初の発話", "次の発話"]
    assert agent._persist_tasks == set(), "ドレン後は永続化タスクが残らない"


@pytest.mark.asyncio
async def test_persist_failure_is_fail_soft(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_analysis(monkeypatch)
    agent = _agent()

    def _boom(session_id: str, utterance: object) -> None:
        raise RuntimeError("firestore down")

    monkeypatch.setattr(agent._repo, "add_utterance", _boom)
    agent.record_utterance("participant", "落ちても会話は続く")
    await agent.drain_background_tasks()

    assert agent.transcript == ["[u1] participant: 落ちても会話は続く"]
