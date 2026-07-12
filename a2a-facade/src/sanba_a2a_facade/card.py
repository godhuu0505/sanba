"""A2A agent card の組み立て（proto AgentCard、ADR-0069）。

card は a2a-sdk の proto 型（`a2a.types.a2a_pb2.AgentCard`）で組み立てる。SDK の
`create_agent_card_routes` が `/.well-known/agent-card.json` で配信する。streaming は
Phase 0 では非対応（`message/send` 同期のみ）。interface の `url` はファサードの公開 URL 配下の
JSON-RPC エンドポイント（`{public_url}/a2a/{agent_id}`）で、未設定時は相対パスのまま返す。
"""

from __future__ import annotations

from a2a.types.a2a_pb2 import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    AgentSkill,
)
from a2a.utils.constants import TransportProtocol

from .backends.base import AgentBackend

CARD_VERSION = "0.1.0"


def rpc_path(agent_id: str) -> str:
    return f"/a2a/{agent_id}"


def build_agent_card(backend: AgentBackend, agent_id: str, public_url: str = "") -> AgentCard:
    url = f"{public_url.rstrip('/')}{rpc_path(agent_id)}" if public_url else rpc_path(agent_id)
    return AgentCard(
        name=backend.name,
        description=backend.description,
        version=CARD_VERSION,
        supported_interfaces=[AgentInterface(url=url, protocol_binding=TransportProtocol.JSONRPC)],
        capabilities=AgentCapabilities(streaming=False),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[
            AgentSkill(
                id=skill["id"],
                name=skill["name"],
                description=skill.get("description", ""),
                tags=skill.get("tags", []),
            )
            for skill in backend.skills()
        ],
    )
