"""永続化前 best-effort PII マスク（pii.mask_pii）の単体テスト。"""

from __future__ import annotations

from sanba_shared.pii import mask_pii


def test_masks_email_and_phone() -> None:
    masked = mask_pii("連絡は bob@example.com か 03-1234-5678 まで")
    assert "bob@example.com" not in masked
    assert "[EMAIL]" in masked
    assert "[PHONE]" in masked


def test_masks_japanese_postal_code() -> None:
    assert mask_pii("住所は 〒123-4567 です") == "住所は [POSTAL] です"
    assert mask_pii("郵便番号 123-4567") == "郵便番号 [POSTAL]"


def test_empty_input_is_returned_unchanged() -> None:
    assert mask_pii("") == ""


def test_best_effort_limit_names_are_not_masked() -> None:
    assert mask_pii("担当は田中太郎です") == "担当は田中太郎です"
