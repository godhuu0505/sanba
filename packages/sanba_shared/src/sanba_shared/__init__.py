"""SANBA 共有ドメイン層。

セッション/発話/要件のモデルと永続化境界 (SessionRepository) を agent と api で共有する。
ここは特定アプリの config に依存しない (リテンション日数などは呼び出し側が注入する)。
"""

from __future__ import annotations

from .analytics import TokenUsage, UsageRecorder, estimate_usd, usage_from_genai
from .analytics_sink import AnalyticsConfig, AnalyticsSink
from .inquiry import InquiryTree, make_inquiry_id, normalize_text
from .models import (
    AnalysisResult,
    InquiryKind,
    InquiryNode,
    InquiryOrigin,
    InquiryStatus,
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
    "AnalyticsConfig",
    "AnalyticsSink",
    "InquiryKind",
    "InquiryNode",
    "InquiryOrigin",
    "InquiryStatus",
    "InquiryTree",
    "Priority",
    "Requirement",
    "RequirementCategory",
    "RequirementStatus",
    "SessionMeta",
    "SessionRepository",
    "TokenUsage",
    "UsageRecorder",
    "Utterance",
    "estimate_usd",
    "make_inquiry_id",
    "normalize_text",
    "usage_from_genai",
]
