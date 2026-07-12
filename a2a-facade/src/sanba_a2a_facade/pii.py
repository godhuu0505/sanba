"""永続化前の軽量 PII マスキング（ADR-0069 / issue #547）。

委譲監査を sanba-ops Firestore へ残す前に、依頼文と調査結果に混じり得る明白な識別子
（メール・電話・カード/長桁番号・郵便番号）をプレースホルダに置換し、ストアが生 PII を
保持しないようにする（`packages/sanba_shared` の `mask_pii` と同じ正規表現方針）。sanba_shared
本体には依存しない: 共有パッケージは elasticsearch / google-genai / livekit を引き込み、最小・
非 root を保つ read-only ファサードのベースと供給網スキャン面を不必要に太らせるため
（意図的な境界。会話へ注入する生テキストはマスクせず、監査コピーだけを本関数で通す）。
"""

from __future__ import annotations

import re

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}")
_PHONE = re.compile(r"(?<!\d)(?:\+?\d[\d\-\s()]{8,}\d)(?!\d)")
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)")
_LONGNUM = re.compile(r"(?<!\d)\d{12}(?!\d)")
_POSTAL = re.compile(r"〒\s?\d{3}-?\d{4}|(?<!\d)\d{3}-\d{4}(?!\d)")


def mask_pii(text: str) -> str:
    if not text:
        return text
    text = _EMAIL.sub("[EMAIL]", text)
    text = _CARD.sub("[NUMBER]", text)
    text = _LONGNUM.sub("[NUMBER]", text)
    text = _PHONE.sub("[PHONE]", text)
    text = _POSTAL.sub("[POSTAL]", text)
    return text
