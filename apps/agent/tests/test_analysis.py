"""Unit tests for the pure tool logic (no LiveKit/ADK runtime required)."""

from __future__ import annotations

import pytest

from sanba_agent.tools.analysis import (
    heuristic_ambiguous_topics,
    make_requirement_id,
)


def test_requirement_id_is_deterministic_and_idempotent() -> None:
    a = make_requirement_id("同時に5人が参加できること")
    b = make_requirement_id("  同時に5人が参加できること  ")
    assert a == b
    assert a.startswith("req_")


def test_ambiguous_topics_flags_vague_phrasing() -> None:
    transcript = "[u1] participant: ソート順はいい感じにしてください。"
    topics = heuristic_ambiguous_topics(transcript)
    assert any("いい感じ" in t for t in topics)


def test_ambiguous_topics_ignores_concrete_statements() -> None:
    transcript = "[u1] participant: ソート順は新着順を既定にしてください。"
    assert heuristic_ambiguous_topics(transcript) == []


def test_ambiguous_topics_dedupes_repeats() -> None:
    transcript = "[u1] participant: なるべく速くしたい。\n[u3] participant: なるべく速くしたい。"
    assert heuristic_ambiguous_topics(transcript) == ["なるべく速くしたい。"]


@pytest.mark.asyncio
async def test_analyze_transcript_falls_back_without_adk() -> None:
    from sanba_agent.tools.analysis import analyze_transcript

    result = await analyze_transcript("[u1] participant: 要約機能をいい感じに。")
    assert result.next_question
    assert result.open_topics == []
    assert result.ambiguous_topics


def test_heuristic_result_has_no_hardcoded_gaps() -> None:
    """ハードコード NFR 廃止で gap は空、曖昧語検知だけは残る（ADR-0055）。"""
    from sanba_agent.tools.analysis import heuristic_result

    result = heuristic_result("[u1] participant: 要約機能をいい感じに。")
    assert result.next_question
    assert result.open_topics == []
    assert any("いい感じ" in t for t in result.ambiguous_topics)
