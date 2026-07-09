"""セッション単位の AI コスト集計（ADR-0061）のテスト。

`session_usage_updated` スナップショットの差分化（再起動リセット込み）、セッション終了時の
`session_summary` 組み立て（Firestore 加算との合流・KPI 結合・LiveKit 推定）、および
fail-soft（排出失敗が本処理へ波及しない）を LiveKit ランタイム無しで検証する。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sanba_shared.analytics import (
    COMPONENT_JUDGE,
    COMPONENT_LIVE_AUDIO,
    EVENT_SESSION_SUMMARY,
    LiveKitRates,
    TokenUsage,
    UsageRecorder,
)
from sanba_shared.analytics_sink import AnalyticsSink
from sanba_shared.repository import SessionRepository

from sanba_agent.usage import LiveUsageTracker, emit_session_cost_summary

LIVE_MODEL = "gemini-live-2.5-flash-native-audio"


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)


def _model_usage(
    *,
    input_tokens: int = 0,
    input_audio: int = 0,
    output_tokens: int = 0,
    output_audio: int = 0,
    model: str = LIVE_MODEL,
    usage_type: str = "llm_usage",
) -> SimpleNamespace:
    return SimpleNamespace(
        type=usage_type,
        provider="Gemini",
        model=model,
        input_tokens=input_tokens,
        input_text_tokens=0,
        input_audio_tokens=input_audio,
        input_image_tokens=0,
        input_cached_tokens=0,
        output_tokens=output_tokens,
        output_text_tokens=0,
        output_audio_tokens=output_audio,
    )


def _tracker() -> tuple[LiveUsageTracker, RecordingSink]:
    sink = RecordingSink()
    recorder = UsageRecorder(sink, "sess-1", product_id="prod-1", interview_mode="developer")
    return LiveUsageTracker(recorder, LIVE_MODEL), sink


def test_tracker_emits_deltas_between_snapshots() -> None:
    tracker, sink = _tracker()
    tracker.record_snapshot([_model_usage(input_tokens=100, input_audio=100, output_tokens=40)])
    tracker.record_snapshot([_model_usage(input_tokens=300, input_audio=300, output_tokens=90)])
    assert len(sink.events) == 2
    first, second = sink.events
    assert first["payload"]["component"] == COMPONENT_LIVE_AUDIO
    assert first["payload"]["tokens"]["input_tokens"] == 100
    assert second["payload"]["tokens"]["input_tokens"] == 200
    assert second["payload"]["tokens"]["output_tokens"] == 50
    assert tracker.total.input_tokens == 300


def test_tracker_identical_snapshot_emits_nothing() -> None:
    tracker, sink = _tracker()
    snapshot = [_model_usage(input_tokens=100, output_tokens=40)]
    tracker.record_snapshot(snapshot)
    tracker.record_snapshot(snapshot)
    assert len(sink.events) == 1


def test_tracker_treats_reset_as_fresh_delta() -> None:
    tracker, sink = _tracker()
    tracker.record_snapshot([_model_usage(input_tokens=500, output_tokens=100)])
    tracker.record_snapshot([_model_usage(input_tokens=50, output_tokens=10)])
    assert len(sink.events) == 2
    assert sink.events[1]["payload"]["tokens"]["input_tokens"] == 50
    assert tracker.total.input_tokens == 550


def test_tracker_commit_resets_baseline_for_restart() -> None:
    tracker, sink = _tracker()
    tracker.record_snapshot([_model_usage(input_tokens=100, output_tokens=20)])
    tracker.commit()
    tracker.record_snapshot([_model_usage(input_tokens=60, output_tokens=5)])
    assert sink.events[1]["payload"]["tokens"]["input_tokens"] == 60
    assert tracker.total.input_tokens == 160


def test_tracker_skips_non_llm_usage_entries() -> None:
    tracker, sink = _tracker()
    tracker.record_snapshot(
        [
            _model_usage(input_tokens=10, usage_type="stt_usage"),
            _model_usage(input_tokens=25, output_tokens=5),
        ]
    )
    assert len(sink.events) == 1
    assert sink.events[0]["payload"]["tokens"]["input_tokens"] == 25


def test_tracker_survives_recorder_failure() -> None:
    class ExplodingSink:
        def emit(self, event: dict[str, Any]) -> None:
            raise RuntimeError("boom")

    recorder = UsageRecorder(ExplodingSink(), "sess-1")
    tracker = LiveUsageTracker(recorder, LIVE_MODEL)
    tracker.record_snapshot([_model_usage(input_tokens=10, output_tokens=1)])
    assert tracker.total.input_tokens == 10


def _repo() -> SessionRepository:
    repo = SessionRepository()
    repo._client = None
    return repo


class _JudgeResult:
    overall = 0.8
    scores = {"nfr_coverage": 0.9}


async def test_emit_session_cost_summary_joins_costs_and_kpi() -> None:
    repo = _repo()
    sink = AnalyticsSink()
    recorder = UsageRecorder(sink, "sess-1", product_id="prod-1", interview_mode="developer")
    recorder.record(
        COMPONENT_LIVE_AUDIO,
        LIVE_MODEL,
        TokenUsage(
            input_tokens=1000, input_audio_tokens=1000, output_tokens=500, output_audio_tokens=500
        ),
    )
    recorder.record(COMPONENT_JUDGE, "gemini-2.5-flash", TokenUsage(input_tokens=100))
    repo.add_session_ai_cost("sess-1", component="title", usd=0.001, input_tokens=50)
    payload = await emit_session_cost_summary(
        session_id="sess-1",
        repo=repo,
        sink=sink,
        recorder=recorder,
        inquiry_counts={"resolved_total": 4, "open_total": 1},
        judge_result=_JudgeResult(),
        session_seconds=600.0,
        noise_cancellation=True,
        usd_jpy_rate=150.0,
        livekit_rates=LiveKitRates(),
        finalized_count=4,
    )
    assert set(payload["components"]) == {"live_audio", "judge", "title"}
    assert payload["total_usd"] > payload["ai_usd"]
    assert payload["kpi"]["quality_overall"] == 0.8
    assert payload["kpi"]["finalized_count"] == 4
    assert payload["efficiency"]["usd_per_finalized_requirement"] > 0
    assert payload["kpi"]["inquiry"]["resolved_total"] == 4
    assert payload["kpi"]["session_seconds"] == 600.0
    assert payload["livekit"]["minutes"] == 10.0
    assert payload["efficiency"]["usd_per_resolved_inquiry"] > 0
    stored = repo.get_session_cost_summary("sess-1")
    assert stored is not None
    assert stored["total_usd"] == payload["total_usd"]
    cost = repo.get_session_ai_cost("sess-1")
    assert cost["components"]["live_audio"]["requests"] == 1
    assert cost["components"]["title"]["input_tokens"] == 50
    sink.flush()
    summary_events = [e for e in sink._mem if e.get("event_type") == EVENT_SESSION_SUMMARY]
    assert len(summary_events) == 1
    assert summary_events[0]["product_id"] == "prod-1"


async def test_emit_session_cost_summary_survives_firestore_failure() -> None:
    repo = _repo()

    def _explode(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("firestore down")

    repo.add_session_ai_costs = _explode  # type: ignore[method-assign]
    repo.set_session_cost_summary = _explode  # type: ignore[method-assign]
    sink = AnalyticsSink()
    recorder = UsageRecorder(sink, "sess-1")
    recorder.record(COMPONENT_JUDGE, "gemini-2.5-flash", TokenUsage(input_tokens=100))
    payload = await emit_session_cost_summary(
        session_id="sess-1",
        repo=repo,
        sink=sink,
        recorder=recorder,
        inquiry_counts={},
        judge_result=None,
        session_seconds=60.0,
        noise_cancellation=False,
        usd_jpy_rate=150.0,
    )
    assert payload["components"]["judge"]["usd"] >= 0
    sink.flush()
    assert any(e.get("event_type") == EVENT_SESSION_SUMMARY for e in sink._mem)
