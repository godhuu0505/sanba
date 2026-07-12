"""汎用 A2A ファサード（`a2a-facade/`）のエンドポイント URL 契約: 純粋な組み立て（ADR-0069）。

ファサードは A2A 標準の agent card（`/.well-known/agent-card.json`）と JSON-RPC 2.0
`message/send`（`/a2a/{agent_id}`）だけを公開する。HolmesGPT の生 HTTP API はファサードの
背後（sidecar・localhost）に閉じるため、ここには現れない。ネットワークに触れない純関数なので
単体テストで固定する。
"""

from __future__ import annotations

from urllib.parse import urlparse

AGENT_CARD_PATH = ".well-known/agent-card.json"
A2A_BASE = "a2a"


def root_url(base_url: str) -> str:
    """ファサードのベース URL を正規化して返す。"""
    return base_url.rstrip("/")


def require_http_url(url: str) -> str:
    """URL のスキームが http(s) であることを保証する。file:// 等への誤送信を防ぐ。"""
    if urlparse(url).scheme not in ("http", "https"):
        raise ValueError(f"unsupported URL scheme (http/https only): {url!r}")
    return url


def a2a_agent_card_url(base_url: str) -> str:
    """A2A agent card（能力記述 JSON）の URL。GET で取得する。"""
    return f"{root_url(base_url)}/{AGENT_CARD_PATH}"


def a2a_message_url(base_url: str, agent_id: str) -> str:
    """A2A のメッセージ実行 URL。POST で `message/send` を送る。"""
    return f"{root_url(base_url)}/{A2A_BASE}/{agent_id}"
