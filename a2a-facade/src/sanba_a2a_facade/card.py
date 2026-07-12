"""A2A agent card の組み立て（純関数、ADR-0069）。

card はバックエンドのメタデータから生成する。streaming は Phase 0 では非対応
（`message/send` 同期のみ）。`url` はファサードの公開 URL（Cloud Run の URL）で、
未設定時は空のまま返す（起動時に env で与える）。
"""

from __future__ import annotations

from typing import Any

from .backends.base import AgentBackend

PROTOCOL_VERSION = "0.3.0"


def build_agent_card(backend: AgentBackend, agent_id: str, public_url: str = "") -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "name": backend.name,
        "description": backend.description,
        "url": f"{public_url.rstrip('/')}/a2a/{agent_id}" if public_url else "",
        "version": "0.1.0",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": backend.skills(),
    }
