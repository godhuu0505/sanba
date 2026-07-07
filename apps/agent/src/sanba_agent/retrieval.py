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
from dataclasses import dataclass

import structlog

from .config import settings
from .pii import mask_pii

log = structlog.get_logger(__name__)

INDEX = "sanba-grounding"
EMBED_DIM = 3072  # gemini-embedding-001 (default; truncation requires manual L2 normalize)


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
        # メモリフォールバックは音声 worker の書き込みがスレッドへ逃がされる（main.py の
        # _persist）ため、索引 append と検索走査が別スレッドで並走し得る。_mem をロックで
        # 守り、走査中の並行 append と競合しないようにする（ES 経路では未使用）。
        self._mem_lock = threading.Lock()
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
            # 既存 index は PR 以前の mapping で作られている可能性がある。session_id が keyword で
            # 無いと term フィルタ（session スコープ）がヒットせず context が検索から
            # 消えるため、起動時に keyword mapping を明示する（既に keyword なら冪等・型衝突時は
            # ログのみで会話は止めない）。
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

    # ---- write --------------------------------------------------------
    def index_passage(
        self,
        text: str,
        source: str,
        kind: str,
        session_id: str | None = None,
        doc_id: str | None = None,
    ) -> None:
        # doc_id を渡すと ES 経路はその _id で upsert する（同じ内容の再投入で重複を作らない）。
        # 起動時に毎回シードする KB のように、複数 agent インスタンスが同じ文書を書いても
        # 一意になるよう決定的 _id を与えるための口（未指定なら従来どおり自動採番）。
        # Mask PII before anything is persisted to the grounding store.
        if settings.mask_pii_before_index:
            text = mask_pii(text)
        if self._client is None:
            # メモリフォールバックの検索（_search_mem）はトークン重なりだけで採点し、
            # 埋め込みを参照しない。使われない埋め込みを毎回計算すると (1) Vertex の
            # gemini-embedding クォータを浪費して 429 を招き、(2) 同期ブロッキング呼び出しで
            # 音声パイプラインのイベントループを塞ぐため、メモリモードでは embed しない。
            with self._mem_lock:
                self._mem.append(_MemDoc(text, source, kind, session_id, None))
            return
        embedding = embed_text(text)  # pragma: no cover - needs live ES
        doc: dict[str, object] = {
            "text": text,
            "source": source,
            "kind": kind,
            "session_id": session_id,
        }
        if embedding is not None:
            doc["embedding"] = embedding
        if doc_id is not None:
            self._client.index(index=INDEX, id=doc_id, document=doc)
        else:
            self._client.index(index=INDEX, document=doc)

    # ---- read ---------------------------------------------------------
    def search(
        self,
        query: str,
        k: int = 4,
        kinds: list[str] | None = None,
        session_id: str | None = None,
    ) -> list[Passage]:
        """Retrieve grounding passages.

        ``session_id`` を渡すと、セッション固有の素材（``kind="context"``: ゴール文・
        アップロード資料・紐づけ repo のコード本文 / ADR-0028）を **そのセッションに限定**する。
        知識/過去要件 (knowledge/requirement/utterance) は ADR-0003 の通り横断的に呼び戻す。
        これが無いと、別セッションの参加者が repo 名や実装語で検索したとき他者の private
        リポジトリ断片が返り得る（cross-tenant leak）。
        """
        if self._client is not None:  # pragma: no cover - needs live ES
            return self._search_es(query, k, kinds, session_id)
        return self._search_mem(query, k, kinds, session_id)

    @staticmethod
    def _build_search_params(
        query: str,
        k: int,
        kinds: list[str] | None,
        embedding: list[float] | None,
        session_id: str | None = None,
    ) -> dict:
        """Build elasticsearch ``search`` keyword arguments.

        Passed via ``client.search(index=INDEX, **params)`` rather than the legacy
        ``body=`` parameter, which was removed in elasticsearch-py 9.0.
        """
        kind_filter: list[dict] = [{"terms": {"kind": kinds}}] if kinds else []
        if session_id is not None:
            # context（セッション固有素材）は当該 session_id のものだけ。非 context は横断可。
            kind_filter.append(
                {
                    "bool": {
                        "minimum_should_match": 1,
                        "should": [
                            {"bool": {"must_not": {"term": {"kind": "context"}}}},
                            {"term": {"session_id": session_id}},
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

    def _search_es(  # pragma: no cover - needs live ES
        self, query: str, k: int, kinds: list[str] | None, session_id: str | None = None
    ) -> list[Passage]:
        embedding = embed_text(query)
        params = self._build_search_params(query, k, kinds, embedding, session_id)
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
        self, query: str, k: int, kinds: list[str] | None, session_id: str | None = None
    ) -> list[Passage]:
        tokens = tokenize(query)
        scored: list[Passage] = []
        # ロック下でスナップショットを取り、並行 append（_persist 経由の索引）と競合しない。
        with self._mem_lock:
            docs = list(self._mem)
        for doc in docs:
            if kinds and doc.kind not in kinds:
                continue
            # context（セッション固有素材）は当該セッションのものだけを返す。
            if session_id is not None and doc.kind == "context" and doc.session_id != session_id:
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


def _embedding_client():  # type: ignore[no-untyped-def] # pragma: no cover - needs genai
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


def embed_text(text: str) -> list[float] | None:
    """Embed text with Gemini. Returns None when no credentials are configured."""
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return None
    try:  # pragma: no cover - needs network/credentials
        client = _embedding_client()
        resp = client.models.embed_content(model=settings.gemini_embed_model, contents=text)
        embeddings = resp.embeddings
        if not embeddings or embeddings[0].values is None:
            return None
        return list(embeddings[0].values)
    except Exception as exc:  # pragma: no cover
        log.warning("embed_failed", error=str(exc))
        return None
