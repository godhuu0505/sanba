"""Pre-interview context ingestion -> Elasticsearch grounding (issue #6).

Lets an owner register existing material (PRD drafts, meeting notes, specs) before
the interview. Chunks are indexed into the SAME Elasticsearch index the agent reads
via `search_grounding` (kind="context").

索引投入の本体は `sanba_shared.grounding` へ移設した（worker からも同じロジックを使うため。
ADR-0040）。ここは api の settings と pii マスカを束ねる薄いアダプタと、api 固有のテキスト抽出
（pypdf）だけを残す。`ContextIndexer()` の無引数 API と `chunk_text` の import 互換は維持する。
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Callable
from html.parser import HTMLParser

import structlog
from sanba_shared.grounding import ContextIndexer as _SharedIndexer
from sanba_shared.grounding import GroundingConfig, chunk_text

from .config import settings
from .pii import mask_pii

__all__ = [
    "ContextIndexer",
    "DocumentExtractionError",
    "chunk_text",
    "extract_text_from_upload",
]

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


class DocumentExtractionError(Exception):
    """バイナリ文書からのテキスト抽出失敗（壊れた zip・想定外の中身・展開爆発）。

    呼び出し側（context/file エンドポイント）はこれを 500 にせず「抽出 0 件」へ平すが、
    メトリクス上は成功（indexed）と区別して計上する（運用での異常検知のため）。
    """


# zip コンテナ（docx/xlsx/pptx）の展開後合計サイズ上限。受理サイズ（max_asset_bytes=25MB）は
# 圧縮後のバイト数なので、極端な圧縮率の zip bomb は展開時にメモリを食い尽くし得る。
# 展開前に infolist の非圧縮サイズ合計で弾く（Cloud Run 同居リクエストを OOM で巻き込まない）。
_MAX_ZIP_EXPANSION_BYTES = 100_000_000


def _guard_zip_expansion(raw: bytes) -> None:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        total = sum(info.file_size for info in archive.infolist())
    if total > _MAX_ZIP_EXPANSION_BYTES:
        raise DocumentExtractionError(
            f"zip expands to {total} bytes (limit {_MAX_ZIP_EXPANSION_BYTES})"
        )


class _HTMLTextExtractor(HTMLParser):
    """HTML から可視テキストだけを取り出す（script/style 等は捨てる）。

    grounding に流すのは「人が読む本文」であって、マークアップや JS ではない。
    依存を増やさず stdlib の HTMLParser で足りる範囲に留める（壊れた HTML でも
    エラーにせず、読めた分だけ返す best-effort）。
    """

    _SKIP_TAGS = frozenset({"script", "style", "noscript", "template"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data.strip():
            self._parts.append(data.strip())

    def text(self) -> str:
        return "\n".join(self._parts)


def _extract_pdf(raw: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _extract_docx(raw: bytes) -> str:
    """Word（.docx）の段落と表をテキスト化する。"""
    from docx import Document

    _guard_zip_expansion(raw)
    document = Document(io.BytesIO(raw))
    parts: list[str] = [p.text for p in document.paragraphs if p.text.strip()]
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                parts.append("\t".join(cells))
    return "\n".join(parts)


def _extract_xlsx(raw: bytes) -> str:
    """Excel（.xlsx）を全シート TSV 風のテキストにする（数式は計算済み値）。"""
    from openpyxl import load_workbook  # type: ignore[import-untyped]

    _guard_zip_expansion(raw)
    workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    try:
        parts: list[str] = []
        for sheet in workbook.worksheets:
            rows: list[str] = []
            for row in sheet.iter_rows(values_only=True):
                cells = ["" if v is None else str(v) for v in row]
                if any(c.strip() for c in cells):
                    rows.append("\t".join(cells).rstrip())
            if rows:
                parts.append(f"# {sheet.title}")
                parts.extend(rows)
        return "\n".join(parts)
    finally:
        workbook.close()


def _extract_pptx(raw: bytes) -> str:
    """PowerPoint（.pptx）のスライド本文とスピーカーノートをテキスト化する。"""
    from pptx import Presentation  # type: ignore[import-untyped]

    _guard_zip_expansion(raw)
    presentation = Presentation(io.BytesIO(raw))
    parts: list[str] = []
    for i, slide in enumerate(presentation.slides, start=1):
        texts = [
            shape.text.strip()
            for shape in slide.shapes
            if getattr(shape, "has_text_frame", False) and shape.text.strip()
        ]
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            note = slide.notes_slide.notes_text_frame.text.strip()
            if note:
                texts.append(note)
        if texts:
            parts.append(f"# スライド{i}")
            parts.extend(texts)
    return "\n".join(parts)


def _extract_html(raw: bytes) -> str:
    extractor = _HTMLTextExtractor()
    extractor.feed(raw.decode("utf-8", errors="replace"))
    return extractor.text()


# 拡張子 → 抽出関数。storage.py の TEXT_EXT / DOC_BINARY_EXT（受理判定）とペアで保守する。
_EXTRACTORS: dict[str, Callable[[bytes], str]] = {
    ".pdf": _extract_pdf,
    ".docx": _extract_docx,
    ".xlsx": _extract_xlsx,
    ".pptx": _extract_pptx,
    ".html": _extract_html,
    ".htm": _extract_html,
}

# MIME → 抽出関数。受理判定（storage.py is_text_upload）は拡張子と MIME のどちらでも通すため、
# 拡張子なし・MIME のみのアップロード（例: ファイル名 "book" + Office MIME）でも正しい抽出器を
# 選べるようにする（拡張子だけだと ZIP バイト列を UTF-8 デコードして索引してしまう / Codex P2）。
_MIME_EXTRACTORS: dict[str, Callable[[bytes], str]] = {
    "application/pdf": _extract_pdf,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": _extract_docx,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": _extract_xlsx,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": _extract_pptx,
    "text/html": _extract_html,
}


def extract_text_from_upload(filename: str, raw: bytes, content_type: str | None = None) -> str:
    """Best-effort text extraction (txt/md/html/csv/json/pdf/docx/xlsx/pptx uploads).

    抽出器は拡張子を優先し、無ければ content-type から選ぶ（受理判定と同じ二段構え）。
    """
    name = filename.lower()
    ext = name[name.rfind(".") :] if "." in name else ""
    ct = (content_type or "").split(";")[0].strip().lower()
    extractor = _EXTRACTORS.get(ext) or _MIME_EXTRACTORS.get(ct)
    if extractor is not None:
        try:
            return extractor(raw)
        except Exception as exc:
            # 壊れたファイル・想定外の中身・zip bomb。呼び出し側が 500 にせず「抽出 0 件」に
            # 平しつつ、成功（indexed）と区別してメトリクス計上できるよう型付き例外で伝える。
            log.warning("document_extract_failed", ext=ext, content_type=ct, error=str(exc))
            raise DocumentExtractionError(f"failed to extract {ext or ct}") from exc
    # txt / md / csv / json / anything decodable as utf-8
    return raw.decode("utf-8", errors="replace")
