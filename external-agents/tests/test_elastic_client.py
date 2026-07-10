from __future__ import annotations

from sanba_external_agents.elastic.client import ElasticAgentClient
from sanba_external_agents.elastic.config import ElasticAgentSettings


def test_ask_is_noop_when_unconfigured():
    client = ElasticAgentClient(ElasticAgentSettings(enabled=False))
    result = client.ask("what is the cost?")
    assert result.delegated is False
    assert result.error == "elastic_agent_not_configured"


def test_configured_requires_enabled_url_and_key():
    assert ElasticAgentSettings(enabled=True, kibana_url="", api_key="k").configured is False
    assert ElasticAgentSettings(enabled=False, kibana_url="u", api_key="k").configured is False
    assert ElasticAgentSettings(enabled=True, kibana_url="u", api_key="k").configured is True
