from __future__ import annotations

import pytest

from sanba_a2a_facade.jsonrpc import (
    INTERNAL_ERROR,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    JsonRpcError,
    build_error,
    build_text_result,
    parse_message_send,
)


def _request(text: str = "調査して", method: str = "message/send") -> dict:
    return {
        "jsonrpc": "2.0",
        "id": "m1",
        "method": method,
        "params": {
            "message": {
                "kind": "message",
                "role": "user",
                "messageId": "m1",
                "parts": [{"kind": "text", "text": text}],
            }
        },
    }


def test_parse_message_send_returns_id_and_text():
    request_id, text = parse_message_send(_request("sess-x を調査"))
    assert request_id == "m1"
    assert text == "sess-x を調査"


def test_parse_joins_multiple_text_parts():
    payload = _request()
    payload["params"]["message"]["parts"].append({"kind": "text", "text": "続き"})
    assert parse_message_send(payload)[1] == "調査して\n続き"


def test_parse_rejects_non_object_body():
    with pytest.raises(JsonRpcError) as exc:
        parse_message_send([1, 2])
    assert exc.value.code == INVALID_REQUEST


def test_parse_rejects_wrong_jsonrpc_version():
    payload = _request()
    payload["jsonrpc"] = "1.0"
    with pytest.raises(JsonRpcError) as exc:
        parse_message_send(payload)
    assert exc.value.code == INVALID_REQUEST
    assert exc.value.request_id == "m1"


def test_parse_rejects_unknown_method():
    with pytest.raises(JsonRpcError) as exc:
        parse_message_send(_request(method="tasks/get"))
    assert exc.value.code == METHOD_NOT_FOUND


def test_parse_rejects_empty_parts():
    payload = _request()
    payload["params"]["message"]["parts"] = []
    with pytest.raises(JsonRpcError) as exc:
        parse_message_send(payload)
    assert exc.value.code == INVALID_REQUEST


def test_build_text_result_is_a2a_message():
    result = build_text_result("m1", "回答")
    assert result["id"] == "m1"
    body = result["result"]
    assert body["kind"] == "message"
    assert body["role"] == "agent"
    assert body["parts"] == [{"kind": "text", "text": "回答"}]


def test_build_error_shape():
    error = build_error("m1", INTERNAL_ERROR, "boom")
    assert error["error"] == {"code": INTERNAL_ERROR, "message": "boom"}
    assert error["id"] == "m1"
