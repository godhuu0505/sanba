"""SessionRepository のメモリ fallback 単体テスト (Firestore 不要)。

create/list/get、要件の編集 (3 フィールドのみ)、承認/却下と出所メタの保全を検証する。
"""

from __future__ import annotations

import pytest

from sanba_shared.models import (
    Priority,
    Requirement,
    RequirementCategory,
    RequirementStatus,
    SessionMeta,
)
from sanba_shared.repository import RequirementNotFound, SessionRepository


def _repo() -> SessionRepository:
    repo = SessionRepository(data_retention_days=30)
    assert repo._client is None, "テストは Firestore 非接続のメモリ fallback で走る前提"
    return repo


def _seed_requirement(repo: SessionRepository, session_id: str) -> Requirement:
    req = Requirement(
        id="r1",
        category=RequirementCategory.FUNCTIONAL,
        statement="ログインできること",
        priority=Priority.MUST,
        source_speaker="customer",
        confidence=0.9,
    )
    repo.save_requirement(session_id, req)
    return req


def test_create_and_list_sessions() -> None:
    repo = _repo()
    meta = SessionMeta(
        id="sess-1", title="t", owner_sub="sub", owner_email="o@example.com", roles=["pm"]
    )
    repo.create_session_doc(meta)
    assert repo.get_session("sess-1") == meta
    assert repo.list_sessions() == [meta]


def test_set_session_title_updates_and_ignores_blank() -> None:
    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="sess-t", title="要件インタビュー", owner_sub="sub", owner_email="o@e.com")
    )
    updated = repo.set_session_title("sess-t", "  在庫管理アプリの通知要件  ")
    assert updated is not None
    assert updated.title == "在庫管理アプリの通知要件"
    assert repo.get_session("sess-t").title == "在庫管理アプリの通知要件"
    repo.set_session_title("sess-t", "   ")
    assert repo.get_session("sess-t").title == "在庫管理アプリの通知要件"
    assert repo.set_session_title("missing", "x") is None


def test_list_utterances_returns_insertion_order() -> None:
    from sanba_shared.models import Utterance

    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="sess-u", title="t", owner_sub="sub", owner_email="o@e.com")
    )
    repo.add_utterance("sess-u", Utterance(speaker="participant", text="請求管理を作りたい"))
    repo.add_utterance("sess-u", Utterance(speaker="assistant", text="対象は誰ですか"))
    lines = repo.list_utterances("sess-u")
    assert [u.text for u in lines] == ["請求管理を作りたい", "対象は誰ですか"]
    assert repo.list_utterances("missing") == []


def test_set_session_summary_persists_and_ignores_missing() -> None:
    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="sess-s", title="t", owner_sub="sub", owner_email="o@e.com")
    )
    updated = repo.set_session_summary("sess-s", "  経理向けの請求管理を作る。  ")
    assert updated is not None
    assert updated.conversation_summary == "経理向けの請求管理を作る。"
    assert repo.get_session("sess-s").conversation_summary == "経理向けの請求管理を作る。"
    assert repo.set_session_summary("missing", "x") is None


def test_list_sessions_by_owner_filters_and_sorts() -> None:
    from datetime import UTC, datetime

    repo = _repo()

    def _seed(sid: str, owner: str, created: datetime) -> None:
        repo.create_session_doc(
            SessionMeta(
                id=sid,
                title="t",
                owner_sub=owner,
                owner_email=f"{owner}@example.com",
                roles=["pm"],
                created_at=created,
            )
        )

    _seed("a-old", "alice", datetime(2024, 1, 1, tzinfo=UTC))
    _seed("a-new", "alice", datetime(2024, 12, 31, tzinfo=UTC))
    _seed("b-1", "bob", datetime(2024, 6, 1, tzinfo=UTC))

    mine = repo.list_sessions_by_owner("alice")
    assert [m.id for m in mine] == ["a-new", "a-old"]
    assert repo.list_sessions_by_owner("carol") == []


def test_update_requirement_only_touches_allowed_fields() -> None:
    repo = _repo()
    original = _seed_requirement(repo, "sess-1")
    updated = repo.update_requirement(
        "sess-1",
        "r1",
        statement="SSO でログインできること",
        priority="should",
        category="non_functional",
    )
    assert updated.statement == "SSO でログインできること"
    assert updated.priority is Priority.SHOULD
    assert updated.category is RequirementCategory.NON_FUNCTIONAL
    assert updated.id == original.id
    assert updated.created_at == original.created_at
    assert updated.source_speaker == original.source_speaker
    assert updated.confidence == original.confidence
    assert updated.status is RequirementStatus.DRAFT


def test_update_missing_requirement_raises() -> None:
    repo = _repo()
    with pytest.raises(RequirementNotFound):
        repo.update_requirement("sess-1", "nope", statement="x")


def test_approve_sets_approver_and_timestamp() -> None:
    repo = _repo()
    _seed_requirement(repo, "sess-1")
    approved = repo.set_requirement_status(
        "sess-1", "r1", RequirementStatus.APPROVED, approved_by="admin@example.com"
    )
    assert approved.status is RequirementStatus.APPROVED
    assert approved.approved_by == "admin@example.com"
    assert approved.approved_at is not None


def test_reject_clears_approval_fields() -> None:
    repo = _repo()
    _seed_requirement(repo, "sess-1")
    repo.set_requirement_status(
        "sess-1", "r1", RequirementStatus.APPROVED, approved_by="admin@example.com"
    )
    rejected = repo.set_requirement_status(
        "sess-1", "r1", RequirementStatus.REJECTED, approved_by="admin@example.com"
    )
    assert rejected.status is RequirementStatus.REJECTED
    assert rejected.approved_by is None
    assert rejected.approved_at is None


def test_github_link_set_get_delete() -> None:
    from sanba_shared.models import GitHubLink

    repo = _repo()
    assert repo.get_github_link("sub-1") is None

    link = GitHubLink(sub="sub-1", installation_id=42, github_login="octo")
    repo.set_github_link(link)
    got = repo.get_github_link("sub-1")
    assert got is not None
    assert got.installation_id == 42
    assert got.github_login == "octo"

    assert repo.delete_github_link("sub-1") is True
    assert repo.get_github_link("sub-1") is None
    assert repo.delete_github_link("sub-1") is False


def test_set_session_github_binds_repo_and_status() -> None:
    from sanba_shared.models import GitHubIndexStatus

    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="sess-9", title="t", owner_sub="sub", owner_email="o@example.com")
    )
    updated = repo.set_session_github(
        "sess-9",
        repo="octo/demo",
        branch="main",
        commit_sha="abc123",
        index_status=GitHubIndexStatus.INDEXING,
    )
    assert updated is not None
    assert updated.github_repo == "octo/demo"
    assert updated.github_branch == "main"
    assert updated.github_commit_sha == "abc123"
    assert updated.github_index_status is GitHubIndexStatus.INDEXING
    reread = repo.get_session("sess-9")
    assert reread is not None
    assert reread.github_index_status is GitHubIndexStatus.INDEXING


def test_set_session_github_missing_session_returns_none() -> None:
    from sanba_shared.models import GitHubIndexStatus

    repo = _repo()
    assert (
        repo.set_session_github(
            "nope",
            repo=None,
            branch=None,
            commit_sha=None,
            index_status=GitHubIndexStatus.NONE,
        )
        is None
    )


def test_create_session_doc_applies_ttl_only_when_requested() -> None:
    """ゲスト作成セッションの 30 日 TTL（ADR-0032 / FR-2.7）。

    Firestore 経路（_client あり）で apply_ttl=True のときだけ `expireAt` を書く。
    ログイン済みセッション（apply_ttl=False）は履歴・finalize 資産のアンカーなので
    従来どおり張らない。retention 0（無期限運用）なら apply_ttl でも張らない。
    """
    from datetime import datetime

    captured: dict[str, dict[str, object]] = {}

    class _Doc:
        def __init__(self, key: str) -> None:
            self.key = key

        def set(self, doc: dict[str, object]) -> None:
            captured[self.key] = doc

    class _Col:
        def document(self, key: str) -> _Doc:
            return _Doc(key)

    class _Client:
        def collection(self, name: str) -> _Col:
            assert name == "sessions"
            return _Col()

    repo = SessionRepository(data_retention_days=30)
    repo._client = _Client()  # type: ignore[assignment]

    def _meta(sid: str) -> SessionMeta:
        return SessionMeta(id=sid, title="t", owner_sub="owner", owner_email="")

    repo.create_session_doc(_meta("s-guest"), apply_ttl=True)
    assert isinstance(captured["s-guest"]["expireAt"], datetime)

    repo.create_session_doc(_meta("s-login"))
    assert "expireAt" not in captured["s-login"]

    keep_forever = SessionRepository(data_retention_days=0)
    keep_forever._client = _Client()  # type: ignore[assignment]
    keep_forever.create_session_doc(_meta("s-keep"), apply_ttl=True)
    assert "expireAt" not in captured["s-keep"]


def test_finalize_and_approve_snapshots_and_approves_atomically() -> None:
    """自動確定用のバッチが確定マーカと確定集合の承認を一括で書く（ADR-0056）。"""
    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="s-af", title="t", owner_sub="sub", owner_email="o@example.com")
    )
    repo.save_requirement(
        "s-af",
        Requirement(
            id="c1",
            statement="確定",
            category=RequirementCategory.FUNCTIONAL,
            priority=Priority.MUST,
        ),
    )
    repo.save_requirement(
        "s-af",
        Requirement(
            id="x1",
            statement="却下",
            category=RequirementCategory.SCOPE,
            priority=Priority.SHOULD,
            status=RequirementStatus.REJECTED,
        ),
    )

    meta = repo.finalize_and_approve(
        "s-af",
        finalized_requirement_ids=["c1"],
        labels=["sanba", "priority:must", "functional"],
        approved_by="agent:auto_finalize",
        keep_expiry=False,
    )

    assert meta is not None
    assert meta.status == "finalized"
    assert meta.finalized_requirement_ids == ["c1"]
    assert meta.finalized_count == 1
    assert meta.labels == ["sanba", "priority:must", "functional"]
    c1 = repo.get_requirement("s-af", "c1")
    assert c1 is not None
    assert c1.status is RequirementStatus.APPROVED
    assert c1.approved_by == "agent:auto_finalize"
    x1 = repo.get_requirement("s-af", "x1")
    assert x1 is not None
    assert x1.status is RequirementStatus.REJECTED


def test_finalize_and_approve_is_noop_when_already_finalized() -> None:
    """既に finalized なら再確定せず既存スナップショットを返す（通常 finalize と冪等）。"""
    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="s-af2", title="t", owner_sub="sub", owner_email="o@example.com")
    )
    repo.save_requirement(
        "s-af2",
        Requirement(
            id="c1",
            statement="確定",
            category=RequirementCategory.FUNCTIONAL,
            priority=Priority.MUST,
        ),
    )
    repo.finalize_session(
        "s-af2", confirmed_count=1, finalized_requirement_ids=["c1"], labels=["sanba"]
    )

    meta = repo.finalize_and_approve(
        "s-af2",
        finalized_requirement_ids=["c1", "late"],
        labels=["sanba", "priority:must"],
        approved_by="agent:auto_finalize",
        keep_expiry=False,
    )

    assert meta is not None
    assert meta.finalized_requirement_ids == ["c1"]


def test_finalize_and_approve_second_call_does_not_overwrite_snapshot() -> None:
    """CAS で 2 度目の確定は最初のスナップショットを上書きしない（API–agent 競合の冪等性）。"""
    repo = _repo()
    repo.create_session_doc(
        SessionMeta(id="s-af3", title="t", owner_sub="sub", owner_email="o@example.com")
    )
    repo.save_requirement(
        "s-af3",
        Requirement(
            id="c1",
            statement="確定",
            category=RequirementCategory.FUNCTIONAL,
            priority=Priority.MUST,
        ),
    )

    first = repo.finalize_and_approve(
        "s-af3",
        finalized_requirement_ids=["c1"],
        labels=["sanba", "functional"],
        approved_by="api:owner",
        keep_expiry=False,
    )
    second = repo.finalize_and_approve(
        "s-af3",
        finalized_requirement_ids=["c1"],
        labels=["sanba", "override"],
        approved_by="agent:auto_finalize",
        keep_expiry=False,
    )

    assert first is not None
    assert second is not None
    assert second.labels == ["sanba", "functional"]
    c1 = repo.get_requirement("s-af3", "c1")
    assert c1 is not None
    assert c1.approved_by == "api:owner"
