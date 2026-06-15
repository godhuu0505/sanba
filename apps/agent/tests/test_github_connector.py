"""Tests for the GitHub connector pure logic (issue #7, no network)."""

from __future__ import annotations

from sanba_agent.connectors import issues_to_passages, requirements_to_issue_body
from sanba_agent.models import Priority, Requirement, RequirementCategory


def test_issues_to_passages_skips_pull_requests() -> None:
    issues = [
        {"number": 1, "title": "要約が欲しい", "body": "本文"},
        {"number": 2, "title": "PR", "body": "x", "pull_request": {"url": "..."}},
        {"number": 3, "title": "", "body": "empty title skipped"},
    ]
    passages = issues_to_passages(issues, "owner/repo")
    assert len(passages) == 1
    text, source = passages[0]
    assert "要約が欲しい" in text
    assert source == "github:owner/repo#1"


def test_requirements_to_issue_body_groups_by_priority() -> None:
    reqs = [
        Requirement(
            id="r1", statement="同時5人接続", category=RequirementCategory.NON_FUNCTIONAL,
            priority=Priority.MUST,
        ),
        Requirement(
            id="r2", statement="ダークモード", category=RequirementCategory.FUNCTIONAL,
            priority=Priority.COULD,
        ),
    ]
    title, body = requirements_to_issue_body(reqs, "sess-1")
    assert "sess-1" in title
    assert "## Must" in body
    assert "## Could" in body
    assert "同時5人接続" in body
    # Must should appear before Could in the body.
    assert body.index("## Must") < body.index("## Could")


def test_requirements_to_issue_body_handles_empty() -> None:
    title, body = requirements_to_issue_body([], "sess-2")
    assert "sess-2" in title
    assert "確定した要件はありません" in body
