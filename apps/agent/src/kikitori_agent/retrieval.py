"""Elasticsearch-backed grounding store.

Two jobs (see ADR-0003):
  1. RAG grounding — ヒアリング中の問いを、要件定義のベストプラクティス/チェックリストや
     ドメイン知識で裏付け、引用元つきで返す(佐藤一憲氏の Agentic RAG with Vector Search)。
  2. 過去セッション検索 — 類似する過去のインタビューや確定要件を呼び戻す。

Hybrid search = BM25(全文) + kNN(Gemini embeddings)。Elasticsearch が無い環境
(ユニットテスト等)では、語の重なりスコアの in-memory フォールバックで動く。
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog

from .config import settings

log = structlog.get_logger(__name__)

INDEX = "kikitori-grounding"
EMBED_DIM = 768  # text-embedding-004


@dataclass
class Passage:
    text: str
    source: str
    kind: str  # "knowledge" | "requirement" | "utterance"
    score: float = 0.0
    session_id: str | None = None


@dataclass
class _MemDoc:
    text: str
    source: str
    kind: str
    session_id: str | None = None
    embedding: list[float] | None = None


class GroundingStore:
    """Index and retrieve grounding passages. ES with in-memory fallback."""

    def __init__(self) -> None:
        self._client = self._init_client()
        self._mem: list[_MemDoc] = []
        if self._client is not None:
            self._ensure_index()

    @property
    def is_memory(self) -> bool:
        """True when running on the in-memory fallback (no Elasticsearch)."""
        return self._client is None

    # ---- backend setup ------------------------------------------------
    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        if not settings.elasticsearch_url:
            return None
        try:
            from elasticsearch import Elasticsearch

            kwargs: dict = {"hosts": [settings.elasticsearch_url]}
            if settings.elasticsearch_api_key:
                kwargs["api_key"] = settings.elasticsearch_api_key
            return Elasticsearch(**kwargs)
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("elasticsearch_unavailable_using_memory", error=str(exc))
            return None

    def _ensure_index(self) -> None:  # pragma: no cover - needs live ES
        if self._client.indices.exists(index=INDEX):
            return
        self._client.indices.create(
            index=INDEX,
            mappings={
                "properties": {
                    "text": {"type": "text"},
                    "source": {"type": "keyword"},
                    "kind": {"type": "keyword"},
                    "session_id": {"type": "keyword"},
                    "embedding": {
                        "type": "dense_vector",
                        "dims": EMBED_DIM,
                        "index": True,
                        "similarity": "cosine",
                    },
                }
            },
        )

    # ---- write --------------------------------------------------------
    def index_passage(
        self, text: str, source: str, kind: str, session_id: str | None = None
    ) -> None:
        embedding = embed_text(text)
        if self._client is not None:  # pragma: no cover - needs live ES
            doc = {"text": text, "source": source, "kind": kind, "session_id": session_id}
            if embedding is not None:
                doc["embedding"] = embedding
            self._client.index(index=INDEX, document=doc)
            return
        self._mem.append(_MemDoc(text, source, kind, session_id, embedding))

    # ---- read ---------------------------------------------------------
    def search(self, query: str, k: int = 4, kinds: list[str] | None = None) -> list[Passage]:
        if self._client is not None:  # pragma: no cover - needs live ES
            return self._search_es(query, k, kinds)
        return self._search_mem(query, k, kinds)

    def _search_es(  # pragma: no cover - needs live ES
        self, query: str, k: int, kinds: list[str] | None
    ) -> list[Passage]:
        embedding = embed_text(query)
        kind_filter = [{"terms": {"kind": kinds}}] if kinds else []
        body: dict = {
            "size": k,
            "query": {"bool": {"must": {"match": {"text": query}}, "filter": kind_filter}},
        }
        if embedding is not None:
            body["knn"] = {
                "field": "embedding",
                "query_vector": embedding,
                "k": k,
                "num_candidates": 50,
                "filter": kind_filter,
            }
        res = self._client.search(index=INDEX, body=body)
        return [
            Passage(
                text=h["_source"]["text"],
                source=h["_source"].get("source", ""),
                kind=h["_source"].get("kind", ""),
                score=h.get("_score", 0.0),
                session_id=h["_source"].get("session_id"),
            )
            for h in res["hits"]["hits"]
        ]

    def _search_mem(self, query: str, k: int, kinds: list[str] | None) -> list[Passage]:
        tokens = _tokenize(query)
        scored: list[Passage] = []
        for doc in self._mem:
            if kinds and doc.kind not in kinds:
                continue
            overlap = len(tokens & _tokenize(doc.text))
            if overlap == 0:
                continue
            scored.append(
                Passage(doc.text, doc.source, doc.kind, float(overlap), doc.session_id)
            )
        scored.sort(key=lambda p: p.score, reverse=True)
        return scored[:k]


def _tokenize(text: str) -> set[str]:
    """Cheap CJK-aware tokeniser: words + character bigrams for the memory fallback."""
    import re

    words = set(re.findall(r"[a-zA-Z0-9]+", text.lower()))
    cjk = re.sub(r"[^\w]", "", re.sub(r"[a-zA-Z0-9]+", "", text))
    bigrams = {cjk[i : i + 2] for i in range(len(cjk) - 1)}
    return words | bigrams


def embed_text(text: str) -> list[float] | None:
    """Embed text with Gemini. Returns None when no credentials are configured."""
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return None
    try:  # pragma: no cover - needs network/credentials
        from google import genai

        client = genai.Client(api_key=settings.google_api_key or None)
        resp = client.models.embed_content(
            model=settings.gemini_embed_model, contents=text
        )
        return list(resp.embeddings[0].values)
    except Exception as exc:  # pragma: no cover
        log.warning("embed_failed", error=str(exc))
        return None
