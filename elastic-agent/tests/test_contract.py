from __future__ import annotations

from sanba_elastic_agent.contract import (
    a2a_agent_card_url,
    a2a_message_url,
    converse_url,
    mcp_endpoint_url,
)

KIBANA = "https://kb.example.com"


def test_a2a_urls_default_space():
    assert a2a_message_url(KIBANA, "agent-1") == f"{KIBANA}/api/agent_builder/a2a/agent-1"
    assert a2a_agent_card_url(KIBANA, "agent-1") == f"{KIBANA}/api/agent_builder/a2a/agent-1.json"


def test_urls_strip_trailing_slash():
    assert (
        a2a_message_url("https://kb.example.com/", "a")
        == "https://kb.example.com/api/agent_builder/a2a/a"
    )


def test_space_prefix_is_inserted():
    assert (
        a2a_message_url(KIBANA, "agent-1", space="team")
        == f"{KIBANA}/s/team/api/agent_builder/a2a/agent-1"
    )
    assert mcp_endpoint_url(KIBANA, space="team") == f"{KIBANA}/s/team/api/agent_builder/mcp"


def test_mcp_and_converse():
    assert mcp_endpoint_url(KIBANA) == f"{KIBANA}/api/agent_builder/mcp"
    assert converse_url(KIBANA) == f"{KIBANA}/api/agent_builder/converse"
