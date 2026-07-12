"""grounding のチャンク分割と索引投入の境界・上限テスト（Firestore/ES 非接続）。"""

from __future__ import annotations

import pytest

from sanba_shared.grounding import (
    MATERIAL_KIND,
    MAX_INDEX_CHUNKS,
    ContextIndexer,
    GroundingConfig,
    chunk_text,
)


def test_chunk_text_defaults_split_without_loss() -> None:
    chunks = chunk_text("a" * 250, chunk_size=100, overlap=20)
    assert len(chunks) > 1
    assert "".join(chunks).count("a") >= 250


def test_chunk_text_rejects_nonpositive_chunk_size() -> None:
    with pytest.raises(ValueError):
        chunk_text("text", chunk_size=0, overlap=0)


def test_chunk_text_rejects_overlap_not_less_than_chunk_size() -> None:
    with pytest.raises(ValueError):
        chunk_text("text", chunk_size=100, overlap=100)
    with pytest.raises(ValueError):
        chunk_text("text", chunk_size=100, overlap=150)


def test_index_context_caps_chunks_and_reports() -> None:
    indexer = ContextIndexer(GroundingConfig())
    assert indexer.is_memory
    chunks = [f"chunk-{i}" for i in range(MAX_INDEX_CHUNKS + 5)]
    indexed = indexer.index_context("s1", chunks, "asset:1")
    assert indexed == MAX_INDEX_CHUNKS
    assert len(indexer._mem) == MAX_INDEX_CHUNKS


def test_index_context_defaults_to_context_kind() -> None:
    indexer = ContextIndexer(GroundingConfig())
    indexer.index_context("s1", ["repo chunk"], "github:o/r@main@sha:a.py")
    assert {d["kind"] for d in indexer._mem} == {"context"}


def test_index_context_stores_material_kind_for_uploads() -> None:
    indexer = ContextIndexer(GroundingConfig())
    indexer.index_context("s1", ["observation"], "asset:1", kind=MATERIAL_KIND)
    assert {d["kind"] for d in indexer._mem} == {"material"}
    assert all(d["session_id"] == "s1" for d in indexer._mem)
