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
    （Codex P2: 選択値を確認できないときは連携しない扱い = fail-closed）。"""
    from sanba_shared.repository import SessionRepository

    from sanba_agent.config import settings
    from sanba_agent.main import _resolve_github_repo

    repo = SessionRepository()
    monkeypatch.setattr(settings, "github_repo", "org/env-default")
    assert _resolve_github_repo(repo, "sess-unknown") == ""


def test_resolve_github_repo_respects_explicit_opt_out(monkeypatch) -> None:
    """空文字 = 明示的な「連携しない」。環境変数へフォールバックしない（Codex P2）。"""
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
