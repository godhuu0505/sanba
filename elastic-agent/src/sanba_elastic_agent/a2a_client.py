"""Elastic エージェントへ A2A で委譲する薄いクライアントアダプタ（ADR-0063）。

- リクエスト組み立て（JSON-RPC 2.0 `message/send`）と応答テキスト抽出は**純関数**で、
  ネットワーク非依存に単体テストする。
- 実際の送信は `settings.configured` が真のときだけ行い、未設定・失敗時は fail-soft に
  `DelegationResult(delegated=False, ...)` を返す（ADR-0003 縮退・ADR-0007 flag OFF と同型）。
- **音声クリティカルパスから直接呼ばない**。ADK 分析層の off-loop 非同期からのみ呼ぶ
  （ADR-0046/0002）。Elastic の A2A は同期・非ストリーミングで、往復を会話に載せてはならない。
"""

from __future__ import annotations

import json
import urllib.request
import uuid
from dataclasses import dataclass

import structlog

from .config import ElasticAgentSettings, settings
from .contract import a2a_message_url

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class DelegationResult:
    delegated: bool
    text: str = ""
    error: str | None = None
    raw: dict | None = None


def build_message_send(text: str, *, message_id: str | None = None) -> dict:
    """A2A `message/send`（JSON-RPC 2.0）のリクエストボディを組み立てる。"""
    return {
        "jsonrpc": "2.0",
        "id": message_id or uuid.uuid4().hex,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "messageId": message_id or uuid.uuid4().hex,
                "parts": [{"kind": "text", "text": text}],
            }
        },
    }


def extract_text(response: dict) -> str:
    """A2A 応答（task/message）からテキストパートを連結して取り出す。"""
    result = response.get("result") or {}
    parts: list[dict] = []
    if isinstance(result.get("parts"), list):
        parts = result["parts"]
    else:
        status = result.get("status") or {}
        message = status.get("message") or result.get("message") or {}
        if isinstance(message.get("parts"), list):
            parts = message["parts"]
    texts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("kind") == "text"]
    return "\n".join(t for t in texts if t).strip()


class ElasticAgentClient:
    """境界の向こうの Elastic エージェント（初弾は外部コンテキスト）への A2A クライアント。"""

    def __init__(self, config: ElasticAgentSettings | None = None) -> None:
        self._settings = config or settings

    def ask(self, question: str) -> DelegationResult:
        if not self._settings.configured:
            return DelegationResult(delegated=False, error="elastic_agent_not_configured")
        try:
            response = self._send(question)
        except Exception as exc:  # noqa: BLE001
            log.warning("elastic_a2a_delegation_failed", error=str(exc))
            return DelegationResult(delegated=False, error=str(exc))
        return DelegationResult(delegated=True, text=extract_text(response), raw=response)

    def _send(self, question: str) -> dict:  # pragma: no cover
        url = a2a_message_url(
            self._settings.kibana_url, self._settings.agent_id, self._settings.space
        )
        body = json.dumps(build_message_send(question)).encode()
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "kbn-xsrf": "sanba",
                "Authorization": f"ApiKey {self._settings.api_key}",
            },
        )
        with urllib.request.urlopen(  # noqa: S310
            request, timeout=self._settings.request_timeout_seconds
        ) as response:
            payload: dict = json.loads(response.read().decode())
        return payload
