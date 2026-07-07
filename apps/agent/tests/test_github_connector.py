"""Tests for the GitHub connector pure logic (no network)."""

from __future__ import annotations

from sanba_agent.connectors import issues_to_passages


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


def test_seed_github_context_skips_when_repo_indexed(monkeypatch) -> None:
    from sanba_shared.models import GitHubIndexStatus, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent import main as agent_main
    from sanba_agent.config import settings as agent_settings
    from sanba_agent.retrieval import GroundingStore

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
    assert resolved == "octo/linked"
    agent_main.seed_github_context(grounding, "sess-1", repo, resolved)
    assert grounding._mem == []


def test_seed_github_context_seeds_selected_repo_without_app_index(monkeypatch) -> None:
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
            assert repo_name == "acme/picked"

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
    """02 準備で選んだリポジトリが環境変数より優先される。"""
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
    """未選択セッション（文書あり・github_repo=None）は環境変数へフォールバック（互換）。"""
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


def test_resolve_github_repo_missing_session_is_fail_closed(monkeypatch) -> None:
    """セッション文書が無い（未作成/削除済み/誤設定の空ストア）は既定リポへ流さない
    （選択値を確認できないときは連携しない扱い = fail-closed）。"""
    from sanba_shared.repository import SessionRepository

    from sanba_agent.config import settings
    from sanba_agent.main import _resolve_github_repo

    repo = SessionRepository()
    monkeypatch.setattr(settings, "github_repo", "org/env-default")
    assert _resolve_github_repo(repo, "sess-unknown") == ""


def test_resolve_github_repo_respects_explicit_opt_out(monkeypatch) -> None:
    """空文字 = 明示的な「連携しない」。環境変数へフォールバックしない。"""
    from sanba_shared.models import SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.config import settings
    from sanba_agent.main import _resolve_github_repo

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="sess-optout",
            title="t",
            owner_sub="owner-sub",
            owner_email="owner@example.com",
            github_repo="",
        )
    )
    monkeypatch.setattr(settings, "github_repo", "org/env-default")
    assert _resolve_github_repo(repo, "sess-optout") == ""
