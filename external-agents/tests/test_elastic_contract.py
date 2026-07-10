from __future__ import annotations

import pytest

from sanba_external_agents.elastic.contract import (
    a2a_agent_card_url,
    a2a_message_url,
    converse_url,
    mcp_endpoint_url,
    require_http_url,
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


def test_require_http_url_accepts_http_and_https():
    assert require_http_url("http://x") == "http://x"
    assert require_http_url("https://x") == "https://x"


@pytest.mark.parametrize("bad", ["file:///etc/passwd", "ftp://x", "gopher://x", "x/y"])
def test_require_http_url_rejects_non_http(bad):
    with pytest.raises(ValueError):
        require_http_url(bad)
