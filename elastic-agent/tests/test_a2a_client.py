from __future__ import annotations

from sanba_elastic_agent.a2a_client import (
    AnalyticsAgentClient,
    build_message_send,
    extract_text,
)
from sanba_elastic_agent.config import ElasticAgentSettings


def test_build_message_send_shape():
    body = build_message_send("hello", message_id="m1")
    assert body["jsonrpc"] == "2.0"
    assert body["method"] == "message/send"
    part = body["params"]["message"]["parts"][0]
    assert part == {"kind": "text", "text": "hello"}


def test_extract_text_from_direct_parts():
    resp = {"result": {"parts": [{"kind": "text", "text": "a"}, {"kind": "text", "text": "b"}]}}
    assert extract_text(resp) == "a\nb"


def test_extract_text_from_status_message():
    resp = {"result": {"status": {"message": {"parts": [{"kind": "text", "text": "done"}]}}}}
    assert extract_text(resp) == "done"


def test_extract_text_ignores_non_text_parts_and_empty():
    resp = {"result": {"parts": [{"kind": "data", "data": {}}, {"kind": "text", "text": ""}]}}
    assert extract_text(resp) == ""


def test_ask_is_noop_when_unconfigured():
    client = AnalyticsAgentClient(ElasticAgentSettings(enabled=False))
    result = client.ask("what is the cost?")
    assert result.delegated is False
    assert result.error == "elastic_agent_not_configured"


def test_configured_requires_enabled_url_and_key():
    assert ElasticAgentSettings(enabled=True, kibana_url="", api_key="k").configured is False
    assert ElasticAgentSettings(enabled=False, kibana_url="u", api_key="k").configured is False
    assert ElasticAgentSettings(enabled=True, kibana_url="u", api_key="k").configured is True
