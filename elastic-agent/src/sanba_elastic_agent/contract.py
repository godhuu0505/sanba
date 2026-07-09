"""SANBA <-> Elastic の結合面（seam）の契約: エンドポイント URL の純粋な組み立て（ADR-0063）。

Elastic Agent Builder が公開する標準面に限定する:
  - A2A（エージェント間）: agent card と message 実行
  - MCP（ツール/データ）: ツール公開エンドポイント
ネットワークに触れない純関数なので単体テストで固定する。エンジンを自前実装に差し替える場合も、
同じパス規約を満たす限りこの契約は不変。
"""

from __future__ import annotations

A2A_BASE = "api/agent_builder/a2a"
MCP_PATH = "api/agent_builder/mcp"
CONVERSE_PATH = "api/agent_builder/converse"


def _root(kibana_url: str, space: str = "") -> str:
    root = kibana_url.rstrip("/")
    if space:
        root = f"{root}/s/{space.strip('/')}"
    return root


def a2a_agent_card_url(kibana_url: str, agent_id: str, space: str = "") -> str:
    """A2A agent card（能力記述 JSON）の URL。GET で取得する。"""
    return f"{_root(kibana_url, space)}/{A2A_BASE}/{agent_id}.json"


def a2a_message_url(kibana_url: str, agent_id: str, space: str = "") -> str:
    """A2A のメッセージ実行 URL。POST で `message/send` を送る。"""
    return f"{_root(kibana_url, space)}/{A2A_BASE}/{agent_id}"


def mcp_endpoint_url(kibana_url: str, space: str = "") -> str:
    """Agent Builder のツールを公開する MCP エンドポイント URL。"""
    return f"{_root(kibana_url, space)}/{MCP_PATH}"


def converse_url(kibana_url: str, space: str = "") -> str:
    """Agent Builder のネイティブ会話エンドポイント URL（A2A を使わない直呼び用）。"""
    return f"{_root(kibana_url, space)}/{CONVERSE_PATH}"
