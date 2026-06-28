"""Pre-interview context ingestion -> Elasticsearch grounding (issue #6).

Lets an owner register existing material (PRD drafts, meeting notes, specs) before
the interview. Chunks are indexed into the SAME Elasticsearch index the agent reads
via `search_grounding` (kind="context"), so the agent grounds its questions on the
user's real documents and skips already-answered topics.

NOTE: the document shape mirrors apps/agent/.../retrieval.py. A shared package is the
right long-term home (tracked as a follow-up); kept compact here on purpose.
"""

from __future__ import annotations

import re

import structlog

from .config import settings
from .pii import mask_pii

log = structlog.get_logger(__name__)

INDEX = "sanba-grounding"
EMBED_DIM = 768  # text-embedding-004


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
    # Prefer paragraph boundaries; fall back to a sliding window for long blocks.
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

    def __init__(self) -> None:
        self._client = self._init_client()
        self._mem: list[dict] = []

    @property
    def is_memory(self) -> bool:
        return self._client is None

    @staticmethod
    def _init_client():  # type: ignore[no-untyped-def]
        if not settings.elasticsearch_url:
            return None
        try:
            from elasticsearch import Elasticsearch

            kwargs: dict = {"hosts": [settings.elasticsearch_url]}
            if settings.elasticsearch_api_key:
                kwargs["api_key"] = settings.elasticsearch_api_key
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
            return client
        except Exception as exc:  # pragma: no cover - depends on env
            log.warning("elasticsearch_unavailable_using_memory", error=str(exc))
            return None

    def index_context(self, session_id: str, chunks: list[str], source_name: str) -> int:
        """Index `chunks` for a session; returns the number indexed."""
        for i, chunk in enumerate(chunks):
            source = f"{source_name}#{i}"
            text = mask_pii(chunk) if settings.mask_pii_before_index else chunk
            embedding = _embed(text)
            if self._client is not None:  # pragma: no cover - needs live ES
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

    def delete_context(self, session_id: str, source_prefix: str) -> int:
        """出所が `source_prefix`（例 `asset:{asset_id}`）の grounding chunk を取り消す（#245）。

        index_context は出所を `{source_name}#{i}` で保存するため、`source_prefix` 自身と
        `source_prefix#*` を削除対象にする（別 source_name への巻き込みを避ける）。ES 接続時は
        delete_by_query、未接続（テスト/ローカル）は in-memory を filter する。削除件数を返す
        （冪等: 0 件でも安全）。これで中断素材の観察を以後の検索（search_grounding）から外す。
        """
        if self._client is not None:  # pragma: no cover - needs live ES
            try:
                # in-memory の _source_matches と同じ `#` 境界にそろえる: 素の prefix（あれば）と
                # `prefix#*` のみを対象にし、別 asset への前方一致の誤爆を防ぐ。
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
            except Exception as exc:  # pragma: no cover - depends on env
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


def _embed(text: str) -> list[float] | None:
    if not (settings.google_api_key or settings.google_genai_use_vertexai):
        return None
    try:  # pragma: no cover - needs creds/network
        from google import genai

        client = genai.Client(api_key=settings.google_api_key or None)
        resp = client.models.embed_content(model=settings.gemini_embed_model, contents=text)
        embeddings = resp.embeddings
        if not embeddings or embeddings[0].values is None:
            return None
        return list(embeddings[0].values)
    except Exception as exc:  # pragma: no cover
        log.warning("embed_failed", error=str(exc))
        return None


def extract_text_from_upload(filename: str, raw: bytes) -> str:
    """Best-effort text extraction for txt/md/pdf uploads."""
    name = filename.lower()
    if name.endswith(".pdf"):
        try:  # pragma: no cover - optional dependency
            import io

            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(raw))
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception as exc:  # pragma: no cover
            log.warning("pdf_extract_failed", error=str(exc))
            return ""
    # txt / md / anything decodable as utf-8
    return raw.decode("utf-8", errors="replace")
