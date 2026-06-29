"""grill-me インタビューペルソナの回帰ガード (issue #267)。

プロンプトはコードで管理しているため、grill-me 流の核心原則がプロンプト本文から
退行(誤って削除・希薄化)していないことを軽く保証する。LLM 出力の品質は評価しない
(それは evaluation.py の LLM-as-a-judge が担当)。ここで見るのは「指示文に語が残っているか」。
"""

from __future__ import annotations

from sanba_agent.prompts.interview import (
    CONTRADICTION_AGENT_INSTRUCTIONS,
    LEAD_AGENT_INSTRUCTIONS,
    VOICE_AGENT_INSTRUCTIONS,
)


def test_voice_agent_keeps_grill_me_core_principles() -> None:
    # 一問一答 + 推奨回答(grill-me の肝) と、強化した問い詰め原則が残っていること。
    for marker in (
        "1つの問い",  # 一問一答
        "推奨例",  # 各問に推奨回答を添える
        "grill-me",  # 出どころを明示
        "ディシジョンツリー",  # 枝ごとに解消
        "イエスマンにならない",  # 率直に破綻点を指摘
        "破綻",
        "保留",  # 「もういい/次へ」はリスク添えて保留
    ):
        assert marker in VOICE_AGENT_INSTRUCTIONS, f"missing grill-me marker: {marker}"


def test_voice_agent_digs_into_tradeoffs_and_contradictions() -> None:
    for marker in ("失敗モード", "矛盾", "トレードオフ"):
        assert marker in VOICE_AGENT_INSTRUCTIONS, f"missing dig-in marker: {marker}"


def test_lead_agent_plans_one_branch_with_recommendation() -> None:
    assert "1つの問い" in LEAD_AGENT_INSTRUCTIONS
    assert "推奨回答" in LEAD_AGENT_INSTRUCTIONS
    assert "ディシジョンツリー" in LEAD_AGENT_INSTRUCTIONS
    # 表面的なら率直に突く(イエスマンにならない)計画原則も退行ガードする。
    assert "イエスマン" in LEAD_AGENT_INSTRUCTIONS


def test_contradiction_agent_points_out_directly() -> None:
    assert "直接指摘" in CONTRADICTION_AGENT_INSTRUCTIONS


def test_build_repo_premise_includes_repo_and_grounding_hint() -> None:
    from sanba_agent.prompts.interview import build_repo_premise

    premise = build_repo_premise("octo/demo", "main", ready=True)
    assert "octo/demo" in premise
    assert "main" in premise
    assert "前提" in premise
    assert "search_grounding" in premise
    # 索引完了時は「進行中」注記を出さない。
    assert "進行中" not in premise


def test_build_repo_premise_notes_indexing_in_progress() -> None:
    from sanba_agent.prompts.interview import build_repo_premise

    premise = build_repo_premise("octo/demo", None, ready=False)
    assert "進行中" in premise


def test_build_repo_premise_embeds_summary() -> None:
    from sanba_agent.prompts.interview import build_repo_premise

    premise = build_repo_premise(
        "octo/demo", "main", ready=True, summary="# 前提リポジトリ: octo/demo\n説明: A demo"
    )
    # 索引時の要約をそのまま初期 instructions に埋め込む（retrieval 任せにしない）。
    assert "説明: A demo" in premise
