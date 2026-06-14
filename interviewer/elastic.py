"""Thin Elasticsearch wrapper for vector (kNN) search.

Two indices:
  - knowledge index: domain knowledge / best practices the interviewer grounds
    questions against (Agentic RAG).
  - sessions index: distilled logs of past interviews, for recall.

All methods are no-ops-with-status when Elasticsearch is not configured, so the
agent runs locally without a backend (tools return a clear status instead of
raising).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from interviewer.config import get_config


@lru_cache(maxsize=1)
def _client():
    from elasticsearch import Elasticsearch

    cfg = get_config()
    kwargs: dict[str, Any] = {}
    if cfg.elasticsearch_api_key:
        kwargs["api_key"] = cfg.elasticsearch_api_key
    return Elasticsearch(cfg.elasticsearch_url, **kwargs)


def _ensure_index(name: str, dims: int) -> None:
    es = _client()
    if es.indices.exists(index=name):
        return
    es.indices.create(
        index=name,
        mappings={
            "properties": {
                "text": {"type": "text"},
                "title": {"type": "text"},
                "metadata": {"type": "object", "enabled": True},
                "embedding": {
                    "type": "dense_vector",
                    "dims": dims,
                    "index": True,
                    "similarity": "cosine",
                },
            }
        },
    )


def index_document(
    index: str,
    *,
    doc_id: str,
    text: str,
    embedding: list[float],
    title: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Upsert a document with its embedding."""
    _ensure_index(index, dims=len(embedding))
    _client().index(
        index=index,
        id=doc_id,
        document={
            "text": text,
            "title": title,
            "metadata": metadata or {},
            "embedding": embedding,
        },
    )


def knn_search(
    index: str, *, query_embedding: list[float], k: int = 4
) -> list[dict[str, Any]]:
    """Return the top-k nearest documents (text/title/metadata/score)."""
    es = _client()
    if not es.indices.exists(index=index):
        return []
    resp = es.search(
        index=index,
        knn={
            "field": "embedding",
            "query_vector": query_embedding,
            "k": k,
            "num_candidates": max(50, k * 10),
        },
        size=k,
        source_excludes=["embedding"],
    )
    hits = resp.get("hits", {}).get("hits", [])
    return [
        {
            "title": h["_source"].get("title"),
            "text": h["_source"].get("text", ""),
            "metadata": h["_source"].get("metadata", {}),
            "score": h.get("_score"),
        }
        for h in hits
    ]
