"""worker の動画解析コスト計装（ADR-0061）のテスト。

vision の `usage_metadata` 相当と embedding の索引トークンが `ai_usage` として排出され、
`sessions/{id}.ai_cost` へ加算されること、および recorder 無しでは従来挙動のままである
ことを検証する。
"""

from __future__ import annotations

from typing import Any

from sanba_shared.analytics import TokenUsage, UsageRecorder
from sanba_shared.grounding import ContextIndexer
from sanba_shared.media import VideoAnalysis
from sanba_shared.repository import SessionRepository

from sanba_worker.analysis import VideoTaskPayload, process_video
from sanba_worker.config import WorkerSettings


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)


def _repo_with_material() -> SessionRepository:
    repo = SessionRepository()
    repo.save_material(
        "s1", {"id": "asset-abc", "name": "demo.mp4", "kind": "video", "status": "analyzing"}
    )
    return repo


def _fake_analyze_with_usage(*obs: str):  # type: ignore[no-untyped-def]
    def _inner(_config, **kwargs):  # type: ignore[no-untyped-def]
        on_usage = kwargs.get("on_usage")
        if on_usage is not None:
            on_usage(TokenUsage(input_tokens=5000, input_image_tokens=4800, output_tokens=200))
        return VideoAnalysis(observations=list(obs))

    return _inner


def test_process_video_records_vision_usage_and_increments_cost() -> None:
    repo = _repo_with_material()
    sink = RecordingSink()

    def _increment(component: str, payload: dict[str, Any]) -> None:
        tokens = payload.get("tokens", {})
        repo.add_session_ai_cost(
            "s1",
            component=component,
            usd=float(payload.get("estimated_usd", 0.0)),
            input_tokens=int(tokens.get("input_tokens", 0)),
            output_tokens=int(tokens.get("output_tokens", 0)),
        )

    recorder = UsageRecorder(sink, "s1", product_id="prod-1", on_record=_increment)
    result = process_video(
        VideoTaskPayload(session_id="s1", asset_id="asset-abc", gcs_uri="gs://b/o.mp4"),
        repo=repo,
        indexer=ContextIndexer(),
        settings=WorkerSettings(google_genai_use_vertexai=True),
        analyze=_fake_analyze_with_usage("[00:01] ログイン画面"),
        usage_recorder=recorder,
    )
    assert result.status == "done"
    components = [e["payload"]["component"] for e in sink.events]
    assert "vision" in components
    vision_event = next(e for e in sink.events if e["payload"]["component"] == "vision")
    assert vision_event["payload"]["tokens"]["input_tokens"] == 5000
    assert vision_event["payload"]["estimated_usd"] > 0
    assert vision_event["product_id"] == "prod-1"
    cost = repo.get_session_ai_cost("s1")
    assert cost["components"]["vision"]["input_tokens"] == 5000
    assert cost["total_usd"] > 0


def test_process_video_without_recorder_keeps_legacy_behavior() -> None:
    repo = _repo_with_material()

    def _legacy_analyze(_config, **kwargs):  # type: ignore[no-untyped-def]
        assert "on_usage" not in kwargs
        assert "billing_labels" not in kwargs
        return VideoAnalysis(observations=["x"])

    result = process_video(
        VideoTaskPayload(session_id="s1", asset_id="asset-abc", gcs_uri="gs://b/o.mp4"),
        repo=repo,
        indexer=ContextIndexer(),
        settings=WorkerSettings(google_genai_use_vertexai=True),
        analyze=_legacy_analyze,
    )
    assert result.status == "done"
    assert repo.get_session_ai_cost("s1") == {"total_usd": 0.0, "components": {}}
