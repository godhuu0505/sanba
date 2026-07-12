"""HolmesGPT プロバイダーアダプタ（ADR-0069）。

`HOLMESGPT_AGENT_*` 設定・A2A クライアント・汎用 A2A ファサードの URL 契約を提供する。
HolmesGPT は A2A 非対応のため、SANBA からは `a2a-facade/`（独立パッケージ・Cloud Run
デプロイ対象）が公開する A2A 標準エンドポイントへ委譲する。HolmesGPT 固有の関心は
このサブパッケージとファサードに閉じ、上位の A2A 部品はプロバイダー非依存に保つ。
"""

from __future__ import annotations

from .client import HolmesAgentClient
from .config import HolmesgptAgentSettings, settings
from .contract import (
    a2a_agent_card_url,
    a2a_message_url,
    require_http_url,
    root_url,
)

__all__ = [
    "HolmesgptAgentSettings",
    "settings",
    "HolmesAgentClient",
    "a2a_agent_card_url",
    "a2a_message_url",
    "require_http_url",
    "root_url",
]
