"""SANBA <-> 外部エージェントの境界パッケージ（ADR-0063）。

境界の向こうの AI エージェント（初弾は Elastic Agent Builder。将来は AWS / Google ADK 等の
別プロバイダーもあり得る）と SANBA を A2A / MCP の**オープン標準**で結ぶ。エージェント runtime は
自作しない。プロバイダー非依存の seam（`contract` / `a2a_client`）を上位に置き、プロバイダー固有の
アダプタは各プロバイダーのサブパッケージ（例: `sanba_external_agents.elastic`）配下に隔離する。
"""

from __future__ import annotations

from .a2a_client import DelegationResult, build_message_send, extract_text
from .contract import (
    a2a_agent_card_url,
    a2a_message_url,
    mcp_endpoint_url,
    require_http_url,
    root_url,
)

__all__ = [
    "DelegationResult",
    "build_message_send",
    "extract_text",
    "a2a_message_url",
    "a2a_agent_card_url",
    "mcp_endpoint_url",
    "root_url",
    "require_http_url",
]
