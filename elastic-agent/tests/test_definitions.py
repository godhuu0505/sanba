from __future__ import annotations

import json

import pytest

from sanba_elastic_agent.definitions import (
    DefinitionError,
    load_definitions,
    parse_agent,
    parse_tool,
)


def test_load_bundled_definitions_are_valid_and_referentially_consistent():
    tools, agent = load_definitions()
    tool_ids = {t.id for t in tools}
    assert agent.id == "sanba-external-context-agent"
    assert tool_ids == {"sanba-external-context-search"}
    assert set(agent.tool_ids) <= tool_ids


def test_parse_tool_rejects_unknown_type():
    with pytest.raises(DefinitionError):
        parse_tool({"id": "x", "type": "sql", "configuration": {}})


def test_parse_tool_requires_configuration():
    with pytest.raises(DefinitionError):
        parse_tool({"id": "x", "type": "esql"})


def test_parse_agent_requires_instructions():
    with pytest.raises(DefinitionError):
        parse_agent({"id": "a", "name": "A", "tools": []})


def test_load_rejects_dangling_tool_reference(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / "tools" / "t.json").write_text(
        json.dumps({"id": "real-tool", "type": "esql", "configuration": {"query": "FROM x"}})
    )
    (tmp_path / "external-context-agent.json").write_text(
        json.dumps(
            {"id": "a", "name": "A", "instructions": "i", "tools": ["real-tool", "ghost-tool"]}
        )
    )
    with pytest.raises(DefinitionError):
        load_definitions(tmp_path)
