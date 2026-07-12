"""Unit tests for the in-memory grounding fallback (no Elasticsearch required)."""

from __future__ import annotations

from sanba_agent.retrieval import GroundingStore


def test_memory_store_is_used_without_elasticsearch() -> None:
    store = GroundingStore()
    assert store.is_memory is True


def test_memory_mode_does_not_call_embeddings(monkeypatch) -> None:
    import sanba_agent.retrieval as retrieval

    def _boom(text: str) -> list[float] | None:
        raise AssertionError("memory mode must not call embed_text")

    monkeypatch.setattr(retrieval, "embed_text", _boom)
    store = GroundingStore()
    assert store.is_memory is True
    store.index_passage("非機能要件はセキュリティと可用性を確認する。", "guide:nfr", "knowledge")
    results = store.search("セキュリティ 要件", k=2)
    assert results and results[0].source == "guide:nfr"
    assert store._mem[0].embedding is None


def test_transient_elasticsearch_error_falls_back_to_memory(monkeypatch) -> None:
    class _Indices:
        def exists(self, index):  # type: ignore[no-untyped-def]
            raise RuntimeError("NotFoundError(404, 'Unknown resource.')")

    class _FlakyClient:
        indices = _Indices()

    monkeypatch.setattr(GroundingStore, "_init_client", staticmethod(lambda: _FlakyClient()))
    store = GroundingStore()
    assert store.is_memory is True
    store.index_passage("非機能要件を確認する。", "guide:nfr", "knowledge")
    results = store.search("非機能 要件", k=1)
    assert results and results[0].source == "guide:nfr"


def test_runtime_index_error_degrades_to_memory() -> None:
    class _Boom:
        def index(self, **kwargs):  # type: ignore[no-untyped-def]
            raise RuntimeError("connection reset by peer")

    store = GroundingStore()
    store._client = _Boom()
    assert store.is_memory is False
    store.index_passage("非機能要件を確認する。", "guide:nfr", "knowledge")
    assert store.is_memory is True
    results = store.search("非機能 要件", k=1)
    assert results and results[0].source == "guide:nfr"


def test_runtime_search_error_degrades_to_memory() -> None:
    store = GroundingStore()
    store.index_passage("非機能要件を確認する。", "guide:nfr", "knowledge")

    class _Boom:
        def search(self, **kwargs):  # type: ignore[no-untyped-def]
            raise RuntimeError("connection reset by peer")

    store._client = _Boom()
    results = store.search("非機能 要件", k=1)
    assert store.is_memory is True
    assert results and results[0].source == "guide:nfr"


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
    store = GroundingStore()
    src_a = "github:o/r@main:rank.py"
    src_b = "github:o/r2@main:billing.py"
    store.index_passage("検索リランキングの実装コード", src_a, "context", "sess-A")
    store.index_passage("別案件の請求ロジックの実装コード", src_b, "context", "sess-B")

    mine = store.search("実装 コード", k=5, session_id="sess-A")
    sources = {p.source for p in mine}
    assert src_a in sources
    assert src_b not in sources


def test_uploaded_material_is_scoped_to_session() -> None:
    store = GroundingStore()
    mine = "asset:mine"
    theirs = "asset:theirs"
    store.index_passage("私のセッションへ上げた請求書の画面", mine, "material", "sess-A")
    store.index_passage("他人のセッションへ上げた請求書の画面", theirs, "material", "sess-B")

    out = store.search("請求書 画面", k=5, session_id="sess-A")
    sources = {p.source for p in out}
    assert mine in sources
    assert theirs not in sources, (
        "material も context 同様 session 越境させない（cross-tenant leak 防止）"
    )


def test_build_search_params_scopes_material_kind_to_session() -> None:
    params = GroundingStore._build_search_params(
        "x", k=3, kinds=None, embedding=None, session_id="sess-A"
    )
    filters = params["query"]["bool"]["filter"]
    should = next(f["bool"]["should"] for f in filters if "bool" in f)
    must_not = next(clause["bool"]["must_not"] for clause in should if "bool" in clause)
    assert set(must_not["terms"]["kind"]) == {"context", "material"}


def test_product_scoped_context_is_reachable_with_product_id() -> None:
    store = GroundingStore()
    repo_src = "github:o/r@main@sha:src/app.py"
    other_src = "github:x/y@main@sha:src/other.py"
    store.index_passage("紐づけ repo の実装コード本文", repo_src, "context", "prod-1")
    store.index_passage("別 product の実装コード本文", other_src, "context", "prod-2")

    with_product = store.search("実装 コード", k=5, session_id="sess-A", product_id="prod-1")
    sources = {p.source for p in with_product}
    assert repo_src in sources
    assert other_src not in sources

    without_product = store.search("実装 コード", k=5, session_id="sess-A")
    assert repo_src not in {p.source for p in without_product}


def test_build_search_params_context_scope_includes_product() -> None:
    params = GroundingStore._build_search_params(
        "x", k=3, kinds=None, embedding=None, session_id="sess-A", product_id="prod-1"
    )
    filters = params["query"]["bool"]["filter"]
    should = next(f["bool"]["should"] for f in filters if "bool" in f)
    terms = next(clause["terms"]["session_id"] for clause in should if "terms" in clause)
    assert terms == ["sess-A", "prod-1"]


def test_non_context_kinds_still_recall_across_sessions() -> None:
    store = GroundingStore()
    store.index_passage("非機能要件は可用性99.9%", "req-1", "requirement", "other-session")
    out = store.search("可用性 要件", k=5, session_id="sess-A")
    assert any(p.source == "req-1" for p in out)


def test_build_search_params_scopes_context_to_session() -> None:
    params = GroundingStore._build_search_params(
        "x", k=3, kinds=None, embedding=None, session_id="sess-A"
    )
    filters = params["query"]["bool"]["filter"]
    assert any("bool" in f and "should" in f["bool"] for f in filters)


def test_index_passage_upserts_with_deterministic_id(monkeypatch) -> None:
    import sanba_agent.retrieval as retrieval

    calls: list[dict] = []

    class _FakeClient:
        def index(self, **kwargs: object) -> None:
            calls.append(kwargs)

    monkeypatch.setattr(retrieval, "embed_text", lambda text, **_kwargs: None)
    store = GroundingStore()
    store._client = _FakeClient()
    store.index_passage("KB text", "guide:x", "knowledge", doc_id="knowledge:guide:x")
    store.index_passage("no id", "guide:y", "knowledge")
    assert calls[0]["id"] == "knowledge:guide:x"
    assert calls[0]["index"] == retrieval.INDEX
    assert "id" not in calls[1]


def test_seed_knowledge_base_populates_grounding() -> None:
    from sanba_agent.main import KNOWLEDGE_BASE, seed_knowledge_base

    store = GroundingStore()
    assert store.is_memory is True
    seed_knowledge_base(store)
    assert len(store._mem) == len(KNOWLEDGE_BASE)
    hits = store.search("MoSCoW 優先度付け", k=3)
    assert any(p.source == "guide:moscow" for p in hits)


def test_is_stale_repo_passage_filters_other_sha() -> None:
    from sanba_agent.main import _is_stale_repo_passage

    cur = "github:o/r@main@shaNEW:src/a.py"
    old = "github:o/r@main@shaOLD:src/a.py"
    assert _is_stale_repo_passage(old, "shaNEW") is True
    assert _is_stale_repo_passage(cur, "shaNEW") is False
    assert _is_stale_repo_passage("knowledge:reqs#1", "shaNEW") is False
    assert _is_stale_repo_passage("github:o/r#readme", "shaNEW") is False


def test_unlinked_owner_blocks_repo_passages(monkeypatch) -> None:
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
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))
    assert agent._repo_access() == ("sha1", False)
    repo.delete_github_link("owner")
    assert agent._repo_access() == ("sha1", True)


def test_agent_threads_product_id_into_grounding_search() -> None:
    from sanba_shared.models import GitHubIndexStatus, GitHubLink, Product, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.main import SANBAAgent

    repo = SessionRepository()
    repo.create_product(Product(id="prod-1", name="p", owner_sub="owner"))
    repo.set_product_github(
        "prod-1",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.create_session_doc(
        SessionMeta(
            id="sess-x",
            title="t",
            owner_sub="owner",
            owner_email="o@example.com",
            product_id="prod-1",
        )
    )
    repo.set_session_github(
        "sess-x",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))

    grounding = GroundingStore()
    grounding.index_passage(
        "紐づけ repo の実装コード本文", "github:octo/r@main@sha1:app.py", "context", "prod-1"
    )

    agent = SANBAAgent("sess-x", repo, grounding)
    assert agent._product_id == "prod-1"

    result = agent._grounded_search_inner("実装 コード")
    sources = {p["source"] for p in result["passages"]}
    assert "github:octo/r@main@sha1:app.py" in sources


def test_repo_access_uses_product_current_sha_not_stale_session_snapshot() -> None:
    from sanba_shared.models import GitHubIndexStatus, GitHubLink, Product, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.main import SANBAAgent

    repo = SessionRepository()
    repo.create_product(Product(id="prod-1", name="p", owner_sub="owner"))
    repo.set_product_github(
        "prod-1",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.create_session_doc(
        SessionMeta(
            id="sess-x",
            title="t",
            owner_sub="owner",
            owner_email="o@example.com",
            product_id="prod-1",
        )
    )
    repo.set_session_github(
        "sess-x",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))

    grounding = GroundingStore()
    agent = SANBAAgent("sess-x", repo, grounding)

    assert agent._repo_access() == ("sha1", False)

    repo.set_product_github(
        "prod-1",
        repo="octo/r",
        branch="main",
        commit_sha="sha2",
        index_status=GitHubIndexStatus.READY,
    )

    assert agent._repo_access() == ("sha2", False)


def test_grounded_search_recovers_after_product_reindex_commit_sha_change() -> None:
    from sanba_shared.models import GitHubIndexStatus, GitHubLink, Product, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.main import SANBAAgent

    repo = SessionRepository()
    repo.create_product(Product(id="prod-1", name="p", owner_sub="owner"))
    repo.set_product_github(
        "prod-1",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.create_session_doc(
        SessionMeta(
            id="sess-x",
            title="t",
            owner_sub="owner",
            owner_email="o@example.com",
            product_id="prod-1",
        )
    )
    repo.set_session_github(
        "sess-x",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))

    repo.set_product_github(
        "prod-1",
        repo="octo/r",
        branch="main",
        commit_sha="sha2",
        index_status=GitHubIndexStatus.READY,
    )
    grounding = GroundingStore()
    grounding.index_passage(
        "紐づけ repo の実装コード本文（再索引後）",
        "github:octo/r@main@sha2:app.py",
        "context",
        "prod-1",
    )

    agent = SANBAAgent("sess-x", repo, grounding)
    result = agent._grounded_search_inner("実装 コード")
    sources = {p["source"] for p in result["passages"]}
    assert "github:octo/r@main@sha2:app.py" in sources


def test_repo_access_falls_back_to_revoked_when_product_missing() -> None:
    from sanba_shared.models import GitHubIndexStatus, GitHubLink, SessionMeta
    from sanba_shared.repository import SessionRepository

    from sanba_agent.main import SANBAAgent

    repo = SessionRepository()
    repo.create_session_doc(
        SessionMeta(
            id="sess-x",
            title="t",
            owner_sub="owner",
            owner_email="o@example.com",
            product_id="prod-missing",
        )
    )
    repo.set_session_github(
        "sess-x",
        repo="octo/r",
        branch="main",
        commit_sha="sha1",
        index_status=GitHubIndexStatus.READY,
    )
    repo.set_github_link(GitHubLink(sub="owner", installation_id=1, github_login="octo"))

    grounding = GroundingStore()
    agent = SANBAAgent("sess-x", repo, grounding)

    assert agent._repo_access() == ("sha1", True)
