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


def test_seed_github_context_skips_when_repo_indexed(monkeypatch) -> None:
    # セッションの repo が GitHub App 経由で ES 索引済み（index_status が none/failed 以外）
    # なら connector seed を走らせない（repo 本体 chunk と README/Issue seed の二重化を防ぐ /
    # ADR-0028・Codex P2）。
    from sanba_shared.models import GitHubIndexStatus, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent import main as agent_main
    from sanba_agent.config import settings as agent_settings
    from sanba_agent.retrieval import GroundingStore

    # connector を「有効」に見せる（本来なら seed が走る条件）。
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

    resolved = agent_main._resolve_github_repo(repo, "sess-1")
    assert resolved == "octo/linked"  # 解決はセッション選択が最優先（ADR-0027）
    agent_main.seed_github_context(grounding, "sess-1", repo, resolved)
    # connector の fetch は呼ばれず、何も索引されない。
    assert grounding._mem == []


def test_seed_github_context_seeds_selected_repo_without_app_index(monkeypatch) -> None:
    # ES 索引が無い（App 未連携の connector 選択 / ADR-0027）場合は、解決された repo を
    # connector で seed する（#283 の挙動が正であることの担保）。
    from sanba_shared.models import SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent import connectors
    from sanba_agent import main as agent_main
    from sanba_agent.config import settings as agent_settings
    from sanba_agent.retrieval import GroundingStore

    monkeypatch.setattr(agent_settings, "github_connector_enabled", True)
    monkeypatch.setattr(agent_settings, "github_token", "x")
    monkeypatch.setattr(agent_settings, "github_repo", "global/other")

    class FakeConnector:
        def __init__(self, token: str, repo_name: str) -> None:
            assert repo_name == "acme/picked"  # セッション選択が seed 対象になる

        def fetch_context_passages(self) -> list[tuple[str, str]]:
            return [("readme text", "github:acme/picked#readme")]

    monkeypatch.setattr(connectors, "GitHubConnector", FakeConnector)

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="sess-2",
            title="t",
            owner_sub="s",
            owner_email="o@example.com",
            github_repo="acme/picked",
        )
    )
    grounding = GroundingStore()

    agent_main.seed_github_context(
        grounding, "sess-2", repo, agent_main._resolve_github_repo(repo, "sess-2")
    )
    assert [d.source for d in grounding._mem] == ["github:acme/picked#readme"]


def test_resolve_github_repo_prefers_session_selection(monkeypatch) -> None:
    """02 準備で選んだリポジトリが環境変数より優先される（ADR-0027）。"""
    from sanba_shared.models import SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.config import settings
    from sanba_agent.main import _resolve_github_repo

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="sess-x",
            title="t",
            owner_sub="owner-sub",
            owner_email="owner@example.com",
            github_repo="acme/product-a",
        )
    )
    monkeypatch.setattr(settings, "github_repo", "org/env-default")
    assert _resolve_github_repo(repo, "sess-x") == "acme/product-a"


def test_resolve_github_repo_falls_back_to_env(monkeypatch) -> None:
    """未選択セッション・未知セッションは環境変数へフォールバック（従来挙動の互換）。"""
    from sanba_shared.models import SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.config import settings
    from sanba_agent.main import _resolve_github_repo

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="sess-plain",
            title="t",
            owner_sub="owner-sub",
            owner_email="owner@example.com",
        )
    )
    monkeypatch.setattr(settings, "github_repo", "org/env-default")
    assert _resolve_github_repo(repo, "sess-plain") == "org/env-default"
    assert _resolve_github_repo(repo, "sess-unknown") == "org/env-default"
