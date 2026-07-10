"""A2A 委譲のプロバイダー非依存な部品（ADR-0063）。

A2A は Google 発のオープン標準なので、リクエスト組み立て（JSON-RPC 2.0 `message/send`）と
応答テキスト抽出はどのプロバイダー（Elastic Agent Builder / AWS / Google ADK 等）でも共通。
純関数としてネットワーク非依存に単体テストする。プロバイダー固有のクライアントは各
`providers`（例: `elastic.client.ElasticAgentClient`）がこの部品を組み合わせて実装する。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class DelegationResult:
    delegated: bool
    text: str = ""
    error: str | None = None
    raw: dict | None = None


def build_message_send(text: str, *, message_id: str | None = None) -> dict:
    """A2A `message/send`（JSON-RPC 2.0）のリクエストボディを組み立てる。"""
    mid = message_id or uuid.uuid4().hex
    return {
        "jsonrpc": "2.0",
        "id": mid,
        "method": "message/send",
        "params": {
            "message": {
                "kind": "message",
                "role": "user",
                "messageId": mid,
                "parts": [{"kind": "text", "text": text}],
            }
        },
    }


def _text_parts(parts: object) -> list[str]:
    if not isinstance(parts, list):
        return []
    return [
        p["text"]
        for p in parts
        if isinstance(p, dict) and p.get("kind") == "text" and p.get("text")
    ]


def extract_text(response: dict) -> str:
    """A2A 応答からテキストを取り出す。

    同期 `message/send` の戻りは Message か完了 Task。Task の最終回答は `artifacts[].parts` に
    入るため（`status.message` は途中経過のことがある）、Message の `parts` → Task の
    `artifacts[].parts` → `status.message.parts` の順に拾う。
    """
    result = response.get("result") or {}
    texts = _text_parts(result.get("parts"))
    if not texts:
        for artifact in result.get("artifacts") or []:
            if isinstance(artifact, dict):
                texts.extend(_text_parts(artifact.get("parts")))
    if not texts:
        status = result.get("status") or {}
        message = status.get("message") or result.get("message") or {}
        texts = _text_parts(message.get("parts"))
    return "\n".join(texts).strip()
