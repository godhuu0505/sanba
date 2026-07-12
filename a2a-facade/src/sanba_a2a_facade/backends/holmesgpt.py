"""HolmesGPT バックエンド: `/api/chat` への薄いブリッジ（ADR-0069）。

HolmesGPT server は同一 Cloud Run サービスの sidecar として localhost に閉じる前提。
リクエストには Phase 0.5 で実証した 2 つのノブを常に適用する:

- `additional_system_prompt`: エージェント定義（索引スキーマ・クエリ実例）の注入。
  深掘り調査の偽陰性対策（ADR-0069 Phase 0.5 実施結果）。
- `behavior_controls.todowrite_instructions=false`: モデルが TodoWrite ツール呼び出しで
  手番を終えると `analysis` が None になり HTTP 500 になる上流バグの回避。

`submit()` / `poll()` は Phase 3'（Task ベース非同期）まで未実装。
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any

CHAT_PATH = "/api/chat"


class HolmesBackend:
    def __init__(
        self,
        base_url: str,
        *,
        name: str,
        description: str,
        instructions: str = "",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._instructions = instructions
        self.name = name
        self.description = description

    def skills(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "investigate",
                "name": "read-only investigation",
                "description": self.description,
                "tags": ["sre", "read-only"],
            }
        ]

    def ask(self, text: str, *, timeout: float = 300.0) -> str:
        body: dict[str, Any] = {
            "ask": text,
            "behavior_controls": {"todowrite_instructions": False},
        }
        if self._instructions:
            body["additional_system_prompt"] = self._instructions
        response = self._post_chat(body, timeout)
        analysis = response.get("analysis")
        if not isinstance(analysis, str) or not analysis:
            raise ValueError("holmes /api/chat returned no analysis text")
        return analysis

    def submit(self, text: str) -> str:
        raise NotImplementedError("task-based delegation is planned for Phase 3'")

    def poll(self, task_id: str) -> tuple[str, str | None]:
        raise NotImplementedError("task-based delegation is planned for Phase 3'")

    def _post_chat(self, body: dict[str, Any], timeout: float) -> dict:  # pragma: no cover
        request = urllib.request.Request(
            f"{self._base_url}{CHAT_PATH}",
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            payload: dict = json.loads(response.read().decode())
        return payload
