"""Lightweight PII masking applied before text is persisted to grounding.

Conversations may contain personal data (emails, phone numbers). We mask the
obvious identifiers before indexing so the RAG store never holds raw PII.
This is a pragmatic regex pass — Cloud DLP can replace it for higher recall.
"""

from __future__ import annotations

import re

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s()]{8,}\d)(?!\d)")
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)")
_LONGNUM = re.compile(r"(?<!\d)\d{12}(?!\d)")
_POSTAL = re.compile(r"〒\s?\d{3}-?\d{4}|(?<!\d)\d{3}-\d{4}(?!\d)")


def mask_pii(text: str) -> str:
    """Replace emails, phone numbers and long numeric identifiers with placeholders."""
    if not text:
        return text
    text = _EMAIL.sub("[EMAIL]", text)
    text = _CARD.sub("[NUMBER]", text)
    text = _LONGNUM.sub("[NUMBER]", text)
    text = _PHONE.sub("[PHONE]", text)
    text = _POSTAL.sub("[POSTAL]", text)
    return text
