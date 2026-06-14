"""Tests for PII masking (issue #10)."""

from __future__ import annotations

from kikitori_api.ingestion import ContextIndexer
from kikitori_api.pii import mask_pii


def test_masks_email() -> None:
    assert mask_pii("連絡は alice@example.com まで") == "連絡は [EMAIL] まで"


def test_masks_phone() -> None:
    assert "[PHONE]" in mask_pii("電話は 090-1234-5678 です")


def test_masks_long_number() -> None:
    assert "[NUMBER]" in mask_pii("カード 4111 1111 1111 1111 を使う")


def test_keeps_ordinary_text() -> None:
    assert mask_pii("同時に5人が参加できること") == "同時に5人が参加できること"


def test_indexer_stores_masked_text() -> None:
    indexer = ContextIndexer()
    indexer.index_context("sess-1", ["問い合わせは bob@example.com"], "notes.md")
    assert indexer.is_memory
    stored = indexer._mem[0]["text"]  # noqa: SLF001 - inspecting fallback store in test
    assert "bob@example.com" not in stored
    assert "[EMAIL]" in stored
