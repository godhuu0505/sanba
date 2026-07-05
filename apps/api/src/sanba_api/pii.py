"""PII masking for context ingestion (issue #10).

Mirrors apps/agent/.../pii.py so material registered via the API is masked before
it reaches the shared grounding index. A shared package is the long-term home.
"""

from __future__ import annotations

import re

# Email. Quantifiers are bounded and the domain labels exclude '.' so the
# separator is unambiguous — this keeps matching linear on untrusted input
# (avoids polynomial ReDoS on runs like "%%%%…"; CodeQL py/polynomial-redos).
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s()]{8,}\d)(?!\d)")
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)")
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
