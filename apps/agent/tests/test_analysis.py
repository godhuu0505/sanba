"""Unit tests for the pure tool logic (no LiveKit/ADK runtime required)."""

from __future__ import annotations

import pytest

from sanba_agent.tools.analysis import (
    heuristic_ambiguous_topics,
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
    assert result.open_topics
    assert result.ambiguous_topics


def test_heuristic_result_builds_from_gaps_and_ambiguity() -> None:
    # ADR-0046 段階1: ADK 無し/タイムアウト時に LLM 往復なしで即返すフォールバック。
    from sanba_agent.tools.analysis import heuristic_result

    result = heuristic_result("[u1] participant: 要約機能をいい感じに。")
    assert result.next_question  # 抜け or 既定文から必ず組み立てる
    assert result.open_topics  # NFR 未カバーの抜けが挙がる
    assert any("いい感じ" in t for t in result.ambiguous_topics)
