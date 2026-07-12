"""バックエンドアダプタの Protocol（ADR-0069 決定2）。

ここが汎用ファサードの差し替え点: A2A 非対応の OSS エージェントは、この Protocol を満たす
アダプタを 1 ファイル足すだけで A2A サーバ化できる。`ask()` は同期パス（Phase 0）、
`submit()` / `poll()` は Task ベース非同期パス（Phase 3'。ファサードの `message/send` が
Task を返し `tasks/get` と対応）。
"""

from __future__ import annotations

from typing import Any, Protocol


class AgentBackend(Protocol):
    name: str
    description: str

    def skills(self) -> list[dict[str, Any]]: ...

    def ask(self, text: str, *, timeout: float = 300.0) -> str: ...

    def submit(self, text: str) -> str: ...

    def poll(self, task_id: str) -> tuple[str, str | None]: ...
