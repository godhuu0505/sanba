"""Elastic Agent Builder プロバイダーアダプタ（ADR-0063）。

`ELASTIC_AGENT_*` 設定・A2A クライアント・Kibana Agent Builder の URL 契約・宣言的定義・
冪等プロビジョニングを提供する。Elastic 固有の関心（Kibana API パス・`kibana_url`・space 等）は
このサブパッケージに閉じ、上位の A2A 部品はプロバイダー非依存に保つ。
"""

from __future__ import annotations

from .catalog import AgentDefinition, ToolDefinition, load_definitions
from .client import ElasticAgentClient
from .config import ElasticAgentSettings, settings
from .contract import (
    a2a_agent_card_url,
    a2a_message_url,
    converse_url,
    mcp_endpoint_url,
    require_http_url,
    root_url,
)

__all__ = [
    "ElasticAgentSettings",
    "settings",
    "ElasticAgentClient",
    "AgentDefinition",
    "ToolDefinition",
    "load_definitions",
    "a2a_message_url",
    "a2a_agent_card_url",
    "mcp_endpoint_url",
    "converse_url",
    "root_url",
    "require_http_url",
]
