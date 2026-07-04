"""Unit tests for the in-memory grounding fallback (no Elasticsearch required)."""

from __future__ import annotations

from sanba_agent.retrieval import GroundingStore


def test_memory_store_is_used_without_elasticsearch() -> None:
    store = GroundingStore()
    assert store.is_memory is True


def test_index_and_search_returns_relevant_passage() -> None:
    store = GroundingStore()
    store.index_passage("非機能要件はセキュリティと可用性を確認する。", "guide:nfr", "knowledge")
    store.index_passage("画面の色は青にする。", "guide:ui", "knowledge")

    results = store.search("セキュリティの要件はある？", k=2)
    assert results
    assert results[0].source == "guide:nfr"


def test_search_can_filter_by_kind() -> None:
    store = GroundingStore()
    store.index_passage("過去の要件: 同時5人接続", "requirement:req_x", "requirement", "sess-1")
    store.index_passage("一般知識: MoSCoWで優先度付け", "guide:moscow", "knowledge")

    only_reqs = store.search("接続 要件", k=5, kinds=["requirement"])
    assert all(p.kind == "requirement" for p in only_reqs)
    assert only_reqs and only_reqs[0].session_id == "sess-1"


def test_build_search_params_uses_keyword_args_not_legacy_body() -> None:
    # `body=` was removed in elasticsearch-py 9.0; the params must be top-level
    # keyword arguments so the ES path keeps working under elasticsearch>=8.14,<10.
    params = GroundingStore._build_search_params("セキュリティ", k=3, kinds=None, embedding=None)
    assert "body" not in params
    assert params["size"] == 3
    assert params["query"]["bool"]["must"]["match"]["text"] == "セキュリティ"
    assert "knn" not in params


def test_build_search_params_includes_knn_and_filter_when_available() -> None:
    params = GroundingStore._build_search_params(
        "接続", k=2, kinds=["requirement"], embedding=[0.1, 0.2, 0.3]
    )
    assert params["knn"]["field"] == "embedding"
    assert params["knn"]["query_vector"] == [0.1, 0.2, 0.3]
    assert params["knn"]["k"] == 2
    assert params["query"]["bool"]["filter"] == [{"terms": {"kind": ["requirement"]}}]


def test_context_passages_are_scoped_to_session() -> None:
    # context（セッション固有素材: ゴール/資料/紐づけ repo コード）は、session_id を渡すと
    # 当該セッションのものだけが返る（他セッションの private 断片の越境ヒットを防ぐ / ADR-0028）。
    store = GroundingStore()
    src_a = "github:o/r@main:rank.py"
    src_b = "github:o/r2@main:billing.py"
    store.index_passage("検索リランキングの実装コード", src_a, "context", "sess-A")
    store.index_passage("別案件の請求ロジックの実装コード", src_b, "context", "sess-B")

    mine = store.search("実装 コード", k=5, session_id="sess-A")
    sources = {p.source for p in mine}
    assert src_a in sources
    assert src_b not in sources


def test_non_context_kinds_still_recall_across_sessions() -> None:
    # 知識/過去要件は ADR-0003 の通り横断的に呼び戻す（session_id 指定でも絞らない）。
    store = GroundingStore()
    store.index_passage("非機能要件は可用性99.9%", "req-1", "requirement", "other-session")
    out = store.search("可用性 要件", k=5, session_id="sess-A")
    assert any(p.source == "req-1" for p in out)


def test_build_search_params_scopes_context_to_session() -> None:
    params = GroundingStore._build_search_params(
        "x", k=3, kinds=None, embedding=None, session_id="sess-A"
    )
    # context は session 一致 OR 非 context のみ通すフィルタが入る。
    filters = params["query"]["bool"]["filter"]
    assert any("bool" in f and "should" in f["bool"] for f in filters)


def test_is_stale_repo_passage_filters_other_sha() -> None:
    from sanba_agent.main import _is_stale_repo_passage

    cur = "github:o/r@main@shaNEW:src/a.py"
    old = "github:o/r@main@shaOLD:src/a.py"
    assert _is_stale_repo_passage(old, "shaNEW") is True
    assert _is_stale_repo_passage(cur, "shaNEW") is False
    # 知識や env connector 形式（@ なし）は対象外。
    assert _is_stale_repo_passage("knowledge:reqs#1", "shaNEW") is False
    assert _is_stale_repo_passage("github:o/r#readme", "shaNEW") is False


def test_unlinked_owner_blocks_repo_passages(monkeypatch) -> None:
    # owner が連携解除したら、索引済み repo chunk を検索時に遮断する（query-time ACL / ADR-0028）。
    from sanba_shared.models import GitHubIndexStatus, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.main import SANBAAgent

    repo = SessionRepository()
    assert repo._client is None
    repo.create_session_doc(
        SessionMeta(id="sess-x", title="t", owner_sub="owner", owner_email="o@example.com")
    )
    repo.set_session_github(
        "sess-x",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    from sanba_shared.models import GitHubLink

    grounding = GroundingStore()
    grounding.index_passage("repo code", "github:octo/r@main@sha1:a.py", "context", "sess-x")

    agent = SANBAAgent("sess-x", repo, grounding)
    # 連携あり → revoked=False。
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))
    assert agent._repo_access() == ("sha1", False)
    # 連携解除 → revoked=True（共有索引は消さず query 時に遮断する）。
    repo.delete_github_link("owner")
    assert agent._repo_access() == ("sha1", True)
