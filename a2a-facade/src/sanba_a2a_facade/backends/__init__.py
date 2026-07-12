"""バックエンドアダプタ群。差し替え点は `base.AgentBackend`（ADR-0069 決定2）。"""

from __future__ import annotations

from .base import AgentBackend
from .holmesgpt import HolmesBackend

__all__ = ["AgentBackend", "HolmesBackend"]
