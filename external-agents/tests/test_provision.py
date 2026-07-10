from __future__ import annotations

from sanba_external_agents.elastic.catalog import load_definitions
from sanba_external_agents.elastic.provision import plan_provision

KIBANA = "https://kb.example.com"


def test_plan_orders_tools_before_agent():
    tools, agent = load_definitions()
    steps = plan_provision(KIBANA, tools, agent)
    kinds = [s.kind for s in steps]
    assert kinds[-1] == "agent"
    assert kinds[:-1] == ["tool"] * len(tools)


def test_plan_builds_collection_and_item_urls():
    tools, agent = load_definitions()
    steps = plan_provision(KIBANA, tools, agent, space="team")
    agent_step = steps[-1]
    assert agent_step.collection_url == f"{KIBANA}/s/team/api/agent_builder/agents"
    assert agent_step.item_url == f"{KIBANA}/s/team/api/agent_builder/agents/{agent.id}"
    tool_step = steps[0]
    assert tool_step.collection_url == f"{KIBANA}/s/team/api/agent_builder/tools"
    assert tool_step.item_url.startswith(f"{KIBANA}/s/team/api/agent_builder/tools/")
