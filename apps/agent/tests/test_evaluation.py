"""Tests for the LLM-as-a-judge evaluation harness (heuristic path)."""

from __future__ import annotations

import pytest

from sanba_agent.evaluation import (
    QUALITY_THRESHOLD,
    JudgeResult,
    judge_interview,
    run_dataset_eval,
)


def test_judge_result_overall_is_mean() -> None:
    res = JudgeResult.from_scores({"a": 1.0, "b": 0.0}, "r")
    assert res.overall == 0.5


@pytest.mark.asyncio
async def test_well_covered_outscores_shallow() -> None:
    good = (
        "レイテンシ5秒以内。セキュリティは認証必須。予算は月10万円。"
        "同時ユーザー50人。可用性SLO99.9%。矛盾がないか確認します。"
    )
    shallow = "要約機能がほしい。"
    good_res = await judge_interview(good)
    shallow_res = await judge_interview(shallow)
    assert good_res.overall > shallow_res.overall
    assert good_res.overall >= QUALITY_THRESHOLD


@pytest.mark.asyncio
async def test_empty_transcript_scores_zero() -> None:
    res = await judge_interview("   ")
    assert res.overall == 0.0


@pytest.mark.asyncio
async def test_regression_dataset_passes() -> None:
    assert await run_dataset_eval() == 0
