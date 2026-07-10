from __future__ import annotations

from sanba_external_agents.a2a_client import build_message_send, extract_text


def test_build_message_send_shape():
    body = build_message_send("hello", message_id="m1")
    assert body["jsonrpc"] == "2.0"
    assert body["method"] == "message/send"
    part = body["params"]["message"]["parts"][0]
    assert part == {"kind": "text", "text": "hello"}


def test_build_message_send_reuses_one_id():
    body = build_message_send("hi")
    assert body["id"] == body["params"]["message"]["messageId"]


def test_build_message_send_marks_message_kind():
    body = build_message_send("hi")
    assert body["params"]["message"]["kind"] == "message"


def test_extract_text_from_direct_parts():
    resp = {"result": {"parts": [{"kind": "text", "text": "a"}, {"kind": "text", "text": "b"}]}}
    assert extract_text(resp) == "a\nb"


def test_extract_text_from_task_artifacts():
    resp = {
        "result": {
            "status": {"state": "completed"},
            "artifacts": [
                {"parts": [{"kind": "text", "text": "answer one"}]},
                {"parts": [{"kind": "text", "text": "answer two"}]},
            ],
        }
    }
    assert extract_text(resp) == "answer one\nanswer two"


def test_extract_text_from_status_message():
    resp = {"result": {"status": {"message": {"parts": [{"kind": "text", "text": "done"}]}}}}
    assert extract_text(resp) == "done"


def test_extract_text_ignores_non_text_parts_and_empty():
    resp = {"result": {"parts": [{"kind": "data", "data": {}}, {"kind": "text", "text": ""}]}}
    assert extract_text(resp) == ""


def test_extract_text_empty_on_missing_result():
    assert extract_text({}) == ""
