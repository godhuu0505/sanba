"""Elastic Agent Builder プロバイダーアダプタ（ADR-0063）。

`ELASTIC_AGENT_*` 設定・A2A クライアント・宣言的定義・冪等プロビジョニングを提供する。
Elastic 固有の関心はこのサブパッケージに閉じ、上位の seam はプロバイダー非依存に保つ。
"""

from __future__ import annotations

from .catalog import AgentDefinition, ToolDefinition, load_definitions
from .client import ElasticAgentClient
from .config import ElasticAgentSettings, settings

__all__ = [
    "ElasticAgentSettings",
    "settings",
    "ElasticAgentClient",
    "AgentDefinition",
    "ToolDefinition",
    "load_definitions",
]
