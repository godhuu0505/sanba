"""SANBA 共有ドメイン層。

セッション/発話/要件のモデルと永続化境界 (SessionRepository) を agent と api で共有する。
ここは特定アプリの config に依存しない (リテンション日数などは呼び出し側が注入する)。
"""

from __future__ import annotations

from .models import (
    AnalysisResult,
    Priority,
    Requirement,
    RequirementCategory,
    RequirementStatus,
    SessionMeta,
    Utterance,
)
from .repository import SessionRepository

__all__ = [
    "AnalysisResult",
    "Priority",
    "Requirement",
    "RequirementCategory",
    "RequirementStatus",
    "SessionMeta",
    "SessionRepository",
    "Utterance",
]
