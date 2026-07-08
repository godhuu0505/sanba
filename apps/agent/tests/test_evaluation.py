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
async def test_score_session_falls_back_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM judge が退出猶予を超えたら決定的ヒューリスティックへ即フォールバックする（#435）。"""
    import asyncio

    from sanba_agent import evaluation
    from sanba_agent.config import settings

    async def _hang(transcript: str) -> JudgeResult:
        await asyncio.sleep(60)
        raise AssertionError("unreachable")

    monkeypatch.setattr(evaluation, "judge_interview", _hang)
    monkeypatch.setattr(settings, "session_score_timeout_seconds", 0.05)
    result = await evaluation.score_session(
        session_id="s1", transcript="レイテンシ5秒以内。セキュリティは認証必須。"
    )
    assert result.rationale.startswith("heuristic")
    assert 0.0 <= result.overall <= 1.0


@pytest.mark.asyncio
async def test_regression_dataset_passes() -> None:
    assert await run_dataset_eval() == 0


@pytest.mark.asyncio
async def test_end_user_grounded_outscores_jargon_leak() -> None:
    from sanba_agent.evaluation import (
        END_USER_QUALITY_THRESHOLD,
        END_USER_SCENARIOS,
        judge_end_user_interview,
    )

    by_name = {}
    for sc in END_USER_SCENARIOS:
        by_name[sc["name"]] = await judge_end_user_interview(sc["transcript"], sc["glossary"])
    assert by_name["eu_grounded"].overall > by_name["eu_jargon_leak"].overall
    assert by_name["eu_grounded"].overall >= END_USER_QUALITY_THRESHOLD


@pytest.mark.asyncio
async def test_end_user_jargon_and_stacked_questions_are_penalized() -> None:
    from sanba_agent.evaluation import judge_end_user_interview

    transcript = "参加者: 困りました。\nSANBA: 非機能要件は？APIは？MoSCoWは？"
    res = await judge_end_user_interview(transcript, ["請求書一覧"])
    assert res.scores["no_jargon"] < 0.5
    assert res.scores["single_question"] == 0.0
    assert res.scores["glossary_usage"] == 0.0


@pytest.mark.asyncio
async def test_end_user_empty_glossary_is_not_penalized() -> None:
    from sanba_agent.evaluation import judge_end_user_interview

    transcript = "SANBA: それはいつごろのことですか？たとえば「先週」でも大丈夫です。"
    res = await judge_end_user_interview(transcript, [])
    assert res.scores["glossary_usage"] == 1.0
    assert res.scores["no_jargon"] == 1.0


@pytest.mark.asyncio
async def test_end_user_empty_transcript_scores_zero() -> None:
    from sanba_agent.evaluation import judge_end_user_interview

    res = await judge_end_user_interview("  ", ["請求書一覧"])
    assert res.overall == 0.0
