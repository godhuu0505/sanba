"""Gemini image analysis for uploaded images (ADR-0004).

解析本体は `sanba_shared.media` へ移設した（worker の動画解析と整形ロジック・config 注入形を
そろえるため。ADR-0040）。ここは api の settings を束ねる薄いアダプタと、既存 import
互換（`analyze_image` / `parse_observations`）だけを残す。
"""

from __future__ import annotations

from collections.abc import Callable

from sanba_shared.analytics import TokenUsage
from sanba_shared.media import MediaConfig, parse_observations
from sanba_shared.media import analyze_image as _analyze_image

from .config import settings

__all__ = ["analyze_image", "parse_observations"]


def _media_config() -> MediaConfig:
    return MediaConfig(
        vision_model=settings.gemini_vision_model,
        use_vertexai=settings.google_genai_use_vertexai,
        google_api_key=settings.google_api_key,
    )


def analyze_image(
    raw: bytes,
    content_type: str,
    *,
    on_usage: Callable[[TokenUsage], None] | None = None,
    billing_labels: dict[str, str] | None = None,
) -> list[str]:
    """画像から観察文の配列を返す。creds 未設定や失敗時は空配列。"""
    return _analyze_image(
        raw,
        content_type,
        _media_config(),
        on_usage=on_usage,
        billing_labels=billing_labels,
    )
