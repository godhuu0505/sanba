"""Pre-interview context ingestion -> Elasticsearch grounding (issue #6).

Lets an owner register existing material (PRD drafts, meeting notes, specs) before
the interview. Chunks are indexed into the SAME Elasticsearch index the agent reads
via `search_grounding` (kind="context").

索引投入の本体は `sanba_shared.grounding` へ移設した（worker からも同じロジックを使うため。
ADR-0040）。ここは api の settings と pii マスカを束ねる薄いアダプタと、api 固有のテキスト抽出
（pypdf）だけを残す。`ContextIndexer()` の無引数 API と `chunk_text` の import 互換は維持する。
"""

from __future__ import annotations

import structlog
from sanba_shared.grounding import ContextIndexer as _SharedIndexer
from sanba_shared.grounding import GroundingConfig, chunk_text

from .config import settings
from .pii import mask_pii

__all__ = ["ContextIndexer", "chunk_text", "extract_text_from_upload"]

log = structlog.get_logger(__name__)


def _grounding_config() -> GroundingConfig:
    return GroundingConfig(
        elasticsearch_url=settings.elasticsearch_url,
        elasticsearch_api_key=settings.elasticsearch_api_key,
        embed_model=settings.gemini_embed_model,
        use_vertexai=settings.google_genai_use_vertexai,
        google_api_key=settings.google_api_key,
        mask_pii=settings.mask_pii_before_index,
    )


class ContextIndexer(_SharedIndexer):
    """api の settings と pii マスカを束ねた grounding インデクサ（無引数で使える）。"""

    def __init__(self) -> None:
        super().__init__(_grounding_config(), masker=mask_pii)


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
