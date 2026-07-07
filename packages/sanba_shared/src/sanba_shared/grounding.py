"""Shared grounding index (Elasticsearch) writer for context/material chunks.

`apps/api` のアップロード取り込みと `apps/worker` の動画解析が、同じ Elasticsearch
grounding 索引（agent が `search_grounding` で読む索引）へ観察チャンクを投入するための
共有実装（ADR-0040）。

config は各アプリの settings に依存しないよう `GroundingConfig` で受け取り、PII マスクは
呼び出し側の masker を注入する（api/agent は各自の pii.py を使う）。ES 未設定なら
in-memory にフォールバックし、ローカル/テストで落とさない。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

import structlog

log = structlog.get_logger(__name__)

INDEX = "sanba-grounding"
EMBED_DIM = 3072


@dataclass(frozen=True)
class GroundingConfig:
    """grounding 索引への接続と埋め込み生成に必要な設定（アプリ settings 非依存）。"""

    elasticsearch_url: str = ""
    elasticsearch_api_key: str = ""
    embed_model: str = "gemini-embedding-001"
    use_vertexai: bool = False
    google_api_key: str = ""
    mask_pii: bool = True


def _source_matches(source: str, prefix: str) -> bool:
    """出所が削除接頭辞に一致するか（`prefix` 自身、または `prefix#<i>` の chunk）。

    `asset:{id}` を渡したとき `asset:{id}#0` 等を消しつつ、別 source（`asset:{id2}#0`）を
    巻き込まない（index_context が付ける `#<i>` 境界で判定する）。
    """
    return source == prefix or source.startswith(f"{prefix}#")


def chunk_text(text: str, chunk_size: int = 600, overlap: int = 80) -> list[str]:
    """Split text into overlapping chunks on paragraph/sentence boundaries."""
    text = text.strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) + 1 <= chunk_size:
            buf = f"{buf}\n{para}".strip()
            continue
        if buf:
            chunks.append(buf)
        if len(para) <= chunk_size:
            buf = para
        else:
            for i in range(0, len(para), chunk_size - overlap):
                chunks.append(para[i : i + chunk_size])
            buf = ""
    if buf:
        chunks.append(buf)
    return chunks


class ContextIndexer:
    """Writes context chunks to Elasticsearch, with an in-memory fallback for tests."""

    def __init__(
        self, config: GroundingConfig | None = None, masker: Callable[[str], str] | None = None
    ) -> None:
        self._config = config or GroundingConfig()
        self._masker = masker
        self._client = self._init_client()
        self._mem: list[dict] = []

    @property
    def is_memory(self) -> bool:
        return self._client is None

    def _init_client(self):  # type: ignore[no-untyped-def]
        if not self._config.elasticsearch_url:
            return None
        try:
            from elasticsearch import Elasticsearch

            kwargs: dict = {"hosts": [self._config.elasticsearch_url]}
            if self._config.elasticsearch_api_key:
                kwargs["api_key"] = self._config.elasticsearch_api_key
            client = Elasticsearch(**kwargs)
            if not client.indices.exists(index=INDEX):
                client.indices.create(
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
            else:
                try:
                    client.indices.put_mapping(
                        index=INDEX, properties={"session_id": {"type": "keyword"}}
                    )
                except Exception as exc:
                    log.warning("ensure_session_id_mapping_failed", error=str(exc))
            return client
        except Exception as exc:  # pragma: no cover
            log.warning("elasticsearch_unavailable_using_memory", error=str(exc))
            return None

    def _mask(self, chunk: str) -> str:
        if self._config.mask_pii and self._masker is not None:
            return self._masker(chunk)
        return chunk

    def index_context(self, session_id: str, chunks: list[str], source_name: str) -> int:
        """Index `chunks` for a session; returns the number indexed."""
        for i, chunk in enumerate(chunks):
            source = f"{source_name}#{i}"
            text = self._mask(chunk)
            embedding = _embed(text, self._config)
            if self._client is not None:  # pragma: no cover
                doc: dict[str, object] = {
                    "text": text,
                    "source": source,
                    "kind": "context",
                    "session_id": session_id,
                }
                if embedding is not None:
                    doc["embedding"] = embedding
                self._client.index(index=INDEX, document=doc)
            else:
                self._mem.append(
                    {"text": text, "source": source, "kind": "context", "session_id": session_id}
                )
        log.info("context_indexed", session=session_id, source=source_name, chunks=len(chunks))
        return len(chunks)

    def delete_repo_context(self, session_id: str) -> int:
        """セッションの GitHub repo 由来 chunk（source が `github:` 始まり）を全削除する。

        準備画面で repo を選び直した / 別 branch へ変えた / 再同期したとき、古い repo・commit の
        コード断片が search_grounding に残って混ざるのを防ぐ（ADR-0028）。repo/path に
        依らず一括で消すため、`delete_context` の `#` 境界一致ではなく `github:` 前方一致で消す。
        削除件数を返す（冪等: 0 件でも安全）。
        """
        if self._client is not None:  # pragma: no cover
            try:
                res = self._client.delete_by_query(
                    index=INDEX,
                    query={
                        "bool": {
                            "filter": [
                                {"term": {"session_id": session_id}},
                                {"prefix": {"source": "github:"}},
                            ]
                        }
                    },
                    refresh=True,
                )
                deleted = int(res.get("deleted", 0))
            except Exception as exc:  # pragma: no cover
                log.warning("repo_context_delete_failed", error=str(exc), session=session_id)
                return 0
        else:
            before = len(self._mem)
            self._mem = [
                d
                for d in self._mem
                if not (
                    d.get("session_id") == session_id
                    and str(d.get("source", "")).startswith("github:")
                )
            ]
            deleted = before - len(self._mem)
        if deleted:
            log.info("repo_context_deleted", session=session_id, chunks=deleted)
        return deleted

    def delete_context(self, session_id: str, source_prefix: str) -> int:
        """出所が `source_prefix`（例 `asset:{asset_id}`）の grounding chunk を取り消す。

        index_context は出所を `{source_name}#{i}` で保存するため、`source_prefix` 自身と
        `source_prefix#*` を削除対象にする（別 source_name への巻き込みを避ける）。ES 接続時は
        delete_by_query、未接続（テスト/ローカル）は in-memory を filter する。削除件数を返す
        （冪等: 0 件でも安全）。これで中断素材の観察を以後の検索（search_grounding）から外す。
        """
        if self._client is not None:  # pragma: no cover
            try:
                res = self._client.delete_by_query(
                    index=INDEX,
                    query={
                        "bool": {
                            "filter": [{"term": {"session_id": session_id}}],
                            "minimum_should_match": 1,
                            "should": [
                                {"term": {"source": source_prefix}},
                                {"prefix": {"source": f"{source_prefix}#"}},
                            ],
                        }
                    },
                    refresh=True,
                )
                deleted = int(res.get("deleted", 0))
            except Exception as exc:  # pragma: no cover
                log.warning("context_delete_failed", error=str(exc), source=source_prefix)
                return 0
        else:
            before = len(self._mem)
            self._mem = [
                d
                for d in self._mem
                if not (
                    d.get("session_id") == session_id
                    and _source_matches(str(d.get("source", "")), source_prefix)
                )
            ]
            deleted = before - len(self._mem)
        if deleted:
            log.info("context_deleted", session=session_id, source=source_prefix, chunks=deleted)
        return deleted


def _embed(text: str, config: GroundingConfig) -> list[float] | None:
    if not (config.google_api_key or config.use_vertexai):
        return None
    try:  # pragma: no cover
        from google import genai

        client = genai.Client(api_key=config.google_api_key or None)
        resp = client.models.embed_content(model=config.embed_model, contents=text)
        embeddings = resp.embeddings
        if not embeddings or embeddings[0].values is None:
            return None
        return list(embeddings[0].values)
    except Exception as exc:  # pragma: no cover
        log.warning("embed_failed", error=str(exc))
        return None
