"""JSON-RPC 2.0（A2A `message/send`）の解析と応答組み立ての純関数（ADR-0069）。

受理するメソッドは `message/send` のみ（read-only 方針をプロトコル面でも担保する。
ADR-0069 決定2・3）。`tasks/get` は Phase 3' で追加する。ネットワーク非依存なので
単体テストで固定する。
"""

from __future__ import annotations

import uuid
from typing import Any

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603

SUPPORTED_METHOD = "message/send"


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, request_id: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id


def parse_message_send(payload: Any) -> tuple[Any, str]:
    """`message/send` リクエストを検証し (request_id, 質問テキスト) を返す。"""
    if not isinstance(payload, dict):
        raise JsonRpcError(INVALID_REQUEST, "request body must be a JSON object")
    request_id = payload.get("id")
    if payload.get("jsonrpc") != "2.0":
        raise JsonRpcError(INVALID_REQUEST, "jsonrpc must be '2.0'", request_id)
    method = payload.get("method")
    if method != SUPPORTED_METHOD:
        raise JsonRpcError(
            METHOD_NOT_FOUND,
            f"unsupported method: {method!r} (only {SUPPORTED_METHOD})",
            request_id,
        )
    message = (payload.get("params") or {}).get("message") or {}
    parts = message.get("parts") or []
    texts = [
        p["text"]
        for p in parts
        if isinstance(p, dict) and p.get("kind") == "text" and p.get("text")
    ]
    if not texts:
        raise JsonRpcError(INVALID_REQUEST, "params.message.parts must contain text", request_id)
    return request_id, "\n".join(texts)


def build_text_result(request_id: Any, text: str) -> dict:
    """完了応答（A2A Message）を組み立てる。"""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "result": {
            "kind": "message",
            "role": "agent",
            "messageId": uuid.uuid4().hex,
            "parts": [{"kind": "text", "text": text}],
        },
    }


def build_error(request_id: Any, code: int, message: str) -> dict:
    """JSON-RPC 2.0 エラー応答を組み立てる。"""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }
