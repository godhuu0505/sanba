"""SANBA <-> 外部エージェントの境界パッケージ（ADR-0063）。

境界の向こうの AI エージェント（初弾は Elastic Agent Builder。将来は AWS / Google ADK 等の
別プロバイダーもあり得る）と SANBA を A2A / MCP の**オープン標準**で結ぶ。エージェント runtime は
自作しない。

top-level が持つのは**真にプロバイダー非依存**な A2A 部品（`a2a_client`: JSON-RPC 2.0 の
`message/send` 組み立てと応答解析）のみ。エンドポイント URL 契約は各プロバイダーの API パスに
依存するため（Elastic は Kibana Agent Builder の `api/agent_builder/*`）、プロバイダーごとの
サブパッケージ（例: `sanba_external_agents.elastic`）に置く。
"""

from __future__ import annotations

from .a2a_client import DelegationResult, build_message_send, extract_text

__all__ = [
    "DelegationResult",
    "build_message_send",
    "extract_text",
]
