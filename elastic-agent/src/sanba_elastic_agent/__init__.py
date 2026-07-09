"""SANBA <-> Elastic Agent Builder の境界パッケージ（ADR-0063）。

Elastic 側の AI エージェント（Agent Builder、または seam の背後で差し替え可能な自前エンジン）と
SANBA を A2A / MCP の標準契約で結ぶ。エージェント runtime は自作しない。ここが持つのは
宣言的定義・冪等プロビジョニング・A2A/MCP クライアントアダプタのみ。
"""

from __future__ import annotations

from .a2a_client import DelegationResult, ElasticAgentClient
from .config import ElasticAgentSettings, settings
from .contract import a2a_agent_card_url, a2a_message_url, mcp_endpoint_url

__all__ = [
    "ElasticAgentSettings",
    "settings",
    "ElasticAgentClient",
    "DelegationResult",
    "a2a_message_url",
    "a2a_agent_card_url",
    "mcp_endpoint_url",
]
