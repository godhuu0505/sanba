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
