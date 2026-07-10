"""Elastic Agent Builder のエンドポイント URL 契約: 純粋な組み立て（ADR-0063）。

Kibana Agent Builder が公開する REST パス（`api/agent_builder/*`）に固有なので Elastic プロバイダー
アダプタ配下に置く（プロバイダー非依存なのは `..a2a_client` の JSON-RPC 部品のみ）:
  - A2A（エージェント間）: agent card と message 実行
  - MCP（ツール/データ）: ツール公開エンドポイント
ネットワークに触れない純関数なので単体テストで固定する。将来 AWS / Google ADK 等を足すときは、
各プロバイダーの API パスに応じた同種の contract を各アダプタ配下に置く。
"""

from __future__ import annotations

from urllib.parse import urlparse

A2A_BASE = "api/agent_builder/a2a"
MCP_PATH = "api/agent_builder/mcp"
CONVERSE_PATH = "api/agent_builder/converse"


def root_url(kibana_url: str, space: str = "") -> str:
    """Kibana ベース URL（任意で `/s/{space}` を付加）を正規化して返す。"""
    root = kibana_url.rstrip("/")
    if space:
        root = f"{root}/s/{space.strip('/')}"
    return root


def require_http_url(url: str) -> str:
    """URL のスキームが http(s) であることを保証する。file:// 等への誤送信を防ぐ。"""
    if urlparse(url).scheme not in ("http", "https"):
        raise ValueError(f"unsupported URL scheme (http/https only): {url!r}")
    return url


def a2a_agent_card_url(kibana_url: str, agent_id: str, space: str = "") -> str:
    """A2A agent card（能力記述 JSON）の URL。GET で取得する。"""
    return f"{root_url(kibana_url, space)}/{A2A_BASE}/{agent_id}.json"


def a2a_message_url(kibana_url: str, agent_id: str, space: str = "") -> str:
    """A2A のメッセージ実行 URL。POST で `message/send` を送る。"""
    return f"{root_url(kibana_url, space)}/{A2A_BASE}/{agent_id}"


def mcp_endpoint_url(kibana_url: str, space: str = "") -> str:
    """Agent Builder のツールを公開する MCP エンドポイント URL。"""
    return f"{root_url(kibana_url, space)}/{MCP_PATH}"


def converse_url(kibana_url: str, space: str = "") -> str:
    """Agent Builder のネイティブ会話エンドポイント URL（A2A を使わない直呼び用）。"""
    return f"{root_url(kibana_url, space)}/{CONVERSE_PATH}"
