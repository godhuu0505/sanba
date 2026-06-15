"""Unit tests for the pure tool logic (no LiveKit/ADK runtime required)."""

from __future__ import annotations

import pytest

from sanba_agent.tools.analysis import (
    heuristic_open_topics,
    make_requirement_id,
)


def test_requirement_id_is_deterministic_and_idempotent() -> None:
    a = make_requirement_id("同時に5人が参加できること")
    b = make_requirement_id("  同時に5人が参加できること  ")
    assert a == b
    assert a.startswith("req_")


def test_open_topics_flags_missing_non_functional() -> None:
    transcript = "ユーザーがボタンを押すと要約が表示される機能がほしい。"
    topics = heuristic_open_topics(transcript)
    assert "セキュリティ・プライバシー" in topics
    assert "性能・レイテンシの要件" in topics


def test_open_topics_drops_covered_topics() -> None:
    transcript = (
        "レイテンシは1秒以内。セキュリティは認証必須。予算は月5万円。"
        "同時ユーザーは10人。可用性はSLO99.9%。"
    )
    topics = heuristic_open_topics(transcript)
    assert topics == []


@pytest.mark.asyncio
async def test_analyze_transcript_falls_back_without_adk() -> None:
    from sanba_agent.tools.analysis import analyze_transcript

    result = await analyze_transcript("要約機能がほしい。")
    assert result.next_question
    assert result.open_topics  # non-functional gaps surfaced
