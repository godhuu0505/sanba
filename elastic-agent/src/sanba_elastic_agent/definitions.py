"""宣言的な agent / tool 定義の読み込みと検証（ADR-0063）。

`definitions/` の JSON が Agent Builder へ provision する原本。ここでは版管理された JSON を読み、
最小スキーマ（必須キー・種別）を純粋に検証する。ネットワーク非依存で単体テストする。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFINITIONS_DIR = Path(__file__).resolve().parents[2] / "definitions"

TOOL_TYPES = {"esql", "index_search"}


@dataclass(frozen=True)
class ToolDefinition:
    id: str
    type: str
    body: dict


@dataclass(frozen=True)
class AgentDefinition:
    id: str
    name: str
    instructions: str
    tool_ids: tuple[str, ...]
    body: dict


class DefinitionError(ValueError):
    pass


def _require(mapping: dict, key: str, where: str) -> object:
    if key not in mapping:
        raise DefinitionError(f"{where}: missing required key '{key}'")
    return mapping[key]


def parse_tool(raw: dict) -> ToolDefinition:
    tool_id = str(_require(raw, "id", "tool"))
    tool_type = str(_require(raw, "type", f"tool '{tool_id}'"))
    if tool_type not in TOOL_TYPES:
        raise DefinitionError(
            f"tool '{tool_id}': unknown type '{tool_type}' (expected {TOOL_TYPES})"
        )
    _require(raw, "configuration", f"tool '{tool_id}'")
    return ToolDefinition(id=tool_id, type=tool_type, body=raw)


def parse_agent(raw: dict) -> AgentDefinition:
    agent_id = str(_require(raw, "id", "agent"))
    name = str(_require(raw, "name", f"agent '{agent_id}'"))
    instructions = str(_require(raw, "instructions", f"agent '{agent_id}'"))
    tools = _require(raw, "tools", f"agent '{agent_id}'")
    if not isinstance(tools, list):
        raise DefinitionError(f"agent '{agent_id}': 'tools' must be a list")
    return AgentDefinition(
        id=agent_id,
        name=name,
        instructions=instructions,
        tool_ids=tuple(str(t) for t in tools),
        body=raw,
    )


def load_definitions(directory: Path | None = None) -> tuple[list[ToolDefinition], AgentDefinition]:
    """`definitions/` からツール群とエージェント定義を読み、参照整合性まで検証する。"""
    base = directory or DEFINITIONS_DIR
    tools = [parse_tool(json.loads(p.read_text())) for p in sorted((base / "tools").glob("*.json"))]
    agent = parse_agent(json.loads((base / "analytics-agent.json").read_text()))
    known = {t.id for t in tools}
    missing = [tid for tid in agent.tool_ids if tid not in known]
    if missing:
        raise DefinitionError(f"agent '{agent.id}': references unknown tools {missing}")
    return tools, agent
