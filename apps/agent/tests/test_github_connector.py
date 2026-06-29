"""Tests for the GitHub connector pure logic (issue #7, no network)."""

from __future__ import annotations

from sanba_shared.models import Priority, Requirement, RequirementCategory

from sanba_agent.connectors import issues_to_passages, requirements_to_issue_body


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
            id="r1",
            statement="同時5人接続",
            category=RequirementCategory.NON_FUNCTIONAL,
            priority=Priority.MUST,
        ),
        Requirement(
            id="r2",
            statement="ダークモード",
            category=RequirementCategory.FUNCTIONAL,
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


def test_seed_github_context_skips_when_repo_linked(monkeypatch) -> None:
    # セッションに GitHub App の repo が紐づいていれば、旧グローバル connector の seed を
    # 走らせない（選択 repo の前提に無関係な GITHUB_REPO 断片を混ぜない / ADR-0025・Codex P2）。
    from sanba_shared.models import GitHubIndexStatus, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent import main as agent_main
    from sanba_agent.config import settings as agent_settings
    from sanba_agent.retrieval import GroundingStore

    # グローバル connector を「有効」に見せる（本来なら seed が走る条件）。
    monkeypatch.setattr(agent_settings, "github_connector_enabled", True)
    monkeypatch.setattr(agent_settings, "github_token", "x")
    monkeypatch.setattr(agent_settings, "github_repo", "global/other")

    repo = SessionRepository()
    assert repo._client is None
    repo.create_session_doc(
        SessionMeta(id="sess-1", title="t", owner_sub="s", owner_email="o@example.com")
    )
    repo.set_session_github(
        "sess-1",
        repo="octo/linked",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    grounding = GroundingStore()
    assert grounding.is_memory

    agent_main.seed_github_context(grounding, "sess-1", repo)
    # 旧 connector の fetch は呼ばれず、何も索引されない。
    assert grounding._mem == []
