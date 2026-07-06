"""Lightweight PII masking applied before text is persisted.

Conversations may contain personal data (emails, phone numbers). We mask the
obvious identifiers before they hit Firestore so the store never holds raw PII
at rest. This is a pragmatic regex pass — Cloud DLP can replace it for higher
recall.

ドメイン層 (sanba_shared) に置くことで、永続化境界 (SessionRepository) が
アプリ config に依存せずマスキングを掛けられる。agent/api 側の grounding 索引用
マスキングは各アプリの pii.py がそのまま担う。
"""

from __future__ import annotations

import re

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# Phone: JP (0X-XXXX-XXXX / 0XXXXXXXXXX) and international (+...), 9+ digits.
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s()]{8,}\d)(?!\d)")
# Long digit runs that look like card / account numbers (13-16 digits).
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)")
# My number / generic 12-digit IDs.
_LONGNUM = re.compile(r"(?<!\d)\d{12}(?!\d)")


def mask_pii(text: str) -> str:
    """Replace emails, phone numbers and long numeric identifiers with placeholders."""
    if not text:
        return text
    text = _EMAIL.sub("[EMAIL]", text)
    text = _CARD.sub("[NUMBER]", text)
    text = _LONGNUM.sub("[NUMBER]", text)
    text = _PHONE.sub("[PHONE]", text)
    return text
