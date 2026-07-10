"""Tests for PII masking + masked grounding writes."""

from __future__ import annotations

from sanba_agent.pii import mask_pii
from sanba_agent.retrieval import GroundingStore


def test_masks_email_and_phone() -> None:
    masked = mask_pii("alice@example.com / 090-1234-5678")
    assert "[EMAIL]" in masked
    assert "[PHONE]" in masked


def test_keeps_ordinary_text() -> None:
    assert mask_pii("レイテンシは1秒以内") == "レイテンシは1秒以内"


def test_masks_postal_code() -> None:
    assert "[POSTAL]" in mask_pii("住所は〒123-4567 です")
    assert "[POSTAL]" in mask_pii("123-4567 に送ってください")
    assert mask_pii("バージョンは1-2です") == "バージョンは1-2です"


def test_grounding_store_masks_before_indexing() -> None:
    store = GroundingStore()
    store.index_passage("連絡先は carol@example.com", "utt:1", "utterance", "sess-1")
    hits = store.search("連絡先", k=3)
    assert hits
    assert all("carol@example.com" not in h.text for h in hits)
