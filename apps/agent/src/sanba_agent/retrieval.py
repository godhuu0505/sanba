"""Elasticsearch-backed grounding store.

Two jobs (see ADR-0003):
  1. RAG grounding — ヒアリング中の問いを、要件定義のベストプラクティス/チェックリストや
     ドメイン知識で裏付け、引用元つきで返す(佐藤一憲氏の Agentic RAG with Vector Search)。
  2. 過去セッション検索 — 類似する過去のインタビューや確定要件を呼び戻す。

Hybrid search = BM25(全文) + kNN(Gemini embeddings)。Elasticsearch が無い環境
(ユニットテスト等)では、語の重なりスコアの in-memory フォールバックで動く。
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass

import structlog
from sanba_shared.analytics import TokenUsage, estimated_embedding_tokens

from .config import settings
from .pii import mask_pii

log = structlog.get_logger(__name__)

EmbedUsageHook = Callable[[TokenUsage], None]

INDEX = "sanba-grounding"
EMBED_DIM = 3072


@dataclass
class Passage:
    text: str
    source: str
    kind: str
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

    def __init__(self, usage_hook: EmbedUsageHook | None = None) -> None:
        self._client = self._init_client()
        self._mem: list[_MemDoc] = []
        self._mem_lock = threading.Lock()
        self._usage_hook = usage_hook
        if self._client is not None:
            try:
                self._ensure_index()
            except Exception as exc:
                self._degrade_to_memory(exc)

    @property
    def is_memory(self) -> bool:
        """True when running on the in-memory fallback (no Elasticsearch)."""
        return self._client is None

    def _degrade_to_memory(self, exc: Exception) -> None:
        log.warning("elasticsearch_unavailable_using_memory", error=str(exc))
        self._client = None

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
        except Exception as exc:  # pragma: no cover
            log.warning("elasticsearch_unavailable_using_memory", error=str(exc))
            return None

    def _ensure_index(self) -> None:  # pragma: no cover
        if self._client.indices.exists(index=INDEX):
            try:
                self._client.indices.put_mapping(
                    index=INDEX, properties={"session_id": {"type": "keyword"}}
                )
            except Exception as exc:
                log.warning("ensure_session_id_mapping_failed", error=str(exc))
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

    def index_passage(
        self,
        text: str,
        source: str,
        kind: str,
        session_id: str | None = None,
        doc_id: str | None = None,
    ) -> None:
        if settings.mask_pii_before_index:
            text = mask_pii(text)
        if self._client is None:
            with self._mem_lock:
                self._mem.append(_MemDoc(text, source, kind, session_id, None))
            return
        try:
            embedding = embed_text(text, on_usage=self._usage_hook)
            doc: dict[str, object] = {
                "text": text,
                "source": source,
                "kind": kind,
                "session_id": session_id,
            }
            if embedding is not None:  # pragma: no cover
                doc["embedding"] = embedding
            if doc_id is not None:
                self._client.index(index=INDEX, id=doc_id, document=doc)
            else:  # pragma: no cover
                self._client.index(index=INDEX, document=doc)
        except Exception as exc:
            self._degrade_to_memory(exc)
            with self._mem_lock:
                self._mem.append(_MemDoc(text, source, kind, session_id, None))

    def search(
        self,
        query: str,
        k: int = 4,
        kinds: list[str] | None = None,
        session_id: str | None = None,
        product_id: str | None = None,
    ) -> list[Passage]:
        """Retrieve grounding passages.

        ``session_id`` を渡すと、セッション固有の素材（``kind="context"``: ゴール文・
        アップロード資料）を **そのセッションに限定**する。知識/過去要件
        (knowledge/requirement/utterance) は ADR-0003 の通り横断的に呼び戻す。
        これが無いと、別セッションの参加者が repo 名や実装語で検索したとき他者の private
        リポジトリ断片が返り得る（cross-tenant leak）。

        ``product_id`` を併せて渡すと、product スコープで索引された前提素材（紐づけ repo の
        コード本文 / ADR-0028・0053: `session_id=product_id` で保存）も context として
        許可する。配下セッションが product の前提を共有するための可視範囲拡張で、許可対象は
        「当該セッション ∪ 当該 product」に限る（他 product/他セッションの context は除外）。
        """
        if self._client is not None:
            try:
                return self._search_es(query, k, kinds, session_id, product_id)
            except Exception as exc:
                self._degrade_to_memory(exc)
        return self._search_mem(query, k, kinds, session_id, product_id)

    @staticmethod
    def _build_search_params(
        query: str,
        k: int,
        kinds: list[str] | None,
        embedding: list[float] | None,
        session_id: str | None = None,
        product_id: str | None = None,
    ) -> dict:
        """Build elasticsearch ``search`` keyword arguments.

        Passed via ``client.search(index=INDEX, **params)`` rather than the legacy
        ``body=`` parameter, which was removed in elasticsearch-py 9.0.
        """
        kind_filter: list[dict] = [{"terms": {"kind": kinds}}] if kinds else []
        if session_id is not None:
            context_scope = [session_id] + ([product_id] if product_id else [])
            kind_filter.append(
                {
                    "bool": {
                        "minimum_should_match": 1,
                        "should": [
                            {"bool": {"must_not": {"term": {"kind": "context"}}}},
                            {"terms": {"session_id": context_scope}},
                        ],
                    }
                }
            )
        params: dict = {
            "size": k,
            "query": {"bool": {"must": {"match": {"text": query}}, "filter": kind_filter}},
        }
        if embedding is not None:
            params["knn"] = {
                "field": "embedding",
                "query_vector": embedding,
                "k": k,
                "num_candidates": 50,
                "filter": kind_filter,
            }
        return params

    def _search_es(  # pragma: no cover
        self,
        query: str,
        k: int,
        kinds: list[str] | None,
        session_id: str | None = None,
        product_id: str | None = None,
    ) -> list[Passage]:
        embedding = embed_text(query, on_usage=self._usage_hook)
        params = self._build_search_params(query, k, kinds, embedding, session_id, product_id)
        res = self._client.search(index=INDEX, **params)
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

    def _search_mem(
        self,
        query: str,
        k: int,
        kinds: list[str] | None,
        session_id: str | None = None,
        product_id: str | None = None,
    ) -> list[Passage]:
        tokens = tokenize(query)
        context_scope = {session_id} | ({product_id} if product_id else set())
        scored: list[Passage] = []
        with self._mem_lock:
            docs = list(self._mem)
        for doc in docs:
            if kinds and doc.kind not in kinds:
                continue
            if (
                session_id is not None
                and doc.kind == "context"
                and doc.session_id not in context_scope
            ):
                continue
            overlap = len(tokens & tokenize(doc.text))
            if overlap == 0:
                continue
            scored.append(Passage(doc.text, doc.source, doc.kind, float(overlap), doc.session_id))
        scored.sort(key=lambda p: p.score, reverse=True)
        return scored[:k]


def tokenize(text: str) -> set[str]:
    """Cheap CJK-aware tokeniser: words + character bigrams for the memory fallback."""
    import re

    words = set(re.findall(r"[a-zA-Z0-9]+", text.lower()))
    cjk = re.sub(r"[^\w]", "", re.sub(r"[a-zA-Z0-9]+", "", text))
    bigrams = {cjk[i : i + 2] for i in range(len(cjk) - 1)}
    return words | bigrams


_embed_client: object | None = None
_embed_client_lock = threading.Lock()


def _embedding_client():  # type: ignore[no-untyped-def] # pragma: no cover
    """遅延生成した genai.Client を使い回す。

    従来は呼び出しごとに Client を生成しており、発話・要件のたびに接続確立コストが
    上乗せされていた（音声ターンのレイテンシ源）。プロセス内で 1 つに束ねる。
    """
    global _embed_client
    if _embed_client is None:
        with _embed_client_lock:
            if _embed_client is None:
                from google import genai

                _embed_client = genai.Client(api_key=settings.google_api_key or None)
    return _embed_client


def embed_text(text: str, *, on_usage: EmbedUsageHook | None = None) -> list[float] | None:
    """Embed text with Gemini. Returns None when no credentials are configured.

    `on_usage` には消費トークン（Vertex の `statistics.token_count`、無ければ文字数概算）を
    渡す（ADR-0061 の embedding コスト集計）。hook の失敗は埋め込み本体へ波及させない。
    """
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return None
    try:  # pragma: no cover
        client = _embedding_client()
        resp = client.models.embed_content(model=settings.gemini_embed_model, contents=text)
        embeddings = resp.embeddings
        if not embeddings or embeddings[0].values is None:
            return None
        if on_usage is not None:
            statistics = getattr(embeddings[0], "statistics", None)
            token_count = int(getattr(statistics, "token_count", 0) or 0)
            if token_count <= 0:
                token_count = estimated_embedding_tokens(text)
            try:
                on_usage(TokenUsage(input_tokens=token_count, input_text_tokens=token_count))
            except Exception as exc:  # noqa: BLE001
                log.warning("embed_usage_hook_failed", error=str(exc))
        return list(embeddings[0].values)
    except Exception as exc:  # pragma: no cover
        log.warning("embed_failed", error=str(exc))
        return None
