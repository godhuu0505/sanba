"""バックグラウンド分析（ADR-0037 段階B）のテスト。

AnalysisScheduler の debounce（2 件差分 + 20 秒間隔）はクロック注入で決定的に検証し、
SANBAAgent 統合では「背景実行が検知を publish する」「ツールは新しい背景結果を
即返しして LLM 往復を重複させない」「差分が溜まったら同期フォールバックする」を
LiveKit ランタイム無しで検証する。
"""

from __future__ import annotations

import pytest
from sanba_shared.models import AnalysisResult, SessionMeta
from sanba_shared.repository import SessionRepository

from sanba_agent.background import AnalysisScheduler
from sanba_agent.events import EventPublisher, RecordingTransport
from sanba_agent.main import SANBAAgent
from sanba_agent.retrieval import GroundingStore


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_needs_min_new_utterances() -> None:
    s = AnalysisScheduler(clock=FakeClock())
    assert s.note_utterance() is False
    assert s.note_utterance() is True


def test_running_blocks_new_start() -> None:
    s = AnalysisScheduler(clock=FakeClock())
    s.note_utterance()
    s.note_utterance()
    s.start()
    assert s.pending == 0
    assert s.note_utterance() is False
    assert s.note_utterance() is False


def test_min_interval_blocks_until_elapsed() -> None:
    clock = FakeClock()
    s = AnalysisScheduler(clock=clock)
    s.note_utterance()
    s.note_utterance()
    s.start()
    s.finish()
    s.note_utterance()
    assert s.note_utterance() is False
    clock.advance(20.0)
    assert s.note_utterance() is True


def test_finish_requests_followup_only_when_due() -> None:
    clock = FakeClock()
    s = AnalysisScheduler(clock=clock)
    s.note_utterance()
    s.note_utterance()
    s.start()
    s.note_utterance()
    s.note_utterance()
    assert s.finish() is False
    s.start()
    s.note_utterance()
    s.note_utterance()
    clock.advance(20.0)
    assert s.finish() is True


def _agent(transport: RecordingTransport | None = None) -> SANBAAgent:
    repo = SessionRepository()
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback 前提"
    repo.create_session_doc(SessionMeta(id="s1", title="t", owner_sub="owner", owner_email=""))
    publisher = EventPublisher("s1", transport) if transport is not None else None
    return SANBAAgent("s1", repo, GroundingStore(), publisher=publisher)


def _stub_analysis(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """analyze_transcript を高速スタブに差し替え、呼び出し transcript を記録する。"""
    calls: list[str] = []

    async def _stub(transcript: str) -> AnalysisResult:
        calls.append(transcript)
        return AnalysisResult(
            summary="s",
            open_topics=["性能・レイテンシの要件"],
            next_question="応答時間の目標はありますか？",
            suggested_answer="（例）1 秒以内",
        )

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _stub)
    return calls


@pytest.mark.asyncio
async def test_background_analysis_publishes_detections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _stub_analysis(monkeypatch)
    transport = RecordingTransport()
    agent = _agent(transport)
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None, "2 件目の確定発話で背景分析が発火する"
    await task
    assert len(calls) == 1
    types = [t["event"]["type"] for t in transport.sent]
    assert "detection.gap" in types, "背景実行でも検知カードへ publish される"
    statuses = [
        t["event"]["payload"]["phase"] for t in transport.sent if t["event"]["type"] == "status"
    ]
    assert "deliberating" not in statuses


@pytest.mark.asyncio
async def test_tool_returns_fresh_background_result_without_rerun(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _stub_analysis(monkeypatch)
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None
    await task
    assert len(calls) == 1

    tool = type(agent).analyze_requirements.__wrapped__
    result = await tool(agent, None)
    assert len(calls) == 1, "新しい背景結果があれば LLM 往復を重複させない"
    assert result["next_question"] == "応答時間の目標はありますか？"


@pytest.mark.asyncio
async def test_tool_falls_back_to_sync_when_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _stub_analysis(monkeypatch)
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None
    await task
    agent.record_utterance("participant", "月末に一括処理があります")
    agent.record_utterance("participant", "端末はスマホが中心です")
    assert agent._analysis_task is None or agent._analysis_task.done()

    tool = type(agent).analyze_requirements.__wrapped__
    await tool(agent, None)
    assert len(calls) == 2, "鮮度切れなら同期フォールバックで最新化する"
    assert "スマホ" in calls[1], "フォールバックは最新 transcript を分析する"


@pytest.mark.asyncio
async def test_background_analysis_timeout_is_fail_soft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    calls: list[str] = []

    async def _hang(transcript: str) -> AnalysisResult:
        calls.append(transcript)
        if len(calls) == 1:
            await asyncio.sleep(60)
        return AnalysisResult(summary="s", next_question="q?", suggested_answer="a")

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _hang)
    monkeypatch.setattr("sanba_agent.main.ANALYSIS_TIMEOUT_SECONDS", 0.05)
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None
    await task
    assert agent._last_analysis is None

    tool = type(agent).analyze_requirements.__wrapped__
    result = await tool(agent, None)
    assert result["next_question"] == "q?", "同期フォールバックが最新化を保証する"
    assert len(calls) == 2


def _seed_requirement(agent: SANBAAgent, statement: str = "検索を新設する") -> None:
    from sanba_shared.models import Priority, Requirement, RequirementCategory

    agent._repo.save_requirement(
        agent._session_id,
        Requirement(
            id=f"req-{statement}",
            statement=statement,
            category=RequirementCategory.FUNCTIONAL,
            priority=Priority.MUST,
        ),
    )


@pytest.mark.asyncio
async def test_propose_session_end_gated_on_open_detections() -> None:
    transport = RecordingTransport()
    agent = _agent(transport)
    _seed_requirement(agent)
    propose = type(agent).propose_session_end.__wrapped__

    agent._published_gaps.add("g1")
    declined = await propose(agent, None)
    assert declined["proposed"] is False
    assert declined["reason"] == "open_detections"
    assert not any(t["event"]["type"] == "session.end_proposed" for t in transport.sent)

    agent._published_gaps.clear()
    proposed = await propose(agent, None)
    assert proposed["proposed"] is True
    assert any(t["event"]["type"] == "session.end_proposed" for t in transport.sent)


@pytest.mark.asyncio
async def test_propose_session_end_refused_before_any_requirement() -> None:
    """会話冒頭など要件が 1 件も無い段階では終了を提案しない（誤発火防止 / レビュー指摘）。"""
    transport = RecordingTransport()
    agent = _agent(transport)
    propose = type(agent).propose_session_end.__wrapped__
    result = await propose(agent, None)
    assert result["proposed"] is False
    assert result["reason"] == "no_requirements"
    assert not any(t["event"]["type"] == "session.end_proposed" for t in transport.sent)


@pytest.mark.asyncio
async def test_complete_session_requires_prior_proposal() -> None:
    """提案（同意フロー）を経ずに直接 complete_session を呼んでも終了しない（レビュー指摘）。"""
    transport = RecordingTransport()
    agent = _agent(transport)
    _seed_requirement(agent)
    agent.set_shutdown_hook(lambda reason: None)
    complete = type(agent).complete_session.__wrapped__
    result = await complete(agent, None)
    assert result["completed"] is False
    assert result["reason"] == "not_proposed"
    assert not any(t["event"]["type"] == "session.completed" for t in transport.sent)


@pytest.mark.asyncio
async def test_complete_session_publishes_completed_and_shuts_down() -> None:
    import asyncio

    from sanba_agent.config import settings

    transport = RecordingTransport()
    agent = _agent(transport)
    _seed_requirement(agent)
    agent._end_proposed = True
    reasons: list[str] = []
    agent.set_shutdown_hook(lambda reason: reasons.append(reason))
    monkeypatch_delay = settings.voice_completion_shutdown_delay_s
    settings.voice_completion_shutdown_delay_s = 0.01
    try:
        complete = type(agent).complete_session.__wrapped__
        result = await complete(agent, None)
        assert result["completed"] is True
        assert any(t["event"]["type"] == "session.completed" for t in transport.sent)
        await asyncio.sleep(0.05)
        assert reasons, "同意後にシャットダウンフックが起動する"
    finally:
        settings.voice_completion_shutdown_delay_s = monkeypatch_delay


@pytest.mark.asyncio
async def test_complete_session_refuses_when_open_remains() -> None:
    transport = RecordingTransport()
    agent = _agent(transport)
    _seed_requirement(agent)
    agent._end_proposed = True
    agent.set_shutdown_hook(lambda reason: None)
    agent._published_ambiguous.add("a1")
    complete = type(agent).complete_session.__wrapped__
    result = await complete(agent, None)
    assert result["completed"] is False
    assert result["open_count"] == 1
    assert result["reason"] == "open_detections"
    assert not any(t["event"]["type"] == "session.completed" for t in transport.sent)


@pytest.mark.asyncio
async def test_new_gap_retracts_prior_end_proposal() -> None:
    """終了提案後に新しい抜けが検知されたら提案は取り下げられ、再提案が要る（レビュー指摘）。"""
    transport = RecordingTransport()
    agent = _agent(transport)
    _seed_requirement(agent)
    agent._end_proposed = True
    result = AnalysisResult(
        summary="s", open_topics=["性能要件"], next_question="q?", suggested_answer="a"
    )
    await agent._publish_analysis_detections(result)
    assert agent._end_proposed is False, "新しい未解消が出たら終了提案は無効化される"


@pytest.mark.asyncio
async def test_emit_context_progress_publishes_prep_and_repo() -> None:
    from sanba_shared.models import GitHubIndexStatus

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="s2",
            title="t",
            owner_sub="owner",
            owner_email="",
            goal="アカウント設定画面を作りたい",
            goal_detail="通知設定も統合したい",
            github_repo="octo/app",
            github_branch="main",
            github_index_status=GitHubIndexStatus.READY,
        )
    )
    transport = RecordingTransport()
    publisher = EventPublisher("s2", transport)
    agent = SANBAAgent("s2", repo, GroundingStore(), publisher=publisher)
    await agent.emit_context_progress()

    events = [t["event"] for t in transport.sent if t["event"]["type"] == "context.progress"]
    by_source = {e["source"]: e for e in events}
    assert by_source["prep"]["stage"] == "done"
    assert by_source["repo"]["stage"] == "reused"
    assert by_source["repo"]["label"] == "octo/app@main"


@pytest.mark.asyncio
async def test_emit_context_progress_repo_indexing_is_running() -> None:
    from sanba_shared.models import GitHubIndexStatus

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="s3",
            title="t",
            owner_sub="owner",
            owner_email="",
            github_repo="octo/app",
            github_index_status=GitHubIndexStatus.INDEXING,
        )
    )
    transport = RecordingTransport()
    agent = SANBAAgent("s3", repo, GroundingStore(), publisher=EventPublisher("s3", transport))
    await agent.emit_context_progress()

    repo_event = next(
        t["event"]
        for t in transport.sent
        if t["event"]["type"] == "context.progress" and t["event"]["source"] == "repo"
    )
    assert repo_event["stage"] == "running"


@pytest.mark.asyncio
async def test_emit_context_progress_without_signals_is_noop() -> None:
    repo = SessionRepository()
    repo.create_session_doc(SessionMeta(id="s4", title="t", owner_sub="owner", owner_email=""))
    transport = RecordingTransport()
    agent = SANBAAgent("s4", repo, GroundingStore(), publisher=EventPublisher("s4", transport))
    await agent.emit_context_progress()
    assert [t for t in transport.sent if t["event"]["type"] == "context.progress"] == []


@pytest.mark.asyncio
async def test_analysis_runs_off_event_loop_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import threading

    seen: list[int] = []

    async def _stub(transcript: str) -> AnalysisResult:
        seen.append(threading.get_ident())
        return AnalysisResult(summary="s", next_question="q?", suggested_answer="a")

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _stub)
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None
    await task
    assert seen, "背景分析が実行される"
    assert seen[0] != threading.get_ident(), "分析は音声ループと別スレッドで実行される（#375）"


@pytest.mark.asyncio
async def test_drain_tasks_cancels_overdue() -> None:
    import asyncio

    from sanba_agent.main import _drain_tasks

    async def _hang() -> None:
        await asyncio.sleep(60)

    async def _quick() -> None:
        return None

    hang_task = asyncio.create_task(_hang())
    quick_task = asyncio.create_task(_quick())
    completed, cancelled = await _drain_tasks({hang_task, quick_task}, grace_seconds=0.05)
    assert completed == 1
    assert cancelled == 1
    assert hang_task.cancelled()


@pytest.mark.asyncio
async def test_tool_rides_on_inflight_background_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio
    import threading

    calls: list[str] = []
    gate = threading.Event()

    async def _slow(transcript: str) -> AnalysisResult:
        calls.append(transcript)
        await asyncio.to_thread(gate.wait)
        return AnalysisResult(summary="s", next_question="q?", suggested_answer="a")

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _slow)
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None and not task.done()

    tool = type(agent).analyze_requirements.__wrapped__
    tool_task = asyncio.create_task(tool(agent, None))
    await asyncio.sleep(0)
    gate.set()
    result = await tool_task
    assert len(calls) == 1, "走行中の背景分析に相乗りし、二重の LLM 往復をしない"
    assert result["next_question"] == "q?"


@pytest.mark.asyncio
async def test_tool_ride_along_timeout_returns_without_competing_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio
    import threading

    from sanba_agent.config import settings

    calls: list[str] = []
    gate = threading.Event()

    async def _hang(transcript: str) -> AnalysisResult:
        calls.append(transcript)
        await asyncio.to_thread(gate.wait)
        return AnalysisResult(summary="s", next_question="q?", suggested_answer="a")

    monkeypatch.setattr("sanba_agent.main.analyze_transcript", _hang)
    monkeypatch.setattr(settings, "analysis_ride_along_timeout_seconds", 0.05)
    agent = _agent()
    agent.record_utterance("participant", "請求管理のアプリを作りたい")
    agent.record_utterance("participant", "対象は経理担当者です")
    task = agent._analysis_task
    assert task is not None and not task.done()

    tool = type(agent).analyze_requirements.__wrapped__
    result = await tool(agent, None)
    assert result["next_question"]
    assert len(calls) == 1, "上限超過でも競合する同期分析を起動しない（背景の1回だけ）"

    gate.set()
    await agent.drain_background_tasks()
