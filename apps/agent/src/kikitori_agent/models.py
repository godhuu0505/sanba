"""Domain models for the interview session."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum

from pydantic import BaseModel, Field


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RequirementCategory(StrEnum):
    FUNCTIONAL = "functional"
    NON_FUNCTIONAL = "non_functional"
    CONSTRAINT = "constraint"
    SCOPE = "scope"
    OPEN_QUESTION = "open_question"


class Priority(StrEnum):
    MUST = "must"
    SHOULD = "should"
    COULD = "could"
    WONT = "wont"


class Requirement(BaseModel):
    """A single confirmed (or candidate) requirement."""

    id: str
    category: RequirementCategory
    statement: str
    priority: Priority = Priority.SHOULD
    source_speaker: str | None = None
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    created_at: datetime = Field(default_factory=_now)


class Utterance(BaseModel):
    speaker: str
    text: str
    ts: datetime = Field(default_factory=_now)


class AnalysisResult(BaseModel):
    """Output of the ADK agent team for one analysis pass."""

    summary: str
    open_topics: list[str] = Field(default_factory=list)
    next_question: str
    suggested_answer: str
